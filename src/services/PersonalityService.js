import { VisionClient } from '../api/visionClient.js';
import { LLMClient } from '../api/llmClient.js';
import {
  VISION_CROP_JPEG_QUALITY,
  VISION_CROP_MIME_TYPE,
  assertVisionImageBlob,
  assertVisionImageData,
  resolveVisionCrop,
} from '../contracts/visionImage.js';
import { assertAbortSignal } from '../utils/boundedRequest.js';
import { assertPersonalityServiceConfig } from './personalityServiceConfig.js';

const createBrowserImageBitmap = (...args) => {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is required for personality image cropping');
  }
  return globalThis.createImageBitmap(...args);
};

const createBrowserCanvas = () => document.createElement('canvas');

const encodeCanvas = (canvas, signal) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const handleAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      reject(signal.reason);
    };
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      callback(value);
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    canvas.toBlob(
      (blob) => {
        if (settled) {
          return;
        }
        if (!blob) {
          settle(reject, new Error('Failed to encode object crop'));
          return;
        }
        try {
          settle(resolve, assertVisionImageBlob(blob));
        } catch (error) {
          settle(reject, error);
        }
      },
      VISION_CROP_MIME_TYPE,
      VISION_CROP_JPEG_QUALITY,
    );
  });

export class PersonalityService {
  constructor(config = {}) {
    assertPersonalityServiceConfig(config);
    this.config = {
      ...config,
    };
    this.createImageBitmap = config.createImageBitmap ?? createBrowserImageBitmap;
    this.createCanvas = config.createCanvas ?? createBrowserCanvas;

    this.visionClient = null;
    this.llmClient = null;

    this.listeners = new Set();
    this.isProcessing = false;
    this.lastPersona = null;
    this.activeRequest = null;
    this.runtimeGeneration = 0;
    this.disposed = false;
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      cancelledRequests: 0,
      averageRTT: 0,
      lastRTT: 0,
    };
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, data) {
    this.listeners.forEach((listener) => {
      if (listener[event]) {
        listener[event](data);
      }
    });
  }

  cancelRequest(request) {
    if (!request || request.cancelled) {
      return;
    }
    request.cancelled = true;
    this.metrics.cancelledRequests++;
    request.abortController.abort(new DOMException('Personality request retired', 'AbortError'));
  }

  ownsRequest(request) {
    return (
      !this.disposed &&
      !request.cancelled &&
      request.runtimeGeneration === this.runtimeGeneration &&
      this.activeRequest === request
    );
  }

  async generatePersonality(imageData, bbox) {
    if (this.disposed) {
      return null;
    }

    this.cancelRequest(this.activeRequest);
    const requestId = ++this.metrics.totalRequests;
    const request = {
      requestId,
      runtimeGeneration: this.runtimeGeneration,
      abortController: new AbortController(),
      cancelled: false,
    };
    this.activeRequest = request;
    this.isProcessing = true;
    const startTime = performance.now();
    this.emit('onPersonalityStart', { requestId });

    try {
      const roiImageBlob = await this.extractROI(imageData, bbox, {
        signal: request.abortController.signal,
      });
      if (!this.ownsRequest(request)) {
        return null;
      }
      const visionResult = await this.getVisionClient().identifyObject(roiImageBlob, {
        signal: request.abortController.signal,
      });
      if (!this.ownsRequest(request)) {
        return null;
      }
      const persona = await this.getLLMClient().generatePersona(visionResult, {
        signal: request.abortController.signal,
      });
      if (!this.ownsRequest(request)) {
        return null;
      }

      const endTime = performance.now();
      const rtt = endTime - startTime;

      this.metrics.lastRTT = rtt;
      this.metrics.averageRTT = this.calculateMovingAverage(this.metrics.averageRTT, rtt);
      this.metrics.successfulRequests++;

      this.lastPersona = {
        ...persona,
        visionData: visionResult,
        generatedAt: Date.now(),
        rtt,
      };

      this.emit('onPersonalityGenerated', {
        persona: this.lastPersona,
        rtt,
        success: true,
      });

      return this.lastPersona;
    } catch (error) {
      if (!this.ownsRequest(request)) {
        return null;
      }
      const rtt = performance.now() - startTime;
      this.metrics.failedRequests++;
      this.metrics.lastRTT = rtt;
      this.emit('onPersonalityGenerated', {
        persona: null,
        rtt,
        success: false,
        error: error.message,
      });
      throw error;
    } finally {
      if (this.activeRequest === request) {
        this.activeRequest = null;
        this.isProcessing = false;
      }
    }
  }

  async extractROI(imageData, bbox, { signal } = {}) {
    if (signal !== undefined) {
      assertAbortSignal(signal, 'Personality crop signal');
    }
    signal?.throwIfAborted();
    assertVisionImageData(imageData);
    const crop = resolveVisionCrop(bbox, imageData.width, imageData.height);
    const bitmap = await this.createImageBitmap(
      imageData,
      crop.sourceX,
      crop.sourceY,
      crop.sourceWidth,
      crop.sourceHeight,
      {
        resizeWidth: crop.outputWidth,
        resizeHeight: crop.outputHeight,
        resizeQuality: 'high',
      },
    );
    if (!bitmap || typeof bitmap.close !== 'function') {
      throw new TypeError('Personality createImageBitmap must resolve to an ImageBitmap');
    }

    let canvas = null;
    try {
      try {
        signal?.throwIfAborted();
        canvas = this.createCanvas();
        if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.toBlob !== 'function') {
          throw new TypeError('Personality createCanvas must return a canvas');
        }
        canvas.width = crop.outputWidth;
        canvas.height = crop.outputHeight;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context || typeof context.drawImage !== 'function') {
          throw new Error('A 2D canvas context is required for personality image cropping');
        }
        context.drawImage(bitmap, 0, 0, crop.outputWidth, crop.outputHeight);
      } finally {
        bitmap.close();
      }

      signal?.throwIfAborted();
      return await encodeCanvas(canvas, signal);
    } finally {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }

  getVisionClient() {
    if (!this.visionClient) {
      this.visionClient = new VisionClient({
        ...this.config.vision,
        baseUrl: this.config.vision?.baseUrl ?? this.config.baseUrl,
        requestTimeoutMs: this.config.vision?.requestTimeoutMs ?? this.config.requestTimeoutMs,
        scheduleRequestTimeout:
          this.config.vision?.scheduleRequestTimeout ?? this.config.scheduleRequestTimeout,
      });
    }
    return this.visionClient;
  }

  getLLMClient() {
    if (!this.llmClient) {
      this.llmClient = new LLMClient({
        ...this.config.llm,
        baseUrl: this.config.llm?.baseUrl ?? this.config.baseUrl,
        requestTimeoutMs: this.config.llm?.requestTimeoutMs ?? this.config.requestTimeoutMs,
        scheduleRequestTimeout: this.config.llm?.scheduleRequestTimeout ?? this.config.scheduleRequestTimeout,
      });
    }
    return this.llmClient;
  }

  calculateMovingAverage(currentAvg, newValue, alpha = 0.15) {
    return currentAvg === 0 ? newValue : currentAvg + alpha * (newValue - currentAvg);
  }

  getMetrics() {
    return {
      ...this.metrics,
      successRate:
        this.metrics.totalRequests > 0
          ? (this.metrics.successfulRequests / this.metrics.totalRequests) * 100
          : 0,
    };
  }

  resetSubject() {
    this.runtimeGeneration++;
    const activeRequest = this.activeRequest;
    this.activeRequest = null;
    this.cancelRequest(activeRequest);
    this.isProcessing = false;
    this.lastPersona = null;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.resetSubject();
    this.listeners.clear();
    this.visionClient = null;
    this.llmClient = null;
  }
}
