import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';

const PROGRESSIVE_ANCHOR_STATES = new Set(['candidate', 'mapping']);

export const shouldRenderAnchorOverlay = ({ activeAnchor, anchorState }) => {
  if (!activeAnchor) {
    return false;
  }

  const metrics = anchorState?.metrics || activeAnchor.diagnostics || {};
  const readiness = metrics.readiness || activeAnchor.readiness || activeAnchor.diagnostics?.readiness || null;
  const state = anchorState?.state || activeAnchor.state || null;

  if (readiness?.faceReady === false) {
    return false;
  }

  if (PROGRESSIVE_ANCHOR_STATES.has(state)) {
    return readiness?.faceReady === true;
  }

  const poseModel = metrics.poseModel || activeAnchor.trackingMode || null;
  if (!poseModel) {
    return false;
  }

  if (!isReconstructionMode(poseModel)) {
    return true;
  }

  return readiness?.faceReady === true || metrics.reconstructionReady || metrics.poseSource === 'planar-homography';
};
