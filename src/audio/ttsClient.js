import { Conversation } from '@elevenlabs/client';

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
        try {
          listener[event](data);
        } catch (error) {
          console.error(`[TTSClient] Listener error for ${event}:`, error);
        }
      }
    });
  }

  async initialize() {
    try {
      // Request microphone access first (required for ElevenLabs agents)
      await this.requestMicrophoneAccess();
      
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('[TTSClient] AudioContext created, state:', this.audioContext.state);
      }

      console.log('[TTSClient] Initialized successfully');
      return true;
    } catch (error) {
      console.error('[TTSClient] Initialization failed:', error);
      this.emit('onError', { error: error.message });
      throw error;
    }
  }

  async requestMicrophoneAccess() {
    if (this.micPermissionGranted) {
      return true;
    }

    try {
      console.log('[TTSClient] Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Stop the stream immediately - we just needed permission
      stream.getTracks().forEach(track => track.stop());
      
      this.micPermissionGranted = true;
      console.log('[TTSClient] Microphone access granted');
      return true;
    } catch (error) {
      console.error('[TTSClient] Microphone access denied:', error);
      throw new Error('Microphone access is required for voice synthesis');
    }
  }

  async synthesizeSpeech(text, voiceStyle = 'cheerful') {
    const startTime = performance.now();
    this.metrics.totalRequests++;

    try {
      if (!this.config.agentId) {
        throw new Error('Agent ID is required. Set VITE_ELEVENLABS_AGENT_ID in environment variables.');
      }

      if (!this.micPermissionGranted) {
        await this.initialize();
      }

      // Resume AudioContext if suspended (iOS autoplay handling)
      if (this.audioContext && this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        console.log('[TTSClient] AudioContext resumed for user gesture');
      }

      this.emit('onSynthesisStart', { 
        text: text,
        voiceStyle: voiceStyle,
        requestId: this.metrics.totalRequests 
      });

      console.log('[TTSClient] Starting agent conversation:', { text, voiceStyle, agentId: this.config.agentId });

      // Start conversation session if not already connected
      if (!this.conversation) {
        await this.startConversation();
      }

      // Send message to agent - the agent will respond with voice automatically
      // Note: We can't directly control voice style with agents, but we can include it in the message context
      const messageWithContext = `[Voice style: ${voiceStyle}] ${text}`;
      
      // Start timing for first audio
      this.currentRequestStart = startTime;
      
      // Send the message to the agent
      // Note: ElevenLabs agents may not have a direct sendMessage method
      // The conversation might work automatically with voice input/output
      // For now, we'll simulate this - in a real implementation, you might need
      // to use the agent's specific API for sending text messages
      
      console.log('[TTSClient] Sending message to agent:', messageWithContext);
      
      // Since agents are typically voice-to-voice, we might need to simulate
      // text input or find the correct method to send text messages
      // This is a placeholder - check ElevenLabs agent documentation for the correct approach

      return true;

    } catch (error) {
      console.error('[TTSClient] Synthesis failed:', error);
      this.emit('onError', { error: error.message });
      throw error;
    }
  }

  async startConversation() {
    try {
      console.log('[TTSClient] Starting conversation session...');
      
      this.conversation = await Conversation.startSession({
        agentId: this.config.agentId,
        onConnect: () => {
          console.log('[TTSClient] Connected to agent');
          this.isConnected = true;
          this.emit('onConnect');
        },
        onDisconnect: (details) => {
          console.log('[TTSClient] Disconnected from agent:', details);
          this.isConnected = false;
          this.conversation = null;
          this.emit('onDisconnected', { details });
        },
        onMessage: (message) => {
          console.log('[TTSClient] Received message from agent:', message);
          this.handleAgentMessage(message);
        },
        onError: (error) => {
          console.error('[TTSClient] Agent error:', error);
          this.emit('onError', { error: error.message });
        },
        onStatusChange: (status) => {
          console.log('[TTSClient] Status changed:', status);
          
          // Track when agent starts/stops speaking
          if (status === 'speaking') {
            this.isPlaying = true;
            const latencyToFirstAudio = performance.now() - this.currentRequestStart;
            
            this.emit('onAudioStart', {
              latencyToFirstAudio: latencyToFirstAudio
            });
            
            console.log('[TTSClient] Agent started speaking, latency:', latencyToFirstAudio, 'ms');
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
            
            console.log('[TTSClient] Agent finished speaking, total latency:', totalLatency, 'ms');
          }
        }
      });

      console.log('[TTSClient] Conversation session started successfully');
      
    } catch (error) {
      console.error('[TTSClient] Failed to start conversation:', error);
      throw new Error(`Failed to connect to agent: ${error.message}`);
    }
  }

  handleAgentMessage(message) {
    // Handle incoming messages from the agent
    // For now, just log them - could be used for text responses
    console.log('[TTSClient] Agent message:', message);
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
      console.log('[TTSClient] Stopping current speech...');
      this.isPlaying = false;
    }
  }

  async endConversation() {
    if (this.conversation) {
      try {
        await this.conversation.endSession();
        console.log('[TTSClient] Conversation session ended');
      } catch (error) {
        console.error('[TTSClient] Error ending conversation:', error);
      }
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