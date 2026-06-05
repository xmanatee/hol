import { RECONSTRUCTION_POSE_MODEL } from '../cv/anchor.reconstruction.js';

const OBJECT_POSE_MODEL = 'object-pose';

export const shouldAutoStartObjectVoice = ({ trackingMode, reconstructionReady, hasUserGesture }) => {
  if (!hasUserGesture) {
    return false;
  }

  if (trackingMode === OBJECT_POSE_MODEL) {
    return true;
  }

  if (trackingMode === RECONSTRUCTION_POSE_MODEL) {
    return reconstructionReady;
  }

  throw new Error(`Unsupported object voice tracking mode: ${trackingMode}`);
};
