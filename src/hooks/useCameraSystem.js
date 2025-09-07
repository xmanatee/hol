import { useState, useRef, useEffect, useCallback } from 'react';
import { CameraService } from '../services/CameraService.js';
import { DetectionService } from '../services/DetectionService.js';
import { NormalEstimationService } from '../services/NormalEstimationService.js';
import { AnchorManager } from '../services/AnchorManager.js';
import { useHudMetrics } from './useHudMetrics.js';

export const useCameraSystem = () => {
  // Services
  const cameraServiceRef = useRef(new CameraService());
  const detectionServiceRef = useRef(new DetectionService());
  const normalServiceRef = useRef(new NormalEstimationService());
  const anchorManagerRef = useRef(new AnchorManager());
  const currentCanvasRef = useRef(null);
  const [initialized, setInitialized] = useState(false);

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

        if (isMounted) {
          console.log('[CameraSystem] All services initialized successfully');
          setDetectionState(prev => ({ ...prev, isInitialized: true, isModelLoaded: detectionService.isModelLoaded }));
          setInitialized(true);
        }

        setInitialized(true);
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

    // Anchor manager listeners
    const removeAnchorListener = anchorManager.addListener({
      onAnchorUpdate: ({ trackedObjects, activeTrackId, anchorStates }) => {
        setAnchorData({ trackedObjects, activeTrackId, anchorStates });
      }
    });

    return () => {
      removeCameraListener();
      removeDetectionListener();
      removeAnchorListener();
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

    // Services refs for direct access if needed
    services: {
      camera: cameraServiceRef.current,
      detection: detectionServiceRef.current,
      normal: normalServiceRef.current,
      anchor: anchorManagerRef.current
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

    // Utilities
    getCameraMatrix,
    setCurrentCanvas
  };
};