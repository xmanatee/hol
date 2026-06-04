import { Conversation } from '@elevenlabs/client';
import { createAudioAnalysisFromFrequencyData } from './lipSync.js';
import { buildExpressivePrompt } from './ttsPerformance.js';
import { logger } from '../utils/logger.js';

export class TTSClient {
  constructor(config = {}) {
    this.config = {
      agentId: config.agentId || import.meta.env.VITE_ELEVENLABS_AGENT_ID,
      ...config
    };
    
    this.conversation = null;
    this.audioContext = null;
    this.audioAnalysisInterval = null;
    this.isConnected = false;
    this.isPlaying = false;
    this.micPermissionGranted = false;
    this.currentRequest = null;
    this.speechStartedAt = null;
    this.lastOutputActivityAt = null;
    this.outputSilenceEnergyThreshold = config.outputSilenceEnergyThreshold ?? 0.018;
    this.outputSilenceCompletionMs = config.outputSilenceCompletionMs ?? 1200;
    this.minimumOutputDurationMs = config.minimumOutputDurationMs ?? 420;
    
    this.listeners = new Set();
    
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      averageLatency: 0,
      lastLatency: 0
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

  async initialize() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      logger.info('TTSClient', 'AudioContext created, state:', this.audioContext.state);
    }

    logger.info('TTSClient', 'Initialized successfully');
  }

  async _ensureAudioContextReady() {
    await this.initialize();

    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
      logger.info('TTSClient', 'AudioContext resumed for user gesture');
    }
  }

  async requestMicrophoneAccess() {
    if (this.micPermissionGranted) {
      return;
    }

    logger.info('TTSClient', 'Requesting microphone access...');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Stop the stream immediately - we just needed permission
    stream.getTracks().forEach(track => track.stop());
    
    this.micPermissionGranted = true;
    logger.info('TTSClient', 'Microphone access granted');
  }

  buildExpressivePrompt(text, voiceStyle = 'cheerful', emotionalDelivery = '') {
    return buildExpressivePrompt(text, voiceStyle, emotionalDelivery);
  }

  async synthesizeSpeech(text, voiceStyle = 'cheerful', emotionalDelivery = '') {
    const startTime = performance.now();
    this.metrics.totalRequests++;

    await this._ensureAudioContextReady();

    this.emit('onSynthesisStart', { 
      text: text,
      voiceStyle: voiceStyle,
      emotionalDelivery,
      requestId: this.metrics.totalRequests 
    });

    logger.info('TTSClient', 'Starting agent conversation:', { text, voiceStyle, emotionalDelivery, agentId: this.config.agentId });

    // Start conversation session if not already connected
    if (!this.conversation) {
      await this.startConversation();
    }

    const messageWithContext = this.buildExpressivePrompt(text, voiceStyle, emotionalDelivery);
    
    // Start timing for first audio
    this.currentRequestStart = startTime;
    this.currentRequest = { text, voiceStyle, emotionalDelivery };
    
    logger.info('TTSClient', 'Sending message to agent:', messageWithContext);
    this.conversation.sendUserMessage(messageWithContext);
    return true;
  }

  _buildSessionOptions() {
    return {
      agentId: this.config.agentId,
      connectionType: 'webrtc',
      preferHeadphonesForIosDevices: true,
      onConnect: () => {
        logger.info('TTSClient', 'Connected to agent');
        this.isConnected = true;
        this.emit('onConnect');
      },
      onDisconnect: (details) => {
        logger.info('TTSClient', 'Disconnected from agent:', details);
        if (this.isPlaying) {
          this._completePlayback();
        } else {
          this._stopAudioAnalysisLoop();
        }
        this.isConnected = false;
        this.conversation = null;
        this.emit('onDisconnected', { details });
      },
      onMessage: (message) => {
        logger.info('TTSClient', 'Received message from agent:', message);
        this.handleAgentMessage(message);
      },
      onError: (error, context) => {
        logger.error('TTSClient', 'Agent error:', error, context);
        if (this.isPlaying) {
          this._completePlayback();
        } else {
          this._stopAudioAnalysisLoop();
        }
        this.emit('onError', { error: error.message || String(error) });
      },
      onAudioAlignment: (alignment) => {
        this.emit('onAudioAlignment', {
          ...alignment,
          receivedAt: performance.now()
        });
      },
      onStatusChange: ({ status }) => {
        logger.info('TTSClient', 'Status changed:', status);
      },
      onModeChange: ({ mode }) => {
        this._handleModeChange(mode);
      }
    };
  }

  async startConversation() {
    if (this.conversation) {
      return;
    }

    if (!this.config.agentId) {
      throw new Error('Set VITE_ELEVENLABS_AGENT_ID to enable voice playback.');
    }

    logger.info('TTSClient', 'Starting conversation session...');
    await this._ensureAudioContextReady();
    await this.requestMicrophoneAccess();

    this.conversation = await Conversation.startSession(this._buildSessionOptions());

    logger.info('TTSClient', 'Conversation session started successfully');
  }

  _handleModeChange(mode) {
    logger.info('TTSClient', 'Mode changed:', mode);

    if (mode === 'speaking') {
      this.isPlaying = true;
      const now = performance.now();
      this.speechStartedAt = now;
      this.lastOutputActivityAt = now;
      const requestStart = this.currentRequestStart || now;
      const latencyToFirstAudio = now - requestStart;

      this.emit('onAudioStart', {
        latencyToFirstAudio: latencyToFirstAudio
      });
      this._startAudioAnalysisLoop();

      logger.info('TTSClient', 'Agent started speaking, latency:', latencyToFirstAudio, 'ms');
    } else if (mode === 'listening' && this.isPlaying) {
      this._completePlayback();
    }
  }

  _completePlayback() {
    this.isPlaying = false;
    this._stopAudioAnalysisLoop();
    const requestStart = this.currentRequestStart || performance.now();
    const totalLatency = performance.now() - requestStart;

    this.metrics.successfulRequests++;
    this.metrics.lastLatency = totalLatency;
    this.metrics.averageLatency = this.calculateMovingAverage(this.metrics.averageLatency, totalLatency);

    this.emit('onPlaybackComplete');
    this.emit('onSynthesisComplete', {
      text: this.currentRequest?.text,
      voiceStyle: this.currentRequest?.voiceStyle,
      emotionalDelivery: this.currentRequest?.emotionalDelivery,
      latency: totalLatency
    });
    this.currentRequest = null;
    this.speechStartedAt = null;
    this.lastOutputActivityAt = null;

    logger.info('TTSClient', 'Agent finished speaking, total latency:', totalLatency, 'ms');
  }

  _handleOutputAnalysis(analysis, timestamp = performance.now()) {
    this.emit('onAudioAnalysis', analysis);

    if (!this.isPlaying) {
      return;
    }

    const energy = Number.isFinite(analysis.energy) ? analysis.energy : 0;
    if (energy >= this.outputSilenceEnergyThreshold) {
      this.lastOutputActivityAt = timestamp;
      return;
    }

    const speechStartedAt = this.speechStartedAt ?? timestamp;
    const lastOutputActivityAt = this.lastOutputActivityAt ?? speechStartedAt;
    const longEnoughToBeSpeech = timestamp - speechStartedAt >= this.minimumOutputDurationMs;
    const silentLongEnough = timestamp - lastOutputActivityAt >= this.outputSilenceCompletionMs;

    if (longEnoughToBeSpeech && silentLongEnough) {
      logger.info('TTSClient', 'Completing playback after sustained output silence');
      this._completePlayback();
    }
  }

  _handleOutputAnalysisError(error) {
    if (this.isPlaying) {
      this._completePlayback();
    } else {
      this._stopAudioAnalysisLoop();
    }
    this.emit('onError', { error: error.message || String(error) });
  }

  _startAudioAnalysisLoop() {
    this._stopAudioAnalysisLoop();

    this.audioAnalysisInterval = window.setInterval(async () => {
      if (!this.conversation || !this.isPlaying) {
        return;
      }

      try {
        const frequencyData = await this.conversation.getOutputByteFrequencyData();
        const volume = await this.conversation.getOutputVolume();
        if (!frequencyData) {
          this._handleOutputAnalysis({ energy: 0, centroid: 0, spectrum: [] });
          return;
        }
        this._handleOutputAnalysis(createAudioAnalysisFromFrequencyData(frequencyData, volume));
      } catch (error) {
        this._handleOutputAnalysisError(error);
      }
    }, 33);
  }

  _stopAudioAnalysisLoop() {
    if (this.audioAnalysisInterval) {
      window.clearInterval(this.audioAnalysisInterval);
      this.audioAnalysisInterval = null;
    }
  }

  handleAgentMessage(message) {
    logger.info('TTSClient', 'Agent message:', message);
    this.emit('onMessage', message);
  }

  calculateMovingAverage(currentAvg, newValue, alpha = 0.15) {
    return currentAvg === 0 ? newValue : currentAvg + alpha * (newValue - currentAvg);
  }

  stopCurrentAudio() {
    if (this.conversation && this.isPlaying) {
      logger.info('TTSClient', 'Stopping current speech...');
      this._completePlayback();
    }
  }

  async endConversation() {
    if (this.conversation) {
      this._stopAudioAnalysisLoop();
      await this.conversation.endSession();
      logger.info('TTSClient', 'Conversation session ended');
      this.conversation = null;
      this.isConnected = false;
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalRequests > 0 
        ? (this.metrics.successfulRequests / this.metrics.totalRequests) * 100 
        : 0
    };
  }

  async dispose() {
    await this.endConversation();
    this.stopCurrentAudio();
    this.listeners.clear();
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
  }
}
