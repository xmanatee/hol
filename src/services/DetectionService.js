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
      console.log('[DetectionService] Already initialized');
      return true;
    }

    if (this.initPromise) {
      console.log('[DetectionService] Initialization in progress');
      return this.initPromise;
    }

    console.log('[DetectionService] Starting initialization...');
    if (typeof Worker === 'undefined') {
      const error = new Error('Web Workers are not supported in this browser');
      this.error = error.message;
      console.error('[DetectionService] Worker not supported:', this.error);
      this._notifyListeners('error', { error: this.error });
      throw error;
    }
    
    this.initPromise = new Promise((resolve, reject) => {
      console.log('[DetectionService] Creating worker...');
      this.worker = new Worker(new URL('../cv/detector.worker.js', import.meta.url), {
        type: 'module'
      });
      console.log('[DetectionService] Worker created');

      this.worker.onmessage = (event) => {
        this._handleWorkerMessage(event.data);
      };

      this.worker.onerror = (error) => {
        this.error = `Worker error: ${error.message}`;
        console.error('[DetectionService] Worker error:', this.error);
        this._notifyListeners('error', { error: this.error });
        reject(error);
      };

      this.worker.onmessageerror = (error) => {
        this.error = `Worker message error: ${error.message}`;
        console.error('[DetectionService] Worker message error:', this.error);
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
      
      console.log('[DetectionService] Sending test message...');
      this.worker.postMessage({ type: 'test' });
      console.log('[DetectionService] Sending initialize message...');
      this.worker.postMessage({ type: 'initialize' });
    });

    return this.initPromise;
  }

  async loadModel(modelPath = '/models/yolo11n_480.onnx') {
    if (!this.isInitialized) {
      const error = new Error('Detection service not initialized');
      console.error('[DetectionService] Cannot load model:', error.message);
      throw error;
    }

    if (this.isModelLoaded) {
      console.log('[DetectionService] Model already loaded');
      return true;
    }

    console.log('[DetectionService] Loading model:', modelPath);
    this.worker.postMessage({ 
      type: 'loadModel', 
      modelPath 
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error('[DetectionService] Model loading timeout');
        reject(new Error('Model loading timeout'));
      }, 30000);

      const checkLoaded = () => {
        if (this.isModelLoaded) {
          console.log('[DetectionService] Model loading promise resolved');
          clearTimeout(timeout);
          resolve(true);
        }
      };

      const checkError = (errorData) => {
        console.error('[DetectionService] Model loading failed:', errorData.error);
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
    if (!this.isModelLoaded || !this.worker) {
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

  setDetectionInterval(interval) {
    this.detectionInterval = Math.max(1, interval);
  }

  getState() {
    return {
      isInitialized: this.isInitialized,
      isModelLoaded: this.isModelLoaded,
      error: this.error,
      processingTime: this.lastProcessingTime
    };
  }

  _handleWorkerMessage({ type, ...data }) {
    switch (type) {
      case 'initialized':
        console.log('[DetectionService] Worker initialized successfully');
        this.isInitialized = true;
        this.error = null;
        this._notifyListeners('initialized');
        break;

      case 'modelLoaded':
        console.log('[DetectionService] Model loaded successfully');
        this.isModelLoaded = true;
        this._notifyListeners('modelLoaded');
        break;

      case 'detections':
        console.log('[DetectionService] Received detections:', data.detections?.length || 0, 'objects');
        this.lastProcessingTime = data.processingTime || 0;
        this._notifyListeners('detections', {
          detections: data.detections,
          processingTime: this.lastProcessingTime
        });
        break;

      case 'test_response':
        break;

      case 'error':
        console.error('[DetectionService] Worker error:', data.message);
        this.error = data.message;
        this._notifyListeners('error', { error: this.error });
        break;

      case 'warning':
        this._notifyListeners('warning', { message: data.message });
        break;

      case 'log':
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