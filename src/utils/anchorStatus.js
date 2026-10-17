import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';
import { shouldRenderAnchorOverlay } from './overlayVisibility.js';

const POSE_RECOVERY_REASON = 'Recovering object pose before showing the face';

export const describeAnchorStatus = ({ cameraState, anchorSystemState }) => {
  if (cameraState !== 'active') {
    return {
      status: 'camera',
      severity: 'idle',
      message: 'Camera is not active',
      recommendation: 'Start the camera before checking anchors.',
    };
  }

  if (anchorSystemState.error) {
    return {
      status: 'error',
      severity: 'bad',
      message: 'Object discovery unavailable',
      recommendation: 'Check your connection, then retry vision or stop and restart the camera.',
    };
  }

  if (anchorSystemState.initialized === false) {
    return {
      status: 'initializing',
      severity: 'idle',
      message: 'Loading on-device vision',
      recommendation: 'First use downloads the tracking engine and object model. Keep this tab open.',
    };
  }

  if (anchorSystemState.mode === 'selection') {
    const candidate = anchorSystemState.candidate;
    return {
      status: candidate?.status || 'searching',
      severity: candidate?.status === 'ready' ? 'good' : 'idle',
      message: candidate?.reason || 'Point the camera at an object',
      recommendation:
        candidate?.status === 'ready'
          ? 'Keep the object visible as you tap.'
          : 'Keep one object near the center until its outline turns green.',
    };
  }

  const serviceState = anchorSystemState.anchorState;
  const metrics = serviceState?.metrics || {};
  const reconstructionMode = isReconstructionMode(metrics.poseModel);

  if (anchorSystemState.observationExpired) {
    return {
      status: 'stale',
      severity: 'warn',
      message: 'Waiting for fresh tracking',
      recommendation: 'The face is hidden until tracking catches up. Keep the selected object visible.',
    };
  }

  if (shouldRenderAnchorOverlay(anchorSystemState)) {
    return {
      status: metrics.surfaceAttachment ? 'attached' : 'tracking',
      severity: 'good',
      message: metrics.surfaceAttachment
        ? 'Face attached to the tracked plane'
        : 'Face is tracking the object',
      recommendation: 'Keep the selected surface visible.',
    };
  }

  if (reconstructionMode && metrics.readiness?.reason === POSE_RECOVERY_REASON) {
    return {
      status: 'recovering',
      severity: 'warn',
      message: 'Recovering object pose',
      recommendation:
        metrics.poseRejectedReason ||
        metrics.reconstructionPoseRejectedReason ||
        'Keep the object visible and move slower until pose support is rebuilt.',
    };
  }

  if (serviceState?.state === 'stable' || serviceState?.state === 'tracking') {
    if (reconstructionMode && !metrics.reconstructionReady) {
      return {
        status: 'mapping',
        severity: 'warn',
        message: 'Building 3D object map',
        recommendation: 'Slowly turn and tilt the object while keeping the clicked area visible.',
      };
    }

    return {
      status: 'recovering',
      severity: 'warn',
      message: 'Preparing surface attachment',
      recommendation:
        metrics.readiness?.reason || 'Keep the selected surface visible while pose support is rebuilt.',
    };
  }

  if (serviceState?.state === 'candidate') {
    return {
      status: 'candidate',
      severity: 'warn',
      message: 'Object selected; building initial support',
      recommendation:
        metrics.readiness?.reason || 'Hold the object in view while support landmarks are collected.',
    };
  }

  if (serviceState?.state === 'mapping') {
    return {
      status: 'mapping',
      severity: 'warn',
      message: 'Building 3D object map',
      recommendation:
        metrics.readiness?.reason || 'Slowly turn and tilt the object while keeping it visible.',
    };
  }

  if (serviceState?.state === 'degraded') {
    if (reconstructionMode && !metrics.reconstructionReady) {
      return {
        status: 'mapping',
        severity: 'warn',
        message: '3D map needs more stable observations',
        recommendation:
          metrics.reconstructionFailureReason ||
          'Move slower and keep a textured part of the object in view.',
      };
    }

    return {
      status: 'weak',
      severity: 'warn',
      message: 'Weak lock; template recovery is active',
      recommendation: 'Move closer to a textured label or stronger edge detail.',
    };
  }

  if (serviceState?.state === 'lost') {
    return {
      status: 'recovering',
      severity: 'bad',
      message: `Anchor lost; recovery attempt ${metrics.recoveryAttempts ?? 0}`,
      recommendation: 'Bring the original object back into view or use Clear anchor to select another.',
    };
  }

  return {
    status: 'unknown',
    severity: 'warn',
    message: 'Anchor state is unavailable',
    recommendation: 'Return to selection mode and create a new anchor.',
  };
};
