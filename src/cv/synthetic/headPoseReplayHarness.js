import { computeAnchorOverlayTransform } from '../../utils/anchorProjection.js';
import { shouldRenderAnchorOverlay } from '../../utils/overlayVisibility.js';

const normalizeAngle = value => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

const finiteValues = values => values.filter(Number.isFinite);

const maxValue = values => Math.max(...finiteValues(values), 0);

const meanValue = values => {
  const finite = finiteValues(values);
  return finite.reduce((sum, value) => sum + value, 0) / Math.max(1, finite.length);
};

const activeAnchorForSequence = sequence => ({
  position: sequence.tap,
  sourceDetection: sequence.boundingBox,
});

const overlayStateFromFrame = frame => ({
  anchored: true,
  state: frame.success ? 'tracking' : 'lost',
  position: frame.predicted,
  normal: frame.normal,
  planarTransform: frame.planarTransform,
  metrics: frame.metrics || {},
});

const overlayStateFromGroundTruth = frame => ({
  anchored: true,
  state: 'tracking',
  position: frame.groundTruth.anchor,
  normal: frame.groundTruth.normal,
  planarTransform: {
    scale: frame.groundTruth.scale,
    rotation: frame.groundTruth.roll,
  },
  metrics: frame.metrics || {},
});

const transformForState = ({ sequence, anchorState, renderWidth, renderHeight }) => computeAnchorOverlayTransform({
  width: sequence.width,
  height: sequence.height,
  renderWidth,
  renderHeight,
  activeAnchor: activeAnchorForSequence(sequence),
  anchorState,
});

const vectorDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const rotationDelta = (predicted, expected) => [
  normalizeAngle(predicted[0] - expected[0]),
  normalizeAngle(predicted[1] - expected[1]),
  normalizeAngle(predicted[2] - expected[2]),
];

const scoreFrame = ({ frame, sequence, renderWidth, renderHeight, previous }) => {
  const activeAnchor = activeAnchorForSequence(sequence);
  const anchorState = overlayStateFromFrame(frame);
  const renderedByPolicy = shouldRenderAnchorOverlay({ activeAnchor, anchorState });
  const rawPredicted = transformForState({
    sequence,
    anchorState,
    renderWidth,
    renderHeight,
  });
  const predicted = renderedByPolicy
    ? rawPredicted
    : { ...rawPredicted, visible: false };
  const expected = transformForState({
    sequence,
    anchorState: overlayStateFromGroundTruth(frame),
    renderWidth,
    renderHeight,
  });
  const hiddenByPolicy = !renderedByPolicy;
  const evaluatedVisible = predicted.visible && expected.visible;
  const rotation = evaluatedVisible
    ? rotationDelta(predicted.rotation, expected.rotation)
    : hiddenByPolicy ? [0, 0, 0] : [Infinity, Infinity, Infinity];
  const worldPositionError = evaluatedVisible
    ? vectorDistance(predicted.position, expected.position)
    : hiddenByPolicy ? 0 : Infinity;
  const scaleLogError = evaluatedVisible
    ? Math.abs(Math.log(predicted.scale / expected.scale))
    : hiddenByPolicy ? 0 : Infinity;
  const rotationError = Math.hypot(...rotation);
  const headJump = predicted.visible && previous?.predicted?.visible
    ? vectorDistance(predicted.position, previous.predicted.position)
    : 0;
  const expectedHeadJump = expected.visible && previous?.expected?.visible
    ? vectorDistance(expected.position, previous.expected.position)
    : 0;

  return {
    index: frame.index,
    success: frame.success,
    positionSource: frame.positionSource || frame.method || null,
    poseSource: frame.poseSource || null,
    predicted,
    expected,
    worldPositionError,
    scaleLogError,
    rotationError,
    pitchError: Math.abs(rotation[0]),
    yawError: Math.abs(rotation[1]),
    rollError: Math.abs(rotation[2]),
    headJump,
    expectedHeadJump,
    headJumpExcess: Math.max(0, headJump - expectedHeadJump),
    hiddenByPolicy,
    visibleMismatch: renderedByPolicy && predicted.visible !== expected.visible,
  };
};

const worstFrames = frames => [...frames]
  .sort((a, b) => {
    const aScore = a.worldPositionError + a.scaleLogError + a.rotationError + a.headJumpExcess;
    const bScore = b.worldPositionError + b.scaleLogError + b.rotationError + b.headJumpExcess;
    return bScore - aScore;
  })
  .slice(0, 6)
  .map(frame => ({
    index: frame.index,
    positionSource: frame.positionSource,
    poseSource: frame.poseSource,
    worldPositionError: frame.worldPositionError,
    scaleLogError: frame.scaleLogError,
    rotationError: frame.rotationError,
    headJumpExcess: frame.headJumpExcess,
  }));

export const scoreHeadPoseReplay = ({
  replay,
  sequence,
  renderWidth = sequence.width,
  renderHeight = sequence.height,
}) => {
  const frames = [];
  for (const frame of replay.frames) {
    frames.push(scoreFrame({
      frame,
      sequence,
      renderWidth,
      renderHeight,
      previous: frames[frames.length - 1],
    }));
  }

  return {
    sequenceKind: sequence.kind,
    frameCount: frames.length,
    frames,
    summary: {
      frameCount: frames.length,
      visibleMismatches: frames.filter(frame => frame.visibleMismatch).length,
      maxWorldPositionError: maxValue(frames.map(frame => frame.worldPositionError)),
      meanWorldPositionError: meanValue(frames.map(frame => frame.worldPositionError)),
      maxScaleLogError: maxValue(frames.map(frame => frame.scaleLogError)),
      meanScaleLogError: meanValue(frames.map(frame => frame.scaleLogError)),
      maxRotationError: maxValue(frames.map(frame => frame.rotationError)),
      meanRotationError: meanValue(frames.map(frame => frame.rotationError)),
      maxPitchError: maxValue(frames.map(frame => frame.pitchError)),
      maxYawError: maxValue(frames.map(frame => frame.yawError)),
      maxRollError: maxValue(frames.map(frame => frame.rollError)),
      maxHeadJump: maxValue(frames.map(frame => frame.headJump)),
      maxExpectedHeadJump: maxValue(frames.map(frame => frame.expectedHeadJump)),
      maxHeadJumpExcess: maxValue(frames.map(frame => frame.headJumpExcess)),
      meanHeadJumpExcess: meanValue(frames.map(frame => frame.headJumpExcess)),
      hiddenByPolicyFrames: frames.filter(frame => frame.hiddenByPolicy).length,
      worstFrames: worstFrames(frames),
    },
  };
};
