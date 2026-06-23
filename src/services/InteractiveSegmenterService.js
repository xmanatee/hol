export class InteractiveSegmenterService {
  constructor({ WorkerClass = null, requestTimeoutMs = 6000 } = {}) {
    this.WorkerClass = WorkerClass;
    this.requestTimeoutMs = requestTimeoutMs;
    this.worker = null;
    this.workerPromise = null;
    this.workerGeneration = 0;
    this.pendingRequests = new Map();
    this.nextRequestId = 1;
  }

  segmentTap({ imageData, tapPosition, createdAtFrame, maxRadius = null, timeoutMs = this.requestTimeoutMs }) {
    const requestId = this.nextRequestId++;
    const copiedImageData = {
      width: imageData.width,
      height: imageData.height,
      data: new Uint8ClampedArray(imageData.data),
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!this.pendingRequests.has(requestId)) {
          return;
        }

        this._handleWorkerError(`Interactive segmenter request timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });
      this._getWorker().then(worker => {
        if (!this.pendingRequests.has(requestId)) {
          return;
        }

        worker.postMessage({
          type: 'segment',
          requestId,
          imageData: copiedImageData,
          tapPosition: { ...tapPosition },
          createdAtFrame,
          maxRadius,
        }, [copiedImageData.data.buffer]);
      }, error => {
        if (this.pendingRequests.has(requestId)) {
          this._rejectRequest(requestId, error);
        }
      });
    });
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.workerGeneration++;
    this.workerPromise = null;

    this._rejectAll('Interactive segmenter disposed');
  }

  async _getWorker() {
    if (this.worker) {
      return this.worker;
    }

    if (this.workerPromise) {
      return this.workerPromise;
    }

    this.workerPromise = this._createWorker(this.workerGeneration);
    return this.workerPromise;
  }

  async _createWorker(workerGeneration) {
    const WorkerClass = this.WorkerClass || (await import('../cv/interactiveSegmenter.worker.js?worker')).default;
    if (workerGeneration !== this.workerGeneration) {
      throw new Error('Interactive segmenter disposed');
    }

    this.worker = new WorkerClass();
    this.worker.onmessage = event => this._handleMessage(event.data);
    this.worker.onerror = error => this._handleWorkerError(error.message || 'Interactive segmenter worker failed');
    return this.worker;
  }

  _handleMessage(message) {
    const request = this.pendingRequests.get(message.requestId);
    if (!request) {
      return;
    }

    this.pendingRequests.delete(message.requestId);
    clearTimeout(request.timeoutId);

    if (message.type === 'segment-result') {
      request.resolve(message.objectSupportMask);
    } else {
      request.reject(new Error(message.reason));
    }
  }

  _handleWorkerError(reason) {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.workerGeneration++;
    this.workerPromise = null;
    this._rejectAll(reason);
  }

  _rejectAll(reason) {
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timeoutId);
      request.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  _rejectRequest(requestId, error) {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      return;
    }

    this.pendingRequests.delete(requestId);
    clearTimeout(request.timeoutId);
    request.reject(error);
  }
}
