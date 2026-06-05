import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';

const OBJECT_POSE_MODEL = 'object-pose';

export const shouldAutoStartObjectVoice = ({ trackingMode, reconstructionReady, hasUserGesture }) => {
  if (!hasUserGesture) {
    return false;
  }

  if (trackingMode === OBJECT_POSE_MODEL) {
    return true;
  }

  if (isReconstructionMode(trackingMode)) {
    return reconstructionReady;
  }

  throw new Error(`Unsupported object voice tracking mode: ${trackingMode}`);
};
