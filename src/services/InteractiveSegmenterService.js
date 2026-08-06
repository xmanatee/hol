import { copyImageData } from '../utils/imageDataTransfer.js';
import { assertWorkerRequestTimeout, WorkerRequestRegistry } from '../utils/workerRequestRegistry.js';

export class InteractiveSegmenterService {
  constructor({ WorkerClass = null, requestTimeoutMs = 6000, scheduleRequestTimeout } = {}) {
    this.WorkerClass = WorkerClass;
    this.requestTimeoutMs = assertWorkerRequestTimeout(
      requestTimeoutMs,
      'Interactive segmenter request timeout',
    );
    this.worker = null;
    this.workerPromise = null;
    this.workerGeneration = 0;
    this.pendingRequests = new WorkerRequestRegistry({
      scheduleTimeout: scheduleRequestTimeout,
    });
    this.nextRequestId = 1;
  }

  segmentTap({
    imageData,
    tapPosition,
    createdAtFrame,
    maxRadius = null,
    timeoutMs = this.requestTimeoutMs,
  }) {
    assertWorkerRequestTimeout(timeoutMs, 'Interactive segmenter request timeout');
    const requestId = this.nextRequestId++;
    const copiedImageData = copyImageData(imageData);
    const workerGeneration = this.workerGeneration;

    return this.pendingRequests.start({
      id: requestId,
      timeoutMs,
      timeoutMessage: `Interactive segmenter request timed out after ${timeoutMs}ms`,
      send: () => {
        let requestWorker = null;
        const posting = this._getWorker().then((worker) => {
          requestWorker = worker;
          if (!this.pendingRequests.has(requestId)) {
            return;
          }
          if (!this._ownsWorker(worker, workerGeneration)) {
            throw new Error('Interactive segmenter request owner changed');
          }

          worker.postMessage(
            {
              type: 'segment',
              requestId,
              imageData: copiedImageData,
              tapPosition: { ...tapPosition },
              createdAtFrame,
              maxRadius,
            },
            [copiedImageData.data.buffer],
          );
        });
        posting.then(
          () => {},
          (error) => {
            if (!this.pendingRequests.has(requestId)) {
              return;
            }
            if (requestWorker && this._ownsWorker(requestWorker, workerGeneration)) {
              this._handleWorkerError(error.message);
            } else {
              this.pendingRequests.reject(requestId, error);
            }
          },
        );
      },
      onTimeout: (error) => this._handleWorkerError(error.message),
    });
  }

  dispose() {
    this._retireWorker();
    this.pendingRequests.rejectAll('Interactive segmenter disposed');
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
    const WorkerClass =
      this.WorkerClass || (await import('../cv/interactiveSegmenter.worker.js?worker')).default;
    if (workerGeneration !== this.workerGeneration) {
      throw new Error('Interactive segmenter disposed');
    }

    const worker = new WorkerClass();
    const isCurrentWorker = () => this._ownsWorker(worker, workerGeneration);
    worker.onmessage = (event) => {
      if (isCurrentWorker()) {
        this._handleMessage(event.data);
      }
    };
    worker.onerror = (error) => {
      if (isCurrentWorker()) {
        this._handleWorkerError(error.message || 'Interactive segmenter worker failed');
      }
    };
    worker.onmessageerror = (error) => {
      if (isCurrentWorker()) {
        this._handleWorkerError(
          error.message || 'Interactive segmenter worker response could not be deserialized',
        );
      }
    };
    this.worker = worker;
    return worker;
  }

  _handleMessage(message) {
    if (!this.pendingRequests.has(message.requestId)) {
      return;
    }

    if (message.type === 'segment-result') {
      this.pendingRequests.resolve(message.requestId, message.objectSupportMask);
    } else {
      this._handleWorkerError(message.reason);
    }
  }

  _handleWorkerError(reason) {
    this._retireWorker();
    this.pendingRequests.rejectAll(reason);
  }

  _ownsWorker(worker, workerGeneration) {
    return worker === this.worker && workerGeneration === this.workerGeneration;
  }

  _retireWorker() {
    const worker = this.worker;
    this.worker = null;
    this.workerGeneration++;
    this.workerPromise = null;
    worker?.terminate();
  }
}
