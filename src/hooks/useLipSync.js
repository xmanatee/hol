// Phase 12 - useLipSync React Hook
// Integrates lip-sync system with ElevenLabs agents and R3F render loop

import { useState, useRef, useEffect, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { 
  VisemeMapper, 
  AudioAnalyzer, 
  VisemePicker, 
  MorphController,
  LipSyncMetrics 
} from '../audio/lipSync.js';
import { MicrophoneService } from '../audio/MicrophoneService.js';
import { logger } from '../utils/logger.js';

export const useLipSync = () => {
  const [isActive, setIsActive] = useState(false);
  const [currentViseme, setCurrentViseme] = useState('M');
  const [metrics, setMetrics] = useState({
    avSyncError: 0,
    visemeStability: 100,
    frameRate: 0,
    totalFrames: 0
  });

  // Core lip-sync components
  const visemeMapperRef = useRef(null);
  const audioAnalyzerRef = useRef(null);
  const microphoneServiceRef = useRef(null);
  const visemePickerRef = useRef(null);
  const morphControllerRef = useRef(null);
  const metricsRef = useRef(null);
  
  // State tracking
  const lastFrameTimeRef = useRef(performance.now());
  const isAgentSpeakingRef = useRef(false);
  const headMeshRef = useRef(null);
  const microphoneModeRef = useRef(false);

  // Initialize lip-sync system
  const initialize = useCallback(async (headMesh, microphoneMode = false) => {
    logger.info('useLipSync', 'Initializing lip-sync system with mesh:', headMesh.name, 'microphone mode:', microphoneMode);
    
    headMeshRef.current = headMesh;
    microphoneModeRef.current = microphoneMode;

    // Initialize components
    visemeMapperRef.current = new VisemeMapper(headMesh.morphTargetDictionary);
    visemePickerRef.current = new VisemePicker();
    morphControllerRef.current = new MorphController(headMesh, visemeMapperRef.current);
    metricsRef.current = new LipSyncMetrics();

    // Initialize audio sources
    audioAnalyzerRef.current = new AudioAnalyzer();
    audioAnalyzerRef.current.initialize();

    if (microphoneMode) {
      microphoneServiceRef.current = new MicrophoneService();
      await microphoneServiceRef.current.initialize();
    }

    logger.info('useLipSync', 'Lip-sync system initialized');
    logger.info('useLipSync', 'Viseme mapping:', visemeMapperRef.current.visemeMap);
  }, []);

  // Start lip-sync
  const start = useCallback((isAgentSpeaking = true) => {
    logger.info('useLipSync', 'Starting lip-sync, agent speaking:', isAgentSpeaking);
    setIsActive(true);
    isAgentSpeakingRef.current = isAgentSpeaking;
    lastFrameTimeRef.current = performance.now();
  }, []);

  // Stop lip-sync
  const stop = useCallback(() => {
    logger.info('useLipSync', 'Stopping lip-sync');
    setIsActive(false);
    isAgentSpeakingRef.current = false;
    setCurrentViseme('M'); // Return to mouth closed
    
    // Reset morph influences to mouth closed
    if (morphControllerRef.current) {
      morphControllerRef.current.setViseme('M', 1.0);
    }
  }, []);

  // Update agent speaking status
  const setAgentSpeaking = useCallback((speaking) => {
    isAgentSpeakingRef.current = speaking;
    
    if (speaking) {
      if (!isActive) {
        start(true);
      }
    } else {
      // Gradually return to mouth closed when agent stops speaking
      if (morphControllerRef.current) {
        morphControllerRef.current.setViseme('M', 1.0);
      }
      setCurrentViseme('M');
    }
  }, [isActive, start]);

  // Switch between microphone and agent mode
  const setMicrophoneMode = useCallback(async (enabled) => {
    microphoneModeRef.current = enabled;
    
    if (enabled) {
      // Initialize microphone service if not already done
      if (!microphoneServiceRef.current) {
        microphoneServiceRef.current = new MicrophoneService();
        await microphoneServiceRef.current.initialize();
      }
      microphoneServiceRef.current.start();
      logger.info('useLipSync', 'Switched to microphone mode');
      
      // Auto-start lip-sync when microphone mode is enabled
      if (!isActive) {
        start(true);
      }
    } else {
      if (microphoneServiceRef.current) {
        microphoneServiceRef.current.stop();
      }
      logger.info('useLipSync', 'Switched to agent mode');
    }
  }, [isActive, start]);

  // Set voice activity threshold for microphone mode
  const setVoiceActivityThreshold = useCallback((threshold) => {
    if (microphoneServiceRef.current) {
      microphoneServiceRef.current.setVoiceActivityThreshold(threshold);
    }
  }, []);

  // Check if voice is currently active (for microphone mode)
  const isVoiceActive = useCallback(() => {
    if (microphoneModeRef.current && microphoneServiceRef.current) {
      return microphoneServiceRef.current.isVoiceActive();
    }
    return false;
  }, []);

  // Main lip-sync update loop - runs every frame
  useFrame(() => {
    if (!isActive) return;

    const currentTime = performance.now();
    const deltaTime = currentTime - lastFrameTimeRef.current;
    lastFrameTimeRef.current = currentTime;

    // Get audio analysis from appropriate source
    let audioData;
    let isCurrentlyVoiceActive;

    if (microphoneModeRef.current && microphoneServiceRef.current) {
      // Use microphone service
      audioData = microphoneServiceRef.current.getAnalysis();
      isCurrentlyVoiceActive = microphoneServiceRef.current.isVoiceActive();
    } else {
      // Use ElevenLabs agent simulation
      audioData = audioAnalyzerRef.current.getAnalysis(
        isAgentSpeakingRef.current, 
        currentTime
      );
      isCurrentlyVoiceActive = isAgentSpeakingRef.current;
    }

    // Pick appropriate viseme based on audio
    const selectedViseme = visemePickerRef.current.pickViseme(
      audioData.energy,
      audioData.centroid,
      currentTime
    );

    // Update current viseme state
    if (selectedViseme !== currentViseme) {
      setCurrentViseme(selectedViseme);
    }

    // Set morph target influences (reduce intensity if voice not active)
    const intensity = isCurrentlyVoiceActive ? audioData.energy : 0;
    morphControllerRef.current.setViseme(selectedViseme, intensity);

    // Update morph controller (handles blending and blink animation)
    morphControllerRef.current.update(deltaTime);

    // Record metrics
    metricsRef.current.recordFrame(
      audioData.energy,
      selectedViseme,
      morphControllerRef.current.currentInfluences
    );

    // Update metrics every 30 frames (~0.5s at 60fps)
    if (metricsRef.current.frameCount % 30 === 0) {
      setMetrics(metricsRef.current.getMetrics());
    }
  });

  // Cleanup
  useEffect(() => {
    return () => {
      if (audioAnalyzerRef.current) {
        audioAnalyzerRef.current.dispose();
      }
      if (microphoneServiceRef.current) {
        microphoneServiceRef.current.dispose();
      }
    };
  }, []);

  // Debug info
  const getDebugInfo = useCallback(() => {
    return {
      isActive,
      currentViseme,
      isAgentSpeaking: isAgentSpeakingRef.current,
      hasHeadMesh: !!headMeshRef.current,
      hasMorphTargets: !!(headMeshRef.current?.morphTargetInfluences),
      morphTargetCount: headMeshRef.current?.morphTargetInfluences?.length || 0,
      visemeMapping: visemeMapperRef.current?.visemeMap || {},
      metrics
    };
  }, [isActive, currentViseme, metrics]);

  // Get current morph influences (for external monitoring)
  const getCurrentInfluences = useCallback(() => {
    return morphControllerRef.current?.currentInfluences || {};
  }, []);

  return {
    // State
    isActive,
    currentViseme,
    metrics,

    // Control methods
    initialize,
    start,
    stop,
    setAgentSpeaking,
    setMicrophoneMode,
    setVoiceActivityThreshold,

    // Info methods
    getDebugInfo,
    getCurrentInfluences,
    isVoiceActive,

    // Component refs (for advanced usage)
    visemeMapper: visemeMapperRef.current,
    morphController: morphControllerRef.current,
    audioAnalyzer: audioAnalyzerRef.current,
    microphoneService: microphoneServiceRef.current
  };
};

// Utility hook for integrating with HeadAnchor component
export const useHeadLipSync = (headMesh) => {
  const lipSync = useLipSync();
  
  // Auto-initialize when head mesh becomes available
  useEffect(() => {
    if (headMesh && headMesh.morphTargetDictionary && !lipSync.isActive) {
      logger.info('useHeadLipSync', 'Auto-initializing lip-sync for head mesh');
      lipSync.initialize(headMesh);
    }
  }, [headMesh, lipSync]);

  return lipSync;
};

export default useLipSync;