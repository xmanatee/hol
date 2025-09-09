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
    this.voiceActivityThreshold = 0.15; // Threshold for detecting voice activity
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
        logger.info('MicrophoneService', 'AudioContext resumed');
      }

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

      // Prepare data buffers
      this.frequencyData = new Uint8Array(this.analyserNode.frequencyBinCount); // 128 bins
      this.timeData = new Uint8Array(this.analyserNode.fftSize); // 256 samples

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

    // Calculate RMS energy from time domain data
    let energy = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const sample = (this.timeData[i] - 128) / 128; // Convert to -1 to 1 range
      energy += sample * sample;
    }
    energy = Math.sqrt(energy / this.timeData.length);

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

    return { energy, centroid, spectrum };
  }

  // Voice activity detection
  isVoiceActive() {
    if (!this.isInitialized) {
      return false;
    }
    
    const analysis = this.getAnalysis();
    return analysis.energy > this.voiceActivityThreshold;
  }

  // Set voice activity detection threshold
  setVoiceActivityThreshold(threshold) {
    this.voiceActivityThreshold = Math.max(0, Math.min(1, threshold));
    logger.info('MicrophoneService', 'Voice activity threshold set to:', this.voiceActivityThreshold);
  }

  // Start microphone analysis
  start() {
    if (this.isInitialized) {
      this.isActive = true;
      logger.info('MicrophoneService', 'Microphone analysis started');
    }
  }

  // Stop microphone analysis
  stop() {
    this.isActive = false;
    logger.info('MicrophoneService', 'Microphone analysis stopped');
  }

  // Clean up microphone resources
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

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }

    logger.info('MicrophoneService', 'Microphone resources disposed');
  }

  // Get debug information
  getDebugInfo() {
    return {
      isInitialized: this.isInitialized,
      isActive: this.isActive,
      voiceActivityThreshold: this.voiceActivityThreshold,
      audioContextState: this.audioContext?.state || 'none',
      hasAnalyser: !!this.analyserNode,
      hasMicrophoneStream: !!this.microphoneStream
    };
  }
}