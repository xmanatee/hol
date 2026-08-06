import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';

const PROGRESSIVE_ANCHOR_STATES = new Set(['candidate', 'mapping']);

export const shouldRenderAnchorOverlay = ({ activeAnchor, anchorState }) => {
  if (!activeAnchor) {
    return false;
  }

  const metrics = anchorState?.metrics || activeAnchor.diagnostics || {};
  const readiness =
    metrics.readiness || activeAnchor.readiness || activeAnchor.diagnostics?.readiness || null;
  const state = anchorState?.state || activeAnchor.state || null;

  if (metrics.targetPresent === false) {
    return false;
  }

  if (readiness?.attachmentReady === false) {
    return false;
  }

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

  const selectedReconstructionPose = metrics.reconstructionReady && metrics.poseSource === poseModel;
  return (
    readiness?.faceReady === true || selectedReconstructionPose || metrics.poseSource === 'planar-homography'
  );
};

export const getRenderableAnchorOverlay = ({ activeAnchor, anchorState }) =>
  shouldRenderAnchorOverlay({ activeAnchor, anchorState }) ? activeAnchor : null;

export const shouldMountOverlayScene = ({ cameraState, activeAnchor }) =>
  cameraState === 'active' && activeAnchor?.overlaySceneReady === true;
