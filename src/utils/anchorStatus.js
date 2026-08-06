import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';

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

  if (anchorSystemState.initialized === false) {
    return {
      status: 'initializing',
      severity: 'warn',
      message: 'CV services are initializing',
      recommendation: 'Wait for selection and anchoring services to finish loading.',
    };
  }

  if (anchorSystemState.mode === 'selection') {
    return {
      status: 'ready',
      severity: 'idle',
      message: 'Tap an object to create an anchor',
      recommendation: 'Tap a sharp, textured area on the object surface.',
    };
  }

  const serviceState = anchorSystemState.anchorState;
  const metrics = serviceState?.metrics || {};
  const reconstructionMode = isReconstructionMode(metrics.poseModel);

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

  if (serviceState?.state === 'stable') {
    if (reconstructionMode && !metrics.reconstructionReady) {
      return {
        status: 'mapping',
        severity: 'warn',
        message: 'Building 3D object map',
        recommendation: 'Slowly turn and tilt the object while keeping the clicked area visible.',
      };
    }

    return {
      status: 'stable',
      severity: 'good',
      message: 'Anchor is stable',
      recommendation: 'The face should stay attached while the object remains visible.',
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

  if (serviceState?.state === 'tracking') {
    if (reconstructionMode && !metrics.reconstructionReady) {
      return {
        status: 'mapping',
        severity: 'warn',
        message: 'Building 3D object map',
        recommendation:
          'Move the object through a small left/right and up/down turn before expecting the face.',
      };
    }

    return {
      status: 'tracking',
      severity: 'good',
      message: 'Anchor is tracking',
      recommendation: 'Hold the object steady if the face drifts.',
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
      recommendation: 'Bring the original object back into view or tap to reset.',
    };
  }

  return {
    status: 'unknown',
    severity: 'warn',
    message: 'Anchor state is unavailable',
    recommendation: 'Return to selection mode and create a new anchor.',
  };
};
