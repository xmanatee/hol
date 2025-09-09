import { useRef, useCallback, useState } from 'react';
import { useAnimationFrame, useFrameRate } from '../hooks/useAnimationFrame.js';
import { useCameraSystem } from '../hooks/useCameraSystem.js';
import { useHudMetrics } from '../hooks/useHudMetrics.js';
import { Canvas } from '@react-three/fiber';

import CameraVideo from '../components/CameraVideo.jsx';
import DetectionCanvas from '../components/DetectionCanvas.jsx';
import UnifiedControlPanel from '../components/ui/UnifiedControlPanel.jsx';
import OverlayScene from '../scenes/OverlayScene.jsx';

import { renderDetectionOverlay, renderDebugStats, renderKeypoints } from '../utils/detectionRenderer.js';
import { logger } from '../utils/logger.js';

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
  const [cameraSystemConfig, setCameraSystemConfig] = useState({
    useWorkerPersistence: false // Default to simple persistence for Phase 1-6
  });
  const [needsRestart, setNeedsRestart] = useState(false);
  const [discoveredMeshes, setDiscoveredMeshes] = useState([]);
  const [hiddenMeshes, setHiddenMeshes] = useState(new Set());
  const [manualRotation, setManualRotation] = useState({ x: 0, y: 0, z: 0 });
  
  // Microphone state
  const [microphoneMode, setMicrophoneMode] = useState(false);
  const [voiceActivityThreshold, setVoiceActivityThreshold] = useState(0.15);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [currentViseme, setCurrentViseme] = useState('M');
  const [audioEnergy, setAudioEnergy] = useState(0);
  const [isVoiceActive, setIsVoiceActive] = useState(false);


  // Use the camera system hook with new image-based anchor system
  const {
    cameraState,
    videoDimensions,
    detectionState,
    anchorSystemState,
    personalityData,
    ttsData,
    cvLoaded,
    services,
    startCamera,
    resumeCamera,
    stopCamera,
    detectObjects,
    processDetections,
    updateAnchor,
    createAnchorFromTap,
    clearAnchor,
    findDetectionAtPosition,
    generatePersonality,
    synthesizeSpeech,
    stopTTS,
    speakGreeting,
    setCurrentCanvas
  } = useCameraSystem(cameraSystemConfig);

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

  // Handle mesh discovery from HeadAnchor
  const handleMeshNamesDiscovered = useCallback((meshNames) => {
    logger.info('CameraView', 'Discovered meshes:', meshNames);
    setDiscoveredMeshes(meshNames);
  }, []);

  // Toggle mesh visibility
  const handleMeshVisibilityChange = useCallback((meshName, isVisible) => {
    setHiddenMeshes(prev => {
      const newSet = new Set(prev);
      if (isVisible) {
        newSet.delete(meshName);
      } else {
        newSet.add(meshName);
      }
      return newSet;
    });
  }, []);

  // Handle manual rotation changes from sliders
  const handleRotationChange = useCallback((rotation) => {
    setManualRotation(rotation);
    logger.info('CameraView', 'Manual rotation changed to:', {
      x: `${(rotation.x * 180 / Math.PI).toFixed(1)}°`,
      y: `${(rotation.y * 180 / Math.PI).toFixed(1)}°`, 
      z: `${(rotation.z * 180 / Math.PI).toFixed(1)}°`
    });
  }, []);

  const handleConfigChange = useCallback((config) => {
    if (config.detectionInterval) {
      services.detection.setDetectionInterval(config.detectionInterval);
    }
    
    // Handle persistence configuration change
    if ('useWorkerPersistence' in config) {
      const newConfig = { ...cameraSystemConfig, useWorkerPersistence: config.useWorkerPersistence };
      setCameraSystemConfig(newConfig);
      
      // Mark that restart is needed for persistence mode change
      if (config.useWorkerPersistence !== cameraSystemConfig.useWorkerPersistence) {
        setNeedsRestart(true);
        logger.info('CameraView', `Persistence mode changed to: ${config.useWorkerPersistence ? 'Worker-based' : 'Simple'} - restart recommended`);
      }
    }
  }, [services.detection, cameraSystemConfig]);

  const handleGeneratePersonality = useCallback(async () => {
    if (anchorSystemState.mode !== 'anchor' || !anchorSystemState.activeAnchor || !canvasRef.current) {
      logger.warn('CameraView', 'No active anchor or canvas available for personality generation');
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Create a mock bbox from anchor position for personality generation
    const position = anchorSystemState.activeAnchor.position;
    const mockBbox = {
      x1: position.x - 50,
      y1: position.y - 50,
      x2: position.x + 50,
      y2: position.y + 50
    };
    
    try {
      await generatePersonality(imageData, mockBbox);
    } catch (error) {
      logger.error('CameraView', 'Failed to generate personality:', error);
    }
  }, [anchorSystemState, generatePersonality]);

  // Handle restart for configuration changes
  const handleRestart = useCallback(async () => {
    logger.info('CameraView', 'Restarting camera system with new configuration...');
    
    // Stop current camera and clear state
    stopCamera();
    
    // Clear canvas context to prevent WebGL issues
    if (canvasRef.current) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    ctxRef.current = null;
    
    setNeedsRestart(false);
    
    // Small delay to allow cleanup
    setTimeout(() => {
      // The camera system will be recreated with new config on next render
      logger.info('CameraView', 'Camera system restarted');
    }, 200); // Slightly longer delay for WebGL cleanup
  }, [stopCamera]);

  // Microphone handlers
  const handleToggleMicrophoneMode = useCallback(async (enabled) => {
    try {
      setMicrophoneMode(enabled);
      
      // Update TTS client microphone mode
      if (services.tts) {
        services.tts.setMicrophoneMode(enabled);
      }
      
      logger.info('CameraView', 'Microphone mode toggled:', enabled);
      
      if (enabled) {
        // Start microphone listening - always activate when enabled
        setMicrophoneActive(true);
        logger.info('CameraView', 'Microphone listening activated');
      } else {
        // Stop microphone mode
        stopTTS();
        setMicrophoneActive(false);
        setIsVoiceActive(false);
        setCurrentViseme('M');
        setAudioEnergy(0);
      }
    } catch (error) {
      logger.error('CameraView', 'Failed to toggle microphone mode:', error);
    }
  }, [services.tts, synthesizeSpeech, stopTTS, ttsData.isPlaying, anchorSystemState]);

  const handleVoiceActivityThresholdChange = useCallback((threshold) => {
    setVoiceActivityThreshold(threshold);
    logger.info('CameraView', 'Voice activity threshold changed:', threshold);
  }, []);

  // Handle lip-sync updates from HeadAnchor
  const handleLipSyncUpdate = useCallback((lipSyncData) => {
    if (microphoneMode) {
      setCurrentViseme(lipSyncData.currentViseme);
      setAudioEnergy(lipSyncData.audioEnergy);
      setIsVoiceActive(lipSyncData.isVoiceActive);
      setMicrophoneActive(lipSyncData.microphoneActive);
    }
  }, [microphoneMode]);

  // Handle canvas tap for detection selection or anchor clearing
  const handleCanvasTap = useCallback(async (event, canvas) => {
    if (!canvas || !cvLoaded || !anchorSystemState.initialized) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const tapX = event.clientX - rect.left;
    const tapY = event.clientY - rect.top;

    // Convert tap coordinates to canvas space
    const x = (tapX / rect.width) * canvas.width;
    const y = (tapY / rect.height) * canvas.height;

    const position = { x, y };

    if (anchorSystemState.mode === 'detection') {
      // In detection mode: create anchor from tap
      if (anchorSystemState.detections.length === 0) {
        logger.info('CameraView', 'No detections available for anchor creation');
        return;
      }

      const detection = findDetectionAtPosition(position);
      if (detection) {
        try {
          // Get current image data
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          
          logger.info('CameraView', `Creating anchor at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}) on detection:`, {
            detection: {
              class: detection.class,
              confidence: detection.confidence?.toFixed(3),
              bbox: `${detection.x1?.toFixed(1)},${detection.y1?.toFixed(1)} -> ${detection.x2?.toFixed(1)},${detection.y2?.toFixed(1)}`
            },
            imageSize: `${imageData.width}x${imageData.height}`,
            canvasSize: `${canvas.width}x${canvas.height}`
          });
          
          const result = await createAnchorFromTap(position, imageData);
          
          if (result.success) {
            logger.info('CameraView', `Anchor created successfully:`, {
              keypoints: result.keypoints,
              quality: result.quality?.toFixed(3),
              method: result.method,
              position: result.position
            });
          } else {
            logger.error('CameraView', 'Anchor creation failed:', result);
          }
        } catch (error) {
          logger.error('CameraView', 'Failed to create anchor:', error);
        }
      } else {
        logger.warn('CameraView', 'No detection found at tap position:', {
          tapPosition: position,
          availableDetections: anchorSystemState.detections?.map(d => ({
            class: d.class,
            bbox: `${d.x1?.toFixed(1)},${d.y1?.toFixed(1)} -> ${d.x2?.toFixed(1)},${d.y2?.toFixed(1)}`,
            confidence: d.confidence?.toFixed(3)
          }))
        });
      }
    } else if (anchorSystemState.mode === 'anchor') {
      // In anchor mode: clear anchor on tap
      logger.info('CameraView', 'Clearing anchor to return to detection mode');
      clearAnchor();
    }
  }, [cvLoaded, anchorSystemState, findDetectionAtPosition, createAnchorFromTap, clearAnchor]);

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

        // Draw current video frame to canvas with horizontal mirroring
        ctx.save();
        ctx.scale(-1, 1);
        ctx.translate(-canvas.width, 0);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.restore();

        // Get current frame data
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        if (anchorSystemState.mode === 'detection') {
          // Detection mode: run YOLO detection periodically
          frameCountRef.current++;
          const shouldDetect = frameCountRef.current % 4 === 0 && detectionState.isModelLoaded && detectionState.detectionEnabled;

          if (shouldDetect) {
            detectObjects(imageData);
          }
          
          // Process new detections if available
          if (detectionState.lastDetections && detectionState.lastDetections !== lastProcessedDetections) {
            processDetections(detectionState.lastDetections, imageData);
            setLastProcessedDetections(detectionState.lastDetections);
          }
        } else if (anchorSystemState.mode === 'anchor') {
          // Anchor mode: update image-based anchor tracking
          const updateResult = updateAnchor(imageData);
          
          // Log tracking updates every 30 frames (~1s at 30fps) to avoid spam
          if (frameCountRef.current % 30 === 0) {
            logger.info('CameraView', 'Anchor tracking update:', {
              success: updateResult?.success,
              reason: updateResult?.reason,
              method: updateResult?.method,
              confidence: updateResult?.confidence?.toFixed(3),
              position: updateResult?.position,
              anchorState: anchorSystemState.anchorState?.state,
              activeAnchor: !!anchorSystemState.activeAnchor
            });
          }
        }

        // Draw overlay based on current mode
        if (anchorSystemState.mode === 'detection') {
          // Draw detection boxes
          renderDetectionOverlay(ctx, {
            detections: anchorSystemState.detections,
            mode: 'detection'
          });
        } else if (anchorSystemState.mode === 'anchor' && anchorSystemState.activeAnchor) {
          // Draw anchor visualization
          renderDetectionOverlay(ctx, {
            anchor: anchorSystemState.activeAnchor,
            anchorState: anchorSystemState.anchorState,
            mode: 'anchor'
          });
        }

        // Update HUD metrics
        const processingTime = detectionState.processingTime || 0;
        const objectCount = anchorSystemState.mode === 'detection' ? 
          anchorSystemState.detections?.length || 0 : 
          (anchorSystemState.activeAnchor ? 1 : 0);
        
        // Debug: logger.info('Metrics', 'Updating:', { fps, frameTime, processingTime, objectCount });
        
        if (typeof fps === 'number' && !isNaN(fps)) {
          updateMetric('Capture FPS', fps);
        }
        if (typeof frameTime === 'number' && !isNaN(frameTime)) {
          updateMetric('Render frame time', frameTime);
        }
        updateMetric('Detection amortized cost', processingTime);
        updateMetric('Object Count', objectCount);
        
        // Debug: Count stable anchors for sparkles
        const stableAnchorCount = anchorSystemState?.anchorState?.state === 'stable' ? 1 : 0;
        updateMetric('Stable Anchors', stableAnchorCount);
        
        // Update Phase 4 stability metrics for active anchor
        if (anchorSystemState?.activeAnchor) {
          const anchorState = anchorSystemState.anchorState;
          if (anchorState) {
            // Update metrics based on new anchor system structure
            const stabilityScore = anchorState.confidence || 0;
            updateMetric('Stability score', stabilityScore.toFixed(3));
            
            if (anchorState.normal) {
              updateMetric('Normal (X,Y,Z)', `${anchorState.normal.x.toFixed(2)}, ${anchorState.normal.y.toFixed(2)}, ${anchorState.normal.z.toFixed(2)}`);
            }
            
            updateMetric('Anchor State', anchorState.state || 'unknown');
          }
        }
        
        // Update anchor persistence metric
        // For image-based anchors, persistence is based on anchor state
        if (anchorSystemState?.activeAnchor && anchorSystemState?.mode === 'anchor') {
          const anchorState = anchorSystemState.anchorState;
          if (anchorState?.state === 'stable' || anchorState?.state === 'tracking') {
            updateMetric('Anchor persistence', 100);
          } else {
            updateMetric('Anchor persistence', 0);
          }
        }
        
        // Phase 6 Persistence metrics
        if (services.anchor.persistenceTracker) {
          const persistenceStats = services.anchor.persistenceTracker.getAnchorStats();
          if (persistenceStats.length > 0) {
            // Calculate short-loss survival rate
            const survivedAnchors = persistenceStats.filter(anchor => 
              anchor.flowPoints > 0 && anchor.missCount <= 10
            );
            const survivalRate = (survivedAnchors.length / persistenceStats.length) * 100;
            updateMetric('Short-loss survival', survivalRate);
            
            // Calculate average reattach latency for recently reacquired tracks
            const reacquiredAnchors = persistenceStats.filter(anchor => 
              anchor.age < 5000 // Last 5 seconds
            );
            if (reacquiredAnchors.length > 0) {
              const avgReattachTime = reacquiredAnchors.reduce((sum, anchor) => 
                sum + (anchor.missCount * (1000/30)), 0) / reacquiredAnchors.length; // Estimate latency from miss count
              updateMetric('Reattach latency', avgReattachTime);
            }
          }
        }

        // Only draw debug stats on canvas if showStats is enabled
        if (showStats) {
          renderDebugStats(ctx, {
            fps,
            frameTime,
            processingTime: detectionState.processingTime,
            objectCount: anchorSystemState?.mode === 'detection' ? (detectionState.detections?.length || 0) : 
                        anchorSystemState?.activeAnchor ? 1 : 0
          });
        }
        
        // Render tracked keypoints if anchor is active  
        if (anchorSystemState?.anchorState?.anchored) {
          renderKeypoints(ctx, services.anchor?.imageAnchorService);
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
    <div className="camera-view fixed top-0 left-0 w-screen h-screen" style={{ overflow: 'visible' }}>
      {/* Video element - hidden when active since canvas shows the processed image */}
      <CameraVideo ref={videoRef} isVisible={cameraState === 'idle' || cameraState === 'blocked'} />
      
      {/* Canvas for CV processing and detection overlay */}
      <DetectionCanvas
        cameraState={cameraState}
        onTap={handleCanvasTap}
        onDraw={handleCanvasDraw}
      />

      {/* WebGL Overlay Scene - restored with working Canvas */}
      {cameraState === 'active' && !needsRestart && (
        <OverlayScene
          width={videoDimensions?.width || 1280}
          height={videoDimensions?.height || 720}
          isAgentSpeaking={microphoneMode ? microphoneActive : ttsData.isPlaying}
          hiddenMeshes={hiddenMeshes}
          manualRotation={manualRotation}
          onMeshNamesDiscovered={handleMeshNamesDiscovered}
          onLipSyncUpdate={handleLipSyncUpdate}
          microphoneMode={microphoneMode}
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
          trackedObjects={anchorSystemState?.mode === 'detection' ? (detectionState.detections || []) : []}
          activeTrackId={anchorSystemState?.activeAnchor ? 'anchor' : null}
          activeAnchor={anchorSystemState?.activeAnchor}
          showStats={showStats}
          onToggleStats={() => setShowStats(!showStats)}
          onUnlock={clearAnchor}
          onStop={stopCamera}
          onConfigChange={handleConfigChange}
          onRestart={handleRestart}
          needsRestart={needsRestart}
          currentConfig={cameraSystemConfig}
          metrics={metrics}
          personalityData={personalityData}
          ttsData={ttsData}
          onGeneratePersonality={handleGeneratePersonality}
          onSpeakGreeting={speakGreeting}
          discoveredMeshes={discoveredMeshes}
          hiddenMeshes={hiddenMeshes}
          onMeshVisibilityChange={handleMeshVisibilityChange}
          onRotationChange={handleRotationChange}
          // Microphone props
          microphoneMode={microphoneMode}
          onToggleMicrophoneMode={handleToggleMicrophoneMode}
          voiceActivityThreshold={voiceActivityThreshold}
          onVoiceActivityThresholdChange={handleVoiceActivityThresholdChange}
          microphoneActive={microphoneActive}
          currentViseme={currentViseme}
          audioEnergy={audioEnergy}
          isVoiceActive={isVoiceActive}
        />
      )}
    </div>
  );
};

export default CameraView;
