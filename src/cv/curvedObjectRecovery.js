export const CURVED_OBJECT_RECOVERY_REASON = 'curved-object-recovery';

const MIN_CURVED_OBJECT_RECOVERY_MAP_CONFIDENCE = 0.55;
const MIN_CURVED_OBJECT_RECOVERY_MATURE_LANDMARKS = 16;
const MIN_SPARSE_MUG_DEFERRED_RECOVERY_MAP_CONFIDENCE = 0.75;
const MAX_SPARSE_MUG_DEFERRED_RECOVERY_TRACKER_DELTA = 4;

const hasMatureCurvedMap = (metrics) =>
  metrics.reconstructionReady === true &&
  (metrics.reconstructionMapConfidence ?? 0) >= MIN_CURVED_OBJECT_RECOVERY_MAP_CONFIDENCE &&
  (metrics.reconstructionMatureLandmarks ?? 0) >= MIN_CURVED_OBJECT_RECOVERY_MATURE_LANDMARKS;

const hasHandledMugTarget = (targetClass) => /mug/i.test(targetClass || '');

export const needsCurvedObjectRecovery = (metrics, targetClass = metrics.targetClass) => {
  if (!hasHandledMugTarget(targetClass)) {
    return false;
  }

  if (!hasMatureCurvedMap(metrics)) {
    return false;
  }

  return metrics.positionFilterAdjustment === 'curved-motion-hold';
};

export const shouldDeferSparseMugPoseDropoutRecovery = (
  metrics,
  targetClass = metrics.targetClass,
  trackingMode = metrics.trackingMode,
) =>
  trackingMode === 'sparse-reconstruction' &&
  hasHandledMugTarget(targetClass) &&
  hasMatureCurvedMap(metrics) &&
  (metrics.reconstructionMapConfidence ?? 0) >= MIN_SPARSE_MUG_DEFERRED_RECOVERY_MAP_CONFIDENCE &&
  (metrics.reconstructionTrackerDelta ?? Infinity) <= MAX_SPARSE_MUG_DEFERRED_RECOVERY_TRACKER_DELTA;
