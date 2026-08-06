import { ImageAnchorService } from '../../services/ImageAnchorService.js';
import { XFeatKeyframeRelocalizer } from '../xfeat.relocalization.js';
import { HomographyEstimator } from '../anchor.homography.js';
import {
  CURVED_OBJECT_RECOVERY_REASON,
  needsCurvedObjectRecovery,
  shouldDeferSparseMugPoseDropoutRecovery,
} from '../curvedObjectRecovery.js';
import { hasPosePositionDropout } from '../poseDropoutRecovery.js';
import { anchorAccuracyMetrics, anchorErrorPercentileMetrics } from '../anchorAccuracyMetrics.js';
import { summarizeLandmarkRefreshCoverage } from '../landmarkSpatialCoverage.js';
import { createObjectSupportMask } from '../objectSupportMask.js';
import { postOcclusionRecoveryMetrics, targetLossRecoveryMetrics } from '../trackingRecoveryMetrics.js';
import { createXFeatFeatureExtractorForNode } from './xfeatNodeLoader.js';
import { shouldRunTimedStep } from '../../utils/cvScheduling.js';
import {
  ANCHOR_PRESENTATION_MOTION_CONFIG,
  AnchorMotionPredictor,
} from '../../utils/anchorMotionPredictor.js';

const OBJECT_SUPPORT_RECOVERY_REFRESH_INTERVAL = 3;
const SYNTHETIC_SOURCE_FRAME_INTERVAL_MS = 1000 / 30;
const SYNTHETIC_PRESENTATION_FRAME_INTERVAL_MS = 1000 / 60;
const PRESENTATION_TIME_EPSILON_MS = 1e-6;

const presentationMotionConfig = (updateIntervalMs) =>
  updateIntervalMs === null
    ? null
    : {
        ...ANCHOR_PRESENTATION_MOTION_CONFIG,
        frameIntervalMs: SYNTHETIC_PRESENTATION_FRAME_INTERVAL_MS,
      };

const normalizeAngle = (value) => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

const normalAngularError = (predicted, expected) => {
  if (!predicted || !expected) return Infinity;

  const predictedLength = Math.hypot(predicted.x, predicted.y, predicted.z);
  const expectedLength = Math.hypot(expected.x, expected.y, expected.z);
  const dot =
    (predicted.x * expected.x + predicted.y * expected.y + predicted.z * expected.z) /
    (predictedLength * expectedLength);

  return Math.acos(Math.max(-1, Math.min(1, dot)));
};

const objectSupportAnchorFromMetrics = (metrics) => {
  const uv = metrics?.objectSupportAnchorUv;
  const bounds = metrics?.currentObjectSupportMaskBounds || metrics?.objectSupportMaskBounds;
  if (
    !uv ||
    !bounds ||
    !Number.isFinite(uv.u) ||
    !Number.isFinite(uv.v) ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    return null;
  }

  return {
    x: bounds.x + bounds.width * uv.u,
    y: bounds.y + bounds.height * uv.v,
  };
};

const objectSupportAnchorError = (frame) => {
  const supportAnchor = objectSupportAnchorFromMetrics(frame.metrics);
  const groundTruthAnchor = frame.groundTruth?.anchor;
  if (!supportAnchor || !groundTruthAnchor) {
    return null;
  }

  return Math.hypot(supportAnchor.x - groundTruthAnchor.x, supportAnchor.y - groundTruthAnchor.y);
};

const getCameraParams = (sequence) =>
  sequence.camera || HomographyEstimator.createCameraMatrix(63, sequence.width, sequence.height);

const setupOpenCvGlobals = (cv) => {
  globalThis.window = { ...(globalThis.window || {}), cv };
  globalThis.performance = globalThis.performance || performance;
};

const cross = (origin, left, right) =>
  (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);

const createConvexHull = (points) => {
  const sorted = [...points]
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((left, right) => left.x - right.x || left.y - right.y);
  if (sorted.length < 3) return sorted;

  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index--) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
};

const pointInPolygon = (point, polygon) => {
  let inside = false;
  for (let left = 0, right = polygon.length - 1; left < polygon.length; right = left++) {
    const leftPoint = polygon[left];
    const rightPoint = polygon[right];
    const intersects =
      leftPoint.y > point.y !== rightPoint.y > point.y &&
      point.x <
        ((rightPoint.x - leftPoint.x) * (point.y - leftPoint.y)) / (rightPoint.y - leftPoint.y) + leftPoint.x;
    if (intersects) inside = !inside;
  }

  return inside;
};

const createSyntheticObjectSupportMask = ({ sequence, frame, referencePoint, updatedAtFrame = 0 }) => {
  if (frame.objectMask) {
    return createObjectSupportMask({
      width: sequence.width,
      height: sequence.height,
      data: frame.objectMask.data,
      source: 'synthetic-object-mask',
      confidence: 0.96,
      referencePoint,
      createdAtFrame: 0,
      updatedAtFrame,
    });
  }

  const polygon = createConvexHull(frame.corners || []);
  const data = new Uint8Array(sequence.width * sequence.height);
  if (polygon.length < 3) {
    return createObjectSupportMask({
      width: sequence.width,
      height: sequence.height,
      data,
      source: 'synthetic-object-mask',
      confidence: 0.96,
      referencePoint,
      createdAtFrame: 0,
      updatedAtFrame,
    });
  }

  const minX = Math.max(0, Math.floor(Math.min(...polygon.map((point) => point.x))));
  const maxX = Math.min(sequence.width - 1, Math.ceil(Math.max(...polygon.map((point) => point.x))));
  const minY = Math.max(0, Math.floor(Math.min(...polygon.map((point) => point.y))));
  const maxY = Math.min(sequence.height - 1, Math.ceil(Math.max(...polygon.map((point) => point.y))));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (pointInPolygon({ x: x + 0.5, y: y + 0.5 }, polygon)) {
        data[y * sequence.width + x] = 255;
      }
    }
  }

  return createObjectSupportMask({
    width: sequence.width,
    height: sequence.height,
    data,
    source: 'synthetic-object-mask',
    confidence: 0.96,
    referencePoint,
    createdAtFrame: 0,
    updatedAtFrame,
  });
};

const hasSyntheticLowObjectOwnership = (metrics) => {
  const active = metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0;
  const owned = metrics.objectOwnedLandmarks ?? active;
  return owned / Math.max(1, active) < 0.65;
};

const shouldDeferSyntheticObjectSupportRefresh = ({ metrics, targetClass, trackingMode }) =>
  shouldDeferSparseMugPoseDropoutRecovery(metrics, targetClass, trackingMode) &&
  !hasSyntheticLowObjectOwnership(metrics);

const shouldRefreshSyntheticObjectSupport = ({
  enabled,
  frame,
  index,
  metrics,
  interval,
  targetClass,
  trackingMode,
}) => {
  if (
    !enabled ||
    (!frame.objectMask && (frame.corners || []).length < 3) ||
    shouldDeferSyntheticObjectSupportRefresh({ metrics, targetClass, trackingMode })
  ) {
    return false;
  }

  const recoveryRefresh =
    hasPosePositionDropout(metrics, { targetClass, trackingMode }) ||
    needsCurvedObjectRecovery(metrics, targetClass);
  return (
    index % interval === 0 || (recoveryRefresh && index % OBJECT_SUPPORT_RECOVERY_REFRESH_INTERVAL === 1)
  );
};

const syntheticObjectSupportRefreshReason = (metrics, targetClass, trackingMode, { index, interval }) => {
  if (index % interval === 0) return 'periodic-segmentation-refresh';
  if (hasPosePositionDropout(metrics, { targetClass, trackingMode })) return 'pose-dropout-recovery';
  if (needsCurvedObjectRecovery(metrics, targetClass)) return CURVED_OBJECT_RECOVERY_REASON;
  return 'periodic-segmentation-refresh';
};

export const createSyntheticDepthFrame = ({ frame, sequence, index, timestamp }) => {
  const width = sequence.width;
  const height = sequence.height;
  const data = new Float32Array(width * height);
  const anchor = frame.groundTruth.anchor;
  const phase = index * 0.018;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - anchor.x) / width;
      const dy = (y - anchor.y) / height;
      data[y * width + x] = Math.max(0.04, Math.min(0.96, 0.48 + dx * 0.34 + dy * 0.18 + phase));
    }
  }

  return {
    width,
    height,
    data,
    timestamp,
    processingTime: 7.5,
    provider: 'synthetic-depth',
    modelUrl: 'synthetic://depth-fusion-replay',
  };
};

const settle = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );

export const replayImageAnchorSequence = async ({
  cv,
  sequence,
  trackingMode,
  targetClassOverride = null,
  useObjectSupportMask = true,
  depthFrameForFrame = null,
  refreshObjectSupportMask = false,
  objectSupportRefreshInterval = 8,
  sourceFrameIntervalMs = SYNTHETIC_SOURCE_FRAME_INTERVAL_MS,
  updateIntervalMs = null,
}) => {
  setupOpenCvGlobals(cv);

  let replayTime = 1000;
  const service = new ImageAnchorService({
    now: () => replayTime,
    profileUpdates: true,
    learnedRelocalizer: new XFeatKeyframeRelocalizer({
      featureExtractorFactory: createXFeatFeatureExtractorForNode,
    }),
  });
  service.setTrackingMode(trackingMode);
  await service.initialize(cv, getCameraParams(sequence));

  const firstFrame = sequence.frames[0];
  const objectSupportMask = useObjectSupportMask
    ? createSyntheticObjectSupportMask({ sequence, frame: firstFrame, referencePoint: sequence.tap })
    : null;
  const targetClass = targetClassOverride || sequence.targetClass;
  const createAttempt = await settle(
    service.createAnchor(firstFrame.imageData, sequence.tap, {
      x1: sequence.boundingBox.x1,
      y1: sequence.boundingBox.y1,
      x2: sequence.boundingBox.x2,
      y2: sequence.boundingBox.y2,
      surfaceHint: targetClass,
      objectSupportMask,
    }),
  );

  if (!createAttempt.ok) {
    service.dispose();
    return {
      sequenceKind: sequence.kind,
      anchorCreated: false,
      createFailure: createAttempt.error.message,
      frames: [],
      cadence: {
        sourceFrameIntervalMs,
        updateIntervalMs,
        sourceFrameCount: 0,
        admittedUpdateCount: 0,
        heldFrameCount: 0,
        presentationMotion: presentationMotionConfig(updateIntervalMs),
      },
    };
  }

  const frames = [];
  const presentationPredictor = updateIntervalMs === null ? null : new AnchorMotionPredictor();
  let lastAdmittedUpdateAt = 0;
  let lastResult = null;
  let admittedUpdateCount = 0;
  for (let index = 1; index < sequence.frames.length; index++) {
    const previousReplayTime = replayTime;
    replayTime += sourceFrameIntervalMs;
    let presentationPredictionMs = null;
    if (presentationPredictor) {
      const presentationStart = performance.now();
      for (
        let presentationTime = previousReplayTime + SYNTHETIC_PRESENTATION_FRAME_INTERVAL_MS;
        presentationTime < replayTime - PRESENTATION_TIME_EPSILON_MS;
        presentationTime += SYNTHETIC_PRESENTATION_FRAME_INTERVAL_MS
      ) {
        presentationPredictor.project(presentationTime);
      }
      presentationPredictionMs = performance.now() - presentationStart;
    }
    const frame = sequence.frames[index];
    const admittedUpdate =
      updateIntervalMs === null ||
      shouldRunTimedStep({
        now: replayTime,
        lastRunAt: lastAdmittedUpdateAt,
        intervalMs: updateIntervalMs,
      });
    let updateWallTimeMs = null;
    if (admittedUpdate) {
      const depthFrame = depthFrameForFrame?.({ frame, index, sequence, timestamp: replayTime }) || null;
      const frameStart = performance.now();
      lastResult = await service.updateAnchor(
        frame.imageData,
        depthFrame
          ? {
              depthFrame,
              depthState: { state: 'ready', provider: depthFrame.provider },
            }
          : {
              depthFrame: null,
              depthState: { state: 'idle' },
            },
      );
      updateWallTimeMs = performance.now() - frameStart;
      lastAdmittedUpdateAt = replayTime;
      admittedUpdateCount++;
    }
    const result = lastResult;
    let state = service.getState();
    if (
      useObjectSupportMask &&
      shouldRefreshSyntheticObjectSupport({
        enabled: refreshObjectSupportMask,
        frame,
        index,
        metrics: state.metrics,
        interval: objectSupportRefreshInterval,
        targetClass,
        trackingMode,
      })
    ) {
      service.updateObjectSupportMask(
        createSyntheticObjectSupportMask({
          sequence,
          frame,
          referencePoint: result.position || state.position || sequence.tap,
          updatedAtFrame: index,
        }),
        {
          reason: syntheticObjectSupportRefreshReason(state.metrics, targetClass, trackingMode, {
            index,
            interval: objectSupportRefreshInterval,
          }),
        },
      );
      state = service.getState();
    }
    const transform = result.planarTransform || state.planarTransform || {};
    const measuredPosition = state.position || result.position || null;
    let predicted = measuredPosition;
    if (presentationPredictor) {
      const presentationStart = performance.now();
      const present = result.success && state.metrics.targetPresent === true && measuredPosition;
      if (!present) {
        presentationPredictor.reset();
      } else {
        if (admittedUpdate) {
          presentationPredictor.observe(measuredPosition, replayTime);
        }
        predicted = presentationPredictor.project(replayTime);
      }
      presentationPredictionMs += performance.now() - presentationStart;
    }
    const normal = state.normal || result.normal || null;
    const groundTruth = frame.groundTruth;

    frames.push({
      index,
      occluded: frame.occluded === true,
      targetVisible: frame.targetVisible !== false,
      success: result.success,
      targetPresent: state.metrics.targetPresent === true,
      anchorState: state.state,
      positionSource: result.method || null,
      method: result.method || null,
      poseSource: result.poseSource || state.metrics.poseSource || null,
      failureReason: result.reason || state.metrics.lastFailureReason || null,
      predicted,
      normal,
      planarTransform: transform,
      groundTruth,
      runtime: {
        admittedUpdate,
        updateWallTimeMs,
        stageTimings: admittedUpdate ? state.metrics.updateTimings || null : null,
        poseAgeMs: replayTime - lastAdmittedUpdateAt,
        presentationPredictionMs,
      },
      metrics: state.metrics,
      anchorError: predicted
        ? Math.hypot(predicted.x - groundTruth.anchor.x, predicted.y - groundTruth.anchor.y)
        : Infinity,
      scaleError:
        typeof transform.scale === 'number' ? Math.abs(transform.scale - groundTruth.scale) : Infinity,
      rollError:
        typeof transform.rotation === 'number'
          ? Math.abs(normalizeAngle(transform.rotation - groundTruth.roll))
          : Infinity,
      normalError: normalAngularError(normal, groundTruth.normal),
      reconstructionNormalError: normalAngularError(
        state.metrics.reconstructionPoseNormal,
        groundTruth.normal,
      ),
    });
  }

  service.dispose();

  return {
    sequenceKind: sequence.kind,
    anchorCreated: true,
    createResult: createAttempt.value,
    frames,
    cadence: {
      sourceFrameIntervalMs,
      updateIntervalMs,
      sourceFrameCount: frames.length,
      admittedUpdateCount,
      heldFrameCount: frames.length - admittedUpdateCount,
      presentationMotion: presentationMotionConfig(updateIntervalMs),
    },
  };
};

export const summarizeReplay = (replay) => {
  const frames = replay.frames;
  const visibleFrames = frames.filter((frame) => frame.targetVisible !== false);
  const successful = visibleFrames.filter((frame) => frame.success && frame.targetPresent === true);
  const failures = visibleFrames.filter((frame) => !frame.success || frame.targetPresent !== true);
  const jumps = [];
  const objectSupportCorrections = successful.filter(
    (frame) => frame.metrics?.objectSupportPositionCorrection,
  );
  const objectSupportFrameStepLimited = successful.filter(
    (frame) => frame.metrics?.objectSupportFrameStepLimited,
  );
  const objectSupportAnchorErrors = successful.map(objectSupportAnchorError).filter(Number.isFinite);
  const poseSourceCounts = successful.reduce((counts, frame) => {
    const source = frame.poseSource || 'none';
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
  const positionSourceCounts = successful.reduce((counts, frame) => {
    const source = frame.positionSource || frame.method || 'none';
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
  const objectSupportCorrectionCounts = objectSupportCorrections.reduce((counts, frame) => {
    const reason = frame.metrics.objectSupportPositionCorrection;
    counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});

  for (let index = 1; index < successful.length; index++) {
    if (successful[index].index !== successful[index - 1].index + 1) continue;
    const previous = successful[index - 1].predicted;
    const current = successful[index].predicted;
    jumps.push(Math.hypot(current.x - previous.x, current.y - previous.y));
  }

  return {
    frameCount: frames.length,
    visibleFrameCount: visibleFrames.length,
    successfulFrames: successful.length,
    failedFrames: failures.length,
    failureReasons: [...new Set(failures.map((frame) => frame.failureReason).filter(Boolean))],
    maxAnchorError: Math.max(...successful.map((frame) => frame.anchorError), 0),
    meanAnchorError:
      successful.reduce((sum, frame) => sum + frame.anchorError, 0) / Math.max(1, successful.length),
    ...anchorAccuracyMetrics(visibleFrames),
    ...anchorErrorPercentileMetrics(visibleFrames),
    ...postOcclusionRecoveryMetrics(frames),
    ...targetLossRecoveryMetrics(frames),
    maxScaleError: Math.max(...successful.map((frame) => frame.scaleError), 0),
    maxRollError: Math.max(...successful.map((frame) => frame.rollError), 0),
    maxNormalError: Math.max(...successful.map((frame) => frame.normalError), 0),
    meanNormalError:
      successful.reduce((sum, frame) => sum + frame.normalError, 0) / Math.max(1, successful.length),
    maxFrameJump: Math.max(...jumps, 0),
    minPoseInliers: Math.min(...successful.map((frame) => frame.metrics.poseInliers || 0), Infinity),
    planarPoseUsage:
      successful.filter((frame) => frame.poseSource === 'planar-homography').length /
      Math.max(1, successful.length),
    planarPositionUsage:
      successful.filter((frame) => frame.positionSource === 'planar-homography').length /
      Math.max(1, successful.length),
    sparsePoseUsage:
      successful.filter((frame) => frame.poseSource === 'sparse-reconstruction').length /
      Math.max(1, successful.length),
    sparsePositionUsage:
      successful.filter((frame) => frame.positionSource === 'sparse-reconstruction').length /
      Math.max(1, successful.length),
    poseSourceCounts,
    positionSourceCounts,
    objectSupportCorrectionCounts,
    objectSupportCorrectionFrames: objectSupportCorrections.length,
    objectSupportFrameStepLimitedFrames: objectSupportFrameStepLimited.length,
    objectSupportRecoveryFrames: objectSupportCorrections.filter((frame) =>
      /dropout|recovery/i.test(frame.metrics.objectSupportPositionCorrection),
    ).length,
    maxOwnershipProbationLandmarks: Math.max(
      ...frames.map((frame) => frame.metrics?.ownershipProbationLandmarks || 0),
      0,
    ),
    landmarkRefreshProbationaryLandmarks: frames.reduce(
      (sum, frame) => sum + (frame.metrics?.landmarkRefreshProbationary || 0),
      0,
    ),
    landmarkOwnershipPromotions: frames.reduce(
      (sum, frame) => sum + (frame.metrics?.landmarkOwnershipPromoted || 0),
      0,
    ),
    ...summarizeLandmarkRefreshCoverage(frames),
    maxObjectSupportPositionStep: Math.max(
      ...objectSupportCorrections.map((frame) => frame.metrics.objectSupportPositionStep || 0),
      0,
    ),
    maxObjectSupportAnchorError: Math.max(...objectSupportAnchorErrors, 0),
    meanObjectSupportAnchorError:
      objectSupportAnchorErrors.reduce((sum, value) => sum + value, 0) /
      Math.max(1, objectSupportAnchorErrors.length),
  };
};
