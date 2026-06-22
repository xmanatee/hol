import { ImageAnchorService } from '../../services/ImageAnchorService.js';
import { HomographyEstimator } from '../anchor.homography.js';
import {
  CURVED_OBJECT_RECOVERY_REASON,
  needsCurvedObjectRecovery,
  shouldDeferSparseMugPoseDropoutRecovery,
} from '../curvedObjectRecovery.js';
import { createObjectSupportMask } from '../objectSupportMask.js';

const normalizeAngle = value => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

const normalAngularError = (predicted, expected) => {
  if (!predicted || !expected) return Infinity;

  const predictedLength = Math.hypot(predicted.x, predicted.y, predicted.z);
  const expectedLength = Math.hypot(expected.x, expected.y, expected.z);
  const dot = (
    predicted.x * expected.x +
    predicted.y * expected.y +
    predicted.z * expected.z
  ) / (predictedLength * expectedLength);

  return Math.acos(Math.max(-1, Math.min(1, dot)));
};

const getCameraParams = sequence => sequence.camera || HomographyEstimator.createCameraMatrix(
  63,
  sequence.width,
  sequence.height
);

const setupOpenCvGlobals = cv => {
  globalThis.window = { ...(globalThis.window || {}), cv };
  globalThis.performance = globalThis.performance || performance;
};

const cross = (origin, left, right) => (
  (left.x - origin.x) * (right.y - origin.y) -
  (left.y - origin.y) * (right.x - origin.x)
);

const createConvexHull = points => {
  const sorted = [...points]
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
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
    const intersects = (leftPoint.y > point.y) !== (rightPoint.y > point.y) &&
      point.x < (rightPoint.x - leftPoint.x) * (point.y - leftPoint.y) / (rightPoint.y - leftPoint.y) + leftPoint.x;
    if (intersects) inside = !inside;
  }

  return inside;
};

const createSyntheticObjectSupportMask = ({
  sequence,
  frame,
  referencePoint,
  updatedAtFrame = 0,
}) => {
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

  const minX = Math.max(0, Math.floor(Math.min(...polygon.map(point => point.x))));
  const maxX = Math.min(sequence.width - 1, Math.ceil(Math.max(...polygon.map(point => point.x))));
  const minY = Math.max(0, Math.floor(Math.min(...polygon.map(point => point.y))));
  const maxY = Math.min(sequence.height - 1, Math.ceil(Math.max(...polygon.map(point => point.y))));

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

const hasSyntheticLowObjectOwnership = metrics => {
  const active = metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0;
  const owned = metrics.objectOwnedLandmarks ?? active;
  return owned / Math.max(1, active) < 0.65;
};

const hasSyntheticPoseDropout = (metrics, { targetClass, trackingMode } = {}) => {
  if (shouldDeferSparseMugPoseDropoutRecovery(metrics, targetClass, trackingMode)) {
    return false;
  }

  const active = metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0;
  const trackingRate = metrics.trackingSuccessRate ?? 0;
  const poseInliers = metrics.poseInliers ?? 0;

  return active >= 8 &&
    trackingRate >= 0.55 &&
    poseInliers < 8 &&
    metrics.poseSource == null;
};

const shouldDeferSyntheticObjectSupportRefresh = ({ metrics, targetClass, trackingMode }) => (
  shouldDeferSparseMugPoseDropoutRecovery(metrics, targetClass, trackingMode) &&
  !hasSyntheticLowObjectOwnership(metrics)
);

const shouldRefreshSyntheticObjectSupport = ({ enabled, frame, index, metrics, interval, targetClass, trackingMode }) => {
  if (!enabled ||
      (!frame.objectMask && (frame.corners || []).length < 3) ||
      shouldDeferSyntheticObjectSupportRefresh({ metrics, targetClass, trackingMode })) {
    return false;
  }

  return index % interval === 0 ||
    hasSyntheticPoseDropout(metrics, { targetClass, trackingMode }) ||
    needsCurvedObjectRecovery(metrics, targetClass);
};

const syntheticObjectSupportRefreshReason = (metrics, targetClass, trackingMode) => {
  if (hasSyntheticPoseDropout(metrics, { targetClass, trackingMode })) return 'pose-dropout-recovery';
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

const settle = promise => promise.then(
  value => ({ ok: true, value }),
  error => ({ ok: false, error })
);

export const replayImageAnchorSequence = async ({
  cv,
  sequence,
  trackingMode,
  useObjectSupportMask = true,
  depthFrameForFrame = null,
  refreshObjectSupportMask = false,
  objectSupportRefreshInterval = 8,
}) => {
  setupOpenCvGlobals(cv);

  let replayTime = 1000;
  const service = new ImageAnchorService({ now: () => replayTime, profileUpdates: true });
  service.setTrackingMode(trackingMode);
  await service.initialize(cv, getCameraParams(sequence));

  const firstFrame = sequence.frames[0];
  const objectSupportMask = useObjectSupportMask
    ? createSyntheticObjectSupportMask({ sequence, frame: firstFrame, referencePoint: sequence.tap })
    : null;
  const createAttempt = await settle(service.createAnchor(
    firstFrame.imageData,
    sequence.tap,
    {
      x1: sequence.boundingBox.x1,
      y1: sequence.boundingBox.y1,
      x2: sequence.boundingBox.x2,
      y2: sequence.boundingBox.y2,
      class: sequence.targetClass,
      objectSupportMask,
    }
  ));

  if (!createAttempt.ok) {
    service.dispose();
    return {
      sequenceKind: sequence.kind,
      anchorCreated: false,
      createFailure: createAttempt.error.message,
      frames: [],
    };
  }

  const frames = [];
  for (let index = 1; index < sequence.frames.length; index++) {
    replayTime += 1000 / 30;
    const frame = sequence.frames[index];
    const depthFrame = depthFrameForFrame?.({ frame, index, sequence, timestamp: replayTime }) || null;
    const frameStart = performance.now();
    const result = service.updateAnchor(frame.imageData, depthFrame
      ? {
          depthFrame,
          depthState: { state: 'ready', provider: depthFrame.provider },
        }
      : {
          depthFrame: null,
          depthState: { state: 'idle' },
        });
    const updateWallTimeMs = performance.now() - frameStart;
    let state = service.getState();
    if (useObjectSupportMask &&
        shouldRefreshSyntheticObjectSupport({
          enabled: refreshObjectSupportMask,
          frame,
          index,
          metrics: state.metrics,
          interval: objectSupportRefreshInterval,
          targetClass: sequence.targetClass,
          trackingMode,
        })) {
      service.updateObjectSupportMask(createSyntheticObjectSupportMask({
        sequence,
        frame,
        referencePoint: result.position || state.position || sequence.tap,
        updatedAtFrame: index,
      }), {
        reason: syntheticObjectSupportRefreshReason(state.metrics, sequence.targetClass, trackingMode),
      });
      state = service.getState();
    }
    const transform = result.planarTransform || state.planarTransform || {};
    const predicted = state.position || result.position || null;
    const normal = state.normal || result.normal || null;
    const groundTruth = frame.groundTruth;

    frames.push({
      index,
      success: result.success,
      positionSource: result.method || null,
      method: result.method || null,
      poseSource: result.poseSource || state.metrics.poseSource || null,
      failureReason: result.reason || state.metrics.lastFailureReason || null,
      predicted,
      normal,
      planarTransform: transform,
      groundTruth,
      runtime: {
        updateWallTimeMs,
        stageTimings: state.metrics.updateTimings || null,
      },
      metrics: state.metrics,
      anchorError: predicted
        ? Math.hypot(predicted.x - groundTruth.anchor.x, predicted.y - groundTruth.anchor.y)
        : Infinity,
      scaleError: typeof transform.scale === 'number'
        ? Math.abs(transform.scale - groundTruth.scale)
        : Infinity,
      rollError: typeof transform.rotation === 'number'
        ? Math.abs(normalizeAngle(transform.rotation - groundTruth.roll))
        : Infinity,
      normalError: normalAngularError(normal, groundTruth.normal),
    });
  }

  service.dispose();

  return {
    sequenceKind: sequence.kind,
    anchorCreated: true,
    createResult: createAttempt.value,
    frames,
  };
};

export const summarizeReplay = replay => {
  const frames = replay.frames;
  const successful = frames.filter(frame => frame.success);
  const failures = frames.filter(frame => !frame.success);
  const jumps = [];
  const poseSourceCounts = successful.reduce((counts, frame) => {
    const source = frame.poseSource || frame.method || 'none';
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
  const positionSourceCounts = successful.reduce((counts, frame) => {
    const source = frame.positionSource || frame.method || 'none';
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});

  for (let index = 1; index < successful.length; index++) {
    const previous = successful[index - 1].predicted;
    const current = successful[index].predicted;
    jumps.push(Math.hypot(current.x - previous.x, current.y - previous.y));
  }

  return {
    frameCount: frames.length,
    successfulFrames: successful.length,
    failedFrames: failures.length,
    failureReasons: [...new Set(failures.map(frame => frame.failureReason).filter(Boolean))],
    maxAnchorError: Math.max(...successful.map(frame => frame.anchorError), 0),
    meanAnchorError: successful.reduce((sum, frame) => sum + frame.anchorError, 0) / Math.max(1, successful.length),
    maxScaleError: Math.max(...successful.map(frame => frame.scaleError), 0),
    maxRollError: Math.max(...successful.map(frame => frame.rollError), 0),
    maxNormalError: Math.max(...successful.map(frame => frame.normalError), 0),
    meanNormalError: successful.reduce((sum, frame) => sum + frame.normalError, 0) / Math.max(1, successful.length),
    maxFrameJump: Math.max(...jumps, 0),
    minPoseInliers: Math.min(...successful.map(frame => frame.metrics.poseInliers || 0), Infinity),
    planarPoseUsage: successful.filter(frame => frame.poseSource === 'planar-homography').length / Math.max(1, successful.length),
    planarPositionUsage: successful.filter(frame => frame.positionSource === 'planar-homography').length / Math.max(1, successful.length),
    sparsePoseUsage: successful.filter(frame => frame.poseSource === 'sparse-reconstruction').length / Math.max(1, successful.length),
    sparsePositionUsage: successful.filter(frame => frame.positionSource === 'sparse-reconstruction').length / Math.max(1, successful.length),
    poseSourceCounts,
    positionSourceCounts,
  };
};
