import { logger } from '../utils/logger.js';

export class DetectionService {
  constructor() {
    this.worker = null;
    this.isInitialized = false;
    this.isModelLoaded = false;
    this.error = null;
    this.lastProcessingTime = 0;
    this.listeners = new Set();
    this.frameCounter = 0;
    this.detectionInterval = 4; // Run detection every 4th frame
    this.detectionEnabled = true; // Can disable detection for anchor mode
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

    if (this.initPromise) {
      logger.info('Detection', 'Initialization in progress');
      return this.initPromise;
    }

    logger.info('Detection', 'Starting initialization...');
    if (typeof Worker === 'undefined') {
      const error = new Error('Web Workers are not supported in this browser');
      this.error = error.message;
      logger.error('Detection', 'Worker not supported:', this.error);
      this._notifyListeners('error', { error: this.error });
      throw error;
    }
    
    this.initPromise = new Promise((resolve, reject) => {
      logger.info('Detection', 'Creating worker...');
      this.worker = new Worker(new URL('../cv/detector.worker.js', import.meta.url), {
        type: 'module'
      });
      logger.info('Detection', 'Worker created');

      this.worker.onmessage = (event) => {
        this._handleWorkerMessage(event.data);
      };

      this.worker.onerror = (error) => {
        this.error = `Worker error: ${error.message}`;
        logger.error('Detection', 'Worker error:', this.error);
        this._notifyListeners('error', { error: this.error });
        reject(error);
      };

      this.worker.onmessageerror = (error) => {
        this.error = `Worker message error: ${error.message}`;
        logger.error('Detection', 'Worker message error:', this.error);
        this._notifyListeners('error', { error: this.error });
        reject(error);
      };

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          this.initPromise = null;
          reject(new Error('Detection service initialization timeout'));
        }
      }, 10000);

      const checkReady = () => {
        if (this.isInitialized && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.initPromise = null;
          resolve(true);
        }
      };

      this.addListener({ onInitialized: checkReady });
      
      logger.info('Detection', 'Sending test message...');
      this.worker.postMessage({ type: 'test' });
      logger.info('Detection', 'Sending initialize message...');
      this.worker.postMessage({ type: 'initialize' });
    });

    return this.initPromise;
  }

  async loadModel(modelPath = '/models/yolo11n_480.onnx') {
    if (!this.isInitialized) {
      const error = new Error('Detection service not initialized');
      logger.error('Detection', 'Cannot load model:', error.message);
      throw error;
    }

    if (this.isModelLoaded) {
      logger.info('Detection', 'Model already loaded');
      return true;
    }

    logger.info('Detection', 'Loading model:', modelPath);
    this.worker.postMessage({ 
      type: 'loadModel', 
      modelPath 
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error('Detection', 'Model loading timeout');
        reject(new Error('Model loading timeout'));
      }, 30000);

      const checkLoaded = () => {
        if (this.isModelLoaded) {
          logger.info('Detection', 'Model loading promise resolved');
          clearTimeout(timeout);
          resolve(true);
        }
      };

      const checkError = (errorData) => {
        logger.error('Detection', 'Model loading failed:', errorData.error);
        clearTimeout(timeout);
        reject(new Error(errorData.error));
      };

      this.addListener({ 
        onModelLoaded: checkLoaded,
        onError: checkError
      });
    });
  }

  detectObjects(imageData, forceDetection = false) {
    if (!this.isModelLoaded || !this.worker || !this.detectionEnabled) {
      return false;
    }

    this.frameCounter++;
    
    // Skip detection unless it's time or forced
    if (!forceDetection && this.frameCounter % this.detectionInterval !== 0) {
      return false;
    }

    this.worker.postMessage({
      type: 'detect',
      imageData: {
        data: Array.from(imageData.data),
        width: imageData.width,
        height: imageData.height
      }
    });

    return true;
  }

  /**
   * Enable or disable detection (for switching between detection and anchor modes)
   * @param {boolean} enabled - Whether detection should be enabled
   */
  setDetectionEnabled(enabled) {
    this.detectionEnabled = enabled;
    logger.info('Detection', `Detection ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Check if detection is currently enabled
   * @returns {boolean} Detection enabled state
   */
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
        this._notifyListeners('initialized');
        break;

      case 'modelLoaded':
        logger.info('Detection', 'Model loaded successfully');
        this.isModelLoaded = true;
        this._notifyListeners('modelLoaded');
        break;

      case 'detections':
        logger.info('Detection', 'Received detections:', data.detections?.length || 0, 'objects');
        this.lastProcessingTime = data.processingTime || 0;
        this._notifyListeners('detections', {
          detections: data.detections,
          processingTime: this.lastProcessingTime
        });
        break;

      case 'test_response':
        break;

      case 'error':
        logger.error('Detection', 'Worker error:', data.message);
        this.error = data.message;
        this._notifyListeners('error', { error: this.error });
        break;

      case 'warning':
        this._notifyListeners('warning', { message: data.message });
        break;

      case 'log':
        // Forward worker logs to main logger with tag filtering
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
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    
    this.listeners.clear();
    this.isInitialized = false;
    this.isModelLoaded = false;
    this.error = null;
  }
}