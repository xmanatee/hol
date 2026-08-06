import { writeAudioAnalysisFromFrequencyData } from './lipSync.js';
import { buildSpeechInstructions } from './speechPerformance.js';
import { LocalAIClient } from '../api/localAIClient.js';
import { readViteEnv } from '../api/viteEnv.js';
import { logger } from '../utils/logger.js';
import { normalizeSpeechPerformance } from '../contracts/objectPerformance.js';
import { SPEECH_INPUT_MAX_CHARACTERS, readBoundedText } from '../contracts/objectContent.js';

export class TTSClient {
  constructor(config = {}) {
    this.config = {
      model: config.model ?? readViteEnv('VITE_LOCAL_AI_TTS_MODEL'),
      voice: config.voice ?? readViteEnv('VITE_LOCAL_AI_TTS_VOICE'),
      responseFormat: config.responseFormat ?? 'wav',
    };
    if (
      typeof this.config.model !== 'string' ||
      this.config.model.trim().length === 0 ||
      typeof this.config.voice !== 'string' ||
      this.config.voice.trim().length === 0
    ) {
      throw new Error(
        'Set VITE_LOCAL_AI_TTS_MODEL and VITE_LOCAL_AI_TTS_VOICE to enable local speech synthesis.',
      );
    }
    if (typeof this.config.responseFormat !== 'string' || this.config.responseFormat.trim().length === 0) {
      throw new TypeError('Speech response format must be a non-empty string.');
    }
    this.config.model = this.config.model.trim();
    this.config.voice = this.config.voice.trim();
    this.config.responseFormat = this.config.responseFormat.trim();

    if (Object.hasOwn(config, 'aiClient') && typeof config.aiClient?.createSpeech !== 'function') {
      throw new TypeError('Speech aiClient must implement createSpeech.');
    }
    this.aiClient = Object.hasOwn(config, 'aiClient')
      ? config.aiClient
      : new LocalAIClient({
          ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
          ...(Object.hasOwn(config, 'fetchImpl') ? { fetchImpl: config.fetchImpl } : {}),
          ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
          ...(Object.hasOwn(config, 'scheduleRequestTimeout')
            ? { scheduleRequestTimeout: config.scheduleRequestTimeout }
            : {}),
        });
    this.AudioContextClass = config.AudioContextClass ?? null;
    this.audioContext = null;
    this.sourceNode = null;
    this.analyserNode = null;
    this.frequencyData = null;
    this.latestFrame = { energy: 0, centroid: 0 };
    this.currentAbortController = null;
    this.currentRequest = null;
    this.isPlaying = false;
    this.disposed = false;
    this.runtimeGeneration = 0;
    this.listeners = new Set();
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      averageLatency: 0,
      lastLatency: 0,
    };
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, data) {
    this.listeners.forEach((listener) => {
      listener[event]?.(data);
    });
  }

  initialize() {
    if (this.disposed) {
      return false;
    }
    if (!this.audioContext) {
      const AudioContextClass = this.AudioContextClass || window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('AudioContext is required for speech playback.');
      }
      this.audioContext = new AudioContextClass();
    }
    return true;
  }

  async _ensureAudioContextReady(runtimeGeneration) {
    const initialized = await this.initialize();
    if (!initialized || this.disposed || this.runtimeGeneration !== runtimeGeneration) {
      return false;
    }

    const audioContext = this.audioContext;
    if (audioContext.state === 'suspended') {
      const resumed = await audioContext.resume().then(
        () => true,
        (error) => {
          if (
            this.disposed ||
            this.runtimeGeneration !== runtimeGeneration ||
            this.audioContext !== audioContext
          ) {
            return false;
          }
          throw error;
        },
      );
      if (!resumed) {
        return false;
      }
    }
    return (
      !this.disposed && this.runtimeGeneration === runtimeGeneration && this.audioContext === audioContext
    );
  }

  _ownsRequest(requestId, runtimeGeneration) {
    return (
      !this.disposed &&
      this.runtimeGeneration === runtimeGeneration &&
      this.currentRequest?.requestId === requestId
    );
  }

  async synthesizeSpeech(text, voiceStyle, emotionalDelivery) {
    const input = readBoundedText(text, {
      label: 'Speech input',
      maxCharacters: SPEECH_INPUT_MAX_CHARACTERS,
    });
    const speechPerformance = normalizeSpeechPerformance(voiceStyle, emotionalDelivery);

    if (this.disposed) {
      return false;
    }
    const runtimeGeneration = this.runtimeGeneration;
    if (!(await this._ensureAudioContextReady(runtimeGeneration))) {
      return false;
    }
    this.stopCurrentAudio();

    const startedAt = performance.now();
    const requestId = ++this.metrics.totalRequests;
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.currentRequest = { requestId, text: input, ...speechPerformance, startedAt };
    this.emit('onSynthesisStart', { requestId, text: input, ...speechPerformance });

    try {
      const encodedAudio = await this.aiClient.createSpeech(
        {
          model: this.config.model,
          voice: this.config.voice,
          input,
          instructions: buildSpeechInstructions(
            speechPerformance.voiceStyle,
            speechPerformance.emotionalDelivery,
          ),
          response_format: this.config.responseFormat,
        },
        { signal: abortController.signal },
      );
      if (!this._ownsRequest(requestId, runtimeGeneration)) {
        return false;
      }
      const audioBuffer = await this.audioContext.decodeAudioData(encodedAudio);
      if (!this._ownsRequest(requestId, runtimeGeneration)) {
        return false;
      }

      this._startPlayback(audioBuffer, startedAt);
      return true;
    } catch (error) {
      if (!this._ownsRequest(requestId, runtimeGeneration)) {
        return false;
      }
      this.currentRequest = null;
      this.currentAbortController = null;
      this.emit('onError', { error: error.message });
      throw error;
    }
  }

  _startPlayback(audioBuffer, startedAt) {
    const sourceNode = this.audioContext.createBufferSource();
    const analyserNode = this.audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(analyserNode);
    analyserNode.connect(this.audioContext.destination);
    sourceNode.onended = () => this._completePlayback();
    this.sourceNode = sourceNode;
    this.analyserNode = analyserNode;
    this.frequencyData = new Uint8Array(analyserNode.frequencyBinCount);
    this.isPlaying = true;

    const latencyToFirstAudio = performance.now() - startedAt;
    this.emit('onAudioStart', { latencyToFirstAudio });
    sourceNode.start();
  }

  readFrame() {
    if (!this.isPlaying) {
      return this.latestFrame;
    }
    this.analyserNode.getByteFrequencyData(this.frequencyData);
    return writeAudioAnalysisFromFrequencyData(this.frequencyData, 1, this.latestFrame);
  }

  _completePlayback() {
    if (!this.isPlaying && !this.currentRequest) {
      return;
    }

    const request = this.currentRequest;
    this.isPlaying = false;
    this.sourceNode = null;
    this.analyserNode = null;
    this.frequencyData = null;
    this.latestFrame.energy = 0;
    this.latestFrame.centroid = 0;
    this.currentAbortController = null;
    this.currentRequest = null;
    this.emit('onPlaybackComplete');

    if (request) {
      const latency = performance.now() - request.startedAt;
      this.metrics.successfulRequests++;
      this.metrics.lastLatency = latency;
      this.metrics.averageLatency = this.calculateMovingAverage(this.metrics.averageLatency, latency);
      this.emit('onSynthesisComplete', {
        text: request.text,
        voiceStyle: request.voiceStyle,
        emotionalDelivery: request.emotionalDelivery,
        latency,
      });
    }
  }

  calculateMovingAverage(currentAverage, newValue, alpha = 0.15) {
    return currentAverage === 0 ? newValue : currentAverage + alpha * (newValue - currentAverage);
  }

  stopCurrentAudio() {
    this.currentAbortController?.abort();
    this.currentAbortController = null;
    if (this.sourceNode && this.isPlaying) {
      const sourceNode = this.sourceNode;
      this.sourceNode = null;
      sourceNode.onended = null;
      sourceNode.stop();
      this._completePlayback();
    } else if (this.currentRequest) {
      this.currentRequest = null;
      this.emit('onPlaybackComplete');
    }
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

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.runtimeGeneration++;
    this.stopCurrentAudio();
    this.listeners.clear();
    const audioContext = this.audioContext;
    this.audioContext = null;
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close();
    }
    logger.info('TTSClient', 'Local speech runtime disposed');
  }
}
