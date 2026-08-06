import { assertWorkerRequestTimeout, WorkerRequestRegistry } from '../utils/workerRequestRegistry.js';

const DEFAULT_REFERENCE_TIMEOUT_MS = 60_000;
const DEFAULT_RELOCALIZATION_TIMEOUT_MS = 10_000;

export class XFeatWorkerRelocalizer {
  constructor({
    createWorker,
    referenceTimeoutMs = DEFAULT_REFERENCE_TIMEOUT_MS,
    relocalizationTimeoutMs = DEFAULT_RELOCALIZATION_TIMEOUT_MS,
    scheduleRequestTimeout,
  }) {
    if (typeof createWorker !== 'function') {
      throw new TypeError('XFeat createWorker required');
    }
    this.createWorker = createWorker;
    this.referenceTimeoutMs = assertWorkerRequestTimeout(referenceTimeoutMs, 'XFeat timeout');
    this.relocalizationTimeoutMs = assertWorkerRequestTimeout(relocalizationTimeoutMs, 'XFeat timeout');
    this.worker = null;
    this.workerGeneration = 0;
    this.pendingRequests = new WorkerRequestRegistry({
      scheduleTimeout: scheduleRequestTimeout,
    });
    this.nextRequestId = 1;
    this.referenceEpoch = 0;
    this.referenceReady = false;
    this.disposed = false;
  }

  hasReference() {
    return this.referenceReady;
  }

  async storeReference(reference) {
    const epoch = ++this.referenceEpoch;
    const result = await this._request(
      'storeReference',
      reference,
      [reference.imageData.data.buffer],
      this.referenceTimeoutMs,
    );
    if (epoch !== this.referenceEpoch) {
      return { success: false, descriptorCount: 0, reason: 'Learned reference storage superseded' };
    }
    this.referenceReady ||= result.success;
    return result;
  }

  relocalize(imageData) {
    if (this.disposed) {
      return Promise.reject(new Error('XFeat worker disposed'));
    }
    if (!this.referenceReady) {
      return Promise.resolve({ success: false, reason: 'No XFeat reference available' });
    }
    const workerImageData = {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data.slice(),
    };
    return this._request(
      'relocalize',
      { imageData: workerImageData },
      [workerImageData.data.buffer],
      this.relocalizationTimeoutMs,
    );
  }

  clear() {
    this.referenceEpoch++;
    this.referenceReady = false;
    if (this.worker) {
      this.worker.postMessage({ id: null, command: 'clear', payload: null });
    }
  }

  dispose() {
    this.referenceEpoch++;
    this.referenceReady = false;
    this.disposed = true;
    this.pendingRequests.rejectAll('XFeat worker disposed');
    this._retireWorker();
  }

  _getWorker() {
    if (!this.worker) {
      const workerGeneration = this.workerGeneration;
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = (event) => {
        if (this._ownsWorker(worker, workerGeneration)) {
          this._handleMessage(event.data);
        }
      };
      worker.onerror = (error) => this._handleFailure(error, worker, workerGeneration);
      worker.onmessageerror = (error) => this._handleFailure(error, worker, workerGeneration);
    }
    return this.worker;
  }

  _request(command, payload, transferables, timeoutMs) {
    if (this.disposed) {
      return Promise.reject(new Error('XFeat worker disposed'));
    }
    const worker = this._getWorker();
    const workerGeneration = this.workerGeneration;
    const id = this.nextRequestId++;
    return this.pendingRequests.start({
      id,
      timeoutMs,
      timeoutMessage: `XFeat ${command} timed out after ${timeoutMs}ms`,
      send: () => worker.postMessage({ id, command, payload }, transferables),
      onTimeout: (error) => this._handleFailure(error, worker, workerGeneration),
    });
  }

  _handleMessage(message) {
    if (message.error) {
      this.pendingRequests.reject(message.id, new Error(message.error));
    } else {
      this.pendingRequests.resolve(message.id, message.result);
    }
  }

  _handleFailure(error, worker, workerGeneration) {
    if (!this._ownsWorker(worker, workerGeneration)) {
      return;
    }

    const message = error?.message || 'XFeat worker failed';
    this.referenceReady = false;
    this.pendingRequests.rejectAll(message);
    this._retireWorker();
  }

  _ownsWorker(worker, workerGeneration) {
    return worker === this.worker && workerGeneration === this.workerGeneration;
  }

  _retireWorker() {
    const worker = this.worker;
    this.worker = null;
    this.workerGeneration++;
    worker?.terminate();
  }
}
