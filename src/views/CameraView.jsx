import { lazy, Suspense, useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { useVideoFrames } from '../hooks/useVideoFrames.js';
import { useCameraSystem } from '../hooks/useCameraSystem.js';
import { ANCHOR_SELECTION_IN_PROGRESS_REASON } from '../services/AnchorSelectionGate.js';
import { useCameraMetrics } from '../hooks/useCameraMetrics.js';
import { useMicrophoneRuntime } from '../hooks/useMicrophoneRuntime.js';
import { useTransientFeedback } from '../hooks/useTransientFeedback.js';

import CameraVideo from '../components/CameraVideo.jsx';
import CameraCanvas from '../components/CameraCanvas.jsx';
import FeatureBoundary, { FeatureError } from '../components/FeatureBoundary.jsx';
import FieldControls from '../components/ui/FieldControls.jsx';
import { AnchorStatusMessage } from '../components/ui/AnchorStatusMessage.jsx';
import { describeAnchorStatus } from '../utils/anchorStatus.js';
import {
  renderAnchorOverlay,
  renderDiscoveryOverlay,
  renderDebugStats,
  renderKeypoints,
} from '../utils/anchorOverlayRenderer.js';
import { logger } from '../utils/logger.js';
import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';
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
      className="absolute inset-0 z-40 flex max-h-dvh overflow-y-auto overscroll-contain bg-black px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-auto"
    >
      <div className="m-auto min-w-0 w-full max-w-sm shrink-0 text-center text-white [overflow-wrap:anywhere]">
        <h1 id="start-screen-title" className="text-4xl font-bold mb-4 text-white">
          High on Life
        </h1>
        <p className="text-base mb-8 text-gray-400">Point at an object. Tap when its outline turns green.</p>
        <button
          type="button"
          onClick={onStartCamera}
          disabled={isRequesting}
          aria-busy={isRequesting}
          className="min-h-11 max-w-full px-6 py-3 text-lg bg-blue-600 text-white border-0 rounded-lg cursor-pointer hover:bg-blue-700 transition-colors duration-200 font-medium disabled:cursor-wait disabled:bg-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
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
      className={`fixed left-1/2 bottom-[calc(6rem_+_env(safe-area-inset-bottom))] z-50 w-[min(92vw,28rem)] -translate-x-1/2 rounded border px-3 py-2 text-center text-sm shadow-lg ${toneClass}`}
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
  const autoVoiceRequestRef = useRef(0);
  const mapReadyAnchorRef = useRef(null);
  const lastAnchorUpdateAtRef = useRef(0);
  const lastSegmentationRefreshCheckAtRef = useRef(0);
  const lastCameraFrameCostRef = useRef(0);
  const captureFpsRef = useRef(0);

  const [showStats, setShowStats] = useState(false);
  const [discoveredMeshes, setDiscoveredMeshes] = useState([]);
  const [hiddenMeshes, setHiddenMeshes] = useState(new Set());
  const [manualRotation, setManualRotation] = useState({ x: 0, y: 0, z: 0 });
  const { feedback: anchorFeedback, showFeedback: showAnchorFeedback } = useTransientFeedback();
  const [fieldControlsOpen, setFieldControlsOpen] = useState(false);

  const cameraMetricsStore = useCameraMetrics();

  // Use the camera system hook with image-based anchors
  const {
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
    services,
    startCamera,
    resumeCamera,
    stopCamera,
    retryVision,
    canProcessAnchorFrame,
    processAnchorFrame,
    selectAnchorFromTap,
    clearAnchor,
    generatePersonality,
    synthesizeSpeech,
    stopTTS,
    speakGreeting,
    setAnchorTrackingMode,
  } = useCameraSystem();
  const anchorStatus = useMemo(
    () => describeAnchorStatus({ cameraState, anchorSystemState }),
    [cameraState, anchorSystemState],
  );
  const overlaySceneEnabled = shouldMountOverlayScene({
    cameraState,
    activeAnchor: anchorSystemState.activeAnchor,
  });

  useEffect(() => {
    if (cameraState !== 'active') {
      frameCountRef.current = 0;
      lastCameraFrameCostRef.current = 0;
      captureFpsRef.current = 0;
      cameraMetricsStore.reset();
    }
  }, [cameraMetricsStore, cameraState]);

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
    toggle: toggleMicrophoneMode,
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
  const handleMicrophoneModeChange = useCallback(
    (enabled) => {
      if (enabled) autoVoiceRequestRef.current++;
      return toggleMicrophoneMode(enabled);
    },
    [toggleMicrophoneMode],
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
      if (getAnchorSystemState().activeAnchor?.createdAt !== liveAnchorSystemState.activeAnchor.createdAt)
        return;
      logger.error('CameraView', 'Failed to generate personality:', error);
      showAnchorFeedback(`Personality not generated: ${error.message}`, 'bad');
    }
  }, [captureCurrentCameraFrame, generatePersonality, getAnchorSystemState, showAnchorFeedback]);

  const generateAndSpeakForAnchor = useCallback(
    async (anchorCreatedAt) => {
      const requestId = ++autoVoiceRequestRef.current;
      const ownsRequest = () =>
        ownsObjectVoiceRequest({
          requestId,
          currentRequestId: autoVoiceRequestRef.current,
          anchorCreatedAt,
          activeAnchor: getAnchorSystemState().activeAnchor,
        });

      try {
        const { readLocalAISetup } = await import('../api/localAISetup.js');
        if (!ownsRequest()) return;
        const setup = readLocalAISetup();
        if (!setup.personalityReady || !setup.speechReady) {
          showAnchorFeedback('Object selected. Use the microphone button to animate its face.', 'good');
          return;
        }
        showAnchorFeedback('Generating object voice...', 'warn');
        const anchor = getAnchorSystemState().activeAnchor;
        const imageData = captureCurrentCameraFrame();
        const roi = getPersonalityRoi(anchor.position, anchor.selectionRegion);
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
    [
      captureCurrentCameraFrame,
      generatePersonality,
      getAnchorSystemState,
      showAnchorFeedback,
      synthesizeSpeech,
    ],
  );

  const handleClearAnchor = useCallback(() => {
    autoVoiceRequestRef.current++;
    mapReadyAnchorRef.current = null;
    lastAnchorUpdateAtRef.current = 0;
    lastSegmentationRefreshCheckAtRef.current = 0;
    clearAnchor();
    showAnchorFeedback('Point at another object and wait for its green outline.', 'good');
  }, [clearAnchor, showAnchorFeedback]);

  const handleSpeakGreeting = useCallback(async () => {
    const anchor = getAnchorSystemState().activeAnchor;
    if (!anchor) return;
    const requestId = ++autoVoiceRequestRef.current;
    try {
      await speakGreeting();
    } catch (error) {
      if (
        !ownsObjectVoiceRequest({
          requestId,
          currentRequestId: autoVoiceRequestRef.current,
          anchorCreatedAt: anchor.createdAt,
          activeAnchor: getAnchorSystemState().activeAnchor,
        })
      )
        return;
      logger.error('CameraView', 'Greeting playback failed:', error);
      showAnchorFeedback(`Voice not started: ${error.message}`, 'bad');
    }
  }, [getAnchorSystemState, showAnchorFeedback, speakGreeting]);

  const handleStopSpeech = useCallback(() => {
    autoVoiceRequestRef.current++;
    stopTTS();
    showAnchorFeedback('Speech stopped.', 'good');
  }, [showAnchorFeedback, stopTTS]);

  const candidateId = anchorSystemState.candidate?.id ?? null;
  const handleCanvasSelect = useCallback(
    async (position) => {
      if (cameraState !== 'active' || getAnchorSystemState().mode !== 'selection') {
        return;
      }

      try {
        const canvas = canvasRef.current;
        if (!canvas || !videoRef.current || frameCountRef.current === 0) {
          showAnchorFeedback('Preparing camera frame...', 'warn');
          return;
        }
        const result = await selectAnchorFromTap({
          candidateId,
          tapPosition: position,
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
          showAnchorFeedback('Object selected.', 'good');
          if (
            shouldAutoStartObjectVoice({
              trackingMode: result.trackingMode,
              reconstructionReady:
                getAnchorSystemState().activeAnchor?.diagnostics?.reconstructionReady === true,
              hasUserGesture: true,
            })
          ) {
            const createdAnchor = getAnchorSystemState().activeAnchor;
            generateAndSpeakForAnchor(createdAnchor.createdAt);
          }
        } else {
          logger.warn('CameraView', 'Anchor creation failed:', result);
          showAnchorFeedback(result.reason, 'warn');
        }
      } catch (error) {
        logger.warn('CameraView', `Anchor not created: ${error.message}`);
        showAnchorFeedback(`Anchor not created: ${error.message}`, 'bad');
      }
    },
    [
      candidateId,
      cameraState,
      selectAnchorFromTap,
      showAnchorFeedback,
      generateAndSpeakForAnchor,
      getAnchorSystemState,
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

    showAnchorFeedback('3D map locked.', 'good');
  }, [anchorSystemState.activeAnchor, anchorSystemState.anchorState, showAnchorFeedback]);

  const paintCameraOverlay = useCallback(
    (state) => {
      const canvas = canvasRef.current;
      const ctx = ctxRef.current;
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!services.camera.isActive()) return;

      if (state.mode === 'anchor' && state.activeAnchor) {
        if (showStats) {
          renderAnchorOverlay(ctx, {
            anchor: state.activeAnchor,
            anchorState: state.anchorState,
            trackedPoints: services.anchor?.imageAnchorService?.keypointTracker?.trackedPoints || [],
            showObjectSupport: true,
          });
        }
      } else {
        renderDiscoveryOverlay(ctx, state.candidate);
      }
      if (showStats) {
        renderDebugStats(ctx, {
          fps: captureFpsRef.current,
          cameraFrameCost: lastCameraFrameCostRef.current,
          processingTime: state.anchorState?.metrics?.processingTime ?? 0,
          objectCount: state.activeAnchor ? 1 : 0,
        });
        if (state.anchorState?.anchored) renderKeypoints(ctx, services.anchor?.imageAnchorService);
      }
    },
    [services.anchor, services.camera, showStats],
  );

  useEffect(() => {
    paintCameraOverlay(getAnchorSystemState());
    return subscribeAnchorSystemState(paintCameraOverlay);
  }, [getAnchorSystemState, paintCameraOverlay, subscribeAnchorSystemState]);

  // Camera processing follows presented video frames; the overlay follows CV state, including expiry.
  useVideoFrames(videoRef, cameraState === 'active', ({ now: videoFrameAt, captureFps }) => {
    if (services.camera.isActive() && videoRef.current && canvasRef.current) {
      const frameWorkStartedAt = performance.now();
      const video = videoRef.current;
      const canvas = canvasRef.current;
      let repaint = showStats;
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        // A presented frame can expose new dimensions before the video's resize event.
        if (!services.camera.synchronizeVideoDimensions()) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctxRef.current = null;
      }
      if (!ctxRef.current) {
        ctxRef.current = canvas.getContext('2d');
        repaint = true;
      }
      captureFpsRef.current = captureFps ?? 0;
      const frameIndex = ++frameCountRef.current;
      const liveAnchorSystemState = getAnchorSystemState();

      if (liveAnchorSystemState.initialized) {
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

      if (repaint) paintCameraOverlay(liveAnchorSystemState);

      const cameraFrameCost = performance.now() - frameWorkStartedAt;
      lastCameraFrameCostRef.current = cameraFrameCost;
      cameraMetricsStore.recordFrame(captureFps, cameraFrameCost);
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
      />
      <AnchorFeedback feedback={anchorFeedback} />
      {cameraState === 'active' && anchorSystemState.mode === 'selection' && (
        <div
          data-testid="object-discovery"
          data-stage={anchorStatus.status}
          hidden={fieldControlsOpen}
          className="fixed top-[max(1rem,env(safe-area-inset-top))] left-1/2 z-30 w-[min(90vw,26rem)] -translate-x-1/2 text-white pointer-events-none"
        >
          <AnchorStatusMessage status={anchorStatus} error={visionError} onRetry={retryVision} />
        </div>
      )}

      {/* WebGL Overlay Scene */}
      {overlaySceneEnabled && (
        <FeatureBoundary
          name="OverlayScene"
          renderError={(error) => (
            <div className="fixed left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-40 max-h-[70dvh] w-[min(90vw,26rem)] -translate-x-1/2 overflow-y-auto rounded border border-red-700 bg-red-950 p-3">
              <FeatureError name="3D overlay" error={error} />
            </div>
          )}
        >
          {discoveredMeshes.length === 0 && (
            <p
              role="status"
              className="fixed left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-30 w-[min(90vw,26rem)] -translate-x-1/2 rounded-lg border border-white/15 bg-zinc-950/90 p-3 text-sm text-zinc-100 pointer-events-none"
            >
              Loading face…
            </p>
          )}
          <Suspense fallback={null}>
            <OverlayScene
              width={videoDimensions?.width || 1280}
              height={videoDimensions?.height || 720}
              isAgentSpeaking={ttsData.isPlaying}
              hiddenMeshes={hiddenMeshes}
              manualRotation={manualRotation}
              onMeshNamesDiscovered={handleMeshNamesDiscovered}
              onMicrophoneTelemetry={publishMicrophoneTelemetry}
              microphoneMode={microphoneMode}
              microphoneService={services.microphone}
              ttsService={services.tts}
              facialExpression={personalityData.currentPersona?.facialExpression || 'neutral'}
              animationIntensity={personalityData.currentPersona?.animationIntensity ?? 0.65}
              anchorSystemState={anchorSystemState}
              subscribeAnchorSystemState={subscribeAnchorSystemState}
              mirrored={CAMERA_PRESENTATION_MIRRORED}
            />
          </Suspense>
        </FeatureBoundary>
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
          onAnchorTrackingModeChange={setAnchorTrackingMode}
          cameraMetricsStore={cameraMetricsStore}
          depthStateStore={depthStateStore}
          cameraState={cameraState}
          anchorSystemState={anchorSystemState}
          anchorStatus={anchorStatus}
          onRetryVision={retryVision}
          anchorTrackingMode={anchorSystemState.trackingMode}
          personalityData={personalityData}
          ttsData={ttsData}
          onGeneratePersonality={handleGeneratePersonality}
          onSpeakGreeting={handleSpeakGreeting}
          onStopSpeech={handleStopSpeech}
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
