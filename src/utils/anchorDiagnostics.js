import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';

const collectAnchorDetails = (anchorState) => {
  const metrics = anchorState?.metrics || {};

  return {
    keypointCount: metrics.keypointCount ?? 0,
    landmarkCount: metrics.landmarkCount ?? metrics.keypointCount ?? 0,
    activeLandmarkCount: metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0,
    inactiveLandmarkCount: metrics.inactiveLandmarkCount ?? 0,
    landmarkRefreshAdded: metrics.landmarkRefreshAdded ?? 0,
    templateKeypoints: metrics.templateKeypoints ?? metrics.keypointCount ?? 0,
    templateQuality: metrics.templateQuality ?? null,
    trackingSuccessRate: metrics.trackingSuccessRate ?? null,
    homographyInliers: metrics.homographyInliers ?? 0,
    affinePoseInliers: metrics.affinePoseInliers ?? 0,
    objectPoseInliers: metrics.objectPoseInliers ?? 0,
    reconstructionPoseInliers: metrics.reconstructionPoseInliers ?? 0,
    poseInliers: metrics.poseInliers ?? 0,
    poseModel: metrics.poseModel || null,
    poseSource: metrics.poseSource || null,
    targetClass: metrics.targetClass || null,
    surfaceModel: metrics.reconstructionPreview?.surface?.model || null,
    poseAverageResidual: metrics.poseAverageResidual ?? null,
    poseForeshortening: metrics.poseForeshortening ?? null,
    reconstructionState: metrics.reconstructionState || null,
    reconstructionReady: metrics.reconstructionReady ?? false,
    reconstructionFrames: metrics.reconstructionFrames ?? 0,
    reconstructionLandmarks: metrics.reconstructionLandmarks ?? 0,
    reconstructionDepthQuality: metrics.reconstructionDepthQuality ?? 0,
    reconstructionMapConfidence: metrics.reconstructionMapConfidence ?? 0,
    reconstructionAverageSupport: metrics.reconstructionAverageSupport ?? 0,
    reconstructionAverageReliability: metrics.reconstructionAverageReliability ?? 0,
    reconstructionGeometricConsistency: metrics.reconstructionGeometricConsistency ?? 0,
    reconstructionMatureLandmarks: metrics.reconstructionMatureLandmarks ?? 0,
    reconstructionPreview: metrics.reconstructionPreview || null,
    reconstructionFailureReason: metrics.reconstructionFailureReason || null,
    recoveryAttempts: metrics.recoveryAttempts ?? 0,
    lostFrameCount: metrics.lostFrameCount ?? 0,
    lastFailureReason: metrics.lastFailureReason || null,
    lastFailureStage: metrics.lastFailureStage || null,
    lastUpdateMethod: metrics.lastUpdateMethod || null,
    processingTime: metrics.processingTime ?? 0,
    templateRegion: metrics.templateRegion || null,
    qualityState: metrics.qualityState || null,
    position: anchorState?.position || null,
    normal: anchorState?.normal || null,
    planarTransform: anchorState?.planarTransform || null
  };
};

export const describeAnchorState = ({
  cameraState,
  anchorSystemState
}) => {
  const mode = anchorSystemState?.mode || 'detection';
  const detections = anchorSystemState?.detections || [];
  const serviceState = anchorSystemState?.anchorState;
  const details = collectAnchorDetails(serviceState);

  if (cameraState !== 'active') {
    return {
      status: 'camera',
      severity: 'idle',
      message: 'Camera is not active',
      recommendation: 'Start the camera before checking anchors.',
      details
    };
  }

  if (anchorSystemState?.initialized === false) {
    return {
      status: 'initializing',
      severity: 'warn',
      message: 'CV services are initializing',
      recommendation: 'Wait for detection and anchoring services to finish loading.',
      details
    };
  }

  if (mode === 'detection') {
    if (detections.length > 0) {
      return {
        status: 'ready',
        severity: 'good',
        message: 'Tap a detected object to create an anchor',
        recommendation: 'Choose an object with visible texture, edges, or label text.',
        details
      };
    }

    return {
      status: 'scanning',
      severity: 'idle',
      message: 'Scanning for selectable objects',
      recommendation: 'Keep the bottle or can fully visible and well lit.',
      details
    };
  }

  if (serviceState?.state === 'stable') {
    if (isReconstructionMode(details.poseModel) && !details.reconstructionReady) {
      return {
        status: 'mapping',
        severity: 'warn',
        message: 'Building 3D object map',
        recommendation: 'Slowly turn and tilt the object while keeping the clicked area visible.',
        details
      };
    }

    return {
      status: 'stable',
      severity: 'good',
      message: 'Anchor is stable',
      recommendation: 'The face should stay attached while the object remains visible.',
      details
    };
  }

  if (serviceState?.state === 'tracking') {
    if (isReconstructionMode(details.poseModel) && !details.reconstructionReady) {
      return {
        status: 'mapping',
        severity: 'warn',
        message: 'Building 3D object map',
        recommendation: 'Move the object through a small left/right and up/down turn before expecting the face.',
        details
      };
    }

    return {
      status: 'tracking',
      severity: 'good',
      message: 'Anchor is tracking',
      recommendation: 'Hold the object steady if the face drifts.',
      details
    };
  }

  if (serviceState?.state === 'degraded') {
    if (isReconstructionMode(details.poseModel) && !details.reconstructionReady) {
      return {
        status: 'mapping',
        severity: 'warn',
        message: '3D map needs more stable observations',
        recommendation: details.reconstructionFailureReason || 'Move slower and keep a textured part of the object in view.',
        details
      };
    }

    return {
      status: 'weak',
      severity: 'warn',
      message: 'Weak lock; template recovery is active',
      recommendation: 'Move closer to a textured label or stronger edge detail.',
      details
    };
  }

  if (serviceState?.state === 'lost') {
    return {
      status: 'recovering',
      severity: 'bad',
      message: `Anchor lost; recovery attempt ${details.recoveryAttempts}`,
      recommendation: 'Bring the original object back into view or tap to reset.',
      details
    };
  }

  return {
    status: 'unknown',
    severity: 'warn',
    message: 'Anchor state is unavailable',
    recommendation: 'Return to detection mode and create a new anchor.',
    details
  };
};
