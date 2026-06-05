import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';

export const shouldRenderAnchorOverlay = ({ activeAnchor, anchorState }) => {
  if (!activeAnchor) {
    return false;
  }

  const metrics = anchorState?.metrics;
  if (!isReconstructionMode(metrics?.poseModel)) {
    return true;
  }

  return metrics.reconstructionReady || metrics.poseSource === 'planar-homography';
};
