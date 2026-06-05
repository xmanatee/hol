import { ImageAnchorService } from '../../services/ImageAnchorService.js';
import { HomographyEstimator } from '../anchor.homography.js';

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

const settle = promise => promise.then(
  value => ({ ok: true, value }),
  error => ({ ok: false, error })
);

export const replayImageAnchorSequence = async ({ cv, sequence, trackingMode = 'sparse-reconstruction' }) => {
  setupOpenCvGlobals(cv);

  let replayTime = 1000;
  const service = new ImageAnchorService({ now: () => replayTime });
  service.setTrackingMode(trackingMode);
  await service.initialize(cv, getCameraParams(sequence));

  const firstFrame = sequence.frames[0];
  const createAttempt = await settle(service.createAnchor(
    firstFrame.imageData,
    sequence.tap,
    {
      x1: sequence.boundingBox.x1,
      y1: sequence.boundingBox.y1,
      x2: sequence.boundingBox.x2,
      y2: sequence.boundingBox.y2,
      class: sequence.targetClass,
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
    const result = service.updateAnchor(frame.imageData);
    const state = service.getState();
    const transform = result.planarTransform || state.planarTransform || {};
    const predicted = result.position || state.position || null;
    const normal = result.normal || state.normal || null;
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
