export class PersonalityService {
  constructor(config = {}) {
    this.config = {
      apiEndpoint: config.apiEndpoint || '/api/personality',
      maxRetries: config.maxRetries || 2,
      fallbackPersonas: config.fallbackPersonas || this.getDefaultFallbacks(),
      ...config
    };
    
    this.listeners = new Set();
    this.isProcessing = false;
    this.lastPersona = null;
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
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

  async generatePersonality(imageData, bbox, objectInfo = {}) {
    if (this.isProcessing) {
      console.warn('[PersonalityService] Already processing personality request');
      return this.lastPersona;
    }

    this.isProcessing = true;
    const startTime = performance.now();
    
    try {
      this.metrics.totalRequests++;
      
      this.emit('onPersonalityStart', { 
        bbox, 
        objectInfo,
        requestId: this.metrics.totalRequests 
      });

      // Step 1: Extract sharp ROI crop
      const roiImageData = this.extractROI(imageData, bbox);
      
      // Step 2: Vision API call for object identification
      const visionResult = await this.identifyObject(roiImageData, objectInfo);
      
      // Step 3: LLM call for persona generation
      const persona = await this.generatePersona(visionResult);
      
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

      return this.lastPersona;

    } catch (error) {
      console.error('[PersonalityService] Personality generation failed:', error);
      
      const fallbackPersona = this.getFallbackPersona(objectInfo);
      const endTime = performance.now();
      const rtt = endTime - startTime;
      
      this.metrics.lastRTT = rtt;
      
      this.emit('onPersonalityGenerated', {
        persona: fallbackPersona,
        rtt: rtt,
        success: false,
        error: error.message
      });

      return fallbackPersona;
      
    } finally {
      this.isProcessing = false;
    }
  }

  extractROI(imageData, bbox) {
    // Create canvas to extract the bounding box region
    const canvas = new OffscreenCanvas || document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Add 15% padding around bbox as specified in Phase 10
    const padding = 0.15;
    const paddedWidth = bbox.width * (1 + padding);
    const paddedHeight = bbox.height * (1 + padding);
    const paddedX = bbox.x - (paddedWidth - bbox.width) / 2;
    const paddedY = bbox.y - (paddedHeight - bbox.height) / 2;
    
    canvas.width = Math.round(paddedWidth);
    canvas.height = Math.round(paddedHeight);
    
    // Create ImageData from input
    const sourceCanvas = new OffscreenCanvas || document.createElement('canvas');
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
    
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  async identifyObject(imageData, objectInfo = {}) {
    const canvas = new OffscreenCanvas || document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);
    
    // Convert to blob for API upload
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    
    const formData = new FormData();
    formData.append('image', blob, 'roi.jpg');
    formData.append('objectInfo', JSON.stringify(objectInfo));
    
    const response = await this.retryRequest(async () => {
      const res = await fetch(`${this.config.apiEndpoint}/identify`, {
        method: 'POST',
        body: formData,
      });
      
      if (!res.ok) {
        throw new Error(`Vision API error: ${res.status} ${res.statusText}`);
      }
      
      return res.json();
    });
    
    return {
      category: response.category || 'unknown',
      brandOrTitle: response.brandOrTitle || '',
      textSnippets: response.textSnippets || [],
      confidence: response.confidence || 0.5
    };
  }

  async generatePersona(visionResult) {
    const prompt = this.buildPersonaPrompt(visionResult);
    
    const response = await this.retryRequest(async () => {
      const res = await fetch(`${this.config.apiEndpoint}/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: prompt,
          visionResult: visionResult
        }),
      });
      
      if (!res.ok) {
        throw new Error(`LLM API error: ${res.status} ${res.statusText}`);
      }
      
      return res.json();
    });
    
    return this.validatePersona(response);
  }

  buildPersonaPrompt(visionResult) {
    return `
Based on this object analysis: ${JSON.stringify(visionResult)}, generate a fun personality for this object inspired by the game "High on Life".

Return a JSON object with exactly these fields:
{
  "voiceStyle": "one of: cheerful, sassy, wise, gruff, bubbly, sarcastic, dramatic",
  "tone": "brief description of personality tone",
  "quirks": ["unique trait 1", "unique trait 2", "unique trait 3"],
  "oneLiners": ["greeting line", "idle comment", "departure line"]
}

Keep it under 300 tokens total. Make it witty and distinctive based on the object type.
    `.trim();
  }

  validatePersona(response) {
    const defaults = {
      voiceStyle: 'cheerful',
      tone: 'friendly and upbeat',
      quirks: ['loves to chat', 'always optimistic', 'surprisingly wise'],
      oneLiners: ['Hey there!', 'Life is good!', 'See ya later!']
    };
    
    return {
      voiceStyle: response.voiceStyle || defaults.voiceStyle,
      tone: response.tone || defaults.tone,
      quirks: Array.isArray(response.quirks) ? response.quirks : defaults.quirks,
      oneLiners: Array.isArray(response.oneLiners) ? response.oneLiners : defaults.oneLiners
    };
  }

  getFallbackPersona(objectInfo = {}) {
    const fallbacks = this.config.fallbackPersonas;
    const category = objectInfo.category || objectInfo.class || 'bottle';
    
    return fallbacks[category] || fallbacks.default;
  }

  getDefaultFallbacks() {
    return {
      bottle: {
        voiceStyle: 'bubbly',
        tone: 'excited and energetic',
        quirks: ['loves being recycled', 'dreams of becoming a rocket ship', 'always half full, never half empty'],
        oneLiners: [
          'Pop! Hey there, gorgeous!',
          'I may be empty, but my spirit is full!',
          'Remember to recycle me, will ya?'
        ]
      },
      cup: {
        voiceStyle: 'wise',
        tone: 'philosophical and calm',
        quirks: ['has held many stories', 'believes in the power of pause', 'thinks steam is just liquid meditation'],
        oneLiners: [
          'Greetings, fellow traveler.',
          'Every sip is a moment of zen.',
          'Until we meet again over coffee.'
        ]
      },
      default: {
        voiceStyle: 'cheerful',
        tone: 'friendly and curious',
        quirks: ['loves meeting new people', 'always ready for an adventure', 'believes everything has a story'],
        oneLiners: [
          'Well hello there!',
          'Isn\'t life fascinating?',
          'Keep being awesome!'
        ]
      }
    };
  }

  async retryRequest(requestFn) {
    let lastError;
    
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error;
        
        if (attempt < this.config.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, delay));
          console.warn(`[PersonalityService] Request failed, retrying in ${delay}ms...`, error.message);
        }
      }
    }
    
    throw lastError;
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