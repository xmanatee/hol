import { Conversation } from '@elevenlabs/client';
import { logger } from '../utils/logger.js';

export class TTSClient {
  constructor(config = {}) {
    this.config = {
      agentId: config.agentId || import.meta.env.VITE_ELEVENLABS_AGENT_ID,
      ...config
    };
    
    this.conversation = null;
    this.audioContext = null;
    this.isConnected = false;
    this.isPlaying = false;
    this.micPermissionGranted = false;
    
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
    // Request microphone access first (required for ElevenLabs agents)
    await this.requestMicrophoneAccess();
    
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      logger.info('TTSClient', 'AudioContext created, state:', this.audioContext.state);
    }

    logger.info('TTSClient', 'Initialized successfully');
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

  async synthesizeSpeech(text, voiceStyle = 'cheerful') {
    const startTime = performance.now();
    this.metrics.totalRequests++;

    if (!this.micPermissionGranted) {
      await this.initialize();
    }

    // Resume AudioContext if suspended (iOS autoplay handling)
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
      logger.info('TTSClient', 'AudioContext resumed for user gesture');
    }

    this.emit('onSynthesisStart', { 
      text: text,
      voiceStyle: voiceStyle,
      requestId: this.metrics.totalRequests 
    });

    logger.info('TTSClient', 'Starting agent conversation:', { text, voiceStyle, agentId: this.config.agentId });

    // Start conversation session if not already connected
    if (!this.conversation) {
      await this.startConversation();
    }

    // Send message to agent with voice style context
    const messageWithContext = `[Voice style: ${voiceStyle}] ${text}`;
    
    // Start timing for first audio
    this.currentRequestStart = startTime;
    
    logger.info('TTSClient', 'Sending message to agent:', messageWithContext);
  }

  async startConversation() {
    logger.info('TTSClient', 'Starting conversation session...');
    
    this.conversation = await Conversation.startSession({
      agentId: this.config.agentId,
      onConnect: () => {
        logger.info('TTSClient', 'Connected to agent');
        this.isConnected = true;
        this.emit('onConnect');
      },
      onDisconnect: (details) => {
        logger.info('TTSClient', 'Disconnected from agent:', details);
        this.isConnected = false;
        this.conversation = null;
        this.emit('onDisconnected', { details });
      },
      onMessage: (message) => {
        logger.info('TTSClient', 'Received message from agent:', message);
        this.handleAgentMessage(message);
      },
      onError: (error) => {
        logger.error('TTSClient', 'Agent error:', error);
        this.emit('onError', { error: error.message });
      },
      onStatusChange: (status) => {
        logger.info('TTSClient', 'Status changed:', status);
        
        // Track when agent starts/stops speaking
        if (status === 'speaking') {
          this.isPlaying = true;
          const latencyToFirstAudio = performance.now() - this.currentRequestStart;
          
          this.emit('onAudioStart', {
            latencyToFirstAudio: latencyToFirstAudio
          });
          
          logger.info('TTSClient', 'Agent started speaking, latency:', latencyToFirstAudio, 'ms');
        } else if (status === 'listening' && this.isPlaying) {
          this.isPlaying = false;
          const totalLatency = performance.now() - this.currentRequestStart;
          
          this.metrics.successfulRequests++;
          this.metrics.lastLatency = totalLatency;
          this.metrics.averageLatency = this.calculateMovingAverage(this.metrics.averageLatency, totalLatency);
          
          this.emit('onPlaybackComplete');
          this.emit('onSynthesisComplete', { 
            latency: totalLatency 
          });
          
          logger.info('TTSClient', 'Agent finished speaking, total latency:', totalLatency, 'ms');
        }
      }
    });

    logger.info('TTSClient', 'Conversation session started successfully');
  }

  handleAgentMessage(message) {
    // Handle incoming messages from the agent
    // For now, just log them - could be used for text responses
    logger.info('TTSClient', 'Agent message:', message);
  }

  // Note: Audio analysis for lip-sync will need to be implemented differently with agents
  // The agent platform handles audio playback internally, so we'll need to find alternative ways
  // to get audio analysis data for lip-sync in Phase 12

  calculateMovingAverage(currentAvg, newValue, alpha = 0.15) {
    return currentAvg === 0 ? newValue : currentAvg + alpha * (newValue - currentAvg);
  }

  stopCurrentAudio() {
    if (this.conversation && this.isPlaying) {
      // For agents, we might not have direct control to stop mid-speech
      // But we can end the conversation session
      logger.info('TTSClient', 'Stopping current speech...');
      this.isPlaying = false;
    }
  }

  async endConversation() {
    if (this.conversation) {
      this.conversation.endSession();
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