import { CURVED_OBJECT_RECOVERY_REASON } from './curvedObjectRecovery.js';

const MAX_AGE_FRAMES = 2;
const REASONS_BY_PRIORITY = [
  'segmentation-refresh',
  'periodic-segmentation-refresh',
  'tap-local-support-growth',
  'object-ownership-recovery',
  'pose-dropout-recovery',
  CURVED_OBJECT_RECOVERY_REASON,
];

const priorityOf = (reason) => {
  const index = REASONS_BY_PRIORITY.indexOf(reason);
  if (index < 0) {
    throw new TypeError(`Unknown object-support refresh reason: ${String(reason)}`);
  }
  return Math.floor(index / 2);
};

const assertFrame = (frame) => {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new TypeError('Object-support refresh frames must be non-negative safe integers');
  }
};

export const isRecoveryObjectSupportRefreshReason = (reason) =>
  reason === null ? false : priorityOf(reason) === 2;

export const isObjectSupportRefreshSignalActive = ({ reason, signalFrame, currentFrame }) => {
  if (reason === null && signalFrame === null) {
    return false;
  }
  if (reason === null || signalFrame === null) {
    throw new TypeError('Object-support refresh reason and frame must be present together');
  }
  const priority = priorityOf(reason);
  assertFrame(signalFrame);
  assertFrame(currentFrame);
  if (currentFrame < signalFrame) {
    throw new RangeError('Object-support refresh frame cannot move backwards');
  }
  return priority > 0 && currentFrame - signalFrame <= MAX_AGE_FRAMES;
};

export const mergeObjectSupportRefreshSignal = ({
  currentReason,
  currentFrame,
  incomingReason,
  incomingFrame,
}) => {
  const incomingPriority = priorityOf(incomingReason);
  assertFrame(incomingFrame);
  if (currentReason === null && currentFrame === null) {
    return { reason: incomingReason, frame: incomingFrame };
  }
  if (currentReason === null || currentFrame === null) {
    throw new TypeError('Current object-support refresh reason and frame must be present together');
  }
  const currentPriority = priorityOf(currentReason);
  assertFrame(currentFrame);
  if (incomingFrame < currentFrame) {
    throw new RangeError('Object-support refresh frame cannot move backwards');
  }
  if (
    currentPriority > 0 &&
    incomingFrame - currentFrame <= MAX_AGE_FRAMES &&
    currentPriority > incomingPriority
  ) {
    return { reason: currentReason, frame: currentFrame };
  }
  return { reason: incomingReason, frame: incomingFrame };
};
