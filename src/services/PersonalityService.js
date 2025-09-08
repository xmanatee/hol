import { VisionClient } from '../api/visionClient.js';
import { LLMClient } from '../api/llmClient.js';

export class PersonalityService {
  constructor(config = {}) {
    this.config = {
      ...config
    };
    
    this.visionClient = new VisionClient({
      ...config.vision,
      apiKey: config.apiKey || config.vision?.apiKey
    });
    this.llmClient = new LLMClient({
      ...config.llm,
      apiKey: config.apiKey || config.llm?.apiKey
    });
    
    this.listeners = new Set();
    this.isProcessing = false;
    this.lastPersona = null;
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageRTT: 0,
      lastRTT: 0
    };
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, data) {
    this.listeners.forEach(listener => {
      if (listener[event]) {
        listener[event](data);
      }
    });
  }

  async generatePersonality(imageData, bbox) {
    this.isProcessing = true;
    const startTime = performance.now();
    
    this.metrics.totalRequests++;
    
    this.emit('onPersonalityStart', { 
      requestId: this.metrics.totalRequests 
    });

    const roiImageBlob = await this.extractROI(imageData, bbox);
    const visionResult = await this.visionClient.identifyObject(roiImageBlob);
    const persona = await this.llmClient.generatePersona(visionResult);
    
    const endTime = performance.now();
    const rtt = endTime - startTime;
    
    this.metrics.lastRTT = rtt;
    this.metrics.averageRTT = this.calculateMovingAverage(this.metrics.averageRTT, rtt);
    this.metrics.successfulRequests++;
    
    this.lastPersona = {
      ...persona,
      visionData: visionResult,
      generatedAt: Date.now(),
      rtt: rtt
    };

    this.emit('onPersonalityGenerated', {
      persona: this.lastPersona,
      rtt: rtt,
      success: true
    });

    this.isProcessing = false;
    return this.lastPersona;
  }

  extractROI(imageData, bbox) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Add 15% padding around bbox
    const padding = 0.15;
    const paddedWidth = bbox.width * (1 + padding);
    const paddedHeight = bbox.height * (1 + padding);
    const paddedX = bbox.x - (paddedWidth - bbox.width) / 2;
    const paddedY = bbox.y - (paddedHeight - bbox.height) / 2;
    
    canvas.width = Math.round(paddedWidth);
    canvas.height = Math.round(paddedHeight);
    
    // Create ImageData from input
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = imageData.width;
    sourceCanvas.height = imageData.height;
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.putImageData(imageData, 0, 0);
    
    // Extract ROI
    ctx.drawImage(
      sourceCanvas,
      Math.max(0, paddedX), Math.max(0, paddedY),
      Math.min(paddedWidth, imageData.width - Math.max(0, paddedX)),
      Math.min(paddedHeight, imageData.height - Math.max(0, paddedY)),
      0, 0,
      canvas.width, canvas.height
    );
    
    // Convert to blob for API upload
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  }

  calculateMovingAverage(currentAvg, newValue, alpha = 0.15) {
    return currentAvg === 0 ? newValue : currentAvg + alpha * (newValue - currentAvg);
  }

  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalRequests > 0 
        ? (this.metrics.successfulRequests / this.metrics.totalRequests) * 100 
        : 0
    };
  }

  dispose() {
    this.listeners.clear();
    this.isProcessing = false;
  }
}