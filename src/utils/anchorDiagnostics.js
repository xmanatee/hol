import { isReconstructionMode } from '../cv/anchor.reconstructionModes.js';

const collectAnchorDetails = (anchorState) => {
  const metrics = anchorState?.metrics || {};

  return {
    keypointCount: metrics.keypointCount ?? 0,
    landmarkCount: metrics.landmarkCount ?? metrics.keypointCount ?? 0,
    activeLandmarkCount: metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0,
    inactiveLandmarkCount: metrics.inactiveLandmarkCount ?? 0,
    objectOwnedLandmarks: metrics.objectOwnedLandmarks ?? 0,
    maskCoverage: metrics.maskCoverage ?? null,
    maskConfidence: metrics.maskConfidence ?? null,
    objectSupportMaskSource: metrics.currentObjectSupportMaskSource || metrics.objectSupportMaskSource || null,
    objectSupportMaskBounds: metrics.objectSupportMaskBounds || null,
    currentObjectSupportMaskBounds: metrics.currentObjectSupportMaskBounds || null,
    objectSupportMaskPreview: metrics.currentObjectSupportMaskPreview || metrics.objectSupportMaskPreview || null,
    objectSupportMaskConfidence: metrics.objectSupportMaskConfidence ?? null,
    keypointDensity: metrics.keypointDensity ?? null,
    backgroundRejected: metrics.backgroundRejected ?? 0,
    readiness: metrics.readiness || null,
    landmarkRefreshReason: metrics.landmarkRefreshReason || null,
    landmarkRefreshAdded: metrics.landmarkRefreshAdded ?? 0,
    landmarkRefreshTotal: metrics.landmarkRefreshTotal ?? 0,
    landmarkRefreshRejectedByMask: metrics.landmarkRefreshRejectedByMask ?? 0,
    segmentationRefreshReason: metrics.segmentationRefreshReason || null,
    segmentationRefreshFrame: metrics.segmentationRefreshFrame ?? null,
    templateKeypoints: metrics.templateKeypoints ?? metrics.keypointCount ?? 0,
    templateQuality: metrics.templateQuality ?? null,
    trackingRegion: metrics.trackingRegion || null,
    trackingSuccessRate: metrics.trackingSuccessRate ?? null,
    homographyInliers: metrics.homographyInliers ?? 0,
    affinePoseInliers: metrics.affinePoseInliers ?? 0,
    objectPoseInliers: metrics.objectPoseInliers ?? 0,
    reconstructionPoseInliers: metrics.reconstructionPoseInliers ?? 0,
    poseInliers: metrics.poseInliers ?? 0,
    poseModel: metrics.poseModel || null,
    poseSource: metrics.poseSource || null,
    poseRejectedReason: metrics.poseRejectedReason || null,
    poseSourceHoldReason: metrics.poseSourceHoldReason || null,
    targetClass: metrics.targetClass || null,
    surfaceModel: metrics.reconstructionPreview?.surface?.model || null,
    poseAverageResidual: metrics.poseAverageResidual ?? null,
    poseForeshortening: metrics.poseForeshortening ?? null,
    reconstructionState: metrics.reconstructionState || null,
    reconstructionRegion: metrics.reconstructionRegion || null,
    reconstructionReady: metrics.reconstructionReady ?? false,
    reconstructionFrames: metrics.reconstructionFrames ?? 0,
    reconstructionLandmarks: metrics.reconstructionLandmarks ?? 0,
    reconstructionDepthQuality: metrics.reconstructionDepthQuality ?? 0,
    reconstructionMapConfidence: metrics.reconstructionMapConfidence ?? 0,
    reconstructionAverageSupport: metrics.reconstructionAverageSupport ?? 0,
    reconstructionAverageReliability: metrics.reconstructionAverageReliability ?? 0,
    reconstructionGeometricConsistency: metrics.reconstructionGeometricConsistency ?? 0,
    reconstructionMatureLandmarks: metrics.reconstructionMatureLandmarks ?? 0,
    reconstructionDepthStatus: metrics.reconstructionDepthStatus || null,
    reconstructionDepthProvider: metrics.reconstructionDepthProvider || null,
    reconstructionDepthInferenceTime: metrics.reconstructionDepthInferenceTime ?? 0,
    reconstructionDepthFrameTimestamp: metrics.reconstructionDepthFrameTimestamp ?? null,
    reconstructionPreview: metrics.reconstructionPreview || null,
    reconstructionFailureReason: metrics.reconstructionFailureReason || null,
    reconstructionPoseRejectedReason: metrics.reconstructionPoseRejectedReason || null,
    surfaceCoverage: metrics.surfaceCoverage ?? null,
    surfacePrior: metrics.surfacePrior || null,
    surfaceLockedLandmarks: metrics.surfaceLockedLandmarks ?? 0,
    surfaceContourSegments: metrics.surfaceContourSegments ?? 0,
    surfaceCellCount: metrics.surfaceCellCount ?? 0,
    surfaceOccupiedCells: metrics.surfaceOccupiedCells ?? 0,
    silhouetteCoverage: metrics.silhouetteCoverage ?? null,
    contourFitResidual: metrics.contourFitResidual ?? null,
    landmarksInsideMask: metrics.landmarksInsideMask ?? 0,
    landmarksOutsideMask: metrics.landmarksOutsideMask ?? 0,
    occlusionState: metrics.occlusionState || null,
    surfaceGrowthAllowed: metrics.surfaceGrowthAllowed ?? false,
    surfaceOcclusionReason: metrics.surfaceOcclusionReason || null,
    poseCandidateSource: metrics.poseCandidateSource || null,
    poseCandidateScore: metrics.poseCandidateScore ?? null,
    poseCandidates: metrics.poseCandidates || [],
    rejectedPoseCandidates: metrics.rejectedPoseCandidates || {},
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
        message: 'Tap an object to create an anchor',
        recommendation: 'Use a detected outline when available, or tap the object surface directly.',
        details
      };
    }

    return {
      status: 'scanning',
      severity: 'idle',
      message: 'Scanning for selectable objects',
      recommendation: 'Point at the object, then tap its visible surface if no outline appears.',
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

  if (serviceState?.state === 'candidate') {
    return {
      status: 'candidate',
      severity: 'warn',
      message: 'Object selected; building initial support',
      recommendation: details.readiness?.reason || 'Hold the object in view while support landmarks are collected.',
      details
    };
  }

  if (serviceState?.state === 'mapping') {
    return {
      status: 'mapping',
      severity: 'warn',
      message: 'Building 3D object map',
      recommendation: details.readiness?.reason || 'Slowly turn and tilt the object while keeping it visible.',
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
