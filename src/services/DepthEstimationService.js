import { DEPTH_MODEL_DEFAULT_INPUT_SIZE } from '../cv/depthModelPreprocess.js';
import { logger } from '../utils/logger.js';

const DEFAULT_MODEL_URL = '/models/depth_anything_v2_small.onnx';
const DEFAULT_INTERVAL_MS = 260;

const cloneImageDataForWorker = imageData => ({
  width: imageData.width,
  height: imageData.height,
  data: new Uint8ClampedArray(imageData.data),
});

const disposeWorker = worker => {
  if (worker) {
    worker.terminate();
  }
};

export class DepthEstimationService {
  constructor({
    modelUrl = DEFAULT_MODEL_URL,
    inputSize = DEPTH_MODEL_DEFAULT_INPUT_SIZE,
    intervalMs = DEFAULT_INTERVAL_MS,
    workerFactory = () => new Worker(new URL('../cv/depth.worker.js', import.meta.url), { type: 'module' }),
    now = () => performance.now(),
  } = {}) {
    this.modelUrl = modelUrl;
    this.inputSize = inputSize;
    this.intervalMs = intervalMs;
    this.workerFactory = workerFactory;
    this.now = now;
    this.worker = null;
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
    this.inFlight = false;
    this.lastRequestAt = 0;
    this.requestId = 0;
    this.pending = new Map();
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

    this.worker = this.workerFactory();
    this.worker.onmessage = event => this._handleWorkerMessage(event.data);
    this.worker.onerror = event => {
      const message = event.message ?? 'Depth worker failed';
      this._rejectPending(message);
      this.initializePromise = null;
      this.inFlight = false;
      disposeWorker(this.worker);
      this.worker = null;
      this._setStatus({
        state: 'error',
        error: message,
      });
    };
    this._setStatus({ state: 'loading', error: null });
    this.initializePromise = new Promise((resolve, reject) => {
      this.pending.set('initialize', { resolve, reject });
      this.worker.postMessage({
        type: 'initialize',
        config: {
          modelUrl: this.modelUrl,
          inputSize: this.inputSize,
        },
      });
    });

    return this.initializePromise;
  }

  estimate(imageData, { timestamp = this.now(), force = false } = {}) {
    if (this.status.state !== 'ready') {
      return Promise.resolve(null);
    }

    const now = this.now();
    if (this.inFlight || (!force && now - this.lastRequestAt < this.intervalMs)) {
      return Promise.resolve(this.latestFrame);
    }

    this.inFlight = true;
    this.lastRequestAt = now;
    const requestId = ++this.requestId;
    const workerImageData = cloneImageDataForWorker(imageData);

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({
        type: 'estimate',
        requestId,
        timestamp,
        imageData: workerImageData,
      }, [workerImageData.data.buffer]);
    });
  }

  dispose() {
    this._rejectPending('Depth estimation service disposed');
    disposeWorker(this.worker);
    this.worker = null;
    this.initializePromise = null;
    this.inFlight = false;
    this._setStatus({ state: 'idle' });
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
      const pending = this.pending.get('initialize');
      this.pending.delete('initialize');
      pending?.resolve(this.getState());
      return;
    }

    if (message.type === 'depth') {
      this.inFlight = false;
      this.latestFrame = {
        width: message.width,
        height: message.height,
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
      const pending = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      pending?.resolve(this.latestFrame);
      return;
    }

    if (message.type === 'error') {
      this.inFlight = false;
      const pending = this.pending.get(message.requestId || 'initialize');
      this.pending.delete(message.requestId || 'initialize');
      if (message.stage === 'initialize') {
        this.initializePromise = null;
        disposeWorker(this.worker);
        this.worker = null;
      }
      this._setStatus({
        state: message.stage === 'initialize' ? 'error' : this.status.state,
        error: message.message,
      });
      logger.warn('DepthEstimation', `${message.stage}: ${message.message}`);
      pending?.reject(new Error(message.message));
    }
  }

  _setStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
    };
    this.listeners.forEach(listener => listener(this.getState()));
  }

  _rejectPending(message) {
    this.pending.forEach(pending => {
      pending.reject(new Error(message));
    });
    this.pending.clear();
  }
}
