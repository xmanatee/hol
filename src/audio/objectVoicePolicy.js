import { isReconstructionMode, OBJECT_POSE_MODEL } from '../cv/anchor.reconstructionModes.js';

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
