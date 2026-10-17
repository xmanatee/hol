import { lazy, Suspense, useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { useVideoFrames } from '../hooks/useVideoFrames.js';
import { useCameraSystem } from '../hooks/useCameraSystem.js';
import { ANCHOR_SELECTION_IN_PROGRESS_REASON } from '../services/AnchorSelectionGate.js';
import { useCameraMetrics } from '../hooks/useCameraMetrics.js';
import { useMicrophoneRuntime } from '../hooks/useMicrophoneRuntime.js';
import { useTransientFeedback } from '../hooks/useTransientFeedback.js';
import { useAppRelease } from '../hooks/useAppRelease.js';
import { TARGET_SCENARIOS } from '../cv/targetScenario.js';

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
} from '../utils/anchorOverlayRenderer.js';
import { logger } from '../utils/logger.js';
import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';
import { shouldAutoStartObjectVoice } from '../audio/objectVoicePolicy.js';
import { ownsObjectVoiceRequest } from '../audio/objectVoiceOwnership.js';
import { shouldMountOverlayScene } from '../utils/overlayVisibility.js';
import {
  captureCameraFrame,
  getCurrentObjectCaptureRegion,
  shouldCaptureCameraFrame,
} from '../utils/cameraFrameCapture.js';
import {
  ANCHOR_TRACKING_INTERVAL_MS,
  SEGMENTATION_REFRESH_CHECK_INTERVAL_MS,
  isSelectedObjectObservationFresh,
  shouldRunTimedStep,
} from '../utils/cvScheduling.js';

const OverlayScene = lazy(() => import('../scenes/OverlayScene.jsx'));
const CAMERA_PRESENTATION_MIRRORED = false;
const TARGET_GUIDANCE = {
  can: ['Printed can', 'Center the printed body, away from the rims. Use soft, even light.'],
  'bottle-label': [
    'Bottle label',
    'Center the printed label; keep the bottle body visible. Avoid clear glass and the neck.',
  ],
  paper: [
    'Rectangular paper',
    'Keep the whole flat sheet visible. Printed detail is currently required for tracking.',
  ],
  general: [
    'Other object (experimental)',
    'Center one distinct, textured object. Its surface shape is not known.',
  ],
};

const getStartButtonLabel = (cameraState) => {
  if (cameraState === 'requesting') return 'Starting Camera...';
  if (cameraState === 'blocked') return 'Resume Camera';
  if (cameraState === 'error') return 'Retry Camera';
  return 'Start Camera';
};

const StartScreen = ({
  cameraState,
  cameraError,
  onStartCamera,
  release,
  targetScenario,
  onTargetScenarioChange,
}) => {
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
        <p className="text-base mb-6 text-gray-400">Point at an object. Tap when its outline turns green.</p>
        <label className="block mb-2 text-sm text-gray-200" htmlFor="target-surface">
          Target surface
        </label>
        <select
          id="target-surface"
          value={targetScenario}
          disabled={isRequesting || cameraState === 'blocked'}
          onChange={(event) => onTargetScenarioChange(event.target.value)}
          className="min-h-11 w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 text-base text-white focus-visible:outline-2 focus-visible:outline-white"
          aria-describedby="target-surface-guide"
        >
          {TARGET_SCENARIOS.map(({ id }) => (
            <option key={id} value={id}>
              {TARGET_GUIDANCE[id][0]}
            </option>
          ))}
        </select>
        <p id="target-surface-guide" className="mt-2 mb-6 text-sm text-gray-400">
          {TARGET_GUIDANCE[targetScenario][1]} Surface type is your assumption, not automatic recognition.
        </p>
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
        <p className="mt-6 text-xs text-gray-400">Build {release.build}</p>
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
  const [targetScenario, setTargetScenario] = useState('can');
  const [discoveredMeshes, setDiscoveredMeshes] = useState([]);
  const [hiddenMeshes, setHiddenMeshes] = useState(new Set());
  const [manualRotation, setManualRotation] = useState({ x: 0, y: 0, z: 0 });
  const { feedback: anchorFeedback, showFeedback: showAnchorFeedback } = useTransientFeedback();
  const [fieldControlsOpen, setFieldControlsOpen] = useState(false);
  const release = useAppRelease();

  const cameraMetricsStore = useCameraMetrics();

  const resetFaceControls = useCallback(() => {
    setDiscoveredMeshes([]);
    setHiddenMeshes(new Set());
    setManualRotation({ x: 0, y: 0, z: 0 });
  }, []);

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
  } = useCameraSystem({ targetScenario });
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
    showAnchorFeedback('Select a highlighted object before enabling microphone mode.', 'warn');
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
      resetFaceControls();
      await startCamera(videoRef.current);
    }
  }, [cameraState, startCamera, resumeCamera, resetFaceControls]);

  const handleStopClick = useCallback(() => {
    setFieldControlsOpen(false);
    resetFaceControls();
    stopCamera();
  }, [resetFaceControls, stopCamera]);

  // Handle mesh discovery from HeadAnchor
  const handleMeshNamesDiscovered = useCallback((meshNames) => {
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
  }, []);

  const handleGeneratePersonality = useCallback(async () => {
    const liveAnchorSystemState = getAnchorSystemState();
    if (liveAnchorSystemState.mode !== 'anchor' || !liveAnchorSystemState.activeAnchor || !videoRef.current) {
      return;
    }

    try {
      const roi = getCurrentObjectCaptureRegion(liveAnchorSystemState, performance.now());
      const imageData = captureCurrentCameraFrame();
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
        const roi = getCurrentObjectCaptureRegion(getAnchorSystemState(), performance.now());
        const imageData = captureCurrentCameraFrame();
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
    resetFaceControls();
    clearAnchor();
    showAnchorFeedback('Point at another object and wait for its green outline.', 'good');
  }, [clearAnchor, resetFaceControls, showAnchorFeedback]);

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
        resetFaceControls();
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
        logger.warn('CameraView', `Object not selected: ${error.message}`);
        showAnchorFeedback(`Object not selected: ${error.message}`, 'bad');
      }
    },
    [
      candidateId,
      cameraState,
      selectAnchorFromTap,
      resetFaceControls,
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
      const observationFresh = isSelectedObjectObservationFresh(state, performance.now());

      if (state.mode === 'anchor' && state.activeAnchor) {
        if (showStats && observationFresh) {
          renderAnchorOverlay(ctx, {
            anchor: state.activeAnchor,
            anchorState: state.anchorState,
            showObjectSupport: true,
          });
        }
      } else {
        if (state.initialized && !state.error) renderDiscoveryOverlay(ctx, state.candidate);
      }
      if (showStats) {
        renderDebugStats(ctx, {
          fps: captureFpsRef.current,
          cameraFrameCost: lastCameraFrameCostRef.current,
          processingTime: state.anchorState?.metrics?.processingTime ?? 0,
          objectCount: state.activeAnchor ? 1 : 0,
        });
      }
    },
    [services.camera, showStats],
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
      frameCountRef.current++;
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
          processAnchorFrame(captureCurrentCameraFrame(), {
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
        selectionReady={anchorSystemState.candidate?.status === 'ready'}
        onSelect={handleCanvasSelect}
        onCanvasReady={handleCanvasReady}
        mirrored={CAMERA_PRESENTATION_MIRRORED}
      />
      <AnchorFeedback
        feedback={
          cameraState === 'active' &&
          !visionError &&
          (anchorFeedback?.severity !== 'good' ||
            (anchorSystemState.activeAnchor && anchorStatus.severity === 'good'))
            ? anchorFeedback
            : null
        }
      />
      {cameraState === 'active' && (
        <div
          data-testid={anchorSystemState.mode === 'selection' ? 'object-discovery' : 'object-recovery'}
          data-stage={anchorStatus.status}
          hidden={fieldControlsOpen}
          className={
            anchorSystemState.mode === 'anchor' && anchorStatus.severity === 'good'
              ? 'sr-only'
              : 'fixed top-[max(1rem,env(safe-area-inset-top))] left-1/2 z-30 w-[min(90vw,26rem)] -translate-x-1/2 text-white pointer-events-none'
          }
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
          {discoveredMeshes.length === 0 && anchorStatus.severity === 'good' && (
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
              getAnchorSystemState={getAnchorSystemState}
              subscribeAnchorSystemState={subscribeAnchorSystemState}
              mirrored={CAMERA_PRESENTATION_MIRRORED}
            />
          </Suspense>
        </FeatureBoundary>
      )}

      {/* Start Screen - only when camera is not active */}
      <StartScreen
        cameraState={cameraState}
        cameraError={cameraError}
        onStartCamera={handleStartClick}
        release={release}
        targetScenario={targetScenario}
        onTargetScenarioChange={setTargetScenario}
      />
      {release.status === 'update' && (
        <div
          role="status"
          className="fixed top-[max(1rem,env(safe-area-inset-top))] left-1/2 z-50 w-[min(90vw,26rem)] -translate-x-1/2 rounded-lg border border-amber-500 bg-zinc-950 p-3 text-sm text-white"
        >
          <p>A newer version is available. Reload to use it; this restarts the camera.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 min-h-11 rounded border border-white/30 px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Reload app
          </button>
        </div>
      )}

      {cameraState === 'active' && (
        <FieldControls
          hasActiveAnchor={Boolean(anchorSystemState.activeAnchor)}
          showStats={showStats}
          onShowStatsChange={setShowStats}
          onClearAnchor={handleClearAnchor}
          onStopCamera={handleStopClick}
          cameraMetricsStore={cameraMetricsStore}
          release={release}
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
