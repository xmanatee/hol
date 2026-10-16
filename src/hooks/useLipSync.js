import { useRef, useCallback, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { MorphController, VisemeMapper, VisemePicker } from '../audio/lipSync.js';

export const useLipSync = (microphoneService, ttsService, onMicrophoneTelemetry) => {
  const visemePickerRef = useRef(null);
  const morphControllerRef = useRef(null);
  const lastFrameTimeRef = useRef(null);
  const agentSpeakingRef = useRef(false);
  const microphoneServiceRef = useRef(microphoneService);
  const ttsServiceRef = useRef(ttsService);
  const telemetrySnapshotRef = useRef({ currentViseme: 'M', audioEnergy: 0, isVoiceActive: false });
  useEffect(() => {
    microphoneServiceRef.current = microphoneService;
  }, [microphoneService]);
  useEffect(() => {
    ttsServiceRef.current = ttsService;
  }, [ttsService]);

  const initialize = useCallback((headMesh) => {
    const visemeMapper = new VisemeMapper(headMesh.morphTargetDictionary);
    visemePickerRef.current = new VisemePicker();
    morphControllerRef.current = new MorphController(headMesh, visemeMapper);
    morphControllerRef.current.setRestPose();
    morphControllerRef.current.update(160);
  }, []);

  const setAgentSpeaking = useCallback((speaking) => {
    agentSpeakingRef.current = speaking;
    lastFrameTimeRef.current = performance.now();

    if (!speaking) {
      morphControllerRef.current?.setRestPose();
    }
  }, []);

  const setExpression = useCallback((expression) => {
    morphControllerRef.current?.setExpression(expression, 1);
  }, []);

  const setPerformanceIntensity = useCallback((intensity) => {
    morphControllerRef.current?.setPerformanceIntensity(intensity);
  }, []);

  useFrame(() => {
    const morphController = morphControllerRef.current;
    if (!morphController) {
      return;
    }

    const currentTime = performance.now();
    const previousFrameTime = lastFrameTimeRef.current;
    const deltaTime = previousFrameTime === null ? 0 : currentTime - previousFrameTime;
    lastFrameTimeRef.current = currentTime;
    const activeMicrophone = microphoneServiceRef.current?.isActive ? microphoneServiceRef.current : null;
    const activeTTS = agentSpeakingRef.current ? ttsServiceRef.current : null;
    const isActive = Boolean(activeMicrophone || activeTTS);

    if (!isActive) {
      morphController.setRestPose();
      morphController.update(deltaTime);
      return;
    }

    let audioData;
    let voiceActive;
    if (activeMicrophone) {
      audioData = activeMicrophone.readFrame();
      voiceActive = audioData.voiceActive;
    } else {
      audioData = activeTTS.readFrame();
      voiceActive = audioData.energy >= visemePickerRef.current.energyThreshold;
    }

    const selectedViseme = visemePickerRef.current.pickViseme(
      audioData.energy,
      audioData.centroid,
      currentTime,
    );
    morphController.setSpeechFrame(selectedViseme, voiceActive ? audioData.energy : 0, voiceActive);
    morphController.update(deltaTime);

    if (activeMicrophone) {
      const telemetrySnapshot = telemetrySnapshotRef.current;
      telemetrySnapshot.currentViseme = selectedViseme;
      telemetrySnapshot.audioEnergy = audioData.energy;
      telemetrySnapshot.isVoiceActive = voiceActive;
      onMicrophoneTelemetry(telemetrySnapshot);
    }
  });

  return {
    initialize,
    setAgentSpeaking,
    setExpression,
    setPerformanceIntensity,
  };
};
