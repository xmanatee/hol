import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import {
  createCameraSessionServices,
  disposeCameraSessionServices,
} from '../services/CameraSessionServices.js';
import { AnchorSelectionGate } from '../services/AnchorSelectionGate.js';
import { OBJECT_POSE_MODEL } from '../cv/anchor.reconstructionModes.js';
import { createAnchorStateStore } from '../utils/anchorStateStore.js';
import { copyImageData } from '../utils/imageDataTransfer.js';
import { LatestValueMailbox } from '../utils/latestValueMailbox.js';
import { logger } from '../utils/logger.js';
import { createDepthStateStore } from '../utils/depthStateStore.js';
import { pageVisibility } from '../utils/pageVisibility.js';

const DEPTH_FUSION_MODE = 'depth-fusion';
const createIdleDepthState = () => ({
  state: 'idle',
  provider: null,
  error: null,
  processingTime: 0,
  lastFrameAt: 0,
});

const createIdleAnchorState = () => ({
  observationExpired: false,
  mode: 'selection',
  activeAnchor: null,
  candidate: null,
  anchorState: null,
  sampledAt: null,
  trackingMode: OBJECT_POSE_MODEL,
  initialized: false,
  error: null,
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
export const shouldLoadVisionRuntime = ({ cameraState, initialized, error }) =>
  cameraState === 'active' && !initialized && error === null;
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
  const speechRequestRef = useRef(0);
  const depthServiceRef = useRef(null);
  const depthServicePromiseRef = useRef(null);
  const depthGenerationRef = useRef(0);
  const removeDepthListenerRef = useRef(null);
  const [anchorSelectionGate] = useState(() => new AnchorSelectionGate());
  const [depthFrameMailbox] = useState(() => new LatestValueMailbox());
  const [depthStateStore] = useState(() => createDepthStateStore(createIdleDepthState()));
  const visionInitializationRef = useRef(null);
  const visionGenerationRef = useRef(0);

  const [cameraState, setCameraState] = useState('idle');
  const [cameraError, setCameraError] = useState(null);
  const visionError = anchorSystemState.error;
  const [videoDimensions, setVideoDimensions] = useState({ width: 1280, height: 720 });
  const [personalityData, setPersonalityData] = useState(createIdlePersonalityData);
  const [ttsData, setTTSData] = useState(createIdleTTSData);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => () => anchorStateStore.dispose(), [anchorStateStore]);
  useEffect(() => () => depthStateStore.dispose(), [depthStateStore]);

  const bindDepthService = useCallback(
    (depthService) => {
      if (removeDepthListenerRef.current) {
        return;
      }

      removeDepthListenerRef.current = depthService.addListener(depthStateStore.update);
    },
    [depthStateStore],
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
    anchorStateStore.reset(createIdleAnchorState());
    setPersonalityData(createIdlePersonalityData());
    setTTSData(createIdleTTSData());

    const nextSession = createCameraSessionServices(sessionConfig);
    sessionRef.current = nextSession;
    setSession(nextSession);
  }, [anchorSelectionGate, anchorStateStore, releaseDepthRuntime, sessionConfig]);

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
        throw error;
      });

    visionInitializationRef.current = initialization;
    return initialization;
  }, [anchorStateStore, cameraState, session, videoDimensions]);

  const retryVision = useCallback(() => {
    anchorSelectionGate.reset();
    retireObjectVoiceSession(session);
    releaseDepthRuntime();
    visionGenerationRef.current += 1;
    visionInitializationRef.current = null;
    session.anchor.reset();
  }, [anchorSelectionGate, releaseDepthRuntime, session]);

  useEffect(() => {
    if (
      shouldLoadVisionRuntime({
        cameraState,
        initialized: session.anchor.initialized,
        error: visionError,
      })
    ) {
      initializeVisionServices().catch((error) => {
        logger.warn('CameraSystem', `Vision initialization request failed: ${error.message}`);
      });
    }
  }, [cameraState, initializeVisionServices, session.anchor.initialized, visionError]);

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
        } else if (lifecycleAction === 'replace-session') {
          replaceCameraSession();
        }
      },
    });

    const removeAnchorListener = anchorManager.addListener(anchorStateStore.update);
    const updateVisibility = () => {
      depthFrameMailbox.reset();
      anchorManager.setObservationsActive(pageVisibility.getSnapshot());
    };
    const removeVisibilityListener = pageVisibility.subscribe(updateVisibility);
    updateVisibility();

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
      },
    });

    const ttsClient = session.tts;
    const removeTTSListener = ttsClient.addListener({
      onAudioStart: ({ latencyToFirstAudio }) => {
        logger.info('CameraSystem', 'TTS audio started, latency:', latencyToFirstAudio, 'ms');
        setTTSData((prev) => ({
          ...prev,
          isSynthesizing: false,
          isPlaying: true,
          lastLatency: latencyToFirstAudio,
        }));
      },
      onPlaybackComplete: () => {
        logger.info('CameraSystem', 'Speech activity ended');
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
      },
    });

    return () => {
      mountedRef.current = false;
      removeCameraListener();
      removeAnchorListener();
      removeVisibilityListener();
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
    session,
  ]);

  const initializeDepthForActiveMode = useCallback(() => {
    getDepthService()
      .then((depthService) => {
        if (!depthService || !session.anchor.observationsActive) {
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
  }, [getDepthService, session]);

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
      if (!session.anchor.canProcessFrame()) {
        return { success: false, reason: 'Anchor frame in progress' };
      }

      let currentDepthState = depthStateStore.getSnapshot();
      let depthRequestTimestamp = null;
      if (shouldInitializeDepthForTrackingMode(currentAnchorState.trackingMode)) {
        initializeDepthForActiveMode();
        const depthService = depthServiceRef.current;
        currentDepthState = depthService?.getState() ?? currentDepthState;
        if (update && depthService?.shouldEstimate()) {
          depthRequestTimestamp = capturedAt;
          const depthImageData = copyImageData(imageData);
          const mailboxGeneration = depthFrameMailbox.captureGeneration();
          depthService
            .estimate(depthImageData, { timestamp: capturedAt })
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

      const depthFrame = update ? depthFrameMailbox.take() : null;
      return session.anchor.processFrame(imageData, {
        update,
        refreshSegmentation,
        capturedAt,
        depthContext: {
          depthFrame,
          depthRequestTimestamp,
          depthState: currentDepthState,
        },
      });
    },
    [depthFrameMailbox, depthStateStore, getAnchorSystemState, initializeDepthForActiveMode, session],
  );

  const selectAnchorFromTap = useCallback(
    ({ candidateId, tapPosition }) => {
      return anchorSelectionGate.run(() => {
        if (!session.anchor.initialized) {
          return {
            success: false,
            reason: visionError
              ? 'Vision unavailable. Stop and restart the camera.'
              : 'Preparing object discovery',
          };
        }
        if (candidateId === null) {
          return { success: false, reason: 'Wait for an object to be highlighted before tapping' };
        }
        return session.anchor.selectCandidate({
          candidateId,
          tapPosition,
          capturedAt: performance.now(),
        });
      });
    },
    [anchorSelectionGate, session, visionError],
  );

  const clearAnchor = useCallback(() => {
    retireObjectVoiceSession(session);
    session.anchor.clearAnchor();
    depthFrameMailbox.reset();
    setPersonalityData(createIdlePersonalityData());
    setTTSData(createIdleTTSData());
  }, [depthFrameMailbox, session]);

  const setAnchorTrackingMode = useCallback(
    (mode) => {
      depthFrameMailbox.reset();
      session.anchor.setTrackingMode(mode);
      if (shouldInitializeDepthForTrackingMode(mode)) {
        initializeDepthForActiveMode();
      } else {
        releaseDepthRuntime();
      }
    },
    [depthFrameMailbox, initializeDepthForActiveMode, releaseDepthRuntime, session],
  );

  const generatePersonality = useCallback(
    (imageData, bbox) => {
      return session.personality.generatePersonality(imageData, bbox);
    },
    [session],
  );

  const synthesizeSpeech = useCallback(
    async (text, voiceStyle, emotionalDelivery) => {
      const requestId = ++speechRequestRef.current;
      const ownsRequest = () =>
        mountedRef.current && sessionRef.current === session && requestId === speechRequestRef.current;
      setTTSData((current) => ({ ...current, isSynthesizing: true, isPlaying: false, error: null }));
      try {
        const started = await session.tts.synthesizeSpeech(text, voiceStyle, emotionalDelivery);
        if (!started && ownsRequest()) {
          setTTSData((current) => ({ ...current, isSynthesizing: false, isPlaying: false }));
        }
        return started;
      } catch (error) {
        if (!ownsRequest()) return false;
        setTTSData((current) => ({
          ...current,
          isSynthesizing: false,
          isPlaying: false,
          error: error.message,
        }));
        throw error;
      }
    },
    [session],
  );

  const stopTTS = useCallback(() => {
    speechRequestRef.current++;
    session.tts.stopCurrentAudio();
    setTTSData((current) => ({ ...current, isSynthesizing: false, isPlaying: false, error: null }));
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
    visionError,
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
    retryVision,

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
