import { useState, useRef, useEffect, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { 
  VisemeMapper, 
  AudioAnalyzer, 
  VisemePicker, 
  MorphController,
  LipSyncMetrics,
  pickVisemeFromAlignment
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

  const visemeMapperRef = useRef(null);
  const audioAnalyzerRef = useRef(null);
  const microphoneServiceRef = useRef(null);
  const visemePickerRef = useRef(null);
  const morphControllerRef = useRef(null);
  const metricsRef = useRef(null);
  const lastFrameTimeRef = useRef(performance.now());
  const isAgentSpeakingRef = useRef(false);
  const headMeshRef = useRef(null);
  const microphoneModeRef = useRef(false);
  const externalAgentAudioRef = useRef(null);
  const externalAgentAlignmentRef = useRef(null);

  const initialize = useCallback(async (headMesh, microphoneMode = false) => {
    headMeshRef.current = headMesh;
    microphoneModeRef.current = microphoneMode;

    visemeMapperRef.current = new VisemeMapper(headMesh.morphTargetDictionary);
    visemePickerRef.current = new VisemePicker();
    morphControllerRef.current = new MorphController(headMesh, visemeMapperRef.current);
    metricsRef.current = new LipSyncMetrics();
    audioAnalyzerRef.current = new AudioAnalyzer();
    audioAnalyzerRef.current.initialize();

    if (microphoneMode) {
      microphoneServiceRef.current = new MicrophoneService();
      await microphoneServiceRef.current.initialize();
    }
  }, []);

  const start = useCallback((isAgentSpeaking = true) => {
    setIsActive(true);
    isAgentSpeakingRef.current = isAgentSpeaking;
    lastFrameTimeRef.current = performance.now();
  }, []);

  const stop = useCallback(() => {
    setIsActive(false);
    isAgentSpeakingRef.current = false;
    externalAgentAudioRef.current = null;
    externalAgentAlignmentRef.current = null;
    setCurrentViseme('M');
    if (morphControllerRef.current) {
      morphControllerRef.current.resetTargets();
    }
  }, []);

  const setAgentSpeaking = useCallback((speaking) => {
    isAgentSpeakingRef.current = speaking;
    if (speaking) {
      if (!isActive) {
        start(true);
      }
    } else {
      if (morphControllerRef.current) {
        morphControllerRef.current.resetTargets();
      }
      externalAgentAudioRef.current = null;
      externalAgentAlignmentRef.current = null;
      setCurrentViseme('M');
    }
  }, [isActive, start]);

  const setAgentAudioAnalysis = useCallback((audioData) => {
    externalAgentAudioRef.current = {
      energy: audioData.energy,
      centroid: audioData.centroid,
      spectrum: audioData.spectrum,
      receivedAt: performance.now()
    };
  }, []);

  const setAgentAudioAlignment = useCallback((alignment) => {
    externalAgentAlignmentRef.current = {
      data: alignment,
      receivedAt: alignment.receivedAt || performance.now()
    };
  }, []);

  const setMicrophoneMode = useCallback(async (enabled) => {
    microphoneModeRef.current = enabled;
    if (enabled) {
      if (!microphoneServiceRef.current) {
        microphoneServiceRef.current = new MicrophoneService();
        await microphoneServiceRef.current.initialize();
      }
      microphoneServiceRef.current.start();
      setIsActive(true);
      isAgentSpeakingRef.current = true;
      lastFrameTimeRef.current = performance.now();
    } else {
      if (microphoneServiceRef.current) {
        microphoneServiceRef.current.stop();
      }
    }
  }, []);

  const setVoiceActivityThreshold = useCallback((threshold) => {
    microphoneServiceRef.current?.setVoiceActivityThreshold(threshold);
  }, []);

  const setMicrophoneGain = useCallback((gain) => {
    microphoneServiceRef.current?.setInputGain(gain);
  }, []);

  const setMicrophoneDebugMode = useCallback((enabled) => {
    microphoneServiceRef.current?.setDebugMode(enabled);
  }, []);

  const resetMicrophoneBaseline = useCallback(() => {
    microphoneServiceRef.current?.resetBaseline();
  }, []);

  const isVoiceActive = useCallback(() => {
    if (microphoneModeRef.current && microphoneServiceRef.current) {
      return microphoneServiceRef.current.isVoiceActive();
    }
    return false;
  }, []);

  const getMicrophoneAnalysis = useCallback(() => {
    return microphoneServiceRef.current?.getAnalysis() || {
      energy: 0,
      centroid: 0,
      spectrum: []
    };
  }, []);

  useFrame(() => {
    if (!isActive) {
      return;
    }

    const currentTime = performance.now();
    const deltaTime = currentTime - lastFrameTimeRef.current;
    lastFrameTimeRef.current = currentTime;

    let audioData;
    let isCurrentlyVoiceActive;

    if (microphoneModeRef.current && microphoneServiceRef.current) {
      audioData = microphoneServiceRef.current.getAnalysis();
      isCurrentlyVoiceActive = microphoneServiceRef.current.isVoiceActive();
    } else {
      const externalAudio = externalAgentAudioRef.current;
      const hasFreshAgentAudio = externalAudio && currentTime - externalAudio.receivedAt < 500;
      audioData = hasFreshAgentAudio ? externalAudio : audioAnalyzerRef.current.getAnalysis();
      isCurrentlyVoiceActive = isAgentSpeakingRef.current && audioData.energy >= visemePickerRef.current.energyThreshold;
    }

    const alignment = externalAgentAlignmentRef.current;
    const hasFreshAlignment = !microphoneModeRef.current && alignment && currentTime - alignment.receivedAt < 1500;
    const alignedViseme = hasFreshAlignment
      ? pickVisemeFromAlignment(alignment.data, currentTime - alignment.receivedAt + 35)
      : null;
    const selectedViseme = alignedViseme || visemePickerRef.current.pickViseme(
      audioData.energy,
      audioData.centroid,
      currentTime
    );

    if (selectedViseme !== currentViseme) {
      setCurrentViseme(selectedViseme);
    }

    const intensity = isCurrentlyVoiceActive ? audioData.energy : 0;

    if (morphControllerRef.current) {
      morphControllerRef.current.setViseme(selectedViseme, intensity);
      morphControllerRef.current.update(deltaTime);
    } else {
      logger.error('useLipSync', 'MorphController is null! Cannot apply morph targets.');
    }

    if (metricsRef.current) {
      metricsRef.current.recordFrame(
        audioData.energy,
        selectedViseme,
        morphControllerRef.current?.currentInfluences || {}
      );
    }

    if (metricsRef.current?.frameCount % 30 === 0) {
      setMetrics(metricsRef.current.getMetrics());
    }
  });

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

  const getCurrentInfluences = useCallback(() => {
    return morphControllerRef.current?.currentInfluences || {};
  }, []);

  return {
    isActive,
    currentViseme,
    metrics,
    initialize,
    start,
    stop,
    setAgentSpeaking,
    setAgentAudioAnalysis,
    setAgentAudioAlignment,
    setMicrophoneMode,
    setVoiceActivityThreshold,
    setMicrophoneGain,
    setMicrophoneDebugMode,
    resetMicrophoneBaseline,
    getDebugInfo,
    getCurrentInfluences,
    getMicrophoneAnalysis,
    isVoiceActive
  };
};

export default useLipSync;
