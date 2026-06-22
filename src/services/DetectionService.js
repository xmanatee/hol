import { logger } from '../utils/logger.js';

const DEFAULT_MODEL_PATH = '/models/yolo11n_480.onnx';
const INITIALIZATION_TIMEOUT_MS = 10000;
const MODEL_LOAD_TIMEOUT_MS = 30000;

const createPendingOperation = ({ timeoutMs, onTimeout }) => {
  let resolveOperation;
  let rejectOperation;
  const promise = new Promise((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  return {
    promise,
    resolve: resolveOperation,
    reject: rejectOperation,
    timeout: setTimeout(onTimeout, timeoutMs),
  };
};

export class DetectionService {
  constructor() {
    this.worker = null;
    this.isInitialized = false;
    this.isModelLoaded = false;
    this.error = null;
    this.lastProcessingTime = 0;
    this.listeners = new Set();
    this.frameCounter = 0;
    this.detectionInterval = 4;
    this.detectionEnabled = false;
    this.pendingInitialization = null;
    this.pendingModelLoad = null;
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notifyListeners(type, data) {
    this.listeners.forEach(listener => {
      const handlerName = `on${type.charAt(0).toUpperCase() + type.slice(1)}`;
      if (listener[handlerName]) {
        listener[handlerName](data);
      }
    });
  }

  async initialize() {
    if (this.isInitialized) {
      logger.info('Detection', 'Already initialized');
      return true;
    }

    if (this.pendingInitialization) {
      logger.info('Detection', 'Initialization in progress');
      return this.pendingInitialization.promise;
    }

    logger.info('Detection', 'Starting initialization...');
    if (typeof Worker === 'undefined') {
      const error = new Error('Web Workers are not supported in this browser');
      this.error = error.message;
      logger.error('Detection', 'Worker not supported:', this.error);
      this._notifyListeners('error', { error: this.error });
      throw error;
    }
    
    logger.info('Detection', 'Creating worker...');
    this.worker = new Worker(new URL('../cv/detector.worker.js', import.meta.url), {
      type: 'module'
    });
    logger.info('Detection', 'Worker created');

    this.worker.onmessage = event => {
      this._handleWorkerMessage(event.data);
    };
    this.worker.onerror = error => {
      this._handleWorkerError(error, 'Worker error');
    };
    this.worker.onmessageerror = error => {
      this._handleWorkerError(error, 'Worker message error');
    };

    this.pendingInitialization = createPendingOperation({
      timeoutMs: INITIALIZATION_TIMEOUT_MS,
      onTimeout: () => {
        this._rejectInitialization(new Error('Detection service initialization timeout'));
      },
    });

    logger.info('Detection', 'Sending test message...');
    this.worker.postMessage({ type: 'test' });
    logger.info('Detection', 'Sending initialize message...');
    this.worker.postMessage({ type: 'initialize' });

    return this.pendingInitialization.promise;
  }

  async loadModel(modelPath = DEFAULT_MODEL_PATH) {
    if (!this.isInitialized) {
      const error = new Error('Detection service not initialized');
      logger.error('Detection', 'Cannot load model:', error.message);
      throw error;
    }

    if (this.isModelLoaded) {
      logger.info('Detection', 'Model already loaded');
      return true;
    }

    if (this.pendingModelLoad) {
      if (modelPath !== this.pendingModelLoad.modelPath) {
        throw new Error(`Detection model already loading: ${this.pendingModelLoad.modelPath}`);
      }
      logger.info('Detection', 'Model loading in progress');
      return this.pendingModelLoad.promise;
    }

    logger.info('Detection', 'Loading model:', modelPath);
    this.pendingModelLoad = {
      modelPath,
      ...createPendingOperation({
        timeoutMs: MODEL_LOAD_TIMEOUT_MS,
        onTimeout: () => {
          this._rejectModelLoad(new Error('Model loading timeout'));
        },
      }),
    };
    this.worker.postMessage({
      type: 'loadModel',
      modelPath
    });

    return this.pendingModelLoad.promise;
  }

  _resolveInitialization(value) {
    const pending = this.pendingInitialization;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingInitialization = null;
    pending.resolve(value);
  }

  _rejectInitialization(error) {
    const pending = this.pendingInitialization;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingInitialization = null;
    pending.reject(error);
  }

  _resolveModelLoad(value) {
    const pending = this.pendingModelLoad;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingModelLoad = null;
    pending.resolve(value);
  }

  _rejectModelLoad(error) {
    const pending = this.pendingModelLoad;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingModelLoad = null;
    pending.reject(error);
  }

  _handleWorkerError(error, label) {
    const message = error.message ?? 'Detection worker failed';
    const workerError = error instanceof Error ? error : new Error(message);
    this.error = `${label}: ${message}`;
    logger.error('Detection', `${label}:`, this.error);
    this._rejectInitialization(workerError);
    this._rejectModelLoad(workerError);
    this._stopWorker();
    this._notifyListeners('error', { error: this.error });
  }

  _handleWorkerProtocolError(message) {
    this.error = message;
    logger.error('Detection', 'Worker error:', this.error);
    const error = new Error(message);
    if (this.pendingInitialization) {
      this._rejectInitialization(error);
      this._stopWorker();
    } else if (this.pendingModelLoad) {
      this._rejectModelLoad(error);
    }
    this._notifyListeners('error', { error: this.error });
  }

  _stopWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.isInitialized = false;
    this.isModelLoaded = false;
  }

  detectObjects(imageData, forceDetection = false) {
    if (!this.isModelLoaded || !this.worker || !this.detectionEnabled) {
      return false;
    }

    this.frameCounter++;
    
    if (!forceDetection && this.frameCounter % this.detectionInterval !== 0) {
      return false;
    }

    const { message, transferList } = this._createDetectionMessage(imageData);
    this.worker.postMessage(message, transferList);

    return true;
  }

  _createDetectionMessage(imageData) {
    const data = new Uint8ClampedArray(imageData.data);

    return {
      message: {
        type: 'detect',
        imageData: {
          data,
          width: imageData.width,
          height: imageData.height
        }
      },
      transferList: [data.buffer]
    };
  }

  setDetectionEnabled(enabled) {
    this.detectionEnabled = enabled;
    logger.info('Detection', `Detection ${enabled ? 'enabled' : 'disabled'}`);
  }

  isDetectionEnabled() {
    return this.detectionEnabled;
  }

  setDetectionInterval(interval) {
    this.detectionInterval = Math.max(1, interval);
  }

  getState() {
    return {
      isInitialized: this.isInitialized,
      isModelLoaded: this.isModelLoaded,
      detectionEnabled: this.detectionEnabled,
      error: this.error,
      processingTime: this.lastProcessingTime
    };
  }

  _handleWorkerMessage({ type, ...data }) {
    switch (type) {
      case 'initialized':
        logger.info('Detection', 'Worker initialized successfully');
        this.isInitialized = true;
        this.error = null;
        this._resolveInitialization(true);
        this._notifyListeners('initialized');
        break;

      case 'modelLoaded':
        logger.info('Detection', 'Model loaded successfully');
        this.isModelLoaded = true;
        this._resolveModelLoad(true);
        this._notifyListeners('modelLoaded');
        break;

      case 'detections': {
        const detectionCount = data.detections?.length || 0;
        logger.debugChanged(
          'Detection',
          'detection-count',
          detectionCount,
          'Received detections:',
          detectionCount,
          'objects'
        );
        this.lastProcessingTime = data.processingTime || 0;
        this._notifyListeners('detections', {
          detections: data.detections,
          processingTime: this.lastProcessingTime
        });
        break;
      }

      case 'test_response':
        break;

      case 'error':
        this._handleWorkerProtocolError(data.message ?? 'Detection worker error');
        break;

      case 'warning':
        this._notifyListeners('warning', { message: data.message });
        break;

      case 'log':
        if (data.level && data.tag && data.args) {
          logger[data.level](data.tag, ...data.args);
        }
        break;
        
      case 'worker_loaded':
        break;

      default:
        break;
    }
  }

  dispose() {
    const disposed = new Error('Detection service disposed');
    this._rejectInitialization(disposed);
    this._rejectModelLoad(disposed);
    this._stopWorker();
    
    this.listeners.clear();
    this.error = null;
  }
}
