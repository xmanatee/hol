export const collectAnchorMetrics = (state) => {
  const activeAnchor = state.activeAnchor;
  const anchorState = state.anchorState;
  const metrics = anchorState?.metrics;
  const collected = {
    'System mode': state.mode,
    'Object Count': activeAnchor ? 1 : 0,
    'Stable Anchors': anchorState?.state === 'stable' ? 1 : 0,
    'Anchor persistence': activeAnchor && ['stable', 'tracking'].includes(anchorState?.state) ? 100 : 0,
  };

  if (!anchorState) {
    return collected;
  }

  collected['Anchor state'] = anchorState.state;
  collected['Stability score'] = anchorState.confidence ?? 0;

  if (anchorState.normal) {
    collected['Surface normal'] =
      `[${anchorState.normal.x.toFixed(2)}, ${anchorState.normal.y.toFixed(2)}, ${anchorState.normal.z.toFixed(2)}]`;
  }

  if (anchorState.planarTransform) {
    collected['Planar scale'] = anchorState.planarTransform.scale;
    collected['Planar roll'] = (anchorState.planarTransform.rotation * 180) / Math.PI;
  }

  if (!metrics) {
    return collected;
  }

  Object.assign(collected, {
    'Keypoint count': metrics.keypointCount ?? 0,
    'Landmark count': metrics.landmarkCount ?? metrics.keypointCount ?? 0,
    'Active landmarks': metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0,
    'Object-owned landmarks': metrics.objectOwnedLandmarks ?? 0,
    'Mask coverage': metrics.maskCoverage ?? 0,
    'Background rejected': metrics.backgroundRejected ?? 0,
    'Landmark refresh added': metrics.landmarkRefreshAdded ?? 0,
    'Tracking success rate': (metrics.trackingSuccessRate ?? 0) * 100,
    'Homography inliers': metrics.homographyInliers ?? 0,
    'Affine pose inliers': metrics.affinePoseInliers ?? 0,
    'Object pose inliers': metrics.objectPoseInliers ?? 0,
    'Reconstruction inliers': metrics.reconstructionPoseInliers ?? 0,
    'Pose patch points': metrics.poseKeypointCount ?? 0,
    'Pose confidence': metrics.poseConfidence ?? 0,
    'Pose inliers': metrics.poseInliers ?? 0,
    'Pose model': metrics.poseModel ?? 'object-pose',
    'Pose source': metrics.poseSource ?? 'None',
    'Pose rejection': metrics.poseRejectedReason ?? 'None',
    'Pose residual': metrics.poseAverageResidual ?? 0,
    'Pose foreshortening': metrics.poseForeshortening ?? 1,
    'Reconstruction state': metrics.reconstructionState ?? 'inactive',
    'Reconstruction frames': metrics.reconstructionFrames ?? 0,
    'Reconstruction landmarks': metrics.reconstructionLandmarks ?? 0,
    'Reconstruction depth': metrics.reconstructionDepthQuality ?? 0,
    'Reconstruction depth status': metrics.reconstructionDepthStatus ?? 'None',
    'Reconstruction depth provider': metrics.reconstructionDepthProvider ?? 'None',
    'Reconstruction depth inference': metrics.reconstructionDepthInferenceTime ?? 0,
    'Anchor processing time': metrics.processingTime ?? 0,
    'Recovery attempts': metrics.recoveryAttempts ?? 0,
    'Lost frame count': metrics.lostFrameCount ?? 0,
    'Anchor last failure': metrics.lastFailureReason ?? 'None',
  });

  if (typeof metrics.templateQuality === 'number') {
    collected['Template quality'] = metrics.templateQuality * 100;
  }

  return collected;
};
