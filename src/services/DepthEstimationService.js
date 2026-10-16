import { DEPTH_MODEL_DEFAULT_INPUT_SIZE } from '../cv/depthModelPreprocess.js';
import { prepareImageDataTransfer } from '../utils/imageDataTransfer.js';
import { assertWorkerRequestTimeout, WorkerRequestRegistry } from '../utils/workerRequestRegistry.js';
import { DEPTH_ANYTHING_ASSET_URL } from '../runtime/capabilityPacks.js';

export class DepthEstimationService {
  constructor({
    modelUrl = DEPTH_ANYTHING_ASSET_URL,
    inputSize = DEPTH_MODEL_DEFAULT_INPUT_SIZE,
    intervalMs = 260,
    initializeTimeoutMs = 90_000,
    requestTimeoutMs = 10_000,
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
    this.lastRequestAt = -Infinity;
    this.nextRequestId = 1;
    this.pending = new WorkerRequestRegistry({ scheduleTimeout: scheduleRequestTimeout });
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return { ...this.status };
  }

  initialize() {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    const generation = this.workerGeneration;
    const initializePromise = this._request(
      'initialize',
      { modelUrl: this.modelUrl, inputSize: this.inputSize },
      [],
      this.initializeTimeoutMs,
    ).then((result) => {
      this._assertGeneration(generation);
      this._setStatus({ ...result, state: 'ready', error: null });
      this._assertGeneration(generation);
      return this.getState();
    });
    this.initializePromise = initializePromise;
    this._setStatus({ state: 'loading', error: null });
    return initializePromise;
  }

  estimate(imageData, { timestamp = this.now(), force = false } = {}) {
    if (!this.shouldEstimate({ force })) {
      return Promise.resolve(null);
    }

    const transfer = prepareImageDataTransfer(imageData);
    const generation = this.workerGeneration;
    this.lastRequestAt = this.now();
    return this._request(
      'estimate',
      { imageData: transfer.imageData, timestamp },
      transfer.transferList,
      this.requestTimeoutMs,
    ).then((frame) => {
      this._assertGeneration(generation);
      this._setStatus({
        processingTime: frame.processingTime,
        lastFrameAt: this.now(),
        error: null,
      });
      this._assertGeneration(generation);
      return frame;
    });
  }

  shouldEstimate({ force = false } = {}) {
    return (
      this.status.state === 'ready' &&
      this.pending.size === 0 &&
      (force || this.now() - this.lastRequestAt >= this.intervalMs)
    );
  }

  dispose() {
    this._resetRuntime('idle', null);
  }

  _getWorker() {
    if (this.worker) {
      return this.worker;
    }

    const generation = this.workerGeneration;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.onmessage = ({ data: message }) => {
      if (generation !== this.workerGeneration) {
        return;
      }
      if (Object.hasOwn(message, 'error')) {
        this.pending.reject(message.id, new Error(message.error));
      } else {
        this.pending.resolve(message.id, message.result);
      }
    };
    worker.onerror = (event) => {
      this._handleWorkerFailure(event.message ?? 'Depth worker failed', generation);
    };
    worker.onmessageerror = (event) => {
      this._handleWorkerFailure(
        event.message ?? 'Depth worker message could not be deserialized',
        generation,
      );
    };
    return worker;
  }

  _request(command, payload, transferables, timeoutMs) {
    const generation = this.workerGeneration;
    const id = this.nextRequestId++;
    return this.pending
      .start({
        id,
        timeoutMs,
        timeoutMessage: `Depth worker ${command} timed out after ${timeoutMs}ms`,
        send: () => this._getWorker().postMessage({ id, command, payload }, transferables),
        onTimeout: (error) => this._handleWorkerFailure(error.message, generation),
      })
      .catch((error) => {
        this._handleWorkerFailure(error.message, generation);
        throw error;
      });
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((listener) => {
      listener(this.getState());
    });
  }

  _assertGeneration(generation) {
    if (generation !== this.workerGeneration) {
      throw new Error('Depth worker request superseded');
    }
  }

  _handleWorkerFailure(message, generation) {
    if (generation === this.workerGeneration) {
      this._resetRuntime('error', message);
    }
  }

  _resetRuntime(state, error) {
    this.workerGeneration++;
    this.worker?.terminate();
    this.worker = null;
    this.pending.rejectAll(error ?? 'Depth estimation service disposed');
    this.initializePromise = null;
    this.lastRequestAt = -Infinity;
    this._setStatus({ state, error, provider: null, processingTime: 0, lastFrameAt: 0 });
  }
}
