import { lazy, Suspense, useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { useAnimationFrame, useFrameRate } from '../hooks/useAnimationFrame.js';
import { useCameraSystem } from '../hooks/useCameraSystem.js';
import { useHudMetrics } from '../hooks/useHudMetrics.js';

import CameraVideo from '../components/CameraVideo.jsx';
import DetectionCanvas from '../components/DetectionCanvas.jsx';
import UnifiedControlPanel from '../components/ui/UnifiedControlPanel.jsx';
import { renderDetectionOverlay, renderDebugStats, renderKeypoints } from '../utils/detectionRenderer.js';
import { logger } from '../utils/logger.js';
import { describeAnchorState } from '../utils/anchorDiagnostics.js';
import { collectRuntimeReadiness } from '../utils/runtimeReadiness.js';
import { RECONSTRUCTION_POSE_MODEL, isReconstructionMode } from '../cv/anchor.reconstructionModes.js';
import { shouldAutoStartObjectVoice } from '../audio/objectVoicePolicy.js';
import { shouldRenderAnchorOverlay } from '../utils/overlayVisibility.js';

const OverlayScene = lazy(() => import('../scenes/OverlayScene.jsx'));

// Start Screen Component - separate from control panel
const getStartButtonLabel = (cameraState) => {
  if (cameraState === 'requesting') return 'Starting Camera...';
  if (cameraState === 'blocked') return 'Resume Camera';
  if (cameraState === 'error') return 'Retry Camera';
  return 'Start Camera';
};

const StartScreen = ({ cameraState, cameraError, onStartCamera }) => {
  if (cameraState === 'active') return null;
  const isRequesting = cameraState === 'requesting';
  
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black z-40 pointer-events-auto">
      <div className="text-center text-white max-w-sm mx-auto px-4">
        <h1 className="text-4xl font-bold mb-4 text-white">
          High on Life
        </h1>
        <p className="text-base mb-8 text-gray-400">
          Tap an object in view to bring it to life
        </p>
        <button
          onClick={onStartCamera}
          disabled={isRequesting}
          className="px-6 py-3 text-lg bg-blue-600 text-white border-0 rounded-lg cursor-pointer hover:bg-blue-700 transition-all duration-200 font-medium disabled:cursor-wait disabled:bg-blue-900"
        >
          {getStartButtonLabel(cameraState)}
        </button>
        <div className="mt-6 text-sm text-gray-500">
          {cameraError || 'Allow camera permissions when prompted'}
        </div>
      </div>
    </div>
  );
};

const AnchorFeedback = ({ feedback }) => {
  if (!feedback) return null;

  const toneClass = feedback.severity === 'bad'
    ? 'border-red-500 bg-red-950/90 text-red-100'
    : feedback.severity === 'warn'
      ? 'border-yellow-500 bg-yellow-950/90 text-yellow-100'
      : 'border-green-500 bg-green-950/90 text-green-100';

  return (
    <div className={`fixed left-1/2 bottom-8 z-50 w-[min(92vw,28rem)] -translate-x-1/2 rounded border px-3 py-2 text-center text-sm shadow-lg ${toneClass}`}>
      {feedback.message}
    </div>
  );
};

const getPersonalityRoi = (position, sourceDetection) => {
  if (sourceDetection) {
    return {
      x: sourceDetection.x1,
      y: sourceDetection.y1,
      width: sourceDetection.x2 - sourceDetection.x1,
      height: sourceDetection.y2 - sourceDetection.y1
    };
  }

  return {
    x: position.x - 50,
    y: position.y - 50,
    width: 100,
    height: 100
  };
};

const CameraView = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const frameCountRef = useRef(0);
  const ctxRef = useRef(null);
  const anchorFeedbackTimeoutRef = useRef(null);
  const autoVoiceRequestRef = useRef(0);
  const mapReadyAnchorRef = useRef(null);

  const [showStats, setShowStats] = useState(false);
  const [lastProcessedDetections, setLastProcessedDetections] = useState(null);
  const [discoveredMeshes, setDiscoveredMeshes] = useState([]);
  const [hiddenMeshes, setHiddenMeshes] = useState(new Set());
  const [manualRotation, setManualRotation] = useState({ x: 0, y: 0, z: 0 });
  const [anchorFeedback, setAnchorFeedback] = useState(null);
  const [controlPanelVisible, setControlPanelVisible] = useState(false);
  
  // Microphone state
  const [microphoneMode, setMicrophoneMode] = useState(false);
  const [voiceActivityThreshold, setVoiceActivityThreshold] = useState(0.02);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [currentViseme, setCurrentViseme] = useState('M');
  const [audioEnergy, setAudioEnergy] = useState(0);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  // Enhanced microphone controls
  const [microphoneGain, setMicrophoneGain] = useState(3.0);
  const [microphoneDebugMode, setMicrophoneDebugMode] = useState(false);
  const [microphoneBaselineResetToken, setMicrophoneBaselineResetToken] = useState(0);


  const { metrics, updateMetric } = useHudMetrics();
  const runtimeReadiness = useMemo(() => collectRuntimeReadiness(), []);

  // Use the camera system hook with image-based anchors
  const {
    cameraState,
    cameraError,
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
    refreshAnchorSegmentation,
    createAnchorFromTap,
    clearAnchor,
    findDetectionAtPosition,
    generatePersonality,
    synthesizeSpeech,
    stopTTS,
    speakGreeting,
    setCurrentCanvas,
    setAnchorTrackingMode,
    setDetectionEnabled
  } = useCameraSystem({ onMetricUpdate: updateMetric });
  const throttledFrame = useFrameRate(30);
  const anchorDiagnostics = useMemo(() => describeAnchorState({
    cameraState,
    anchorSystemState
  }), [cameraState, anchorSystemState]);
  const cameraViewportStyle = useMemo(() => ({}), []);

  useEffect(() => () => {
    if (anchorFeedbackTimeoutRef.current) {
      window.clearTimeout(anchorFeedbackTimeoutRef.current);
    }
  }, []);

  const showAnchorFeedback = useCallback((message, severity = 'info') => {
    if (anchorFeedbackTimeoutRef.current) {
      window.clearTimeout(anchorFeedbackTimeoutRef.current);
    }

    setAnchorFeedback({ message, severity });
    anchorFeedbackTimeoutRef.current = window.setTimeout(() => {
      setAnchorFeedback(null);
      anchorFeedbackTimeoutRef.current = null;
    }, 3500);
  }, []);

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
    if (typeof config.detectionEnabled === 'boolean') {
      setDetectionEnabled(config.detectionEnabled);
    }
    if (config.anchorTrackingMode) {
      setAnchorTrackingMode(config.anchorTrackingMode === 'auto' ? RECONSTRUCTION_POSE_MODEL : config.anchorTrackingMode);
    }
  }, [services.detection, setAnchorTrackingMode, setDetectionEnabled]);

  const handleGeneratePersonality = useCallback(async () => {
    if (anchorSystemState.mode !== 'anchor' || !anchorSystemState.activeAnchor || !canvasRef.current) {
      logger.warn('CameraView', 'No active anchor or canvas available for personality generation');
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    const position = anchorSystemState.activeAnchor.position;
    const sourceDetection = anchorSystemState.activeAnchor.sourceDetection;
    const roi = getPersonalityRoi(position, sourceDetection);
    
    try {
      await generatePersonality(imageData, roi);
    } catch (error) {
      logger.error('CameraView', 'Failed to generate personality:', error);
    }
  }, [anchorSystemState, generatePersonality]);

  const generateAndSpeakForAnchor = useCallback(async (imageData, position, sourceDetection) => {
    const requestId = ++autoVoiceRequestRef.current;
    const roi = getPersonalityRoi(position, sourceDetection);

    try {
      showAnchorFeedback('Generating object voice...', 'warn');
      const persona = await generatePersonality(imageData, roi);

      if (requestId !== autoVoiceRequestRef.current) {
        return;
      }

      const greeting = persona.oneLiners[0];
      const voiceStyle = persona.voiceStyle || 'cheerful';
      const emotionalDelivery = persona.emotionalDelivery || persona.tone;
      await synthesizeSpeech(greeting, voiceStyle, emotionalDelivery);
      showAnchorFeedback('Object voice is live.', 'good');
    } catch (error) {
      logger.error('CameraView', 'Failed to start object voice:', error);
      showAnchorFeedback(`Voice not started: ${error.message}`, 'bad');
    }
  }, [generatePersonality, showAnchorFeedback, synthesizeSpeech]);

  // Microphone handlers
  const handleToggleMicrophoneMode = useCallback(async (enabled) => {
    setMicrophoneMode(enabled);
    logger.info('CameraView', 'Microphone mode toggled:', enabled);

    if (enabled) {
      setMicrophoneActive(true);
      logger.info('CameraView', 'Microphone listening activated');
    } else {
      stopTTS();
      setMicrophoneActive(false);
      setIsVoiceActive(false);
      setCurrentViseme('M');
      setAudioEnergy(0);
    }
  }, [stopTTS]);

  const handleVoiceActivityThresholdChange = useCallback((threshold) => {
    setVoiceActivityThreshold(threshold);
    logger.info('CameraView', 'Voice activity threshold changed:', threshold);
  }, []);

  const handleMicrophoneGainChange = useCallback((gain) => {
    setMicrophoneGain(gain);
    logger.info('CameraView', 'Microphone gain changed:', gain);
  }, []);

  const handleToggleMicrophoneDebug = useCallback((enabled) => {
    setMicrophoneDebugMode(enabled);
    logger.info('CameraView', 'Microphone debug mode:', enabled);
  }, []);

  const handleResetMicrophoneBaseline = useCallback(() => {
    setMicrophoneBaselineResetToken(token => token + 1);
    logger.info('CameraView', 'Microphone baseline reset');
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

  // Handle canvas tap for anchor creation or clearing
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
      const detection = findDetectionAtPosition(position);
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        logger.info('CameraView', `Creating tap-local anchor at (${position.x.toFixed(1)}, ${position.y.toFixed(1)})`, {
          detection: detection
            ? {
              class: detection.class,
              confidence: detection.confidence?.toFixed(3),
              bbox: `${detection.x1?.toFixed(1)},${detection.y1?.toFixed(1)} -> ${detection.x2?.toFixed(1)},${detection.y2?.toFixed(1)}`
            }
            : null,
          imageSize: `${imageData.width}x${imageData.height}`,
          canvasSize: `${canvas.width}x${canvas.height}`
        });

        const result = await createAnchorFromTap(position, imageData);

        if (result.success) {
          logger.info('CameraView', 'Anchor created successfully:', {
            keypoints: result.keypoints,
            quality: result.quality?.toFixed(3),
            method: result.method,
            position: result.position
          });
          const qualityLabel = result.state === 'degraded' ? 'weak' : 'solid';
          if (result.state === 'candidate' || result.state === 'mapping') {
            showAnchorFeedback(`Object selected. Building support from ${result.evidence?.objectOwnedLandmarks || result.keypoints} object landmarks.`, 'warn');
          } else if (isReconstructionMode(result.trackingMode)) {
            showAnchorFeedback(`Anchor created with ${result.keypoints} local points. Move slowly to build the 3D map.`, 'warn');
          } else {
            showAnchorFeedback(`Anchor created with ${result.keypoints} local points (${qualityLabel} lock).`, result.state === 'degraded' ? 'warn' : 'good');
            if (shouldAutoStartObjectVoice({
              trackingMode: result.trackingMode,
              reconstructionReady: false,
              hasUserGesture: true,
            })) {
              generateAndSpeakForAnchor(imageData, result.position, detection);
            }
          }
        } else {
          logger.warn('CameraView', 'Anchor creation failed:', result);
          showAnchorFeedback('Anchor was not created. Try a sharper textured area.', 'warn');
        }
      } catch (error) {
        logger.warn('CameraView', `Anchor not created: ${error.message}`);
        updateMetric('Anchor creation', error.message);
        showAnchorFeedback(`Anchor not created: ${error.message}`, 'bad');
      }
    } else if (anchorSystemState.mode === 'anchor') {
      // In anchor mode: clear anchor on tap
      logger.info('CameraView', 'Clearing anchor to return to detection mode');
      autoVoiceRequestRef.current++;
      mapReadyAnchorRef.current = null;
      clearAnchor();
      showAnchorFeedback('Anchor cleared. Tap any object to anchor again.', 'good');
    }
  }, [cvLoaded, anchorSystemState, findDetectionAtPosition, createAnchorFromTap, clearAnchor, updateMetric, showAnchorFeedback, generateAndSpeakForAnchor]);

  useEffect(() => {
    const activeAnchor = anchorSystemState.activeAnchor;
    const diagnostics = activeAnchor?.diagnostics;
    const activeMode = anchorSystemState.anchorState?.metrics?.poseModel || activeAnchor?.trackingMode;
    const isReconstructionAnchor = isReconstructionMode(activeMode);

    if (!activeAnchor || !isReconstructionAnchor || !diagnostics?.reconstructionReady || !canvasRef.current) {
      return;
    }

    if (mapReadyAnchorRef.current === activeAnchor.createdAt) {
      return;
    }

    mapReadyAnchorRef.current = activeAnchor.createdAt;

    if (shouldAutoStartObjectVoice({
      trackingMode: activeMode,
      reconstructionReady: true,
      hasUserGesture: false,
    })) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      showAnchorFeedback('3D map locked. Starting object voice.', 'good');
      generateAndSpeakForAnchor(imageData, activeAnchor.position, activeAnchor.sourceDetection);
    } else {
      showAnchorFeedback('3D map locked. Voice controls are ready.', 'good');
    }
  }, [anchorSystemState.activeAnchor, anchorSystemState.anchorState, generateAndSpeakForAnchor, showAnchorFeedback]);

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
          // Optional detection overlay for debug mode.
          frameCountRef.current++;
          const shouldDetect = frameCountRef.current % 4 === 0 && detectionState.isModelLoaded && detectionState.detectionEnabled;

          if (shouldDetect) {
            detectObjects(imageData);
          }
          
          if (detectionState.lastDetections && detectionState.lastDetections !== lastProcessedDetections) {
            processDetections(detectionState.lastDetections, imageData);
            setLastProcessedDetections(detectionState.lastDetections);
          }
        } else if (anchorSystemState.mode === 'anchor') {
          // Anchor mode: update image-based anchor tracking
          const updateResult = updateAnchor(imageData);
          refreshAnchorSegmentation(imageData);
          
          if (frameCountRef.current % 30 === 0) {
            logger.debug('CameraView', 'Anchor tracking update:', {
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

        if (anchorSystemState.mode === 'detection' && detectionState.detectionEnabled) {
          renderDetectionOverlay(ctx, {
            detections: anchorSystemState.detections,
            mode: 'detection'
          });
        } else if (anchorSystemState.mode === 'anchor' && anchorSystemState.activeAnchor) {
          renderDetectionOverlay(ctx, {
            anchor: anchorSystemState.activeAnchor,
            anchorState: anchorSystemState.anchorState,
            trackedPoints: services.anchor?.imageAnchorService?.keypointTracker?.trackedPoints || [],
            mode: 'anchor'
          });
        }

        // Update HUD metrics
        const processingTime = detectionState.processingTime || 0;
        const objectCount = anchorSystemState.mode === 'detection' ? 
          anchorSystemState.detections?.length || 0 : 
          (anchorSystemState.activeAnchor ? 1 : 0);
        
        if (typeof fps === 'number' && !isNaN(fps)) {
          updateMetric('Capture FPS', fps);
        }
        if (typeof frameTime === 'number' && !isNaN(frameTime)) {
          updateMetric('Render frame time', frameTime);
        }
        updateMetric('Detection amortized cost', processingTime);
        updateMetric('Object Count', objectCount);
        
        const stableAnchorCount = anchorSystemState?.anchorState?.state === 'stable' ? 1 : 0;
        updateMetric('Stable Anchors', stableAnchorCount);
        
        // Update stability metrics for active anchor
        if (anchorSystemState?.activeAnchor) {
          const anchorState = anchorSystemState.anchorState;
          if (anchorState) {
            const stabilityScore = anchorState.confidence || 0;
            updateMetric('Stability score', stabilityScore.toFixed(3));
            
            if (anchorState.normal) {
              updateMetric('Normal (X,Y,Z)', `${anchorState.normal.x.toFixed(2)}, ${anchorState.normal.y.toFixed(2)}, ${anchorState.normal.z.toFixed(2)}`);
            }

            if (anchorState.planarTransform) {
              updateMetric('Tracked scale', anchorState.planarTransform.scale);
              updateMetric('Tracked roll', anchorState.planarTransform.rotation * 180 / Math.PI);
            }

            if (anchorState.metrics) {
              updateMetric('Pose patch points', anchorState.metrics.poseKeypointCount || 0);
              updateMetric('Pose confidence', anchorState.metrics.poseConfidence || 0);
              updateMetric('Pose inliers', anchorState.metrics.poseInliers || 0);
              updateMetric('Object pose inliers', anchorState.metrics.objectPoseInliers || 0);
              updateMetric('Pose residual', anchorState.metrics.poseAverageResidual || 0);
              updateMetric('Pose foreshortening', anchorState.metrics.poseForeshortening || 1);
              updateMetric('Pose source', anchorState.metrics.poseSource || 'None');
              updateMetric('Pose rejection', anchorState.metrics.poseRejectedReason || 'None');
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
        
        // Only draw debug stats on canvas if showStats is enabled
        if (showStats) {
          renderDebugStats(ctx, {
            fps,
            frameTime,
            processingTime: detectionState.processingTime,
            objectCount: anchorSystemState?.mode === 'detection' ? (anchorSystemState.detections?.length || 0) : 
                        anchorSystemState?.activeAnchor ? 1 : 0
          });
        }
        
        if (showStats && anchorSystemState?.anchorState?.anchored) {
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
        style={cameraViewportStyle}
      />
      <AnchorFeedback feedback={anchorFeedback} />

      {/* WebGL Overlay Scene */}
      {cameraState === 'active' && (
        <Suspense fallback={null}>
          <OverlayScene
            width={videoDimensions?.width || 1280}
            height={videoDimensions?.height || 720}
            isAgentSpeaking={microphoneMode ? microphoneActive : ttsData.isPlaying}
            hiddenMeshes={hiddenMeshes}
            manualRotation={manualRotation}
            onMeshNamesDiscovered={handleMeshNamesDiscovered}
            onLipSyncUpdate={handleLipSyncUpdate}
            microphoneMode={microphoneMode}
            agentAudioAnalysis={ttsData.audioAnalysis}
            agentAudioAlignment={ttsData.audioAlignment}
            facialExpression={personalityData.currentPersona?.facialExpression || 'neutral'}
            animationIntensity={personalityData.currentPersona?.animationIntensity ?? 0.65}
            voiceActivityThreshold={voiceActivityThreshold}
            microphoneGain={microphoneGain}
            microphoneDebugMode={microphoneDebugMode}
            microphoneBaselineResetToken={microphoneBaselineResetToken}
            style={cameraViewportStyle}
            activeAnchor={shouldRenderAnchorOverlay({
              activeAnchor: anchorSystemState.activeAnchor,
              anchorState: anchorSystemState.anchorState
            }) ? anchorSystemState.activeAnchor : null}
            anchorState={anchorSystemState.anchorState}
          />
        </Suspense>
      )}

      {/* Start Screen - only when camera is not active */}
      <StartScreen 
        cameraState={cameraState} 
        cameraError={cameraError}
        onStartCamera={handleStartClick} 
      />

      {/* Control Panel - only when camera is active, minimized by default */}
      {cameraState === 'active' && (
        <UnifiedControlPanel
          cameraState={cameraState}
          detectionEnabled={detectionState.detectionEnabled}
          activeTrackId={anchorSystemState?.activeAnchor ? 'anchor' : null}
          showStats={showStats}
          onToggleStats={() => setShowStats(!showStats)}
          onUnlock={clearAnchor}
          onStop={stopCamera}
          onConfigChange={handleConfigChange}
          metrics={metrics}
          anchorDiagnostics={anchorDiagnostics}
          anchorTrackingMode={anchorSystemState.trackingMode}
          runtimeReadiness={runtimeReadiness}
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
          // Enhanced microphone controls
          onMicrophoneGainChange={handleMicrophoneGainChange}
          onToggleMicrophoneDebug={handleToggleMicrophoneDebug}
          onResetMicrophoneBaseline={handleResetMicrophoneBaseline}
          microphoneGain={microphoneGain}
          microphoneDebugMode={microphoneDebugMode}
          isVisible={controlPanelVisible}
          onVisibilityChange={setControlPanelVisible}
        />
      )}
    </div>
  );
};

export default CameraView;
