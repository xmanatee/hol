import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';
import { shouldRenderAnchorOverlay } from './overlayVisibility.js';

const MAPPING_STATUS = {
  status: 'mapping',
  severity: 'warn',
  message: 'Building 3D object map',
  recommendation: 'Slowly turn and tilt the object while keeping the selected surface visible.',
};

export const describeAnchorStatus = ({ cameraState, anchorSystemState }) => {
  if (cameraState !== 'active') {
    return {
      status: 'camera',
      severity: 'idle',
      message: 'Camera is not active',
      recommendation: 'Start the camera to find an object.',
    };
  }

  if (anchorSystemState.error) {
    return {
      status: 'error',
      severity: 'bad',
      message: 'Object discovery unavailable',
      recommendation: anchorSystemState.requiresReload
        ? 'Tracking code could not be loaded. Reload the app to retry; this stops the camera.'
        : 'Check your connection, then retry vision or stop and restart the camera.',
      recoveryAction: anchorSystemState.requiresReload ? 'reload' : 'retry',
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
      message: candidate?.reason || anchorSystemState.discoveryReason || 'Point the camera at an object',
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

  if (serviceState?.state === 'lost' || metrics.targetPresent === false) {
    return {
      status: 'recovering',
      severity: 'warn',
      message: 'Looking for your object',
      recommendation: 'Bring the original object back into view, or choose another object.',
    };
  }

  if (metrics.objectSupportConflict) {
    return {
      status: 'recovering',
      severity: 'warn',
      message: 'Checking the object outline',
      recommendation:
        'Hold the original object steady. Its face is hidden while the outline and tracking disagree.',
    };
  }

  if (shouldRenderAnchorOverlay(anchorSystemState)) {
    return {
      status: metrics.surfaceAttachment ? 'attached' : 'tracking',
      severity: 'good',
      message: 'Face is tracking the object',
      recommendation: 'Keep the selected surface visible.',
    };
  }

  if (serviceState?.state === 'candidate') {
    return {
      status: 'candidate',
      severity: 'warn',
      message: 'Object selected; building initial support',
      recommendation: 'Hold the object in view while support landmarks are collected.',
    };
  }

  if (
    serviceState?.state === 'mapping' ||
    (reconstructionMode &&
      !metrics.reconstructionReady &&
      ['stable', 'tracking', 'degraded'].includes(serviceState?.state))
  ) {
    return MAPPING_STATUS;
  }

  if (serviceState?.state === 'stable' || serviceState?.state === 'tracking') {
    return {
      status: 'recovering',
      severity: 'warn',
      message: 'Preparing surface attachment',
      recommendation: 'Keep the selected surface visible while pose support is rebuilt.',
    };
  }

  if (serviceState?.state === 'degraded') {
    return {
      status: 'weak',
      severity: 'warn',
      message: 'Tracking is uncertain',
      recommendation: 'Keep the selected surface visible and move slowly.',
    };
  }

  return {
    status: 'unknown',
    severity: 'warn',
    message: 'Object tracking is unavailable',
    recommendation: 'Choose another object to restart selection.',
  };
};
