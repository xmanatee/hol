import { logger } from '../utils/logger.js';

export class NormalEstimationService {
  constructor() {
    this.worker = null;
    this.isReady = false;
    this.listeners = new Set();
    this.lastNormal = null;
    this.processing = false;
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
    if (this.isReady) {
      logger.info('NormalEstimationService', 'Already initialized, returning true');
      return true;
    }

    if (this.initPromise) {
      logger.info('NormalEstimationService', 'Initialization already in progress, waiting...');
      return this.initPromise;
    }

    try {
      this.worker = new Worker(new URL('../cv/normal.worker.js', import.meta.url), {
        type: 'module'
      });

      this.worker.onmessage = (event) => {
        this._handleWorkerMessage(event.data);
      };

      this.worker.onerror = (error) => {
        logger.error('NormalEstimationService', 'Worker error:', error);
        this._notifyListeners('error', { error: error.message });
      };

      this.initPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.initPromise = null; // Clear failed promise
          reject(new Error('Normal estimation service initialization timeout'));
        }, 10000);

        const checkReady = () => {
          if (this.isReady) {
            clearTimeout(timeout);
            this.initPromise = null;
            resolve(true);
          }
        };

        // Add listener BEFORE sending initialize message to avoid race condition
        this.addListener({ onReady: checkReady });
        
        // Initialize worker
        this.worker.postMessage({ type: 'initialize' });
      });

      return this.initPromise;
    } catch (err) {
      logger.error('NormalEstimationService', 'Initialization error:', err);
      throw err;
    }
  }

  estimateNormal(imageData, bbox, cameraMatrix) {
    if (!this.isReady || !this.worker || this.processing) {
      return false;
    }

    this.processing = true;

    this.worker.postMessage({
      type: 'estimateNormal',
      imageData: {
        data: Array.from(imageData.data),
        width: imageData.width,
        height: imageData.height
      },
      bbox,
      cameraMatrix
    });

    return true;
  }

  getLastNormal() {
    return this.lastNormal;
  }

  getState() {
    return {
      isReady: this.isReady,
      processing: this.processing,
      lastNormal: this.lastNormal
    };
  }

  _handleWorkerMessage({ type, ...data }) {
    switch (type) {
      case 'ready':
        this.isReady = true;
        this._notifyListeners('ready');
        logger.info('NormalEstimationService', 'Ready');
        break;

      case 'normal':
        this.processing = false;
        this.lastNormal = data.normal;
        this._notifyListeners('normal', { 
          normal: data.normal,
          confidence: data.confidence,
          method: data.method 
        });
        break;

      case 'error':
        this.processing = false;
        this._notifyListeners('error', { error: data.message });
        logger.error('NormalEstimationService', 'Estimation error:', data.message);
        break;

      case 'log':
        // Forward worker logs to main logger with tag filtering
        if (data.level && data.tag && data.args) {
          logger[data.level](data.tag, ...data.args);
        } else if (data.message) {
          // Legacy format support
          logger.info('NormalEstimationService', 'Worker:', data.message);
        }
        break;

      case 'no_result':
        // Normal estimation worker found no valid result - this is expected behavior
        logger.info('NormalEstimationService', 'No normal estimation result available');
        break;

      default:
        logger.warn('NormalEstimationService', 'Unknown worker message type:', type);
    }
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    
    this.listeners.clear();
    this.isReady = false;
    this.processing = false;
    this.lastNormal = null;
  }
}