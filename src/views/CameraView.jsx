import { lazy, Suspense, useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { useVideoFrames } from '../hooks/useVideoFrames.js';
import { useCameraSystem } from '../hooks/useCameraSystem.js';
import { ANCHOR_SELECTION_IN_PROGRESS_REASON } from '../services/AnchorSelectionGate.js';
import { useHudMetrics } from '../hooks/useHudMetrics.js';
import { useMicrophoneRuntime } from '../hooks/useMicrophoneRuntime.js';
import { useTransientFeedback } from '../hooks/useTransientFeedback.js';

import CameraVideo from '../components/CameraVideo.jsx';
import CameraCanvas from '../components/CameraCanvas.jsx';
import OverlaySceneBoundary from '../components/OverlaySceneBoundary.jsx';
import FieldControls from '../components/ui/FieldControls.jsx';
import { renderAnchorOverlay, renderDebugStats, renderKeypoints } from '../utils/anchorOverlayRenderer.js';
import { logger } from '../utils/logger.js';
import { RECONSTRUCTION_POSE_MODEL, isReconstructionMode } from '../cv/anchor.reconstructionModes.js';
import { shouldAutoStartObjectVoice } from '../audio/objectVoicePolicy.js';
import { ownsObjectVoiceRequest } from '../audio/objectVoiceOwnership.js';
import { shouldMountOverlayScene } from '../utils/overlayVisibility.js';
import { captureCameraFrame, shouldCaptureCameraFrame } from '../utils/cameraFrameCapture.js';
import {
  ANCHOR_TRACKING_INTERVAL_MS,
  SEGMENTATION_REFRESH_CHECK_INTERVAL_MS,
  shouldRunTimedStep,
} from '../utils/cvScheduling.js';

const OverlayScene = lazy(() => import('../scenes/OverlayScene.jsx'));
const CAMERA_PRESENTATION_MIRRORED = false;

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
    <section
      aria-labelledby="start-screen-title"
      className="absolute inset-0 flex items-center justify-center bg-black z-40 pointer-events-auto"
    >
      <div className="text-center text-white max-w-sm mx-auto px-4">
        <h1 id="start-screen-title" className="text-4xl font-bold mb-4 text-white">
          High on Life
        </h1>
        <p className="text-base mb-8 text-gray-400">Tap an object in view to bring it to life</p>
        <button
          type="button"
          onClick={onStartCamera}
          disabled={isRequesting}
          aria-busy={isRequesting}
          className="px-6 py-3 text-lg bg-blue-600 text-white border-0 rounded-lg cursor-pointer hover:bg-blue-700 transition-colors duration-200 font-medium disabled:cursor-wait disabled:bg-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        >
          {getStartButtonLabel(cameraState)}
        </button>
        <div role="status" aria-live="polite" aria-atomic="true" className="mt-6 text-sm text-gray-400">
          {cameraError || 'Allow camera permissions when prompted'}
        </div>
      </div>
    </section>
  );
};

const AnchorFeedback = ({ feedback }) => {
  if (!feedback) return null;

  const toneClass =
    feedback.severity === 'bad'
      ? 'border-red-500 bg-red-950/90 text-red-100'
      : feedback.severity === 'warn'
        ? 'border-yellow-500 bg-yellow-950/90 text-yellow-100'
        : 'border-green-500 bg-green-950/90 text-green-100';

  return (
    <div
      role={feedback.severity === 'bad' ? 'alert' : 'status'}
      aria-live={feedback.severity === 'bad' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`fixed left-1/2 bottom-8 z-50 w-[min(92vw,28rem)] -translate-x-1/2 rounded border px-3 py-2 text-center text-sm shadow-lg ${toneClass}`}
    >
      {feedback.message}
    </div>
  );
};

const getPersonalityRoi = (position, selectionRegion) => {
  if (selectionRegion) {
    return {
      x: selectionRegion.x1,
      y: selectionRegion.y1,
      width: selectionRegion.x2 - selectionRegion.x1,
      height: selectionRegion.y2 - selectionRegion.y1,
    };
  }

  return {
    x: position.x - 50,
    y: position.y - 50,
    width: 100,
    height: 100,
  };
};

const CameraView = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const captureContextRef = useRef(null);
  const frameCountRef = useRef(0);
  const ctxRef = useRef(null);
  const overlayContentRef = useRef(false);
  const autoVoiceRequestRef = useRef(0);
  const mapReadyAnchorRef = useRef(null);
  const lastAnchorUpdateAtRef = useRef(0);
  const lastSegmentationRefreshCheckAtRef = useRef(0);
  const lastCameraFrameCostRef = useRef(0);

  const [showStats, setShowStats] = useState(false);
  const [discoveredMeshes, setDiscoveredMeshes] = useState([]);
  const [hiddenMeshes, setHiddenMeshes] = useState(new Set());
  const [manualRotation, setManualRotation] = useState({ x: 0, y: 0, z: 0 });
  const { feedback: anchorFeedback, showFeedback: showAnchorFeedback } = useTransientFeedback();
  const [fieldControlsOpen, setFieldControlsOpen] = useState(false);

  const { metricStore, updateMetric } = useHudMetrics();

  // Use the camera system hook with image-based anchors
  const {
    cameraState,
    cameraError,
    videoDimensions,
    depthStateStore,
    anchorSystemState,
    getAnchorSystemState,
    subscribeAnchorSystemState,
    personalityData,
    ttsData,
    services,
    startCamera,
    resumeCamera,
    stopCamera,
    canProcessAnchorFrame,
    processAnchorFrame,
    selectAnchorFromTap,
    clearAnchor,
    generatePersonality,
    synthesizeSpeech,
    stopTTS,
    speakGreeting,
    setAnchorTrackingMode,
  } = useCameraSystem({ onMetricUpdate: updateMetric });
  const cameraViewportStyle = useMemo(() => ({}), []);
  const overlaySceneEnabled = shouldMountOverlayScene({
    cameraState,
    activeAnchor: anchorSystemState.activeAnchor,
  });

  useEffect(() => {
    if (cameraState !== 'active') {
      frameCountRef.current = 0;
    }
  }, [cameraState]);

  const captureCurrentCameraFrame = useCallback(() => {
    if (!captureCanvasRef.current) {
      captureCanvasRef.current = document.createElement('canvas');
    }
    const captured = captureCameraFrame({
      video: videoRef.current,
      canvas: captureCanvasRef.current,
      context: captureContextRef.current,
    });
    captureContextRef.current = captured.context;
    return captured.imageData;
  }, []);

  const handleMicrophoneUnavailable = useCallback(() => {
    showAnchorFeedback('Anchor an object before enabling microphone mode.', 'warn');
  }, [showAnchorFeedback]);
  const {
    mode: microphoneMode,
    runtime: microphoneRuntime,
    telemetryStore: microphoneTelemetryStore,
    voiceActivityThreshold,
    gain: microphoneGain,
    debugMode: microphoneDebugMode,
    toggle: handleMicrophoneModeChange,
    updateVoiceActivityThreshold: handleVoiceActivityThresholdChange,
    updateGain: handleMicrophoneGainChange,
    updateDebugMode: handleMicrophoneDebugModeChange,
    resetBaseline: handleResetMicrophoneBaseline,
    publishTelemetry: publishMicrophoneTelemetry,
  } = useMicrophoneRuntime({
    microphoneService: services.microphone,
    available: overlaySceneEnabled,
    stopTTS,
    onUnavailable: handleMicrophoneUnavailable,
  });
  const publishSpeechTelemetry = useCallback(
    ({ audioEnergy, audioCentroid }) => {
      if (!metricStore.hasSubscribers()) {
        return;
      }
      updateMetric('Audio energy', audioEnergy);
      updateMetric('Audio centroid', audioCentroid);
    },
    [metricStore, updateMetric],
  );

  // Handle camera start/resume
  const handleStartClick = useCallback(async () => {
    setFieldControlsOpen(false);
    if (cameraState === 'blocked') {
      await resumeCamera();
    } else {
      await startCamera(videoRef.current);
    }
  }, [cameraState, startCamera, resumeCamera]);

  const handleStopClick = useCallback(() => {
    setFieldControlsOpen(false);
    stopCamera();
  }, [stopCamera]);

  // Handle mesh discovery from HeadAnchor
  const handleMeshNamesDiscovered = useCallback((meshNames) => {
    logger.info('CameraView', 'Discovered meshes:', meshNames);
    setDiscoveredMeshes(meshNames);
  }, []);

  // Toggle mesh visibility
  const handleMeshVisibilityChange = useCallback((meshName, isVisible) => {
    setHiddenMeshes((prev) => {
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
      x: `${((rotation.x * 180) / Math.PI).toFixed(1)}°`,
      y: `${((rotation.y * 180) / Math.PI).toFixed(1)}°`,
      z: `${((rotation.z * 180) / Math.PI).toFixed(1)}°`,
    });
  }, []);

  const handleAnchorTrackingModeChange = useCallback(
    (anchorTrackingMode) => {
      setAnchorTrackingMode(anchorTrackingMode === 'auto' ? RECONSTRUCTION_POSE_MODEL : anchorTrackingMode);
    },
    [setAnchorTrackingMode],
  );

  const handleGeneratePersonality = useCallback(async () => {
    const liveAnchorSystemState = getAnchorSystemState();
    if (liveAnchorSystemState.mode !== 'anchor' || !liveAnchorSystemState.activeAnchor || !videoRef.current) {
      logger.warn('CameraView', 'No active anchor or camera frame available for personality generation');
      return;
    }

    const imageData = captureCurrentCameraFrame();

    const position = liveAnchorSystemState.activeAnchor.position;
    const selectionRegion = liveAnchorSystemState.activeAnchor.selectionRegion;
    const roi = getPersonalityRoi(position, selectionRegion);

    try {
      await generatePersonality(imageData, roi);
    } catch (error) {
      logger.error('CameraView', 'Failed to generate personality:', error);
    }
  }, [captureCurrentCameraFrame, generatePersonality, getAnchorSystemState]);

  const generateAndSpeakForAnchor = useCallback(
    async ({ imageData, position, selectionRegion, anchorCreatedAt }) => {
      const requestId = ++autoVoiceRequestRef.current;
      const roi = getPersonalityRoi(position, selectionRegion);
      const ownsRequest = () =>
        ownsObjectVoiceRequest({
          requestId,
          currentRequestId: autoVoiceRequestRef.current,
          anchorCreatedAt,
          activeAnchor: getAnchorSystemState().activeAnchor,
        });

      try {
        showAnchorFeedback('Generating object voice...', 'warn');
        const persona = await generatePersonality(imageData, roi);

        if (!persona || !ownsRequest()) {
          return;
        }

        const greeting = persona.oneLiners[0];
        const started = await synthesizeSpeech(greeting, persona.voiceStyle, persona.emotionalDelivery);
        if (!started || !ownsRequest()) {
          return;
        }
        showAnchorFeedback('Object voice is live.', 'good');
      } catch (error) {
        if (!ownsRequest()) {
          return;
        }
        logger.error('CameraView', 'Failed to start object voice:', error);
        showAnchorFeedback(`Voice not started: ${error.message}`, 'bad');
      }
    },
    [generatePersonality, getAnchorSystemState, showAnchorFeedback, synthesizeSpeech],
  );

  const handleClearAnchor = useCallback(() => {
    autoVoiceRequestRef.current++;
    mapReadyAnchorRef.current = null;
    lastAnchorUpdateAtRef.current = 0;
    lastSegmentationRefreshCheckAtRef.current = 0;
    clearAnchor();
    showAnchorFeedback('Anchor cleared. Tap any object to anchor again.', 'good');
  }, [clearAnchor, showAnchorFeedback]);

  // Handle canvas selection for anchor creation or clearing
  const handleCanvasSelect = useCallback(
    async (position) => {
      if (cameraState !== 'active') {
        return;
      }

      const liveAnchorSystemState = getAnchorSystemState();
      if (liveAnchorSystemState.mode === 'selection') {
        try {
          const canvas = canvasRef.current;
          if (!canvas || !videoRef.current || frameCountRef.current === 0) {
            showAnchorFeedback('Preparing camera frame...', 'warn');
            return;
          }
          let imageData = null;
          const result = await selectAnchorFromTap({
            tapPosition: position,
            captureFrame: () => {
              imageData = captureCurrentCameraFrame();
              logger.info(
                'CameraView',
                `Creating tap-local anchor at (${position.x.toFixed(1)}, ${position.y.toFixed(1)})`,
                {
                  imageSize: `${imageData.width}x${imageData.height}`,
                },
              );
              if (!liveAnchorSystemState.initialized) {
                showAnchorFeedback('Preparing vision tracking...', 'warn');
              }
              return imageData;
            },
          });

          if (result.reason === ANCHOR_SELECTION_IN_PROGRESS_REASON) {
            return;
          }

          if (result.success) {
            lastAnchorUpdateAtRef.current = 0;
            lastSegmentationRefreshCheckAtRef.current = 0;
            logger.info('CameraView', 'Anchor created successfully:', {
              keypoints: result.keypoints,
              quality: result.quality?.toFixed(3),
              method: result.method,
              position: result.position,
            });
            const qualityLabel = result.state === 'degraded' ? 'weak' : 'solid';
            if (result.state === 'candidate' || result.state === 'mapping') {
              showAnchorFeedback(
                `Object selected. Building support from ${result.evidence?.objectOwnedLandmarks || result.keypoints} object landmarks.`,
                'warn',
              );
            } else if (isReconstructionMode(result.trackingMode)) {
              showAnchorFeedback(
                `Anchor created with ${result.keypoints} local points. Move slowly to build the 3D map.`,
                'warn',
              );
            } else {
              showAnchorFeedback(
                `Anchor created with ${result.keypoints} local points (${qualityLabel} lock).`,
                result.state === 'degraded' ? 'warn' : 'good',
              );
              if (
                shouldAutoStartObjectVoice({
                  trackingMode: result.trackingMode,
                  reconstructionReady: false,
                  hasUserGesture: true,
                })
              ) {
                const createdAnchor = getAnchorSystemState().activeAnchor;
                generateAndSpeakForAnchor({
                  imageData,
                  position: result.position,
                  selectionRegion: createdAnchor?.selectionRegion,
                  anchorCreatedAt: createdAnchor?.createdAt,
                });
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
      } else if (liveAnchorSystemState.mode === 'anchor') {
        // In anchor mode: clear anchor on tap
        logger.info('CameraView', 'Clearing anchor to return to selection mode');
        handleClearAnchor();
      }
    },
    [
      cameraState,
      captureCurrentCameraFrame,
      selectAnchorFromTap,
      updateMetric,
      showAnchorFeedback,
      generateAndSpeakForAnchor,
      getAnchorSystemState,
      handleClearAnchor,
    ],
  );

  useEffect(() => {
    const activeAnchor = anchorSystemState.activeAnchor;
    const diagnostics = activeAnchor?.diagnostics;
    const activeMode = anchorSystemState.anchorState?.metrics?.poseModel || activeAnchor?.trackingMode;
    const isReconstructionAnchor = isReconstructionMode(activeMode);

    if (!activeAnchor || !isReconstructionAnchor || !diagnostics?.reconstructionReady || !videoRef.current) {
      return;
    }

    if (mapReadyAnchorRef.current === activeAnchor.createdAt) {
      return;
    }

    mapReadyAnchorRef.current = activeAnchor.createdAt;

    if (
      shouldAutoStartObjectVoice({
        trackingMode: activeMode,
        reconstructionReady: true,
        hasUserGesture: false,
      })
    ) {
      const imageData = captureCurrentCameraFrame();
      showAnchorFeedback('3D map locked. Starting object voice.', 'good');
      generateAndSpeakForAnchor({
        imageData,
        position: activeAnchor.position,
        selectionRegion: activeAnchor.selectionRegion,
        anchorCreatedAt: activeAnchor.createdAt,
      });
    } else {
      showAnchorFeedback('3D map locked. Voice controls are ready.', 'good');
    }
  }, [
    anchorSystemState.activeAnchor,
    anchorSystemState.anchorState,
    captureCurrentCameraFrame,
    generateAndSpeakForAnchor,
    showAnchorFeedback,
  ]);

  // Camera processing follows presented video frames instead of display refreshes.
  useVideoFrames(videoRef, cameraState === 'active', ({ now: videoFrameAt, captureFps }) => {
    if (cameraState === 'active' && videoRef.current && canvasRef.current) {
      const frameWorkStartedAt = performance.now();
      const video = videoRef.current;
      const canvas = canvasRef.current;
      let resized = false;
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctxRef.current = null;
        resized = true;
      }
      if (!ctxRef.current) {
        ctxRef.current = canvas.getContext('2d');
      }
      const ctx = ctxRef.current;
      const frameIndex = ++frameCountRef.current;
      const liveAnchorSystemState = getAnchorSystemState();
      const hasOverlayContent =
        Boolean(liveAnchorSystemState.mode === 'anchor' && liveAnchorSystemState.activeAnchor) || showStats;
      if (resized || hasOverlayContent || overlayContentRef.current) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      overlayContentRef.current = hasOverlayContent;

      if (liveAnchorSystemState.mode === 'anchor') {
        const now = videoFrameAt;
        const shouldUpdateAnchor = shouldRunTimedStep({
          now,
          lastRunAt: lastAnchorUpdateAtRef.current,
          intervalMs: ANCHOR_TRACKING_INTERVAL_MS,
        });
        const shouldCheckSegmentationRefresh = shouldRunTimedStep({
          now,
          lastRunAt: lastSegmentationRefreshCheckAtRef.current,
          intervalMs: SEGMENTATION_REFRESH_CHECK_INTERVAL_MS,
        });
        const scheduledWork = shouldUpdateAnchor || shouldCheckSegmentationRefresh;
        const canProcess = scheduledWork && canProcessAnchorFrame();

        if (
          shouldCaptureCameraFrame({
            mode: liveAnchorSystemState.mode,
            shouldUpdateAnchor,
            shouldRefreshSegmentation: shouldCheckSegmentationRefresh,
            canProcess,
          })
        ) {
          const updateResult = processAnchorFrame(captureCurrentCameraFrame(), {
            update: shouldUpdateAnchor,
            refreshSegmentation: shouldCheckSegmentationRefresh,
            capturedAt: now,
          });

          if (shouldUpdateAnchor) {
            lastAnchorUpdateAtRef.current = now;
          }
          if (shouldCheckSegmentationRefresh) {
            lastSegmentationRefreshCheckAtRef.current = now;
          }

          if (frameIndex % 30 === 0) {
            logger.debug('CameraView', 'Anchor tracking update:', {
              success: updateResult?.success,
              reason: updateResult?.reason,
              method: updateResult?.method,
              confidence: updateResult?.confidence?.toFixed(3),
              position: updateResult?.position,
              anchorState: liveAnchorSystemState.anchorState?.state,
              activeAnchor: !!liveAnchorSystemState.activeAnchor,
            });
          }
        }
      }

      if (liveAnchorSystemState.mode === 'anchor' && liveAnchorSystemState.activeAnchor) {
        renderAnchorOverlay(ctx, {
          anchor: liveAnchorSystemState.activeAnchor,
          anchorState: liveAnchorSystemState.anchorState,
          trackedPoints: services.anchor?.imageAnchorService?.keypointTracker?.trackedPoints || [],
          showObjectSupport: showStats,
        });
      }

      if (typeof captureFps === 'number' && !isNaN(captureFps)) {
        updateMetric('Capture FPS', captureFps);
      }
      if (showStats) {
        renderDebugStats(ctx, {
          fps: captureFps ?? 0,
          cameraFrameCost: lastCameraFrameCostRef.current,
          processingTime: liveAnchorSystemState.anchorState?.metrics?.processingTime ?? 0,
          objectCount: liveAnchorSystemState.activeAnchor ? 1 : 0,
        });
      }
      if (showStats && liveAnchorSystemState.anchorState?.anchored) {
        renderKeypoints(ctx, services.anchor?.imageAnchorService);
      }

      const cameraFrameCost = performance.now() - frameWorkStartedAt;
      lastCameraFrameCostRef.current = cameraFrameCost;
      updateMetric('Camera frame cost', cameraFrameCost);
    }
  });

  // Set canvas ref for child component
  const handleCanvasReady = useCallback((canvas) => {
    canvasRef.current = canvas;
  }, []);

  return (
    <main
      aria-label="Camera experience"
      className="camera-view fixed top-0 left-0 w-screen h-screen"
      style={{ overflow: 'visible' }}
    >
      {/* The browser compositor presents video; canvas work is reserved for CV and diagnostics. */}
      <CameraVideo
        ref={videoRef}
        isVisible={cameraState === 'active'}
        mirrored={CAMERA_PRESENTATION_MIRRORED}
      />

      {/* Transparent canvas for tap selection and anchor diagnostics. */}
      <CameraCanvas
        cameraState={cameraState}
        selectionMode={anchorSystemState.mode}
        onSelect={handleCanvasSelect}
        onCanvasReady={handleCanvasReady}
        mirrored={CAMERA_PRESENTATION_MIRRORED}
        style={cameraViewportStyle}
      />
      <AnchorFeedback feedback={anchorFeedback} />

      {/* WebGL Overlay Scene */}
      {overlaySceneEnabled && (
        <OverlaySceneBoundary>
          <Suspense fallback={null}>
            <OverlayScene
              width={videoDimensions?.width || 1280}
              height={videoDimensions?.height || 720}
              isAgentSpeaking={ttsData.isPlaying}
              hiddenMeshes={hiddenMeshes}
              manualRotation={manualRotation}
              onMeshNamesDiscovered={handleMeshNamesDiscovered}
              onMicrophoneTelemetry={publishMicrophoneTelemetry}
              onSpeechTelemetry={publishSpeechTelemetry}
              microphoneMode={microphoneMode}
              microphoneService={services.microphone}
              ttsService={services.tts}
              facialExpression={personalityData.currentPersona?.facialExpression || 'neutral'}
              animationIntensity={personalityData.currentPersona?.animationIntensity ?? 0.65}
              style={cameraViewportStyle}
              anchorSystemState={anchorSystemState}
              subscribeAnchorSystemState={subscribeAnchorSystemState}
              mirrored={CAMERA_PRESENTATION_MIRRORED}
            />
          </Suspense>
        </OverlaySceneBoundary>
      )}

      {/* Start Screen - only when camera is not active */}
      <StartScreen cameraState={cameraState} cameraError={cameraError} onStartCamera={handleStartClick} />

      {cameraState === 'active' && (
        <FieldControls
          hasActiveAnchor={Boolean(anchorSystemState.activeAnchor)}
          showStats={showStats}
          onShowStatsChange={setShowStats}
          onClearAnchor={handleClearAnchor}
          onStopCamera={handleStopClick}
          onAnchorTrackingModeChange={handleAnchorTrackingModeChange}
          metricStore={metricStore}
          depthStateStore={depthStateStore}
          cameraState={cameraState}
          anchorSystemState={anchorSystemState}
          anchorTrackingMode={anchorSystemState.trackingMode}
          personalityData={personalityData}
          ttsData={ttsData}
          onGeneratePersonality={handleGeneratePersonality}
          onSpeakGreeting={speakGreeting}
          discoveredMeshes={discoveredMeshes}
          hiddenMeshes={hiddenMeshes}
          rotation={manualRotation}
          onMeshVisibilityChange={handleMeshVisibilityChange}
          onRotationChange={handleRotationChange}
          // Microphone props
          microphoneMode={microphoneMode}
          onMicrophoneModeChange={handleMicrophoneModeChange}
          voiceActivityThreshold={voiceActivityThreshold}
          onVoiceActivityThresholdChange={handleVoiceActivityThresholdChange}
          microphoneActive={microphoneRuntime.active}
          microphoneError={microphoneRuntime.error}
          microphoneTelemetryStore={microphoneTelemetryStore}
          // Enhanced microphone controls
          onMicrophoneGainChange={handleMicrophoneGainChange}
          onMicrophoneDebugModeChange={handleMicrophoneDebugModeChange}
          onResetMicrophoneBaseline={handleResetMicrophoneBaseline}
          microphoneGain={microphoneGain}
          microphoneDebugMode={microphoneDebugMode}
          open={fieldControlsOpen}
          onOpenChange={setFieldControlsOpen}
        />
      )}
    </main>
  );
};

export default CameraView;
