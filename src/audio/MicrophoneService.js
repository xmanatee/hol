// Dedicated Microphone Audio Analysis Service
// Provides the same interface as ElevenLabs audio analysis but uses microphone input

import { logger } from '../utils/logger.js';

export class MicrophoneService {
  constructor() {
    this.audioContext = null;
    this.analyserNode = null;
    this.microphoneStream = null;
    this.microphoneSource = null;
    this.frequencyData = null;
    this.timeData = null;
    this.isActive = false;
    this.isInitialized = false;
    this.voiceActivityThreshold = 0.02;
    this.inputGain = 3.0;
    this.debugMode = false;
    this.debugCounter = 0;
    this.energyHistory = [];
    this.baselineNoise = 0;
    this.stateChangeHandler = null;
  }

  async initialize() {
    if (this.isInitialized) {
      return;
    }

    try {
      // Create audio context if not exists
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      // Resume audio context if suspended (iOS requirement)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        logger.info('MicrophoneService', 'AudioContext resumed from suspended state');
      }

      // Handle audio context state changes (important for mobile)
      this.stateChangeHandler = () => {
        if (this.debugMode) {
          logger.info('MicrophoneService', 'AudioContext state changed to:', this.audioContext.state);
        }
        if (this.audioContext.state === 'suspended' && this.isActive) {
          logger.warn('MicrophoneService', 'AudioContext suspended while active, attempting resume');
          this.audioContext.resume().catch(err => {
            logger.error('MicrophoneService', 'Failed to resume AudioContext:', err);
          });
        }
      };
      this.audioContext.addEventListener('statechange', this.stateChangeHandler);

      // Request microphone access
      this.microphoneStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100
        }
      });

      // Create microphone source and analyzer
      this.microphoneSource = this.audioContext.createMediaStreamSource(this.microphoneStream);
      this.analyserNode = this.audioContext.createAnalyser();
      
      // Configure analyzer for real-time speech analysis
      this.analyserNode.fftSize = 256; // Good balance of frequency resolution and performance
      this.analyserNode.smoothingTimeConstant = 0.3; // Some smoothing for natural speech
      this.analyserNode.minDecibels = -90;
      this.analyserNode.maxDecibels = -10;

      // Connect microphone to analyzer
      this.microphoneSource.connect(this.analyserNode);

      this.frequencyData = new Uint8Array(this.analyserNode.frequencyBinCount);
      this.timeData = new Uint8Array(this.analyserNode.fftSize);

      this.isInitialized = true;
      this.isActive = true;

      logger.info('MicrophoneService', 'Microphone initialized successfully', {
        sampleRate: this.audioContext.sampleRate,
        fftSize: this.analyserNode.fftSize,
        frequencyBinCount: this.analyserNode.frequencyBinCount
      });

    } catch (error) {
      logger.error('MicrophoneService', 'Failed to initialize microphone:', error);
      throw new Error(`Microphone initialization failed: ${error.message}`);
    }
  }

  // Main analysis method - matches ElevenLabs AudioAnalyzer interface
  getAnalysis() {
    if (!this.isInitialized || !this.analyserNode || !this.frequencyData || !this.timeData) {
      return {
        energy: 0,
        centroid: 0,
        spectrum: new Array(128).fill(0)
      };
    }

    // Get frequency and time domain data
    this.analyserNode.getByteFrequencyData(this.frequencyData);
    this.analyserNode.getByteTimeDomainData(this.timeData);

    // Calculate RMS energy from time domain data with improved normalization
    let energy = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const sample = (this.timeData[i] - 128) / 128; // Convert to -1 to 1 range
      energy += sample * sample;
    }
    energy = Math.sqrt(energy / this.timeData.length);

    // Apply input gain and normalize
    energy = energy * this.inputGain;
    
    // Update baseline noise level (exponential moving average)
    if (this.energyHistory.length < 10) {
      // During initialization, collect baseline
      this.energyHistory.push(energy);
      if (this.energyHistory.length === 10) {
        this.baselineNoise = Math.min(...this.energyHistory) * 1.5;
        if (this.debugMode) {
          logger.info('MicrophoneService', 'Baseline noise level set to:', this.baselineNoise);
        }
      }
    } else {
      // Update baseline slowly
      this.baselineNoise = this.baselineNoise * 0.995 + energy * 0.005;
    }

    // Subtract baseline noise and ensure positive
    energy = Math.max(0, energy - this.baselineNoise);
    
    // Normalize energy to 0-1 range with dynamic range compression
    energy = Math.min(1.0, energy * 2.0); // Scale up for visibility

    // Calculate spectral centroid from frequency data
    let weightedSum = 0;
    let magnitudeSum = 0;
    
    for (let i = 1; i < this.frequencyData.length; i++) { // Skip DC component
      const magnitude = this.frequencyData[i] / 255; // Normalize to 0-1
      const frequency = i / this.frequencyData.length; // Normalized frequency
      
      weightedSum += frequency * magnitude;
      magnitudeSum += magnitude;
    }
    
    const centroid = magnitudeSum > 0 ? weightedSum / magnitudeSum : 0;

    // Convert frequency data to spectrum format expected by viseme picker
    const spectrum = Array.from(this.frequencyData);

    if (this.debugMode && (this.debugCounter++ % 60 === 0)) {
      logger.info('MicrophoneService', 'Audio Analysis:', {
        energy,
        centroid: centroid.toFixed(3),
        threshold: this.voiceActivityThreshold,
        isActive: energy > this.voiceActivityThreshold,
        baselineNoise: this.baselineNoise.toFixed(4),
        inputGain: this.inputGain
      });
    }

    return { energy, centroid, spectrum };
  }

  isVoiceActive() {
    if (!this.isInitialized) {
      return false;
    }
    
    const analysis = this.getAnalysis();
    return analysis.energy > this.voiceActivityThreshold;
  }

  setVoiceActivityThreshold(threshold) {
    this.voiceActivityThreshold = Math.max(0, Math.min(1, threshold));
  }

  setInputGain(gain) {
    this.inputGain = Math.max(0.1, Math.min(10, gain));
  }

  setDebugMode(enabled) {
    this.debugMode = enabled;
  }

  resetBaseline() {
    this.energyHistory = [];
    this.baselineNoise = 0;
  }

  start() {
    if (this.isInitialized) {
      this.isActive = true;
    }
  }

  stop() {
    this.isActive = false;
  }

  dispose() {
    this.isActive = false;
    
    if (this.microphoneSource) {
      this.microphoneSource.disconnect();
      this.microphoneSource = null;
    }

    if (this.microphoneStream) {
      this.microphoneStream.getTracks().forEach(track => track.stop());
      this.microphoneStream = null;
    }

    this.analyserNode = null;
    this.frequencyData = null;
    this.timeData = null;
    this.isInitialized = false;

    if (this.audioContext) {
      if (this.stateChangeHandler) {
        this.audioContext.removeEventListener('statechange', this.stateChangeHandler);
        this.stateChangeHandler = null;
      }
      if (this.audioContext.state !== 'closed') {
        this.audioContext.close();
      }
      this.audioContext = null;
    }

    logger.info('MicrophoneService', 'Microphone resources disposed');
  }

  getDebugInfo() {
    const currentAnalysis = this.getAnalysis();
    return {
      isInitialized: this.isInitialized,
      isActive: this.isActive,
      voiceActivityThreshold: this.voiceActivityThreshold,
      inputGain: this.inputGain,
      baselineNoise: this.baselineNoise,
      currentEnergy: currentAnalysis.energy,
      currentCentroid: currentAnalysis.centroid,
      debugMode: this.debugMode,
      audioContextState: this.audioContext?.state || 'none',
      hasAnalyser: !!this.analyserNode,
      hasMicrophoneStream: !!this.microphoneStream,
      energyHistoryLength: this.energyHistory.length
    };
  }
}