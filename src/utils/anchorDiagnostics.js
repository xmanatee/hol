const collectAnchorDetails = (anchorState) => {
  const metrics = anchorState?.metrics || {};

  return {
    keypointCount: metrics.keypointCount ?? 0,
    templateKeypoints: metrics.templateKeypoints ?? metrics.keypointCount ?? 0,
    templateQuality: metrics.templateQuality ?? null,
    trackingSuccessRate: metrics.trackingSuccessRate ?? null,
    homographyInliers: metrics.homographyInliers ?? 0,
    recoveryAttempts: metrics.recoveryAttempts ?? 0,
    lostFrameCount: metrics.lostFrameCount ?? 0,
    lastFailureReason: metrics.lastFailureReason || null,
    lastFailureStage: metrics.lastFailureStage || null,
    lastUpdateMethod: metrics.lastUpdateMethod || null,
    processingTime: metrics.processingTime ?? 0,
    templateRegion: metrics.templateRegion || null,
    qualityState: metrics.qualityState || null
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
    return {
      status: 'stable',
      severity: 'good',
      message: 'Anchor is stable',
      recommendation: 'The face should stay attached while the object remains visible.',
      details
    };
  }

  if (serviceState?.state === 'tracking') {
    return {
      status: 'tracking',
      severity: 'good',
      message: 'Anchor is tracking',
      recommendation: 'Hold the object steady if the face drifts.',
      details
    };
  }

  if (serviceState?.state === 'degraded') {
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
      message: `Anchor lost; recovery ${details.recoveryAttempts}/5`,
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
