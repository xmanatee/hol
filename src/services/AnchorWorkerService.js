import { logger } from '../utils/logger.js';
import { copyImageData, prepareImageDataTransfer } from '../utils/imageDataTransfer.js';
import { assertWorkerRequestTimeout, WorkerRequestRegistry } from '../utils/workerRequestRegistry.js';

const loadAnchorWorkerClass = () => import('../cv/anchor.worker.js?worker').then((module) => module.default);
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

export class AnchorWorkerService {
  constructor({
    loadWorkerClass = loadAnchorWorkerClass,
    initializationTimeoutMs = DEFAULT_INITIALIZATION_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    scheduleRequestTimeout,
  } = {}) {
    this.runsInWorker = true;
    this.initialized = false;
    this.mode = 'selection';
    this.activeAnchor = null;
    this.anchorState = null;
    this.sampledAt = null;
    this.trackingMode = 'sparse-reconstruction';
    this.worker = null;
    this.workerPromise = null;
    this.workerClassPromise = null;
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
    this.frameInFlight = false;
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
      const initializationPromise = this._request('initialize', {
        viewportWidth,
        viewportHeight,
        fov,
        trackingMode: this.trackingMode,
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

  async createAnchorFromTap(tapPosition, imageData) {
    if (!this.initialized || this.mode !== 'selection') {
      throw new Error('Can only create an anchor in selection mode');
    }

    const copied = copyImageData(imageData);
    const transfer = prepareImageDataTransfer(copied);
    const result = await this._request(
      'createAnchorFromTap',
      { tapPosition, imageData: transfer.imageData },
      transfer.transferList,
    );
    return result;
  }

  canProcessFrame() {
    return this.initialized && this.mode === 'anchor' && !this.frameInFlight;
  }

  processFrame(imageData, { update, refreshSegmentation, depthContext, capturedAt }) {
    if (!this.canProcessFrame()) {
      return {
        success: false,
        reason: this.frameInFlight ? 'Anchor frame in progress' : 'Not in anchor mode',
      };
    }
    if (!Number.isFinite(capturedAt) || capturedAt < 0) {
      throw new TypeError('Anchor frame capture timestamp must be finite and non-negative');
    }

    const transfer = prepareImageDataTransfer(imageData);
    this.frameInFlight = true;
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
      },
      transfer.transferList,
    )
      .then(
        () => {},
        (error) => this._handleWorkerRequestError(error),
      )
      .finally(() => {
        this.frameInFlight = false;
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
    if (this.initialized) {
      this._send('setTrackingMode', { mode });
    }
    this._notifyUpdate();
  }

  getState() {
    return {
      mode: this.mode,
      activeAnchor: this.activeAnchor,
      anchorState: this.anchorState,
      trackingMode: this.trackingMode,
      initialized: this.initialized,
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
    this.workerGeneration++;
    this.workerCancellationReason = reason;
    this.workerPromise = null;
    this.initializationPromise = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.rejectAll(reason);
    this.frameInFlight = false;
    this.frameRequestId = null;
    this.frameCapturedAt = null;
    this.frameUpdatesAnchor = false;
    this.initialized = false;
    this.mode = 'selection';
    this.activeAnchor = null;
    this.anchorState = null;
    this.sampledAt = null;
  }

  _getWorkerClass() {
    if (!this.workerClassPromise) {
      const workerClassPromise = this.loadWorkerClass();
      this.workerClassPromise = workerClassPromise;
      workerClassPromise.catch(() => {
        if (this.workerClassPromise === workerClassPromise) {
          this.workerClassPromise = null;
        }
      });
    }
    return this.workerClassPromise;
  }

  _getWorker() {
    if (this.worker) {
      return this.worker;
    }

    if (this.workerPromise) {
      return this.workerPromise;
    }

    const workerPromise = this._createWorker(this.workerGeneration);
    this.workerPromise = workerPromise;
    workerPromise.then(
      () => {},
      () => {
        if (this.workerPromise === workerPromise) {
          this.workerPromise = null;
        }
      },
    );
    return workerPromise;
  }

  async _createWorker(workerGeneration) {
    const WorkerClass = await this._getWorkerClass();
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
      send: () => {
        const posting = Promise.resolve(this._getWorker()).then((worker) => {
          if (!this.pendingRequests.has(id)) {
            return;
          }
          if (workerGeneration !== this.workerGeneration || worker !== this.worker) {
            throw new Error(this.workerCancellationReason);
          }
          worker.postMessage({ id, command, payload }, transferables);
        });
        posting.then(
          () => {},
          (error) => this.pendingRequests.reject(id, error),
        );
      },
      onTimeout: (error) => {
        if (workerGeneration === this.workerGeneration) {
          this._handleWorkerFailure(error);
        }
      },
    });
  }

  _send(command, payload = {}, transferables = []) {
    this._request(command, payload, transferables).then(
      () => {},
      (error) => this._handleWorkerRequestError(error),
    );
  }

  _handleWorkerRequestError(error) {
    if (
      error?.name === 'TimeoutError' ||
      error?.message === 'Anchor worker disposed' ||
      error?.message === 'Anchor worker reset'
    ) {
      return;
    }

    this._handleWorkerFailure(error);
  }

  _handleWorkerMessage(message) {
    const frameResponse = message.id === this.frameRequestId;
    if (message.state) {
      this._applyState(
        message.state,
        frameResponse && this.frameUpdatesAnchor ? this.frameCapturedAt : this.sampledAt,
      );
    }
    if (frameResponse) {
      this.frameRequestId = null;
      this.frameCapturedAt = null;
      this.frameUpdatesAnchor = false;
    }

    if (message.error) {
      this.pendingRequests.reject(message.id, new Error(message.error));
      return;
    }

    this.pendingRequests.resolve(message.id, message.result);
  }

  _applyState(state, sampledAt = this.sampledAt) {
    this.mode = state.mode;
    this.activeAnchor = state.activeAnchor;
    this.anchorState = state.anchorState;
    this.trackingMode = state.trackingMode;
    this.initialized = state.initialized;
    this.sampledAt = sampledAt;
    this._notifyUpdate();
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
    this._notifyUpdate();
  }
}
