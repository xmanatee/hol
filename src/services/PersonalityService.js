import { VisionClient } from '../api/visionClient.js';
import { LLMClient } from '../api/llmClient.js';

export class PersonalityService {
  constructor(config = {}) {
    this.config = {
      ...config
    };
    
    try {
      this.visionClient = new VisionClient({
        ...config.vision,
        apiKey: config.apiKey || config.vision?.apiKey
      });
      this.llmClient = new LLMClient({
        ...config.llm,
        apiKey: config.apiKey || config.llm?.apiKey
      });
    } catch (error) {
      console.error('[PersonalityService] Failed to initialize API clients:', error.message);
      this.initializationError = error.message;
    }
    
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
        try {
          listener[event](data);
        } catch (error) {
          console.error(`[PersonalityService] Listener error for ${event}:`, error);
        }
      }
    });
  }

  async generatePersonality(imageData, bbox) {
    // Check for initialization errors
    if (this.initializationError) {
      const error = `API client initialization failed: ${this.initializationError}`;
      this.emit('onPersonalityGenerated', {
        persona: null,
        rtt: 0,
        success: false,
        error: error
      });
      throw new Error(error);
    }

    this.isProcessing = true;
    const startTime = performance.now();
    
    this.metrics.totalRequests++;
    
    this.emit('onPersonalityStart', { 
      requestId: this.metrics.totalRequests 
    });

    try {
      // Step 1: Extract sharp ROI crop
      const roiImageBlob = await this.extractROI(imageData, bbox);
      
      // Step 2: Vision API call for object description
      const visionResult = await this.visionClient.identifyObject(roiImageBlob);
      
      // Step 3: LLM call for persona generation
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

    } catch (error) {
      const endTime = performance.now();
      const rtt = endTime - startTime;
      
      this.metrics.lastRTT = rtt;
      this.metrics.failedRequests++;
      
      let userFriendlyError = 'Failed to generate personality';
      
      if (error.message.includes('API key')) {
        userFriendlyError = 'OpenAI API key not configured. Please check your environment variables.';
      } else if (error.message.includes('quota') || error.message.includes('rate limit')) {
        userFriendlyError = 'OpenAI API quota exceeded or rate limited. Please try again later.';
      } else if (error.message.includes('network') || error.message.includes('fetch')) {
        userFriendlyError = 'Network error. Please check your internet connection.';
      } else if (error.message.includes('Vision API') || error.message.includes('Chat API')) {
        userFriendlyError = 'OpenAI API error. Please try again.';
      }

      console.error('[PersonalityService] Generation failed:', error);
      
      this.emit('onPersonalityGenerated', {
        persona: null,
        rtt: rtt,
        success: false,
        error: userFriendlyError
      });

      this.isProcessing = false;
      throw new Error(userFriendlyError);
    }
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