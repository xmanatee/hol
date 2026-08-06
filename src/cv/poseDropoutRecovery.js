import { shouldDeferSparseMugPoseDropoutRecovery } from './curvedObjectRecovery.js';

const MAX_POSE_DROPOUT_INLIERS = 12;
const BASE_POSE_DROPOUT_INLIERS = 8;
const INDEPENDENT_POSITION_ROLES = new Set(['reconstruction', 'planar', 'object']);
export const WEAKLY_OBSERVED_NORMAL_INNOVATION_REASON = 'weak-normal-innovation';

export const hasIndependentPositionMeasurement = (metrics) =>
  INDEPENDENT_POSITION_ROLES.has(metrics.posePositionRole);

const hasCurrentNormalQuarantine = (metrics, trackingMode) =>
  metrics.poseObs != null &&
  metrics.normalPoseRejectedCandidates?.[trackingMode] === WEAKLY_OBSERVED_NORMAL_INNOVATION_REASON;

export const hasPosePositionDropout = (metrics, { targetClass, trackingMode }) => {
  if (
    metrics.poseSource != null ||
    hasIndependentPositionMeasurement(metrics) ||
    hasCurrentNormalQuarantine(metrics, trackingMode) ||
    shouldDeferSparseMugPoseDropoutRecovery(metrics, targetClass, trackingMode)
  ) {
    return false;
  }

  const active = metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0;
  const trackingRate = metrics.trackingSuccessRate ?? 0;
  const poseInliers = metrics.poseInliers ?? 0;
  const dropoutInlierLimit =
    trackingMode === 'depth-fusion' && !/mug/i.test(targetClass || '')
      ? MAX_POSE_DROPOUT_INLIERS
      : BASE_POSE_DROPOUT_INLIERS;

  return active >= 8 && trackingRate >= 0.55 && poseInliers < dropoutInlierLimit;
};
