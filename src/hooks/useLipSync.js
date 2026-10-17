import { useRef, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { MorphController, VisemeMapper } from '../audio/lipSync.js';
import { SpeechDriver } from '../audio/SpeechDriver.js';

export const useLipSync = (microphoneService, ttsService, onMicrophoneTelemetry) => {
  const speechDriverRef = useRef(null);
  const morphControllerRef = useRef(null);
  const lastFrameTimeRef = useRef(null);

  const initialize = useCallback((headMesh) => {
    const visemeMapper = new VisemeMapper(headMesh.morphTargetDictionary);
    speechDriverRef.current = new SpeechDriver();
    lastFrameTimeRef.current = null;
    morphControllerRef.current = new MorphController(headMesh, visemeMapper);
    morphControllerRef.current.setRestPose();
    morphControllerRef.current.update(160);
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
    const driver = speechDriverRef.current;
    const frame = driver.readFrame(microphoneService, ttsService, currentTime);
    morphController.setSpeechFrame(frame.currentViseme, frame.audioEnergy, frame.isVoiceActive);
    morphController.update(deltaTime);

    if (microphoneService?.isActive) {
      onMicrophoneTelemetry(driver.microphoneFrame);
    }
  });

  return {
    initialize,
    setExpression,
    setPerformanceIntensity,
  };
};
