import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import {
  createCameraSessionServices,
  disposeCameraSessionServices,
} from '../services/CameraSessionServices.js';
import { AnchorSelectionGate } from '../services/AnchorSelectionGate.js';
import { collectAnchorMetrics } from '../utils/anchorMetrics.js';
import { createAnchorStateStore } from '../utils/anchorStateStore.js';
import { copyImageData } from '../utils/imageDataTransfer.js';
import { LatestValueMailbox } from '../utils/latestValueMailbox.js';
import { logger } from '../utils/logger.js';
import { createDepthStateStore } from '../utils/depthStateStore.js';

const DEPTH_FUSION_MODE = 'depth-fusion';
const createIdleDepthState = () => ({
  state: 'idle',
  provider: null,
  error: null,
  processingTime: 0,
  lastFrameAt: 0,
});

const createIdleAnchorState = () => ({
  mode: 'selection',
  activeAnchor: null,
  anchorState: null,
  sampledAt: null,
  trackingMode: 'sparse-reconstruction',
  initialized: false,
});

const createIdlePersonalityData = () => ({
  isProcessing: false,
  currentPersona: null,
  error: null,
  lastRTT: 0,
});

const createIdleTTSData = () => ({
  isSynthesizing: false,
  isPlaying: false,
  error: null,
  lastLatency: 0,
});

export const shouldInitializeDepthForTrackingMode = (mode) => mode === DEPTH_FUSION_MODE;
export const shouldLoadVisionRuntime = ({ cameraState, visionRequested, initialized }) =>
  cameraState === 'active' && visionRequested && !initialized;
export const retireObjectVoiceSession = ({ personality, tts }) => {
  personality.resetSubject();
  tts.stopCurrentAudio();
};
export const selectCameraLifecycleAction = ({ newState, oldState, reason }) => {
  if (newState === 'interrupted' && reason === 'track-ended') {
    return 'replace-session';
  }
  if (
    newState === 'active' &&
    (oldState === 'active' || oldState === 'interrupted') &&
    reason === 'dimensions-changed'
  ) {
    return 'reset-vision';
  }
  return null;
};

export const useCameraSystem = (config = {}) => {
  const [anchorStateStore] = useState(() => createAnchorStateStore(createIdleAnchorState()));
  const anchorSystemState = useSyncExternalStore(anchorStateStore.subscribe, anchorStateStore.getSnapshot);
  const getAnchorSystemState = anchorStateStore.getLatest;
  const subscribeAnchorSystemState = anchorStateStore.subscribeLatest;
  const [sessionConfig] = useState(() => ({
    personality: config.personality,
    tts: config.tts,
  }));
  const [session, setSession] = useState(() => createCameraSessionServices(sessionConfig));
  const sessionRef = useRef(session);
  const mountedRef = useRef(false);
  const depthServiceRef = useRef(null);
  const depthServicePromiseRef = useRef(null);
  const depthGenerationRef = useRef(0);
  const removeDepthListenerRef = useRef(null);
  const [anchorSelectionGate] = useState(() => new AnchorSelectionGate());
  const [depthFrameMailbox] = useState(() => new LatestValueMailbox());
  const [depthStateStore] = useState(() => createDepthStateStore(createIdleDepthState()));
  const visionInitializationRef = useRef(null);
  const visionGenerationRef = useRef(0);
  const metricUpdateRef = useRef(config.onMetricUpdate || null);
  const [visionRequested, setVisionRequested] = useState(false);

  const [cameraState, setCameraState] = useState('idle');
  const [cameraError, setCameraError] = useState(null);
  const [videoDimensions, setVideoDimensions] = useState({ width: 1280, height: 720 });
  const [personalityData, setPersonalityData] = useState(createIdlePersonalityData);
  const [ttsData, setTTSData] = useState(createIdleTTSData);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    metricUpdateRef.current = config.onMetricUpdate || null;
  }, [config.onMetricUpdate]);

  const updateMetric = useCallback((name, value) => {
    metricUpdateRef.current?.(name, value);
  }, []);
  const resetSpeechMetrics = useCallback(() => {
    updateMetric('Audio energy', 0);
    updateMetric('Audio centroid', 0);
  }, [updateMetric]);

  useEffect(
    () =>
      anchorStateStore.subscribe((state) => {
        const metrics = collectAnchorMetrics(state);
        Object.entries(metrics).forEach(([name, value]) => {
          updateMetric(name, value);
        });
      }),
    [anchorStateStore, updateMetric],
  );

  useEffect(() => () => anchorStateStore.dispose(), [anchorStateStore]);
  useEffect(() => () => depthStateStore.dispose(), [depthStateStore]);

  const bindDepthService = useCallback(
    (depthService) => {
      if (removeDepthListenerRef.current) {
        return;
      }

      removeDepthListenerRef.current = depthService.addListener((state) => {
        depthStateStore.update(state);
        updateMetric('Depth model state', state.state);
        updateMetric('Depth provider', state.provider || 'None');
        updateMetric('Depth inference', state.processingTime ?? 0);
        updateMetric('Depth error', state.error || 'None');
      });
    },
    [depthStateStore, updateMetric],
  );

  const getDepthService = useCallback(() => {
    if (depthServiceRef.current) {
      return Promise.resolve(depthServiceRef.current);
    }

    if (!depthServicePromiseRef.current) {
      const requestedSession = session;
      const requestedGeneration = depthGenerationRef.current;
      const depthServicePromise = import('../services/DepthEstimationService.js')
        .then(({ DepthEstimationService }) => {
          if (
            !mountedRef.current ||
            sessionRef.current !== requestedSession ||
            depthGenerationRef.current !== requestedGeneration ||
            depthServicePromiseRef.current !== depthServicePromise
          ) {
            return null;
          }
          const depthService = new DepthEstimationService(config.depth);
          depthServiceRef.current = depthService;
          bindDepthService(depthService);
          depthStateStore.update(depthService.getState());
          return depthService;
        })
        .catch((error) => {
          if (
            depthGenerationRef.current !== requestedGeneration ||
            depthServicePromiseRef.current !== depthServicePromise
          ) {
            return null;
          }
          depthServicePromiseRef.current = null;
          throw error;
        });
      depthServicePromiseRef.current = depthServicePromise;
    }

    return depthServicePromiseRef.current;
  }, [bindDepthService, config.depth, depthStateStore, session]);

  const disposeDepthRuntime = useCallback(() => {
    depthGenerationRef.current += 1;
    removeDepthListenerRef.current?.();
    removeDepthListenerRef.current = null;
    depthServiceRef.current?.dispose();
    depthServiceRef.current = null;
    depthServicePromiseRef.current = null;
    depthFrameMailbox.reset();
  }, [depthFrameMailbox]);

  const releaseDepthRuntime = useCallback(() => {
    disposeDepthRuntime();
    depthStateStore.reset(createIdleDepthState());
  }, [depthStateStore, disposeDepthRuntime]);

  const replaceCameraSession = useCallback(() => {
    anchorSelectionGate.reset();
    releaseDepthRuntime();
    visionGenerationRef.current += 1;
    visionInitializationRef.current = null;
    setVisionRequested(false);
    anchorStateStore.reset(createIdleAnchorState());
    setPersonalityData(createIdlePersonalityData());
    setTTSData(createIdleTTSData());
    resetSpeechMetrics();

    const nextSession = createCameraSessionServices(sessionConfig);
    sessionRef.current = nextSession;
    setSession(nextSession);
  }, [anchorSelectionGate, anchorStateStore, releaseDepthRuntime, resetSpeechMetrics, sessionConfig]);

  const initializeVisionServices = useCallback(() => {
    if (cameraState !== 'active') {
      return Promise.reject(new Error('Vision services require an active camera'));
    }

    if (session.anchor.initialized) {
      anchorStateStore.update(session.anchor.getState());
      return Promise.resolve(true);
    }

    if (visionInitializationRef.current) {
      return visionInitializationRef.current;
    }

    const visionGeneration = visionGenerationRef.current;
    const initialization = Promise.resolve()
      .then(async () => {
        if (
          !mountedRef.current ||
          sessionRef.current !== session ||
          visionGenerationRef.current !== visionGeneration
        ) {
          return false;
        }
        const { width, height } = videoDimensions;
        await session.anchor.initialize(null, width, height);
        if (
          !mountedRef.current ||
          sessionRef.current !== session ||
          visionGenerationRef.current !== visionGeneration
        ) {
          return false;
        }
        await session.tts.initialize();

        if (
          !mountedRef.current ||
          sessionRef.current !== session ||
          visionGenerationRef.current !== visionGeneration
        ) {
          return false;
        }

        logger.info('CameraSystem', 'Vision anchor services initialized successfully');
        return true;
      })
      .catch((error) => {
        if (!mountedRef.current || sessionRef.current !== session) {
          return false;
        }
        if (visionInitializationRef.current === initialization) {
          visionInitializationRef.current = null;
        }
        if (error.message === 'Anchor worker reset') {
          return false;
        }
        logger.error('CameraSystem', 'Vision service initialization failed:', error);
        updateMetric('Vision error', error.message);
        throw error;
      });

    visionInitializationRef.current = initialization;
    return initialization;
  }, [anchorStateStore, cameraState, session, updateMetric, videoDimensions]);

  useEffect(() => {
    if (
      shouldLoadVisionRuntime({
        cameraState,
        visionRequested,
        initialized: session.anchor.initialized,
      })
    ) {
      initializeVisionServices().catch((error) => {
        logger.warn('CameraSystem', `Vision initialization request failed: ${error.message}`);
      });
    }
  }, [cameraState, visionRequested, initializeVisionServices, session.anchor.initialized]);

  useEffect(() => {
    mountedRef.current = true;
    const { camera: cameraService, anchor: anchorManager } = session;

    const removeCameraListener = cameraService.addListener({
      onStateChange: (newState, oldState, data) => {
        setCameraState(newState);
        setCameraError(data.error || null);
        if (newState === 'active' && Number.isFinite(data.width) && Number.isFinite(data.height)) {
          setVideoDimensions({ width: data.width, height: data.height });
        }
        const lifecycleAction = selectCameraLifecycleAction({
          newState,
          oldState,
          reason: data.reason || null,
        });
        if (
          lifecycleAction === 'reset-vision' &&
          (anchorManager.initialized || visionInitializationRef.current)
        ) {
          anchorSelectionGate.reset();
          visionGenerationRef.current += 1;
          anchorManager.reset();
          visionInitializationRef.current = null;
          depthFrameMailbox.reset();
          updateMetric('Camera calibration', `${data.width}x${data.height}`);
        } else if (lifecycleAction === 'replace-session') {
          replaceCameraSession();
        }
      },
    });

    const removeAnchorListener = anchorManager.addListener({
      onAnchorUpdate: (state) => {
        anchorStateStore.update(state);
      },
    });

    const personalityService = session.personality;
    const removePersonalityListener = personalityService.addListener({
      onPersonalityStart: ({ requestId }) => {
        logger.info('CameraSystem', 'Personality generation started for request:', requestId);
        setPersonalityData((prev) => ({ ...prev, isProcessing: true, error: null }));
      },
      onPersonalityGenerated: ({ persona, rtt, success, error }) => {
        logger.info('CameraSystem', 'Personality generated:', { persona, rtt, success });
        setPersonalityData((prev) => ({
          ...prev,
          isProcessing: false,
          currentPersona: persona,
          lastRTT: rtt,
          error: error || null,
        }));
        updateMetric('Persona RTT', rtt);
      },
    });

    const ttsClient = session.tts;
    const removeTTSListener = ttsClient.addListener({
      onSynthesisStart: ({ text, voiceStyle, emotionalDelivery, requestId }) => {
        logger.info('CameraSystem', 'TTS synthesis started:', {
          text,
          voiceStyle,
          emotionalDelivery,
          requestId,
        });
        resetSpeechMetrics();
        setTTSData((prev) => ({
          ...prev,
          isSynthesizing: true,
          error: null,
        }));
      },
      onAudioStart: ({ latencyToFirstAudio }) => {
        logger.info('CameraSystem', 'TTS audio started, latency:', latencyToFirstAudio, 'ms');
        setTTSData((prev) => ({
          ...prev,
          isSynthesizing: false,
          isPlaying: true,
          lastLatency: latencyToFirstAudio,
        }));
        updateMetric('TTS latency to first audio', latencyToFirstAudio);
      },
      onPlaybackComplete: () => {
        logger.info('CameraSystem', 'TTS playback completed');
        resetSpeechMetrics();
        setTTSData((prev) => ({
          ...prev,
          isPlaying: false,
        }));
      },
      onSynthesisComplete: ({ text, voiceStyle, emotionalDelivery, latency }) => {
        logger.info('CameraSystem', 'TTS synthesis completed:', {
          text,
          voiceStyle,
          emotionalDelivery,
          latency,
        });
        updateMetric('TTS total latency', latency);
      },
      onError: ({ error }) => {
        logger.error('CameraSystem', 'TTS error:', error);
        resetSpeechMetrics();
        setTTSData((prev) => ({
          ...prev,
          isSynthesizing: false,
          isPlaying: false,
          error,
        }));
      },
    });

    return () => {
      mountedRef.current = false;
      removeCameraListener();
      removeAnchorListener();
      disposeDepthRuntime();
      removePersonalityListener();
      removeTTSListener();
      disposeCameraSessionServices(session).catch((error) => {
        logger.error('CameraSystem', `Camera session disposal failed: ${error.message}`);
      });
    };
  }, [
    anchorSelectionGate,
    anchorStateStore,
    depthFrameMailbox,
    disposeDepthRuntime,
    replaceCameraSession,
    resetSpeechMetrics,
    session,
    updateMetric,
  ]);

  const initializeDepthForActiveMode = useCallback(() => {
    getDepthService()
      .then((depthService) => {
        if (!depthService) {
          return null;
        }
        if (depthService.getState().state !== 'idle') {
          return null;
        }

        return depthService.initialize();
      })
      .catch((error) => {
        logger.warn('CameraSystem', `Depth model initialization failed: ${error.message}`);
      });
  }, [getDepthService]);

  const startCamera = useCallback(
    async (videoElement) => {
      return await session.camera.start(videoElement);
    },
    [session],
  );

  const resumeCamera = useCallback(async () => {
    return await session.camera.resume();
  }, [session]);

  const stopCamera = useCallback(() => {
    session.camera.stop();
    replaceCameraSession();
  }, [replaceCameraSession, session]);

  const canProcessAnchorFrame = useCallback(() => session.anchor.canProcessFrame(), [session]);

  const processAnchorFrame = useCallback(
    (imageData, { update, refreshSegmentation, capturedAt }) => {
      const currentAnchorState = getAnchorSystemState();
      if (currentAnchorState.mode !== 'anchor') {
        return { success: false, reason: 'Not in anchor mode' };
      }
      if (!session.anchor.canProcessFrame()) {
        return { success: false, reason: 'Anchor frame in progress' };
      }

      let currentDepthState = depthStateStore.getSnapshot();
      if (shouldInitializeDepthForTrackingMode(currentAnchorState.trackingMode)) {
        initializeDepthForActiveMode();
        const depthService = depthServiceRef.current;
        currentDepthState = depthService?.getState() ?? currentDepthState;
        if (depthService?.shouldEstimate()) {
          const timestamp = performance.now();
          const depthImageData = copyImageData(imageData);
          const mailboxGeneration = depthFrameMailbox.captureGeneration();
          depthService
            .estimate(depthImageData, { timestamp })
            .then((estimatedDepthFrame) => {
              if (estimatedDepthFrame) {
                depthFrameMailbox.publish(estimatedDepthFrame, mailboxGeneration);
              }
            })
            .catch((error) => {
              logger.warn('CameraSystem', `Depth inference failed: ${error.message}`);
            });
        }
      }

      const depthFrame = depthFrameMailbox.take();
      return session.anchor.processFrame(imageData, {
        update,
        refreshSegmentation,
        capturedAt,
        depthContext: {
          depthFrame,
          depthState: currentDepthState,
        },
      });
    },
    [depthFrameMailbox, depthStateStore, getAnchorSystemState, initializeDepthForActiveMode, session],
  );

  const selectAnchorFromTap = useCallback(
    ({ tapPosition, captureFrame }) => {
      return anchorSelectionGate.run(async () => {
        const imageData = captureFrame();
        setVisionRequested(true);
        const initialized = await initializeVisionServices();
        if (!initialized) {
          return { success: false, reason: 'Camera session ended' };
        }

        const result = await session.anchor.createAnchorFromTap(tapPosition, imageData);

        if (result.success) {
          updateMetric(
            'Anchor created',
            `${result.keypoints} keypoints, quality: ${result.quality.toFixed(2)}`,
          );
        }

        return result;
      });
    },
    [anchorSelectionGate, initializeVisionServices, session, updateMetric],
  );

  const clearAnchor = useCallback(() => {
    retireObjectVoiceSession(session);
    session.anchor.clearAnchor();
    depthFrameMailbox.reset();
    setPersonalityData(createIdlePersonalityData());
    setTTSData(createIdleTTSData());
    resetSpeechMetrics();

    updateMetric('Anchor cleared', 'Returned to selection mode');
  }, [depthFrameMailbox, resetSpeechMetrics, session, updateMetric]);

  const setAnchorTrackingMode = useCallback(
    (mode) => {
      depthFrameMailbox.reset();
      session.anchor.setTrackingMode(mode);
      if (shouldInitializeDepthForTrackingMode(mode)) {
        initializeDepthForActiveMode();
      } else {
        releaseDepthRuntime();
      }
      updateMetric('Anchor tracking mode', mode);
    },
    [depthFrameMailbox, initializeDepthForActiveMode, releaseDepthRuntime, session, updateMetric],
  );

  const generatePersonality = useCallback(
    (imageData, bbox) => {
      return session.personality.generatePersonality(imageData, bbox);
    },
    [session],
  );

  const synthesizeSpeech = useCallback(
    (text, voiceStyle, emotionalDelivery) => {
      return session.tts.synthesizeSpeech(text, voiceStyle, emotionalDelivery);
    },
    [session],
  );

  const stopTTS = useCallback(() => {
    session.tts.stopCurrentAudio();
  }, [session]);

  const speakGreeting = useCallback(() => {
    const persona = personalityData.currentPersona;
    if (!persona) {
      logger.warn('CameraSystem', 'No persona available for greeting');
      return false;
    }

    const greeting = persona.oneLiners[0];
    logger.info('CameraSystem', 'Speaking greeting:', greeting, 'with voice style:', persona.voiceStyle);
    return synthesizeSpeech(greeting, persona.voiceStyle, persona.emotionalDelivery);
  }, [personalityData.currentPersona, synthesizeSpeech]);

  const getCameraMatrix = useCallback((width, height) => {
    const fov = (60 * Math.PI) / 180;
    const focalLength = width / (2 * Math.tan(fov / 2));
    return {
      fx: focalLength,
      fy: focalLength,
      cx: width / 2,
      cy: height / 2,
    };
  }, []);

  return {
    cameraState,
    cameraError,
    videoDimensions,
    depthStateStore,
    anchorSystemState,
    getAnchorSystemState,
    subscribeAnchorSystemState,
    personalityData,
    ttsData,

    services: {
      camera: session.camera,
      anchor: session.anchor,
      personality: session.personality,
      microphone: session.microphone,
      tts: session.tts,
    },

    startCamera,
    resumeCamera,
    stopCamera,

    canProcessAnchorFrame,
    processAnchorFrame,
    selectAnchorFromTap,
    clearAnchor,
    setAnchorTrackingMode,

    generatePersonality,

    synthesizeSpeech,
    stopTTS,
    speakGreeting,

    getCameraMatrix,
  };
};
