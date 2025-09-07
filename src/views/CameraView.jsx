import { useRef, useCallback, useState } from 'react';
import { useAnimationFrame, useFrameRate } from '../hooks/useAnimationFrame.js';
import { useCameraSystem } from '../hooks/useCameraSystem.js';
import { useHudMetrics } from '../hooks/useHudMetrics.js';

import CameraVideo from '../components/CameraVideo.jsx';
import DetectionCanvas from '../components/DetectionCanvas.jsx';
import UnifiedControlPanel from '../components/ui/UnifiedControlPanel.jsx';
import OverlayScene from '../scenes/OverlayScene.jsx';

import { renderDetectionOverlay, renderDebugStats } from '../utils/detectionRenderer.js';

// Start Screen Component - separate from control panel
const StartScreen = ({ cameraState, onStartCamera }) => {
  if (cameraState === 'active') return null;
  
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black z-40 pointer-events-auto">
      <div className="text-center text-white max-w-sm mx-auto px-4">
        <h1 className="text-4xl font-bold mb-4 text-white">
          High on Life
        </h1>
        <p className="text-base mb-8 text-gray-400">
          Point your camera at bottles and cans to bring them to life
        </p>
        <button
          onClick={onStartCamera}
          className="px-6 py-3 text-lg bg-blue-600 text-white border-0 rounded-lg cursor-pointer hover:bg-blue-700 transition-all duration-200 font-medium"
        >
          {cameraState === 'blocked' ? 'Resume Camera' : 'Start Camera'}
        </button>
        <div className="mt-6 text-sm text-gray-500">
          Allow camera permissions when prompted
        </div>
      </div>
    </div>
  );
};

const CameraView = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const frameCountRef = useRef(0);
  const ctxRef = useRef(null);

  const [showStats, setShowStats] = useState(false);
  const [lastProcessedDetections, setLastProcessedDetections] = useState(null);

  // Use the camera system hook
  const {
    cameraState,
    videoDimensions,
    detectionState,
    anchorData,
    services,
    startCamera,
    resumeCamera,
    stopCamera,
    detectObjects,
    processDetections,
    processWithoutDetections,
    selectTrack,
    clearActiveTrack,
    findTrackAtPosition,
    estimateNormal,
    getCameraMatrix,
    setCurrentCanvas
  } = useCameraSystem();

  const { metrics, updateMetric } = useHudMetrics();
  const throttledFrame = useFrameRate(30);

  // Handle camera start/resume
  const handleStartClick = useCallback(async () => {
    if (cameraState === 'blocked') {
      await resumeCamera();
    } else {
      await startCamera(videoRef.current);
    }
  }, [cameraState, startCamera, resumeCamera]);

  const handleConfigChange = useCallback((config) => {
    if (config.detectionInterval) {
      services.detection.setDetectionInterval(config.detectionInterval);
    }
  }, [services.detection]);

  // Handle canvas tap for track selection
  const handleCanvasTap = useCallback((event, canvas) => {
    if (!canvas || anchorData.trackedObjects.length === 0) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const tapX = event.clientX - rect.left;
    const tapY = event.clientY - rect.top;

    // Convert tap coordinates to canvas space
    const x = (tapX / rect.width) * canvas.width;
    const y = (tapY / rect.height) * canvas.height;

    const position = { x, y };
    const bestTrack = findTrackAtPosition(position);

    if (bestTrack) {
      selectTrack(bestTrack.id);
    }
  }, [anchorData.trackedObjects, findTrackAtPosition, selectTrack]);

  // Main animation frame loop
  useAnimationFrame(() => {
    if (cameraState === 'active' && videoRef.current && canvasRef.current) {
      throttledFrame(({ fps, frameTime }) => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        
        // Get or cache the context with willReadFrequently
        if (!ctxRef.current) {
          ctxRef.current = canvas.getContext('2d', { willReadFrequently: true });
        }
        const ctx = ctxRef.current;

        // Match canvas size to video dimensions
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          // Context is invalidated when canvas size changes, so we need to get it again
          ctxRef.current = canvas.getContext('2d', { willReadFrequently: true });
        }

        // Draw current video frame to canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Run detection every 4th frame
        frameCountRef.current++;
        const shouldDetect = frameCountRef.current % 4 === 0 && detectionState.isModelLoaded;

        if (shouldDetect) {
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          detectObjects(imageData);
        }
        
        // Process new detections if available
        if (detectionState.lastDetections && detectionState.lastDetections !== lastProcessedDetections) {
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          processDetections(detectionState.lastDetections, imageData);
          setLastProcessedDetections(detectionState.lastDetections);
        }

        // Handle detections or recovery
        if (anchorData.trackedObjects.length > 0) {
          // We have tracks, continue processing
        } else if (anchorData.activeTrackId) {
          // No detections but we have an active track - try recovery
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          processWithoutDetections(imageData);
        }

        // Run normal estimation for stable track
        if (anchorData.activeTrackId) {
          const anchorState = anchorData.anchorStates.get(anchorData.activeTrackId);
          if (anchorState?.state === 'stable') {
            const activeTrack = anchorData.trackedObjects.find(t => t.id === anchorData.activeTrackId);
            if (activeTrack) {
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const cameraMatrix = getCameraMatrix(canvas.width, canvas.height);
              estimateNormal(imageData, activeTrack.bbox, cameraMatrix);
            }
          }
        }

        // Draw detection overlay
        renderDetectionOverlay(ctx, {
          trackedObjects: anchorData.trackedObjects,
          activeTrackId: anchorData.activeTrackId,
          anchorStates: anchorData.anchorStates,
          stabilityTrackerRef: { current: services.anchor.stabilityTracker },
          persistenceTrackerRef: { current: services.anchor.persistenceTracker }
        });

        // Update HUD metrics
        const processingTime = detectionState.processingTime || 0;
        const objectCount = anchorData.trackedObjects?.length || 0;
        
        // Debug: console.log('[Metrics] Updating:', { fps, frameTime, processingTime, objectCount });
        
        if (typeof fps === 'number' && !isNaN(fps)) {
          updateMetric('Capture FPS', fps);
        }
        if (typeof frameTime === 'number' && !isNaN(frameTime)) {
          updateMetric('Render frame time', frameTime);
        }
        updateMetric('Detection amortized cost', processingTime);
        updateMetric('Object Count', objectCount);
        
        // Update Phase 4 stability metrics for active track
        if (anchorData.activeTrackId) {
          const anchorState = anchorData.anchorStates.get(anchorData.activeTrackId);
          if (anchorState?.metrics) {
            const { centerVelocity, areaChangePercent, confidenceRate } = anchorState.metrics;
            
            // Calculate stability score as per Phase 4 spec
            const v_norm = Math.min(centerVelocity / 30, 1);
            const area_delta = Math.min(Math.abs(areaChangePercent) / 10, 1);
            const conf_norm = confidenceRate;
            const stabilityScore = Math.max(0, (1 - v_norm) * (1 - area_delta) * conf_norm);
            
            updateMetric('Stability score', stabilityScore);
            
            // Calculate lock time if stability score is good
            if (stabilityScore >= 0.75) {
              const tracker = services.anchor.stabilityTracker;
              const stats = tracker?.trackStats?.get(anchorData.activeTrackId);
              if (stats?.stableStartTime) {
                const lockTime = (performance.now() - stats.stableStartTime) / 1000;
                updateMetric('lock time', lockTime);
              }
            }
          }
        }
        
        // Update Phase 3 Track ID persistence metric
        // This measures % of frames where the active trackId remains unchanged
        // For now, we'll use a simple heuristic: if we have an active track with detections, it's persistent
        if (anchorData.activeTrackId && anchorData.trackedObjects.length > 0) {
          const activeTrack = anchorData.trackedObjects.find(t => t.id === anchorData.activeTrackId);
          if (activeTrack) {
            // If we found the active track in current detections, it's persistent
            updateMetric('Track ID persistence', 100);
          } else {
            // Active track not found in current detections
            updateMetric('Track ID persistence', 0);
          }
        }
        
        // TODO: Phase 5 Normal estimation metrics (when implemented)
        // updateMetric('Normal jitter', normalJitter);
        // updateMetric('Mode confidence', modeConfidence);
        
        // TODO: Phase 6 Persistence metrics (when implemented) 
        // updateMetric('Short-loss survival', survivalRate);
        // updateMetric('Reattach latency', reattachTime);

        // Only draw debug stats on canvas if showStats is enabled
        if (showStats) {
          renderDebugStats(ctx, {
            fps,
            frameTime,
            processingTime: detectionState.processingTime,
            objectCount: anchorData.trackedObjects.length
          });
        }
      });
    }
  });

  // Set canvas ref for child component
  const handleCanvasDraw = useCallback((canvas) => {
    canvasRef.current = canvas;
    setCurrentCanvas(canvas);
  }, [setCurrentCanvas]);

  return (
    <div className="camera-view fixed top-0 left-0 w-screen h-screen overflow-hidden">
      {/* Video element - hidden when active since canvas shows the processed image */}
      <CameraVideo ref={videoRef} isVisible={cameraState === 'idle' || cameraState === 'blocked'} />
      
      {/* Canvas for CV processing and detection overlay */}
      <DetectionCanvas
        cameraState={cameraState}
        onTap={handleCanvasTap}
        onDraw={handleCanvasDraw}
      />

      {/* WebGL Overlay Scene - only when camera is active */}
      {cameraState === 'active' && (
        <OverlayScene 
          width={videoDimensions.width} 
          height={videoDimensions.height} 
          anchors={Array.from(anchorData.anchorStates.entries()).map(([id, anchorState]) => ({
            id,
            state: anchorState.state,
            screenPosition: anchorState.screenPosition,
            color: '#FFD700'
          }))}
        />
      )}

      {/* Start Screen - only when camera is not active */}
      <StartScreen 
        cameraState={cameraState} 
        onStartCamera={handleStartClick} 
      />

      {/* Control Panel - only when camera is active, minimized by default */}
      {cameraState === 'active' && (
        <UnifiedControlPanel
          cameraState={cameraState}
          detectionInitialized={detectionState.isInitialized}
          isModelLoaded={detectionState.isModelLoaded}
          detectionError={detectionState.error}
          trackedObjects={anchorData.trackedObjects}
          activeTrackId={anchorData.activeTrackId}
          showStats={showStats}
          onToggleStats={() => setShowStats(!showStats)}
          onUnlock={clearActiveTrack}
          onStop={stopCamera}
          onConfigChange={handleConfigChange}
          metrics={metrics}
        />
      )}
    </div>
  );
};

export default CameraView;