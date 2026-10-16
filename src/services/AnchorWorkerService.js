import { logger } from '../utils/logger.js';
import { OBJECT_POSE_MODEL } from '../cv/anchor.reconstructionModes.js';
import { prepareImageDataTransfer } from '../utils/imageDataTransfer.js';
import { assertWorkerRequestTimeout, WorkerRequestRegistry } from '../utils/workerRequestRegistry.js';
import { isObjectObservationFresh, MAX_OBJECT_OBSERVATION_AGE_MS } from '../utils/cvScheduling.js';

const loadAnchorWorkerClass = () => import('../cv/anchor.worker.js?worker').then((module) => module.default);
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const scheduleExpiry = (callback, delayMs) => {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
};

export class AnchorWorkerService {
  constructor({
    loadWorkerClass = loadAnchorWorkerClass,
    initializationTimeoutMs = DEFAULT_INITIALIZATION_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    scheduleRequestTimeout,
    now = () => performance.now(),
    scheduleCandidateExpiry = scheduleExpiry,
  } = {}) {
    this.now = now;
    this.scheduleCandidateExpiry = scheduleCandidateExpiry;
    this.cancelCandidateExpiry = null;
    this.runsInWorker = true;
    this.initialized = false;
    this.error = null;
    this.mode = 'selection';
    this.activeAnchor = null;
    this.candidate = null;
    this.nextObservationAt = 0;
    this.anchorState = null;
    this.segmentationRefresh = null;
    this.sampledAt = null;
    this.trackingMode = OBJECT_POSE_MODEL;
    this.worker = null;
    this.workerPromise = null;
    this.loadWorkerClass = loadWorkerClass;
    this.workerGeneration = 0;
    this.workerCancellationReason = 'Anchor worker reset';
    this.initializationPromise = null;
    this.initializationTimeoutMs = assertWorkerRequestTimeout(
      initializationTimeoutMs,
      'Anchor worker initialization timeout',
    );
    this.requestTimeoutMs = assertWorkerRequestTimeout(requestTimeoutMs, 'Anchor worker request timeout');
    this.pendingRequests = new WorkerRequestRegistry({
      scheduleTimeout: scheduleRequestTimeout,
    });
    this.nextRequestId = 1;
    this.minimumStateRequestId = 0;
    this.frameRequestId = null;
    this.frameCapturedAt = null;
    this.frameUpdatesAnchor = false;
    this.listeners = new Set();
  }

  addListener(listener) {
    const callback = typeof listener === 'function' ? listener : listener.onAnchorUpdate.bind(listener);
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  initialize(_cv, viewportWidth, viewportHeight, fov = 63) {
    if (this.initialized) {
      return Promise.resolve();
    }

    if (!this.initializationPromise) {
      const workerGeneration = this.workerGeneration;
      const trackingMode = this.trackingMode;
      const initializationPromise = this._request('initialize', {
        viewportWidth,
        viewportHeight,
        fov,
        trackingMode,
      })
        .then(async (result) => {
          let appliedMode = trackingMode;
          while (workerGeneration === this.workerGeneration && appliedMode !== this.trackingMode) {
            appliedMode = this.trackingMode;
            await this._request('setTrackingMode', { mode: appliedMode });
          }
          return result;
        })
        .catch((error) => {
          if (workerGeneration === this.workerGeneration) {
            this._handleWorkerFailure(error);
          }
          throw error;
        })
        .finally(() => {
          if (this.initializationPromise === initializationPromise) {
            this.initializationPromise = null;
          }
        });
      this.initializationPromise = initializationPromise;
    }

    return this.initializationPromise;
  }

  selectCandidate({ candidateId, tapPosition, capturedAt }) {
    if (!this.initialized || this.mode !== 'selection') {
      return Promise.reject(new Error('Can only select a candidate in initialized selection mode'));
    }
    const candidate = this.getState().candidate;
    if (candidate?.status === 'stale') {
      return Promise.resolve({ success: false, reason: candidate.reason });
    }
    return this._request('selectCandidate', {
      candidateId,
      tapPosition,
      capturedAt,
      timeOrigin: performance.timeOrigin,
    });
  }

  canProcessFrame() {
    return this.initialized && this.frameRequestId === null && this.now() >= this.nextObservationAt;
  }

  processFrame(imageData, { update, refreshSegmentation, depthContext, capturedAt }) {
    if (!this.canProcessFrame()) {
      return {
        success: false,
        reason:
          this.frameRequestId !== null ? 'Observation frame in progress' : 'Observation is not scheduled',
      };
    }
    if (!Number.isFinite(capturedAt) || capturedAt < 0) {
      throw new TypeError('Anchor frame capture timestamp must be finite and non-negative');
    }

    const transfer = prepareImageDataTransfer(imageData);
    if (depthContext?.depthFrame) {
      transfer.transferList.push(depthContext.depthFrame.data.buffer);
    }
    const workerGeneration = this.workerGeneration;
    this.frameRequestId = this.nextRequestId;
    this.frameCapturedAt = capturedAt;
    this.frameUpdatesAnchor = update;
    this._request(
      'processFrame',
      {
        imageData: transfer.imageData,
        update,
        refreshSegmentation,
        depthContext,
        capturedAt,
      },
      transfer.transferList,
    ).catch((error) => {
      if (workerGeneration === this.workerGeneration) {
        this._handleWorkerFailure(error);
      }
    });
    return { success: true, method: 'worker-anchor-frame', pending: true };
  }

  clearAnchor() {
    if (!this.initialized || this.mode !== 'anchor') {
      return;
    }

    this._send('clearAnchor');
  }

  setTrackingMode(mode) {
    if (this.trackingMode === mode) {
      return;
    }

    this.trackingMode = mode;
    this.minimumStateRequestId = this.nextRequestId;
    this.candidate = null;
    this.sampledAt = null;
    this._scheduleCandidateExpiry();
    if (this.initialized && !this.initializationPromise) {
      this._send('setTrackingMode', { mode });
    }
    this._notifyUpdate();
  }

  getState() {
    return {
      mode: this.mode,
      activeAnchor: this.activeAnchor,
      candidate:
        this.candidate && !isObjectObservationFresh(this.candidate.capturedAt, this.now())
          ? {
              ...this.candidate,
              status: 'stale',
              maskPreview: null,
              reason: 'Waiting for fresh tracking. Keep the object in view.',
            }
          : this.candidate,
      nextObservationAt: this.nextObservationAt,
      anchorState: this.anchorState,
      segmentationRefresh: this.segmentationRefresh,
      trackingMode: this.trackingMode,
      initialized: this.initialized,
      error: this.error,
      sampledAt: this.sampledAt,
    };
  }

  reset() {
    this._resetRuntime('Anchor worker reset');
    this._notifyUpdate();
  }

  dispose() {
    this._resetRuntime('Anchor worker disposed');
    this.listeners.clear();
  }

  _resetRuntime(reason) {
    this.cancelCandidateExpiry?.();
    this.cancelCandidateExpiry = null;
    this.workerGeneration++;
    this.workerCancellationReason = reason;
    this.workerPromise = null;
    this.initializationPromise = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.rejectAll(reason);
    this.frameRequestId = null;
    this.frameCapturedAt = null;
    this.frameUpdatesAnchor = false;
    this.initialized = false;
    this.error = null;
    this.mode = 'selection';
    this.activeAnchor = null;
    this.candidate = null;
    this.nextObservationAt = 0;
    this.anchorState = null;
    this.segmentationRefresh = null;
    this.sampledAt = null;
  }

  _getWorker() {
    if (this.workerPromise) {
      return this.workerPromise;
    }

    const workerPromise = this._createWorker(this.workerGeneration);
    this.workerPromise = workerPromise;
    workerPromise.catch(() => {
      if (this.workerPromise === workerPromise) {
        this.workerPromise = null;
      }
    });
    return workerPromise;
  }

  async _createWorker(workerGeneration) {
    const WorkerClass = await this.loadWorkerClass();
    if (workerGeneration !== this.workerGeneration) {
      throw new Error(this.workerCancellationReason);
    }

    const worker = new WorkerClass();
    const isCurrentWorker = () => workerGeneration === this.workerGeneration && worker === this.worker;
    worker.onmessage = (event) => {
      if (isCurrentWorker()) {
        this._handleWorkerMessage(event.data);
      }
    };
    worker.onerror = (error) => {
      if (isCurrentWorker()) {
        this._handleWorkerFailure(error);
      }
    };
    worker.onmessageerror = (error) => {
      if (isCurrentWorker()) {
        this._handleWorkerFailure(error);
      }
    };
    this.worker = worker;
    return worker;
  }

  _request(command, payload = {}, transferables = []) {
    const workerGeneration = this.workerGeneration;
    const id = this.nextRequestId++;
    const timeoutMs = command === 'initialize' ? this.initializationTimeoutMs : this.requestTimeoutMs;
    return this.pendingRequests.start({
      id,
      timeoutMs,
      timeoutMessage: `Anchor worker ${command} timed out after ${timeoutMs}ms`,
      send: async () => {
        const worker = await this._getWorker();
        if (!this.pendingRequests.has(id)) {
          return;
        }
        worker.postMessage({ id, command, payload }, transferables);
      },
      onTimeout: (error) => {
        if (workerGeneration === this.workerGeneration) {
          this._handleWorkerFailure(error);
        }
      },
    });
  }

  _send(command, payload = {}, transferables = []) {
    const workerGeneration = this.workerGeneration;
    this._request(command, payload, transferables).catch((error) => {
      if (workerGeneration === this.workerGeneration) {
        this._handleWorkerFailure(error);
      }
    });
  }

  _handleWorkerMessage(message) {
    if (Object.hasOwn(message, 'error')) {
      const error = new Error(message.error);
      if (this.pendingRequests.reject(message.id, error)) this._handleWorkerFailure(error);
      return;
    }
    const completed = this.pendingRequests.resolve(message.id, message.result);
    if (!completed) {
      return;
    }
    const frameResponse = message.id === this.frameRequestId;
    const sampledAt = frameResponse && this.frameUpdatesAnchor ? this.frameCapturedAt : this.sampledAt;
    if (frameResponse) {
      this.frameRequestId = null;
      this.frameCapturedAt = null;
      this.frameUpdatesAnchor = false;
    }
    if (message.state && message.id >= this.minimumStateRequestId) {
      this._applyState(message.state, sampledAt);
    }
  }

  _applyState(state, sampledAt = this.sampledAt) {
    this.error = null;
    this.mode = state.mode;
    this.activeAnchor = state.activeAnchor;
    this.candidate = state.candidate;
    this.nextObservationAt = state.nextObservationAt;
    this.anchorState = state.anchorState;
    this.segmentationRefresh = state.segmentationRefresh;
    this.initialized = state.initialized;
    this.sampledAt = sampledAt;
    this._scheduleCandidateExpiry();
    this._notifyUpdate();
  }

  _scheduleCandidateExpiry() {
    this.cancelCandidateExpiry?.();
    this.cancelCandidateExpiry = null;
    const now = this.now();
    if (!this.candidate || !isObjectObservationFresh(this.candidate.capturedAt, now)) return;

    this.cancelCandidateExpiry = this.scheduleCandidateExpiry(
      () => {
        this.cancelCandidateExpiry = null;
        this._scheduleCandidateExpiry();
        this._notifyUpdate();
      },
      this.candidate.capturedAt + MAX_OBJECT_OBSERVATION_AGE_MS - now + 1,
    );
  }

  _notifyUpdate() {
    const state = this.getState();
    this.listeners.forEach((listener) => {
      listener(state);
    });
  }

  _handleWorkerFailure(error) {
    const message = error?.message || 'Anchor worker failed';
    logger.error('AnchorWorker', message);
    this._resetRuntime(message);
    this.error = message;
    this._notifyUpdate();
  }
}
