import { useState, useRef, useEffect, useCallback } from 'react';
import { CameraService } from '../services/CameraService.js';
import { DetectionService } from '../services/DetectionService.js';
import { AnchorManager } from '../services/AnchorManager.js';
import { PersonalityService } from '../services/PersonalityService.js';
import { DepthEstimationService } from '../services/DepthEstimationService.js';
import { loadOpenCVRuntime } from '../services/OpenCVRuntimeService.js';
import { LazyTTSClient } from '../audio/lazyTTSClient.js';
import { logger } from '../utils/logger.js';

const DEPTH_FUSION_MODE = 'depth-fusion';

export const useCameraSystem = (config = {}) => {
  const cameraServiceRef = useRef(new CameraService());
  const detectionServiceRef = useRef(new DetectionService());
  const anchorManagerRef = useRef(new AnchorManager());
  const personalityServiceRef = useRef(new PersonalityService(config.personality));
  const depthServiceRef = useRef(new DepthEstimationService(config.depth));
  const ttsClientRef = useRef(new LazyTTSClient(config.tts));
  const currentCanvasRef = useRef(null);
  const latestDepthFrameRef = useRef(null);
  const metricUpdateRef = useRef(config.onMetricUpdate || null);
  const [_initialized, setInitialized] = useState(false);
  const [cvLoaded, setCvLoaded] = useState(false);

  const [cameraState, setCameraState] = useState('idle');
  const [cameraError, setCameraError] = useState(null);
  const [videoDimensions, setVideoDimensions] = useState({ width: 1280, height: 720 });
  const [detectionState, setDetectionState] = useState({
    isInitialized: false,
    isModelLoaded: false,
    detectionEnabled: false,
    error: null,
    processingTime: 0,
    lastDetections: null
  });
  const [anchorSystemState, setAnchorSystemState] = useState({
    mode: 'detection',
    detections: [],
    activeAnchor: null,
    anchorState: null,
    trackingMode: 'sparse-reconstruction',
    initialized: false
  });
  const [depthState, setDepthState] = useState(depthServiceRef.current.getState());
  
  const [personalityData, setPersonalityData] = useState({
    isProcessing: false,
    currentPersona: null,
    error: null,
    lastRTT: 0
  });

  const [ttsData, setTTSData] = useState({
    isSynthesizing: false,
    isPlaying: false,
    audioAnalysis: { energy: 0, centroid: 0, spectrum: [] },
    audioAlignment: null,
    error: null,
    lastLatency: 0
  });

  useEffect(() => {
    metricUpdateRef.current = config.onMetricUpdate || null;
  }, [config.onMetricUpdate]);

  const updateMetric = useCallback((name, value) => {
    metricUpdateRef.current?.(name, value);
  }, []);

  useEffect(() => {
    let isMounted = true;

    loadOpenCVRuntime().then(
      () => {
        if (isMounted) {
          logger.info('CameraSystem', 'OpenCV.js loaded');
          setCvLoaded(true);
        }
      },
      error => {
        if (isMounted) {
          logger.error('CameraSystem', 'Failed to load OpenCV.js:', error);
          setCvLoaded(false);
          setDetectionState(prev => ({ ...prev, error: error.message }));
        }
      }
    );

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!cvLoaded) return;

    let isMounted = true;

    const initializeServices = async () => {
      try {
        const detectionService = detectionServiceRef.current;
        const anchorManager = anchorManagerRef.current;
        const { width, height } = videoDimensions;
        
        if (!detectionService.isInitialized) {
          await detectionService.initialize();
          if (!isMounted) return;
        }
        
        if (!detectionService.isModelLoaded) {
          await detectionService.loadModel();
          if (!isMounted) return;
        }

        if (!anchorManager.initialized) {
          await anchorManager.initialize(window.cv, width, height);
          if (!isMounted) return;
        }

        const ttsClient = ttsClientRef.current;
        await ttsClient.initialize();

        if (isMounted) {
          logger.info('CameraSystem', 'All services initialized successfully');
          setDetectionState(prev => ({ 
            ...prev, 
            isInitialized: true, 
            isModelLoaded: detectionService.isModelLoaded,
            detectionEnabled: detectionService.isDetectionEnabled()
          }));
          setAnchorSystemState(prev => ({ ...prev, initialized: true }));
          setInitialized(true);
        }
      } catch (error) {
        logger.error('CameraSystem', 'Service initialization failed:', error);
        setDetectionState(prev => ({ ...prev, error: error.message }));
      }
    };

    initializeServices();

    return () => {
      isMounted = false;
    };
  }, [cvLoaded, videoDimensions]);

  useEffect(() => {
    const cameraService = cameraServiceRef.current;
    const detectionService = detectionServiceRef.current;
    const anchorManager = anchorManagerRef.current;
    const depthService = depthServiceRef.current;

    const removeCameraListener = cameraService.addListener({
      onStateChange: (newState, oldState, data) => {
        setCameraState(newState);
        setCameraError(data.error || null);
        if (newState === 'active' && data) {
          setVideoDimensions({ width: data.width, height: data.height });
        }
      }
    });

    const removeDetectionListener = detectionService.addListener({
      onInitialized: () => {
        logger.info('CameraSystem', 'Detection service initialized');
        setDetectionState(prev => ({ ...prev, isInitialized: true }));
      },
      onModelLoaded: () => {
        logger.info('CameraSystem', 'Detection model loaded');
        setDetectionState(prev => ({ ...prev, isModelLoaded: true }));
      },
      onDetections: ({ detections, processingTime }) => {
        logger.debugChanged(
          'CameraSystem',
          'detection-count',
          detections.length,
          'Received detections:',
          detections.length
        );
        setDetectionState(prev => ({ ...prev, processingTime, lastDetections: detections }));
        updateMetric('Detection amortized cost', processingTime);
      },
      onError: ({ error }) => {
        logger.error('CameraSystem', 'Detection error:', error);
        setDetectionState(prev => ({ ...prev, error }));
      }
    });

    const removeAnchorListener = anchorManager.addListener({
      onAnchorUpdate: (state) => {
        setAnchorSystemState(state);
        
        if (state.anchorState) {
          const { metrics } = state.anchorState;
          if (metrics) {
            updateMetric('Keypoint count', metrics.keypointCount ?? 0);
            updateMetric('Landmark count', metrics.landmarkCount ?? metrics.keypointCount ?? 0);
            updateMetric('Active landmarks', metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0);
            updateMetric('Object-owned landmarks', metrics.objectOwnedLandmarks ?? 0);
            updateMetric('Mask coverage', metrics.maskCoverage ?? 0);
            updateMetric('Background rejected', metrics.backgroundRejected ?? 0);
            updateMetric('Landmark refresh added', metrics.landmarkRefreshAdded ?? 0);
            updateMetric('Tracking success rate', (metrics.trackingSuccessRate ?? 0) * 100);
            updateMetric('Homography inliers', metrics.homographyInliers ?? 0);
            updateMetric('Affine pose inliers', metrics.affinePoseInliers ?? 0);
            updateMetric('Object pose inliers', metrics.objectPoseInliers ?? 0);
            updateMetric('Reconstruction inliers', metrics.reconstructionPoseInliers ?? 0);
            updateMetric('Pose model', metrics.poseModel || 'object-pose');
            updateMetric('Pose source', metrics.poseSource || 'None');
            updateMetric('Pose residual', metrics.poseAverageResidual ?? 0);
            updateMetric('Pose foreshortening', metrics.poseForeshortening ?? 1);
            updateMetric('Reconstruction state', metrics.reconstructionState || 'inactive');
            updateMetric('Reconstruction frames', metrics.reconstructionFrames ?? 0);
            updateMetric('Reconstruction landmarks', metrics.reconstructionLandmarks ?? 0);
            updateMetric('Reconstruction depth', metrics.reconstructionDepthQuality ?? 0);
            updateMetric('Reconstruction depth status', metrics.reconstructionDepthStatus || 'None');
            updateMetric('Reconstruction depth provider', metrics.reconstructionDepthProvider || 'None');
            updateMetric('Reconstruction depth inference', metrics.reconstructionDepthInferenceTime ?? 0);
            updateMetric('Anchor processing time', metrics.processingTime ?? 0);
            updateMetric('Recovery attempts', metrics.recoveryAttempts ?? 0);
            updateMetric('Lost frame count', metrics.lostFrameCount ?? 0);
            
            if (typeof metrics.templateQuality === 'number') {
              updateMetric('Template quality', metrics.templateQuality * 100);
            }

            updateMetric('Anchor last failure', metrics.lastFailureReason || 'None');
          }
          
          if (state.anchorState.normal) {
            updateMetric('Surface normal', `[${state.anchorState.normal.x.toFixed(2)}, ${state.anchorState.normal.y.toFixed(2)}, ${state.anchorState.normal.z.toFixed(2)}]`);
          }

          if (state.anchorState.planarTransform) {
            updateMetric('Planar scale', state.anchorState.planarTransform.scale);
            updateMetric('Planar roll', state.anchorState.planarTransform.rotation * 180 / Math.PI);
          }
          
          updateMetric('Anchor state', state.anchorState.state || 'inactive');
        }
        
        updateMetric('System mode', state.mode);
      }
    });

    const removeDepthListener = depthService.addListener((state) => {
      setDepthState(state);
      updateMetric('Depth model state', state.state);
      updateMetric('Depth provider', state.provider || 'None');
      updateMetric('Depth inference', state.processingTime ?? 0);
      updateMetric('Depth error', state.error || 'None');
    });

    const personalityService = personalityServiceRef.current;
    const removePersonalityListener = personalityService.addListener({
      onPersonalityStart: ({ requestId }) => {
        logger.info('CameraSystem', 'Personality generation started for request:', requestId);
        setPersonalityData(prev => ({ ...prev, isProcessing: true, error: null }));
      },
      onPersonalityGenerated: ({ persona, rtt, success, error }) => {
        logger.info('CameraSystem', 'Personality generated:', { persona, rtt, success });
        setPersonalityData(prev => ({ 
          ...prev, 
          isProcessing: false, 
          currentPersona: persona,
          lastRTT: rtt,
          error: error || null
        }));
        updateMetric('Persona RTT', rtt);
      }
    });

    const ttsClient = ttsClientRef.current;
    const removeTTSListener = ttsClient.addListener({
      onSynthesisStart: ({ text, voiceStyle, emotionalDelivery, requestId }) => {
        logger.info('CameraSystem', 'TTS synthesis started:', { text, voiceStyle, emotionalDelivery, requestId });
        setTTSData(prev => ({
          ...prev,
          isSynthesizing: true,
          audioAnalysis: { energy: 0, centroid: 0, spectrum: [] },
          audioAlignment: null,
          error: null
        }));
      },
      onAudioStart: ({ latencyToFirstAudio }) => {
        logger.info('CameraSystem', 'TTS audio started, latency:', latencyToFirstAudio, 'ms');
        setTTSData(prev => ({ 
          ...prev, 
          isSynthesizing: false, 
          isPlaying: true, 
          lastLatency: latencyToFirstAudio 
        }));
        updateMetric('TTS latency to first audio', latencyToFirstAudio);
      },
      onAudioAnalysis: (audioAnalysis) => {
        setTTSData(prev => ({
          ...prev,
          audioAnalysis
        }));
        updateMetric('Audio energy', audioAnalysis.energy);
        updateMetric('Audio centroid', audioAnalysis.centroid);
      },
      onAudioAlignment: (audioAlignment) => {
        setTTSData(prev => ({
          ...prev,
          audioAlignment
        }));
      },
      onPlaybackComplete: () => {
        logger.info('CameraSystem', 'TTS playback completed');
        setTTSData(prev => ({
          ...prev,
          isPlaying: false,
          audioAnalysis: { energy: 0, centroid: 0, spectrum: [] },
          audioAlignment: null
        }));
      },
      onSynthesisComplete: ({ text, voiceStyle, emotionalDelivery, latency }) => {
        logger.info('CameraSystem', 'TTS synthesis completed:', { text, voiceStyle, emotionalDelivery, latency });
        updateMetric('TTS total latency', latency);
      },
      onError: ({ error }) => {
        logger.error('CameraSystem', 'TTS error:', error);
        setTTSData(prev => ({
          ...prev,
          isSynthesizing: false,
          isPlaying: false,
          audioAnalysis: { energy: 0, centroid: 0, spectrum: [] },
          audioAlignment: null,
          error
        }));
      }
    });

    return () => {
      removeCameraListener();
      removeDetectionListener();
      removeAnchorListener();
      removeDepthListener();
      removePersonalityListener();
      removeTTSListener();
    };
  }, [updateMetric]);

  const startCamera = useCallback(async (videoElement) => {
    const result = await cameraServiceRef.current.start(videoElement);
    depthServiceRef.current.initialize().catch(error => {
      logger.warn('CameraSystem', `Depth model preload failed: ${error.message}`);
    });
    return result;
  }, []);

  const resumeCamera = useCallback(async () => {
    return await cameraServiceRef.current.resume();
  }, []);

  const stopCamera = useCallback(() => {
    cameraServiceRef.current.stop();
    depthServiceRef.current.dispose();
    latestDepthFrameRef.current = null;
  }, []);

  const detectObjects = useCallback((imageData, options) => {
    return detectionServiceRef.current.detectObjects(imageData, options);
  }, []);

  const processDetections = useCallback((detections, imageData) => {
    if (anchorSystemState.mode === 'detection') {
      return anchorManagerRef.current.processDetections(detections, imageData);
    }
    return [];
  }, [anchorSystemState.mode]);

  const updateAnchor = useCallback((imageData) => {
    if (anchorSystemState.mode === 'anchor') {
      if (anchorSystemState.trackingMode === DEPTH_FUSION_MODE) {
        const timestamp = performance.now();
        depthServiceRef.current.estimate(imageData, { timestamp }).then(depthFrame => {
          if (depthFrame) {
            latestDepthFrameRef.current = depthFrame;
          }
        }).catch(error => {
          logger.warn('CameraSystem', `Depth inference failed: ${error.message}`);
        });
      }

      return anchorManagerRef.current.updateAnchor(imageData, {
        depthFrame: latestDepthFrameRef.current,
        depthState,
      });
    }
    return { success: false, reason: 'Not in anchor mode' };
  }, [anchorSystemState.mode, anchorSystemState.trackingMode, depthState]);

  const refreshAnchorSegmentation = useCallback((imageData) => {
    if (anchorSystemState.mode === 'anchor') {
      return anchorManagerRef.current.refreshSegmentationIfNeeded(imageData);
    }
    return false;
  }, [anchorSystemState.mode]);

  const createAnchorFromTap = useCallback(async (tapPosition, imageData) => {
    const result = await anchorManagerRef.current.createAnchorFromTap(tapPosition, imageData);
    
    if (result.success) {
      detectionServiceRef.current.setDetectionEnabled(false);
      setDetectionState(prev => ({ ...prev, detectionEnabled: false }));
      
      updateMetric('Anchor created', `${result.keypoints} keypoints, quality: ${result.quality.toFixed(2)}`);
    }
    
    return result;
  }, [updateMetric]);

  const clearAnchor = useCallback(() => {
    anchorManagerRef.current.clearAnchor();
    latestDepthFrameRef.current = null;

    updateMetric('Anchor cleared', 'Returned to detection mode');
  }, [updateMetric]);

  const setDetectionEnabled = useCallback((enabled) => {
    detectionServiceRef.current.setDetectionEnabled(enabled);
    setDetectionState(prev => ({ ...prev, detectionEnabled: enabled }));
    updateMetric('Detection debug overlay', enabled ? 'Enabled' : 'Disabled');
  }, [updateMetric]);

  const setAnchorTrackingMode = useCallback((mode) => {
    latestDepthFrameRef.current = null;
    anchorManagerRef.current.setTrackingMode(mode);
    updateMetric('Anchor tracking mode', mode);
  }, [updateMetric]);

  const findDetectionAtPosition = useCallback((position) => {
    if (anchorSystemState.mode === 'detection') {
      return anchorManagerRef.current.findDetectionAtPosition(position);
    }
    return null;
  }, [anchorSystemState.mode]);

  const generatePersonality = useCallback((imageData, bbox) => {
    return personalityServiceRef.current.generatePersonality(imageData, bbox);
  }, []);

  const synthesizeSpeech = useCallback((text, voiceStyle, emotionalDelivery) => {
    return ttsClientRef.current.synthesizeSpeech(text, voiceStyle, emotionalDelivery);
  }, []);

  const stopTTS = useCallback(() => {
    ttsClientRef.current.stopCurrentAudio();
  }, []);

  const speakGreeting = useCallback(async () => {
    if (personalityData.currentPersona && personalityData.currentPersona.oneLiners) {
      const greeting = personalityData.currentPersona.oneLiners[0]; // First one-liner is greeting
      const voiceStyle = personalityData.currentPersona.voiceStyle || 'cheerful';
      const emotionalDelivery = personalityData.currentPersona.emotionalDelivery || personalityData.currentPersona.tone;
      
      logger.info('CameraSystem', 'Speaking greeting:', greeting, 'with voice style:', voiceStyle);
      return await synthesizeSpeech(greeting, voiceStyle, emotionalDelivery);
    } else {
      logger.warn('CameraSystem', 'No persona available for greeting');
    }
  }, [personalityData.currentPersona, synthesizeSpeech]);

  const setCurrentCanvas = useCallback((canvas) => {
    currentCanvasRef.current = canvas;
  }, []);

  const getCameraMatrix = useCallback((width, height) => {
    const fov = 60 * Math.PI / 180;
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
    detectionState,
    depthState,
    anchorSystemState,
    personalityData,
    ttsData,
    cvLoaded,

    services: {
      camera: cameraServiceRef.current,
      detection: detectionServiceRef.current,
      depth: depthServiceRef.current,
      anchor: anchorManagerRef.current,
      personality: personalityServiceRef.current,
      tts: ttsClientRef.current
    },

    startCamera,
    resumeCamera,
    stopCamera,

    detectObjects,

    processDetections,
    updateAnchor,
    refreshAnchorSegmentation,
    createAnchorFromTap,
    clearAnchor,
    findDetectionAtPosition,
    setAnchorTrackingMode,
    setDetectionEnabled,

    generatePersonality,

    synthesizeSpeech,
    stopTTS,
    speakGreeting,

    getCameraMatrix,
    setCurrentCanvas
  };
};
