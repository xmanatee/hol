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
  const visemePickerRef = useRef(null);
  const morphControllerRef = useRef(null);
  const metricsRef = useRef(null);
  
  // State tracking
  const lastFrameTimeRef = useRef(performance.now());
  const isAgentSpeakingRef = useRef(false);
  const headMeshRef = useRef(null);

  // Initialize lip-sync system
  const initialize = useCallback(async (headMesh) => {
    logger.info('useLipSync', 'Initializing lip-sync system with mesh:', headMesh.name);
    
    headMeshRef.current = headMesh;

    // Initialize components
    visemeMapperRef.current = new VisemeMapper(headMesh.morphTargetDictionary);
    audioAnalyzerRef.current = new AudioAnalyzer();
    visemePickerRef.current = new VisemePicker();
    morphControllerRef.current = new MorphController(headMesh, visemeMapperRef.current);
    metricsRef.current = new LipSyncMetrics();

    // Initialize audio analyzer
    audioAnalyzerRef.current.initialize();

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

  // Main lip-sync update loop - runs every frame
  useFrame(() => {
    if (!isActive) return;

    const currentTime = performance.now();
    const deltaTime = currentTime - lastFrameTimeRef.current;
    lastFrameTimeRef.current = currentTime;

    // Get audio analysis from agent simulation
    const audioData = audioAnalyzerRef.current.getAnalysis(
      isAgentSpeakingRef.current, 
      currentTime
    );

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

    // Set morph target influences
    const intensity = audioData.energy;
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

    // Info methods
    getDebugInfo,
    getCurrentInfluences,

    // Component refs (for advanced usage)
    visemeMapper: visemeMapperRef.current,
    morphController: morphControllerRef.current
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