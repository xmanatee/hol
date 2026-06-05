import { RECONSTRUCTION_POSE_MODEL } from '../cv/anchor.reconstruction.js';

export const shouldRenderAnchorOverlay = ({ activeAnchor, anchorState }) => {
  if (!activeAnchor) {
    return false;
  }

  const metrics = anchorState?.metrics;
  if (metrics?.poseModel !== RECONSTRUCTION_POSE_MODEL) {
    return true;
  }

  return metrics.reconstructionReady || metrics.poseSource === 'planar-homography';
};
