import { logger } from '../utils/logger.js';
import { OBJECT_POSE_MODEL } from '../cv/anchor.reconstructionModes.js';
import { prepareImageDataTransfer } from '../utils/imageDataTransfer.js';
import { assertWorkerRequestTimeout, WorkerRequestRegistry } from '../utils/workerRequestRegistry.js';
import { isObjectObservationFresh, MAX_OBJECT_OBSERVATION_AGE_MS } from '../utils/cvScheduling.js';
import { getTargetScenario } from '../cv/targetScenario.js';

const loadAnchorWorkerClass = () =>
  import('../cv/anchor.worker.js?worker').then(
    (module) => module.default,
    (cause) => {
      const error = new Error(
        `Tracking code could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
      error.requiresReload = true;
      throw error;
    },
  );
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const OBSERVATIONS_PAUSED_REASON = 'Camera observations are paused while the page is hidden';
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
    scheduleObservationExpiry = scheduleExpiry,
    logging = logger,
  } = {}) {
    this.now = now;
    this.scheduleObservationExpiry = scheduleObservationExpiry;
    this.cancelObservationExpiry = null;
    this.runsInWorker = true;
    this.initialized = false;
    this.error = null;
    this.requiresReload = false;
    this.mode = 'selection';
    this.activeAnchor = null;
    this.candidate = null;
    this.discoveryReason = null;
    this.nextObservationAt = 0;
    this.anchorState = null;
    this.segmentationRefresh = null;
    this.sampledAt = null;
    this.observationsActive = true;
    this.minimumObservationAt = 0;
    this.minimumObservationRequestId = 0;
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
    this.logging = logging;
    this.logTagsSignature = JSON.stringify(logging.getEnabledTags());
    this.removeLogListener = logging.addListener((_allTags, tags) => {
      const signature = JSON.stringify(tags);
      if (signature === this.logTagsSignature) return;
      this.logTagsSignature = signature;
      if (this.initialized) this._send('configureLogging', { tags });
    });
  }

  addListener(listener) {
    const callback = typeof listener === 'function' ? listener : listener.onAnchorUpdate.bind(listener);
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  initialize(_cv, viewportWidth, viewportHeight, fov = 63, targetScenario = 'general') {
    getTargetScenario(targetScenario);
    if (this.initialized) {
      return Promise.resolve();
    }

    if (!this.initializationPromise) {
      const workerGeneration = this.workerGeneration;
      const trackingMode = this.trackingMode;
      const logTags = this.logging.getEnabledTags();
      const initializationPromise = this._request('initialize', {
        viewportWidth,
        viewportHeight,
        fov,
        trackingMode,
        targetScenario,
        logTags,
      })
        .then(async (result) => {
          let appliedMode = trackingMode;
          while (workerGeneration === this.workerGeneration && appliedMode !== this.trackingMode) {
            appliedMode = this.trackingMode;
            await this._request('setTrackingMode', { mode: appliedMode });
          }
          if (
            workerGeneration === this.workerGeneration &&
            JSON.stringify(logTags) !== JSON.stringify(this.logging.getEnabledTags())
          ) {
            await this._request('configureLogging', { tags: this.logging.getEnabledTags() });
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
    if (!this.observationsActive) {
      return Promise.resolve({ success: false, reason: OBSERVATIONS_PAUSED_REASON });
    }
    if (!this.initialized || this.mode !== 'selection') {
      return Promise.reject(new Error('Can only select a candidate in initialized selection mode'));
    }
    const candidate = this.getState().candidate;
    if (candidate?.status === 'stale') {
      return Promise.resolve({ success: false, reason: candidate.reason });
    }
    if (candidate?.id !== candidateId || candidate.status !== 'ready') {
      return Promise.resolve({ success: false, reason: 'Wait for fresh object tracking before selecting' });
    }
    return this._request('selectCandidate', {
      candidateId,
      tapPosition,
      capturedAt,
      timeOrigin: performance.timeOrigin,
    });
  }

  canProcessFrame() {
    return (
      this.observationsActive &&
      this.initialized &&
      this.frameRequestId === null &&
      this.now() >= this.nextObservationAt
    );
  }

  setObservationsActive(active) {
    if (this.observationsActive === active) return;
    this.observationsActive = active;
    this.minimumObservationAt = this.now();
    this.minimumObservationRequestId = this.nextRequestId;
    this.sampledAt = null;
    this.candidate = null;
    this.nextObservationAt = 0;
    this._scheduleObservationExpiry();
    this._notifyUpdate();
  }

  processFrame(imageData, { update, refreshSegmentation, depthContext, capturedAt }) {
    if (!this.canProcessFrame()) {
      return {
        success: false,
        reason: !this.observationsActive
          ? OBSERVATIONS_PAUSED_REASON
          : this.frameRequestId !== null
            ? 'Observation frame in progress'
            : 'Observation is not scheduled',
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
    this._scheduleObservationExpiry();
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
      discoveryReason: this.discoveryReason,
      anchorState: this.anchorState,
      segmentationRefresh: this.segmentationRefresh,
      trackingMode: this.trackingMode,
      initialized: this.initialized,
      error: this.error,
      requiresReload: this.requiresReload,
      sampledAt: this.sampledAt,
      observationExpired: this.mode === 'anchor' && !isObjectObservationFresh(this.sampledAt, this.now()),
    };
  }

  reset() {
    this._resetRuntime('Anchor worker reset');
    this._notifyUpdate();
  }

  dispose() {
    this.removeLogListener();
    this._resetRuntime('Anchor worker disposed');
    this.listeners.clear();
  }

  _resetRuntime(reason) {
    this.cancelObservationExpiry?.();
    this.cancelObservationExpiry = null;
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
    this.requiresReload = false;
    this.mode = 'selection';
    this.activeAnchor = null;
    this.candidate = null;
    this.discoveryReason = null;
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
      this._applyState(message.state, sampledAt, message.id >= this.minimumObservationRequestId);
    }
  }

  _applyState(state, sampledAt = this.sampledAt, observationAllowed = true) {
    const admitObservation = this.observationsActive && observationAllowed;
    this.error = null;
    this.mode = state.mode;
    this.activeAnchor = state.activeAnchor;
    this.candidate =
      admitObservation && state.candidate?.capturedAt >= this.minimumObservationAt ? state.candidate : null;
    this.nextObservationAt = state.nextObservationAt;
    this.discoveryReason = state.discoveryReason ?? null;
    this.anchorState = state.anchorState;
    this.segmentationRefresh = state.segmentationRefresh;
    this.initialized = state.initialized;
    this.sampledAt =
      admitObservation && sampledAt !== null && sampledAt >= this.minimumObservationAt ? sampledAt : null;
    this._scheduleObservationExpiry();
    this._notifyUpdate();
  }

  _scheduleObservationExpiry() {
    this.cancelObservationExpiry?.();
    this.cancelObservationExpiry = null;
    const now = this.now();
    const capturedAt = this.mode === 'anchor' ? this.sampledAt : this.candidate?.capturedAt;
    if (!isObjectObservationFresh(capturedAt, now)) return;

    this.cancelObservationExpiry = this.scheduleObservationExpiry(
      () => {
        this.cancelObservationExpiry = null;
        this._scheduleObservationExpiry();
        this._notifyUpdate();
      },
      capturedAt + MAX_OBJECT_OBSERVATION_AGE_MS - now + 1,
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
    this.logging.error('AnchorWorker', message);
    this._resetRuntime(message);
    this.error = message;
    this.requiresReload = error?.requiresReload === true;
    this._notifyUpdate();
  }
}
