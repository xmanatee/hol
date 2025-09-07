import { useState, useRef, useEffect, useCallback } from 'react';
import { CameraService } from '../services/CameraService.js';
import { DetectionService } from '../services/DetectionService.js';
import { NormalEstimationService } from '../services/NormalEstimationService.js';
import { AnchorManager } from '../services/AnchorManager.js';
import { PersonalityService } from '../services/PersonalityService.js';
import { TTSClient } from '../audio/ttsClient.js';
import { useHudMetrics } from './useHudMetrics.js';

export const useCameraSystem = (config = {}) => {
  // Services
  const cameraServiceRef = useRef(new CameraService());
  const detectionServiceRef = useRef(new DetectionService());
  const normalServiceRef = useRef(new NormalEstimationService());
  const anchorManagerRef = useRef(new AnchorManager(config));
  const personalityServiceRef = useRef(new PersonalityService(config.personality));
  const ttsClientRef = useRef(new TTSClient(config.tts));
  const currentCanvasRef = useRef(null);
  const [_initialized, setInitialized] = useState(false);

  // Normal history for jitter calculation
  const normalHistoryRef = useRef([]);

  // State
  const [cameraState, setCameraState] = useState('idle');
  const [videoDimensions, setVideoDimensions] = useState({ width: 1280, height: 720 });
  const [detectionState, setDetectionState] = useState({
    isInitialized: false,
    isModelLoaded: false,
    error: null,
    processingTime: 0,
    lastDetections: null
  });
  const [anchorData, setAnchorData] = useState({
    trackedObjects: [],
    activeTrackId: null,
    anchorStates: new Map()
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

  const { updateMetric } = useHudMetrics();

  // Initialize services
  useEffect(() => {
    let isMounted = true;

    const initializeServices = async () => {
      try {
        // Initialize each service only if not already initialized (StrictMode compatibility)
        const detectionService = detectionServiceRef.current;
        const normalService = normalServiceRef.current;
        const anchorManager = anchorManagerRef.current;
        
        // Initialize detection service
        if (!detectionService.isInitialized) {
          await detectionService.initialize();
          if (!isMounted) return;
        }
        
        if (!detectionService.isModelLoaded) {
          await detectionService.loadModel();
          if (!isMounted) return;
        }

        // Initialize other services
        if (!normalService.isReady) {
          await normalService.initialize();
          if (!isMounted) return;
        }

        if (!anchorManager.initialized) {
          await anchorManager.initialize();
          if (!isMounted) return;
        }

        // Initialize TTS client
        const ttsClient = ttsClientRef.current;
        await ttsClient.initialize();

        if (isMounted) {
          console.log('[CameraSystem] All services initialized successfully');
          setDetectionState(prev => ({ ...prev, isInitialized: true, isModelLoaded: detectionService.isModelLoaded }));
          setInitialized(true);
        }
      } catch (error) {
        console.error('[CameraSystem] Service initialization failed:', error);
        setDetectionState(prev => ({ ...prev, error: error.message }));
      }
    };

    initializeServices();

    return () => {
      isMounted = false;
      // Note: Don't dispose ref-based services here as they persist across StrictMode remounts
    };
  }, []);

  // Set up service listeners
  useEffect(() => {
    const cameraService = cameraServiceRef.current;
    const detectionService = detectionServiceRef.current;
    const anchorManager = anchorManagerRef.current;
    const normalService = normalServiceRef.current;

    // Camera service listeners
    const removeCameraListener = cameraService.addListener({
      onStateChange: (newState, oldState, data) => {
        setCameraState(newState);
        if (newState === 'active' && data) {
          setVideoDimensions({ width: data.width, height: data.height });
        }
      }
    });

    // Detection service listeners
    const removeDetectionListener = detectionService.addListener({
      onInitialized: () => {
        console.log('[CameraSystem] Detection service initialized');
        setDetectionState(prev => ({ ...prev, isInitialized: true }));
      },
      onModelLoaded: () => {
        console.log('[CameraSystem] Detection model loaded');
        setDetectionState(prev => ({ ...prev, isModelLoaded: true }));
      },
      onDetections: ({ detections, processingTime }) => {
        console.log('[CameraSystem] Received detections:', detections.length);
        setDetectionState(prev => ({ ...prev, processingTime, lastDetections: detections }));
        updateMetric('Detection amortized cost', processingTime);
      },
      onError: ({ error }) => {
        console.error('[CameraSystem] Detection error:', error);
        setDetectionState(prev => ({ ...prev, error }));
      }
    });

    // Normal estimation service listeners
    const removeNormalListener = normalService.addListener({
      onNormal: ({ normal, confidence, method }) => {
        console.log('[CameraSystem] Normal estimated:', normal, 'confidence:', confidence, 'method:', method);
        
        // Validate normal data before processing
        if (!normal || typeof normal !== 'object' || typeof normal.x !== 'number' || typeof normal.y !== 'number' || typeof normal.z !== 'number') {
          console.warn('[CameraSystem] Invalid normal data received:', normal);
          return;
        }
        
        anchorManager.updateNormal(normal);
        updateMetric('Mode confidence', method === 'planar' ? 'Planar' : 'Cylindrical');
        
        // Calculate normal jitter (Phase 5 metric)
        const history = normalHistoryRef.current;
        history.push({ normal, timestamp: performance.now() });
        
        // Keep only last 1 second of history
        const oneSecondAgo = performance.now() - 1000;
        normalHistoryRef.current = history.filter(entry => entry.timestamp > oneSecondAgo);
        
        // Calculate jitter if we have enough history
        if (normalHistoryRef.current.length >= 5) {
          const normals = normalHistoryRef.current.map(entry => entry.normal);
          const meanNormal = {
            x: normals.reduce((sum, n) => sum + n.x, 0) / normals.length,
            y: normals.reduce((sum, n) => sum + n.y, 0) / normals.length,
            z: normals.reduce((sum, n) => sum + n.z, 0) / normals.length
          };
          
          const angleDiffs = normals.map(n => {
            const dot = n.x * meanNormal.x + n.y * meanNormal.y + n.z * meanNormal.z;
            return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI; // Convert to degrees
          });
          
          const jitterStd = Math.sqrt(angleDiffs.reduce((sum, diff) => sum + diff * diff, 0) / angleDiffs.length);
          updateMetric('Normal jitter', jitterStd);
        }
      },
      onError: ({ error }) => {
        console.error('[CameraSystem] Normal estimation error:', error);
      }
    });

    // Anchor manager listeners
    const removeAnchorListener = anchorManager.addListener({
      onAnchorUpdate: ({ trackedObjects, activeTrackId, anchorStates }) => {
        setAnchorData({ trackedObjects, activeTrackId, anchorStates });
      }
    });

    // Personality service listeners
    const personalityService = personalityServiceRef.current;
    const removePersonalityListener = personalityService.addListener({
      onPersonalityStart: ({ requestId }) => {
        console.log('[CameraSystem] Personality generation started for request:', requestId);
        setPersonalityData(prev => ({ ...prev, isProcessing: true, error: null }));
      },
      onPersonalityGenerated: ({ persona, rtt, success, error }) => {
        console.log('[CameraSystem] Personality generated:', { persona, rtt, success });
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
        console.log('[CameraSystem] TTS synthesis started:', { text, voiceStyle, requestId });
        setTTSData(prev => ({ ...prev, isSynthesizing: true, error: null }));
      },
      onAudioStart: ({ duration, analyser, latencyToFirstAudio }) => {
        console.log('[CameraSystem] TTS audio started, latency:', latencyToFirstAudio, 'ms');
        setTTSData(prev => ({ 
          ...prev, 
          isSynthesizing: false, 
          isPlaying: true, 
          currentAnalyser: analyser,
          lastLatency: latencyToFirstAudio 
        }));
        updateMetric('TTS latency to first audio', latencyToFirstAudio);
      },
      onAudioAnalysis: ({ energy, centroid, spectrum }) => {
        // Forward lip-sync data to lip-sync system (Phase 12)
        // For now just update metrics
        updateMetric('Audio energy', energy);
        updateMetric('Audio centroid', centroid);
      },
      onPlaybackComplete: () => {
        console.log('[CameraSystem] TTS playback completed');
        setTTSData(prev => ({ ...prev, isPlaying: false, currentAnalyser: null }));
      },
      onSynthesisComplete: ({ text, voiceStyle, latency }) => {
        console.log('[CameraSystem] TTS synthesis completed:', { text, voiceStyle, latency });
        updateMetric('TTS total latency', latency);
      },
      onError: ({ error }) => {
        console.error('[CameraSystem] TTS error:', error);
        setTTSData(prev => ({ ...prev, isSynthesizing: false, isPlaying: false, error }));
      }
    });

    return () => {
      removeCameraListener();
      removeDetectionListener();
      removeNormalListener();
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

  // Anchor controls
  const processDetections = useCallback((detections, imageData) => {
    return anchorManagerRef.current.processDetections(detections, imageData);
  }, []);

  const processWithoutDetections = useCallback((imageData) => {
    return anchorManagerRef.current.processWithoutDetections(imageData);
  }, []);

  const selectTrack = useCallback((trackId) => {
    anchorManagerRef.current.selectTrack(trackId);
  }, []);

  const clearActiveTrack = useCallback(() => {
    anchorManagerRef.current.clearActiveTrack();
  }, []);

  const findTrackAtPosition = useCallback((position) => {
    return anchorManagerRef.current.findTrackAtPosition(anchorData.trackedObjects, position);
  }, [anchorData.trackedObjects]);

  // Normal estimation
  const estimateNormal = useCallback((imageData, bbox, cameraMatrix) => {
    return normalServiceRef.current.estimateNormal(imageData, bbox, cameraMatrix);
  }, []);

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
      
      console.log('[CameraSystem] Speaking greeting:', greeting, 'with voice style:', voiceStyle);
      return await synthesizeSpeech(greeting, voiceStyle);
    } else {
      console.warn('[CameraSystem] No persona available for greeting');
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
    videoDimensions,
    detectionState,
    anchorData,
    personalityData,
    ttsData,

    // Services refs for direct access if needed
    services: {
      camera: cameraServiceRef.current,
      detection: detectionServiceRef.current,
      normal: normalServiceRef.current,
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

    // Anchor controls
    processDetections,
    processWithoutDetections,
    selectTrack,
    clearActiveTrack,
    findTrackAtPosition,

    // Normal estimation
    estimateNormal,

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