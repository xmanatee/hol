import { isSelectedObjectObservationFresh } from './cvScheduling.js';

const TRACKED_STATES = new Set(['tracking', 'stable']);

export const isFaceObservationReady = (anchorState) => {
  const metrics = anchorState?.metrics;
  const readiness = metrics?.readiness;
  const position = anchorState?.position;
  const normal = anchorState?.normal;

  return (
    anchorState?.anchored === true &&
    TRACKED_STATES.has(anchorState.state) &&
    Number.isFinite(position?.x) &&
    Number.isFinite(position?.y) &&
    Number.isFinite(normal?.x) &&
    Number.isFinite(normal?.y) &&
    Number.isFinite(normal?.z) &&
    Math.hypot(normal.x, normal.y, normal.z) > 0 &&
    metrics?.targetPresent === true &&
    typeof metrics.poseSource === 'string' &&
    metrics.poseSource.length > 0 &&
    readiness?.poseReady === true &&
    readiness?.attachmentReady === true &&
    readiness?.faceReady === true
  );
};

export const shouldRenderAnchorOverlay = ({ activeAnchor, anchorState, observationExpired }) =>
  observationExpired !== true && activeAnchor != null && isFaceObservationReady(anchorState);

export const getRenderableAnchorOverlay = (state, now) =>
  isSelectedObjectObservationFresh(state, now) && shouldRenderAnchorOverlay(state)
    ? state.activeAnchor
    : null;

export const shouldMountOverlayScene = ({ cameraState, activeAnchor }) =>
  cameraState === 'active' && activeAnchor?.overlaySceneReady === true;
