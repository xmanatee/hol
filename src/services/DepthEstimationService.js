import { DEPTH_MODEL_DEFAULT_INPUT_SIZE } from '../cv/depthModelPreprocess.js';
import { logger } from '../utils/logger.js';
import { prepareImageDataTransfer } from '../utils/imageDataTransfer.js';
import { assertWorkerRequestTimeout, WorkerRequestRegistry } from '../utils/workerRequestRegistry.js';
import { DEPTH_ANYTHING_ASSET_URL } from '../runtime/capabilityPacks.js';

const DEFAULT_MODEL_URL = DEPTH_ANYTHING_ASSET_URL;
const DEFAULT_INTERVAL_MS = 260;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 90_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const disposeWorker = (worker) => {
  if (worker) {
    worker.terminate();
  }
};

export class DepthEstimationService {
  constructor({
    modelUrl = DEFAULT_MODEL_URL,
    inputSize = DEPTH_MODEL_DEFAULT_INPUT_SIZE,
    intervalMs = DEFAULT_INTERVAL_MS,
    initializeTimeoutMs = DEFAULT_INITIALIZATION_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    workerFactory = () => new Worker(new URL('../cv/depth.worker.js', import.meta.url), { type: 'module' }),
    now = () => performance.now(),
    scheduleRequestTimeout,
  } = {}) {
    this.modelUrl = modelUrl;
    this.inputSize = inputSize;
    this.intervalMs = intervalMs;
    this.workerFactory = workerFactory;
    this.now = now;
    this.worker = null;
    this.workerGeneration = 0;
    this.listeners = new Set();
    this.status = {
      state: 'idle',
      modelUrl,
      inputSize,
      provider: null,
      error: null,
      processingTime: 0,
      lastFrameAt: 0,
    };
    this.initializePromise = null;
    this.initializeTimeoutMs = assertWorkerRequestTimeout(
      initializeTimeoutMs,
      'Depth worker initialization timeout',
    );
    this.requestTimeoutMs = assertWorkerRequestTimeout(requestTimeoutMs, 'Depth worker request timeout');
    this.inFlight = false;
    this.lastRequestAt = 0;
    this.requestId = 0;
    this.pending = new WorkerRequestRegistry({ scheduleTimeout: scheduleRequestTimeout });
    this.latestFrame = null;
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return { ...this.status };
  }

  getLatestFrame() {
    return this.latestFrame;
  }

  initialize() {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    const workerGeneration = this.workerGeneration;
    const worker = this.workerFactory();
    this.worker = worker;
    const isCurrentWorker = () => this._ownsWorker(worker, workerGeneration);
    worker.onmessage = (event) => {
      if (isCurrentWorker()) {
        this._handleWorkerMessage(event.data);
      }
    };
    worker.onerror = (event) => {
      if (isCurrentWorker()) {
        this._handleWorkerFailure(event.message ?? 'Depth worker failed');
      }
    };
    worker.onmessageerror = (event) => {
      if (isCurrentWorker()) {
        this._handleWorkerFailure(event.message ?? 'Depth worker message could not be deserialized');
      }
    };
    this.inFlight = false;
    this.latestFrame = null;
    this._setStatus({
      state: 'loading',
      provider: null,
      error: null,
      processingTime: 0,
      lastFrameAt: 0,
    });
    const initializePromise = this.pending.start({
      id: 'initialize',
      timeoutMs: this.initializeTimeoutMs,
      timeoutMessage: `Depth worker initialize timed out after ${this.initializeTimeoutMs}ms`,
      send: () => {
        worker.postMessage({
          type: 'initialize',
          config: {
            modelUrl: this.modelUrl,
            inputSize: this.inputSize,
          },
        });
      },
      onTimeout: (error) => {
        if (isCurrentWorker()) {
          this._handleWorkerFailure(error.message);
        }
      },
    });
    this.initializePromise = initializePromise;
    initializePromise.then(
      () => {},
      (error) => {
        if (this.initializePromise !== initializePromise || !isCurrentWorker()) {
          return;
        }

        this.initializePromise = null;
        this._retireWorker();
        this._setStatus({
          state: 'error',
          provider: null,
          error: error.message,
          processingTime: 0,
          lastFrameAt: 0,
        });
      },
    );

    return this.initializePromise;
  }

  estimate(imageData, { timestamp = this.now(), force = false } = {}) {
    if (this.status.state !== 'ready') {
      return Promise.resolve(null);
    }

    if (!this.shouldEstimate({ force })) {
      return Promise.resolve(this.latestFrame);
    }

    const now = this.now();
    const requestId = ++this.requestId;
    const transfer = prepareImageDataTransfer(imageData);
    const worker = this.worker;
    const workerGeneration = this.workerGeneration;
    let posted = false;

    const estimatePromise = this.pending.start({
      id: requestId,
      timeoutMs: this.requestTimeoutMs,
      timeoutMessage: `Depth worker estimate timed out after ${this.requestTimeoutMs}ms`,
      send: () => {
        worker.postMessage(
          {
            type: 'estimate',
            requestId,
            timestamp,
            imageData: transfer.imageData,
          },
          transfer.transferList,
        );
        posted = true;
      },
      onTimeout: (error) => {
        if (this._ownsWorker(worker, workerGeneration)) {
          this._handleWorkerFailure(error.message);
        }
      },
    });
    if (posted) {
      this.inFlight = true;
      this.lastRequestAt = now;
    }
    estimatePromise.then(
      () => {},
      (error) => {
        if (posted || !this._ownsWorker(worker, workerGeneration)) {
          return;
        }

        this.inFlight = false;
        this._setStatus({ error: error.message });
      },
    );
    return estimatePromise;
  }

  shouldEstimate({ force = false } = {}) {
    if (this.status.state !== 'ready' || this.inFlight) {
      return false;
    }

    return force || this.now() - this.lastRequestAt >= this.intervalMs;
  }

  dispose() {
    this.pending.rejectAll('Depth estimation service disposed');
    this.initializePromise = null;
    this._retireWorker();
    this.inFlight = false;
    this.latestFrame = null;
    this.lastRequestAt = 0;
    this._setStatus({
      state: 'idle',
      provider: null,
      error: null,
      processingTime: 0,
      lastFrameAt: 0,
    });
  }

  _handleWorkerMessage(message) {
    if (message.type === 'initialized') {
      this._setStatus({
        state: 'ready',
        provider: message.provider,
        modelUrl: message.modelUrl,
        inputSize: message.inputSize,
        error: null,
      });
      this.pending.resolve('initialize', this.getState());
      return;
    }

    if (message.type === 'depth') {
      this.inFlight = false;
      this.latestFrame = {
        width: message.width,
        height: message.height,
        sourceWidth: message.sourceWidth,
        sourceHeight: message.sourceHeight,
        data: message.data,
        timestamp: message.timestamp,
        processingTime: message.processingTime,
        provider: message.provider,
        modelUrl: message.modelUrl,
      };
      this._setStatus({
        processingTime: message.processingTime,
        lastFrameAt: this.now(),
        provider: message.provider,
        error: null,
      });
      this.pending.resolve(message.requestId, this.latestFrame);
      return;
    }

    if (message.type === 'error') {
      this.inFlight = false;
      const requestId = message.requestId || 'initialize';
      if (message.stage === 'initialize') {
        this.initializePromise = null;
        this.latestFrame = null;
        this._retireWorker();
      }
      this._setStatus({
        state: message.stage === 'initialize' ? 'error' : this.status.state,
        provider: message.stage === 'initialize' ? null : this.status.provider,
        processingTime: message.stage === 'initialize' ? 0 : this.status.processingTime,
        lastFrameAt: message.stage === 'initialize' ? 0 : this.status.lastFrameAt,
        error: message.message,
      });
      logger.warn('DepthEstimation', `${message.stage}: ${message.message}`);
      this.pending.reject(requestId, new Error(message.message));
    }
  }

  _setStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
    };
    this.listeners.forEach((listener) => {
      listener(this.getState());
    });
  }

  _handleWorkerFailure(message) {
    this.pending.rejectAll(message);
    this.initializePromise = null;
    this.inFlight = false;
    this.latestFrame = null;
    this._retireWorker();
    this._setStatus({
      state: 'error',
      provider: null,
      error: message,
      processingTime: 0,
      lastFrameAt: 0,
    });
  }

  _ownsWorker(worker, workerGeneration) {
    return worker === this.worker && workerGeneration === this.workerGeneration;
  }

  _retireWorker() {
    const worker = this.worker;
    this.worker = null;
    this.workerGeneration++;
    disposeWorker(worker);
  }
}
