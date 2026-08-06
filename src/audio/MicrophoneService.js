import { logger } from '../utils/logger.js';

const createSilentFrame = () => ({
  energy: 0,
  centroid: 0,
  voiceActive: false,
});

const stopMediaStream = (stream) => {
  stream.getTracks().forEach((track) => {
    track.stop();
  });
};

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
    this.initializationPromise = null;
    this.lifecycleGeneration = 0;
    this.voiceActivityThreshold = 0.02;
    this.inputGain = 3.0;
    this.debugMode = false;
    this.debugCounter = 0;
    this.energyHistory = [];
    this.baselineNoise = 0;
    this.stateChangeHandler = null;
    this.latestFrame = createSilentFrame();
  }

  initialize() {
    if (this.isInitialized) {
      return Promise.resolve(true);
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    const generation = this.lifecycleGeneration;
    const initialization = this._initialize(generation)
      .catch(async (error) => {
        if (generation !== this.lifecycleGeneration) {
          return false;
        }
        await this._releaseResources();
        logger.error('MicrophoneService', 'Failed to initialize microphone:', error);
        throw new Error(`Microphone initialization failed: ${error.message}`, { cause: error });
      })
      .finally(() => {
        if (this.initializationPromise === initialization) {
          this.initializationPromise = null;
        }
      });
    this.initializationPromise = initialization;
    return initialization;
  }

  async _initialize(generation) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    this.audioContext = audioContext;

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
      logger.info('MicrophoneService', 'AudioContext resumed from suspended state');
    }

    if (!this._ownsInitialization(generation, audioContext)) {
      await this._closeAudioContext(audioContext);
      return false;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 44100,
      },
    });

    if (!this._ownsInitialization(generation, audioContext)) {
      stopMediaStream(stream);
      await this._closeAudioContext(audioContext);
      return false;
    }

    const microphoneSource = audioContext.createMediaStreamSource(stream);
    const analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.3;
    analyserNode.minDecibels = -90;
    analyserNode.maxDecibels = -10;
    microphoneSource.connect(analyserNode);

    this.microphoneStream = stream;
    this.microphoneSource = microphoneSource;
    this.analyserNode = analyserNode;
    this.frequencyData = new Uint8Array(analyserNode.frequencyBinCount);
    this.timeData = new Uint8Array(analyserNode.fftSize);
    this.stateChangeHandler = () => {
      if (this.debugMode) {
        logger.info('MicrophoneService', 'AudioContext state changed to:', audioContext.state);
      }
      if (audioContext.state === 'suspended' && this.isActive) {
        audioContext.resume().catch((error) => {
          logger.error('MicrophoneService', 'Failed to resume AudioContext:', error);
        });
      }
    };
    audioContext.addEventListener('statechange', this.stateChangeHandler);
    this.isInitialized = true;
    this.isActive = true;

    logger.info('MicrophoneService', 'Microphone initialized successfully', {
      sampleRate: audioContext.sampleRate,
      fftSize: analyserNode.fftSize,
      frequencyBinCount: analyserNode.frequencyBinCount,
    });
    return true;
  }

  _ownsInitialization(generation, audioContext) {
    return generation === this.lifecycleGeneration && this.audioContext === audioContext;
  }

  readFrame() {
    if (!this.isInitialized || !this.isActive) {
      return this.latestFrame;
    }

    this.analyserNode.getByteFrequencyData(this.frequencyData);
    this.analyserNode.getByteTimeDomainData(this.timeData);

    let energy = 0;
    for (let index = 0; index < this.timeData.length; index++) {
      const sample = (this.timeData[index] - 128) / 128;
      energy += sample * sample;
    }
    energy = Math.sqrt(energy / this.timeData.length) * this.inputGain;

    if (this.energyHistory.length < 10) {
      this.energyHistory.push(energy);
      if (this.energyHistory.length === 10) {
        this.baselineNoise = Math.min(...this.energyHistory) * 1.5;
        if (this.debugMode) {
          logger.info('MicrophoneService', 'Baseline noise level set to:', this.baselineNoise);
        }
      }
    } else {
      this.baselineNoise = this.baselineNoise * 0.995 + energy * 0.005;
    }

    energy = Math.min(1, Math.max(0, energy - this.baselineNoise) * 2);

    let weightedSum = 0;
    let magnitudeSum = 0;
    for (let index = 1; index < this.frequencyData.length; index++) {
      const magnitude = this.frequencyData[index] / 255;
      weightedSum += (index / this.frequencyData.length) * magnitude;
      magnitudeSum += magnitude;
    }
    const centroid = magnitudeSum > 0 ? weightedSum / magnitudeSum : 0;
    const voiceActive = energy > this.voiceActivityThreshold;
    this.latestFrame.energy = energy;
    this.latestFrame.centroid = centroid;
    this.latestFrame.voiceActive = voiceActive;

    if (this.debugMode && this.debugCounter++ % 60 === 0) {
      logger.info('MicrophoneService', 'Audio analysis:', {
        energy,
        centroid: centroid.toFixed(3),
        threshold: this.voiceActivityThreshold,
        voiceActive,
        baselineNoise: this.baselineNoise.toFixed(4),
        inputGain: this.inputGain,
      });
    }

    return this.latestFrame;
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

  async dispose() {
    this.lifecycleGeneration++;
    this.initializationPromise = null;
    await this._releaseResources();
    logger.info('MicrophoneService', 'Microphone resources disposed');
  }

  async _releaseResources() {
    this.isActive = false;
    this.isInitialized = false;
    this.latestFrame = createSilentFrame();

    const microphoneSource = this.microphoneSource;
    const microphoneStream = this.microphoneStream;
    const audioContext = this.audioContext;
    const stateChangeHandler = this.stateChangeHandler;

    this.microphoneSource = null;
    this.microphoneStream = null;
    this.audioContext = null;
    this.stateChangeHandler = null;
    this.analyserNode = null;
    this.frequencyData = null;
    this.timeData = null;
    this.energyHistory = [];
    this.baselineNoise = 0;
    this.debugCounter = 0;

    microphoneSource?.disconnect();
    if (microphoneStream) {
      stopMediaStream(microphoneStream);
    }
    if (audioContext && stateChangeHandler) {
      audioContext.removeEventListener('statechange', stateChangeHandler);
    }
    await this._closeAudioContext(audioContext);
  }

  _closeAudioContext(audioContext) {
    if (audioContext && audioContext.state !== 'closed') {
      return audioContext.close();
    }
    return Promise.resolve();
  }
}
