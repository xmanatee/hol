import { logger } from '../utils/logger.js';

const copyImageData = imageData => {
  const data = new Uint8ClampedArray(imageData.data);
  return {
    imageData: {
      width: imageData.width,
      height: imageData.height,
      data,
    },
    transferables: [data.buffer],
  };
};

const withDetectionIds = detections => detections.map(detection => ({
  ...detection,
  id: `${detection.class}-${Math.round(detection.x1)}-${Math.round(detection.y1)}-${Math.round(detection.x2)}-${Math.round(detection.y2)}`,
}));

const findDetectionAtPosition = (detections, position) => {
  let bestDetection = null;
  let bestScore = 0;

  for (const detection of detections) {
    const inside = position.x >= detection.x1 &&
      position.x <= detection.x2 &&
      position.y >= detection.y1 &&
      position.y <= detection.y2;

    if (inside && detection.confidence > bestScore) {
      bestDetection = detection;
      bestScore = detection.confidence;
    }
  }

  return bestDetection;
};

export class AnchorWorkerService {
  constructor() {
    this.runsInWorker = true;
    this.initialized = false;
    this.mode = 'detection';
    this.detections = [];
    this.activeAnchor = null;
    this.anchorState = null;
    this.trackingMode = 'sparse-reconstruction';
    this.worker = null;
    this.workerClassPromise = null;
    this.pendingRequests = new Map();
    this.nextRequestId = 1;
    this.updateInFlight = false;
    this.segmentationRefreshInFlight = false;
    this.listeners = new Set();
  }

  addListener(listener) {
    const callback = typeof listener === 'function'
      ? listener
      : listener.onAnchorUpdate.bind(listener);
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async initialize(_cv, viewportWidth, viewportHeight, fov = 63) {
    if (this.initialized) {
      return;
    }

    await this._request('initialize', {
      viewportWidth,
      viewportHeight,
      fov,
      trackingMode: this.trackingMode,
    });
    this.initialized = true;
    this._notifyUpdate();
  }

  processDetections(detections) {
    if (!this.initialized || this.mode !== 'detection') {
      return [];
    }

    this.detections = withDetectionIds(detections);
    this._send('processDetections', { detections: this.detections });
    this._notifyUpdate();
    return this.detections;
  }

  async createAnchorFromTap(tapPosition, imageData) {
    if (!this.initialized || this.mode !== 'detection') {
      throw new Error('Can only create anchor in detection mode');
    }

    const copied = copyImageData(imageData);
    const result = await this._request(
      'createAnchorFromTap',
      { tapPosition, imageData: copied.imageData },
      copied.transferables
    );
    this._notifyUpdate();
    return result;
  }

  updateAnchor(imageData, depthContext = {}) {
    if (!this.initialized || this.mode !== 'anchor' || this.updateInFlight) {
      return { success: false, reason: this.updateInFlight ? 'Anchor update in progress' : 'Not in anchor mode' };
    }

    const copied = copyImageData(imageData);
    this.updateInFlight = true;
    this._request(
      'updateAnchor',
      { imageData: copied.imageData, depthContext },
      copied.transferables
    ).then(
      () => {},
      error => this._handleWorkerRequestError(error)
    ).finally(() => {
      this.updateInFlight = false;
    });
    return { success: true, method: 'worker-anchor-update', pending: true };
  }

  refreshSegmentationIfNeeded(imageData) {
    if (!this.initialized || this.mode !== 'anchor' || this.segmentationRefreshInFlight) {
      return false;
    }

    const copied = copyImageData(imageData);
    this.segmentationRefreshInFlight = true;
    this._request(
      'refreshSegmentationIfNeeded',
      { imageData: copied.imageData },
      copied.transferables
    ).then(
      () => {},
      error => this._handleWorkerRequestError(error)
    ).finally(() => {
      this.segmentationRefreshInFlight = false;
    });
    return true;
  }

  clearAnchor() {
    if (!this.initialized || this.mode !== 'anchor') {
      return;
    }

    this._send('clearAnchor');
  }

  setTrackingMode(mode) {
    this.trackingMode = mode;
    if (this.initialized) {
      this._send('setTrackingMode', { mode });
    }
    this._notifyUpdate();
  }

  findDetectionAtPosition(position) {
    return findDetectionAtPosition(this.detections, position);
  }

  getState() {
    return {
      mode: this.mode,
      detections: this.detections,
      activeAnchor: this.activeAnchor,
      anchorState: this.anchorState,
      trackingMode: this.trackingMode,
      initialized: this.initialized,
    };
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this._rejectAll('Anchor worker disposed');
    this.updateInFlight = false;
    this.segmentationRefreshInFlight = false;
    this.initialized = false;
    this.mode = 'detection';
    this.detections = [];
    this.activeAnchor = null;
    this.anchorState = null;
    this.listeners.clear();
  }

  async _getWorkerClass() {
    if (!this.workerClassPromise) {
      this.workerClassPromise = import('../cv/anchor.worker.js?worker').then(module => module.default);
    }
    return this.workerClassPromise;
  }

  async _getWorker() {
    if (this.worker) {
      return this.worker;
    }

    const WorkerClass = await this._getWorkerClass();
    this.worker = new WorkerClass();
    this.worker.onmessage = event => this._handleWorkerMessage(event.data);
    this.worker.onerror = error => {
      this._handleWorkerFailure(error);
    };
    this.worker.onmessageerror = error => {
      this._handleWorkerFailure(error);
    };
    return this.worker;
  }

  async _request(command, payload = {}, transferables = []) {
    const worker = await this._getWorker();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      // Register after postMessage succeeds so structured-clone failures do not leak requests.
      worker.postMessage({ id, command, payload }, transferables);
      this.pendingRequests.set(id, { resolve, reject });
    });
  }

  _send(command, payload = {}, transferables = []) {
    this._request(command, payload, transferables).then(
      () => {},
      error => this._handleWorkerRequestError(error)
    );
  }

  _handleWorkerRequestError(error) {
    if (error?.message === 'Anchor worker disposed') {
      return;
    }

    this._handleWorkerFailure(error);
  }

  _handleWorkerMessage(message) {
    if (message.type === 'state') {
      this._applyState(message.state);
      return;
    }

    if (message.state) {
      this._applyState(message.state);
    }

    const request = this.pendingRequests.get(message.id);
    if (!request) {
      return;
    }

    this.pendingRequests.delete(message.id);

    if (message.error) {
      request.reject(new Error(message.error));
      return;
    }

    request.resolve(message.result);
  }

  _applyState(state) {
    this.mode = state.mode;
    this.detections = state.detections;
    this.activeAnchor = state.activeAnchor;
    this.anchorState = state.anchorState;
    this.trackingMode = state.trackingMode;
    this.initialized = state.initialized;
    this._notifyUpdate();
  }

  _notifyUpdate() {
    const state = this.getState();
    this.listeners.forEach(listener => listener(state));
  }

  _handleWorkerFailure(error) {
    const message = error?.message || 'Anchor worker failed';
    logger.error('AnchorWorker', message);
    this._rejectAll(message);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.updateInFlight = false;
    this.segmentationRefreshInFlight = false;
    this.initialized = false;
    this.mode = 'detection';
    this.detections = [];
    this.activeAnchor = null;
    this.anchorState = null;
    this._notifyUpdate();
  }

  _rejectAll(reason) {
    for (const request of this.pendingRequests.values()) {
      request.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
