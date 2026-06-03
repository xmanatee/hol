import { useState, useRef, useEffect, useCallback } from 'react';
import { CameraService } from '../services/CameraService.js';
import { DetectionService } from '../services/DetectionService.js';
import { AnchorManager } from '../services/AnchorManager.js';
import { PersonalityService } from '../services/PersonalityService.js';
import { TTSClient } from '../audio/ttsClient.js';
import { logger } from '../utils/logger.js';

export const useCameraSystem = (config = {}) => {
  // Services
  const cameraServiceRef = useRef(new CameraService());
  const detectionServiceRef = useRef(new DetectionService());
  const anchorManagerRef = useRef(new AnchorManager(config));
  const personalityServiceRef = useRef(new PersonalityService(config.personality));
  const ttsClientRef = useRef(new TTSClient(config.tts));
  const currentCanvasRef = useRef(null);
  const metricUpdateRef = useRef(config.onMetricUpdate || null);
  const [_initialized, setInitialized] = useState(false);
  const [cvLoaded, setCvLoaded] = useState(false);

  // State
  const [cameraState, setCameraState] = useState('idle');
  const [cameraError, setCameraError] = useState(null);
  const [videoDimensions, setVideoDimensions] = useState({ width: 1280, height: 720 });
  const [detectionState, setDetectionState] = useState({
    isInitialized: false,
    isModelLoaded: false,
    detectionEnabled: true,
    error: null,
    processingTime: 0,
    lastDetections: null
  });
  const [anchorSystemState, setAnchorSystemState] = useState({
    mode: 'detection', // 'detection' or 'anchor'
    detections: [],
    activeAnchor: null,
    anchorState: null,
    initialized: false
  });
  
  const [personalityData, setPersonalityData] = useState({
    isProcessing: false,
    currentPersona: null,
    error: null,
    lastRTT: 0
  });

  const [ttsData, setTTSData] = useState({
    isSynthesizing: false,
    isPlaying: false,
    currentAnalyser: null,
    error: null,
    lastLatency: 0
  });

  useEffect(() => {
    metricUpdateRef.current = config.onMetricUpdate || null;
  }, [config.onMetricUpdate]);

  const updateMetric = useCallback((name, value) => {
    metricUpdateRef.current?.(name, value);
  }, []);

  // Load OpenCV.js (singleton pattern to prevent double loading)
  useEffect(() => {
    const loadOpenCV = async () => {
      try {
        // Check if OpenCV is already loaded
        if (typeof window.cv !== 'undefined' && window.cv.Mat) {
          logger.info('CameraSystem', 'OpenCV.js already loaded');
          setCvLoaded(true);
          return;
        }

        // Check if already loading (prevent double loading)
        if (window.__opencv_loading) {
          logger.info('CameraSystem', 'OpenCV.js already loading, waiting...');
          const waitForCV = () => {
            if (typeof window.cv !== 'undefined' && window.cv.Mat) {
              logger.info('CameraSystem', 'OpenCV.js loaded by another component');
              setCvLoaded(true);
            } else if (!window.__opencv_loading) {
              // Loading failed, retry
              loadOpenCV();
            } else {
              setTimeout(waitForCV, 100);
            }
          };
          waitForCV();
          return;
        }

        // Check if script already exists in DOM
        const existingScript = document.querySelector('script[src="/opencv.js"]');
        if (existingScript) {
          logger.info('CameraSystem', 'OpenCV.js script already in DOM, waiting for load...');
          const waitForCV = () => {
            if (typeof window.cv !== 'undefined' && window.cv.Mat) {
              logger.info('CameraSystem', 'OpenCV.js finished loading');
              setCvLoaded(true);
            } else {
              setTimeout(waitForCV, 100);
            }
          };
          waitForCV();
          return;
        }

        logger.info('CameraSystem', 'Loading OpenCV.js');
        window.__opencv_loading = true;
        
        // Load OpenCV.js via script tag
        const script = document.createElement('script');
        script.src = '/opencv.js';
        script.async = true;
        
        script.onload = () => {
          // Wait for cv to be available on window
          let waitAttempts = 0;
          const maxWaitAttempts = 100; // 10 seconds max
          
          const waitForCV = () => {
            waitAttempts++;
            if (typeof window.cv !== 'undefined' && window.cv.Mat) {
              logger.info('CameraSystem', 'OpenCV.js loaded successfully');
              window.__opencv_loading = false;
              setCvLoaded(true);
            } else if (waitAttempts < maxWaitAttempts) {
              setTimeout(waitForCV, 100);
            } else {
              logger.error('CameraSystem', 'OpenCV.js failed to initialize - timeout after 10 seconds');
              window.__opencv_loading = false;
              setCvLoaded(false);
            }
          };
          waitForCV();
        };
        
        script.onerror = (error) => {
          logger.error('CameraSystem', 'Failed to load OpenCV.js script:', error);
          window.__opencv_loading = false;
          setCvLoaded(false);
        };
        
        document.head.appendChild(script);
        
      } catch (error) {
        logger.error('CameraSystem', 'Failed to load OpenCV.js:', error);
        window.__opencv_loading = false;
      }
    };

    loadOpenCV();

    // Cleanup on unmount
    return () => {
      // Don't remove script or cv object as it may be used by other components
      // Just mark this component as no longer needing OpenCV
    };
  }, []);

  // Initialize services after OpenCV is loaded
  useEffect(() => {
    if (!cvLoaded) return;

    let isMounted = true;

    const initializeServices = async () => {
      try {
        const detectionService = detectionServiceRef.current;
        const anchorManager = anchorManagerRef.current;
        const { width, height } = videoDimensions;
        
        // Initialize detection service
        if (!detectionService.isInitialized) {
          await detectionService.initialize();
          if (!isMounted) return;
        }
        
        if (!detectionService.isModelLoaded) {
          await detectionService.loadModel();
          if (!isMounted) return;
        }

        // Initialize anchor manager with OpenCV and camera parameters
        if (!anchorManager.initialized) {
          await anchorManager.initialize(window.cv, width, height);
          if (!isMounted) return;
        }

        // Initialize TTS client
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

  // Set up service listeners
  useEffect(() => {
    const cameraService = cameraServiceRef.current;
    const detectionService = detectionServiceRef.current;
    const anchorManager = anchorManagerRef.current;

    // Camera service listeners
    const removeCameraListener = cameraService.addListener({
      onStateChange: (newState, oldState, data) => {
        setCameraState(newState);
        setCameraError(data.error || null);
        if (newState === 'active' && data) {
          setVideoDimensions({ width: data.width, height: data.height });
        }
      }
    });

    // Detection service listeners
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
        logger.info('CameraSystem', 'Received detections:', detections.length);
        setDetectionState(prev => ({ ...prev, processingTime, lastDetections: detections }));
        updateMetric('Detection amortized cost', processingTime);
      },
      onError: ({ error }) => {
        logger.error('CameraSystem', 'Detection error:', error);
        setDetectionState(prev => ({ ...prev, error }));
      }
    });

    // Anchor manager listeners
    const removeAnchorListener = anchorManager.addListener({
      onAnchorUpdate: (state) => {
        setAnchorSystemState(state);
        
        // Update metrics based on anchor state
        if (state.anchorState) {
          const { metrics } = state.anchorState;
          if (metrics) {
            updateMetric('Keypoint count', metrics.keypointCount || 0);
            updateMetric('Tracking success rate', ((metrics.trackingSuccessRate || 0) * 100).toFixed(1) + '%');
            updateMetric('Homography inliers', metrics.homographyInliers || 0);
            updateMetric('Processing time', (metrics.processingTime || 0).toFixed(2) + ' ms');
            
            if (metrics.templateQuality) {
              updateMetric('Template quality', (metrics.templateQuality * 100).toFixed(1) + '%');
            }
          }
          
          // Update anchor stability metrics
          if (state.anchorState.normal) {
            updateMetric('Surface normal', `[${state.anchorState.normal.x.toFixed(2)}, ${state.anchorState.normal.y.toFixed(2)}, ${state.anchorState.normal.z.toFixed(2)}]`);
          }
          
          updateMetric('Anchor state', state.anchorState.state || 'inactive');
        }
        
        updateMetric('System mode', state.mode);
      }
    });

    // Personality service listeners
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

    // TTS client listeners
    const ttsClient = ttsClientRef.current;
    const removeTTSListener = ttsClient.addListener({
      onSynthesisStart: ({ text, voiceStyle, requestId }) => {
        logger.info('CameraSystem', 'TTS synthesis started:', { text, voiceStyle, requestId });
        setTTSData(prev => ({ ...prev, isSynthesizing: true, error: null }));
      },
      onAudioStart: ({ latencyToFirstAudio }) => {
        logger.info('CameraSystem', 'TTS audio started, latency:', latencyToFirstAudio, 'ms');
        setTTSData(prev => ({ 
          ...prev, 
          isSynthesizing: false, 
          isPlaying: true, 
          currentAnalyser: null,
          lastLatency: latencyToFirstAudio 
        }));
        updateMetric('TTS latency to first audio', latencyToFirstAudio);
      },
      onAudioAnalysis: ({ energy, centroid }) => {
        updateMetric('Audio energy', energy);
        updateMetric('Audio centroid', centroid);
        updateMetric('Current viseme', 'TBD'); // Will be updated by lip-sync system
      },
      onPlaybackComplete: () => {
        logger.info('CameraSystem', 'TTS playback completed');
        setTTSData(prev => ({ ...prev, isPlaying: false, currentAnalyser: null }));
      },
      onSynthesisComplete: ({ text, voiceStyle, latency }) => {
        logger.info('CameraSystem', 'TTS synthesis completed:', { text, voiceStyle, latency });
        updateMetric('TTS total latency', latency);
      },
      onError: ({ error }) => {
        logger.error('CameraSystem', 'TTS error:', error);
        setTTSData(prev => ({ ...prev, isSynthesizing: false, isPlaying: false, error }));
      }
    });

    return () => {
      removeCameraListener();
      removeDetectionListener();
      removeAnchorListener();
      removePersonalityListener();
      removeTTSListener();
    };
  }, [updateMetric]);

  // Camera controls
  const startCamera = useCallback(async (videoElement) => {
    return await cameraServiceRef.current.start(videoElement);
  }, []);

  const resumeCamera = useCallback(async () => {
    return await cameraServiceRef.current.resume();
  }, []);

  const stopCamera = useCallback(() => {
    cameraServiceRef.current.stop();
  }, []);

  // Detection controls
  const detectObjects = useCallback((imageData) => {
    return detectionServiceRef.current.detectObjects(imageData);
  }, []);

  // Anchor system controls
  const processDetections = useCallback((detections, imageData) => {
    if (anchorSystemState.mode === 'detection') {
      return anchorManagerRef.current.processDetections(detections, imageData);
    }
    return [];
  }, [anchorSystemState.mode]);

  const updateAnchor = useCallback((imageData) => {
    if (anchorSystemState.mode === 'anchor') {
      return anchorManagerRef.current.updateAnchor(imageData);
    }
    return { success: false, reason: 'Not in anchor mode' };
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
    
    // Re-enable detection when returning to detection mode
    detectionServiceRef.current.setDetectionEnabled(true);
    setDetectionState(prev => ({ ...prev, detectionEnabled: true }));
    
    updateMetric('Anchor cleared', 'Returned to detection mode');
  }, [updateMetric]);

  const findDetectionAtPosition = useCallback((position) => {
    if (anchorSystemState.mode === 'detection') {
      return anchorManagerRef.current.findDetectionAtPosition(position);
    }
    return null;
  }, [anchorSystemState.mode]);

  // Personality generation
  const generatePersonality = useCallback((imageData, bbox) => {
    return personalityServiceRef.current.generatePersonality(imageData, bbox);
  }, []);

  // TTS controls
  const synthesizeSpeech = useCallback((text, voiceStyle) => {
    return ttsClientRef.current.synthesizeSpeech(text, voiceStyle);
  }, []);

  const stopTTS = useCallback(() => {
    ttsClientRef.current.stopCurrentAudio();
  }, []);

  const speakGreeting = useCallback(async () => {
    if (personalityData.currentPersona && personalityData.currentPersona.oneLiners) {
      const greeting = personalityData.currentPersona.oneLiners[0]; // First one-liner is greeting
      const voiceStyle = personalityData.currentPersona.voiceStyle || 'cheerful';
      
      logger.info('CameraSystem', 'Speaking greeting:', greeting, 'with voice style:', voiceStyle);
      return await synthesizeSpeech(greeting, voiceStyle);
    } else {
      logger.warn('CameraSystem', 'No persona available for greeting');
    }
  }, [personalityData.currentPersona, synthesizeSpeech]);


  // Set current canvas for detection processing
  const setCurrentCanvas = useCallback((canvas) => {
    currentCanvasRef.current = canvas;
  }, []);


  // Compute camera matrix utility
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
    // State
    cameraState,
    cameraError,
    videoDimensions,
    detectionState,
    anchorSystemState, // New unified anchor system state
    personalityData,
    ttsData,
    cvLoaded, // OpenCV loading state

    // Services refs for direct access if needed
    services: {
      camera: cameraServiceRef.current,
      detection: detectionServiceRef.current,
      anchor: anchorManagerRef.current,
      personality: personalityServiceRef.current,
      tts: ttsClientRef.current
    },

    // Camera controls
    startCamera,
    resumeCamera,
    stopCamera,

    // Detection controls
    detectObjects,

    // New image-based anchor controls
    processDetections,
    updateAnchor,
    createAnchorFromTap,
    clearAnchor,
    findDetectionAtPosition,

    // Legacy compatibility methods (deprecated)
    processWithoutDetections: updateAnchor, // Maps to updateAnchor for compatibility
    selectTrack: createAnchorFromTap, // Legacy - use createAnchorFromTap instead
    clearActiveTrack: clearAnchor, // Maps to clearAnchor
    findTrackAtPosition: findDetectionAtPosition, // Maps to findDetectionAtPosition

    // Personality generation
    generatePersonality,

    // TTS controls
    synthesizeSpeech,
    stopTTS,
    speakGreeting,

    // Utilities
    getCameraMatrix,
    setCurrentCanvas
  };
};
