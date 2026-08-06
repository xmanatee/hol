import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAnchorDetails } from './anchorDiagnostics.js';

const collectDetails = (anchorSystemState) =>
  collectAnchorDetails({
    anchorState: anchorSystemState.anchorState,
    segmentationRefresh: anchorSystemState.segmentationRefresh,
  });

test('includes lost-anchor recovery context from service metrics', () => {
  const details = collectDetails({
    anchorState: {
      anchored: true,
      state: 'lost',
      metrics: {
        keypointCount: 6,
        templateQuality: 0.2,
        recoveryAttempts: 3,
        lastFailureReason: 'Insufficient keypoint tracking quality',
        lostFrameCount: 9,
      },
    },
  });

  assert.equal(details.recoveryAttempts, 3);
  assert.equal(details.lastFailureReason, 'Insufficient keypoint tracking quality');
  assert.equal(details.lostFrameCount, 9);
});

test('includes reconstruction preview and current inferred pose for field controls visualization', () => {
  const preview = {
    ready: true,
    points: [{ id: 1, x: 0, y: 0, z: 0 }],
    current: {
      anchor: { x: 214, y: 156 },
      normal: { x: 0.2, y: -0.1, z: 0.97 },
    },
  };
  const details = collectDetails({
    anchorState: {
      anchored: true,
      state: 'stable',
      position: { x: 214, y: 156, z: 0 },
      normal: { x: 0.2, y: -0.1, z: 0.97 },
      planarTransform: { scale: 1.16, rotation: 0.21 },
      metrics: {
        keypointCount: 34,
        templateQuality: 0.4,
        poseModel: 'sparse-reconstruction',
        reconstructionReady: true,
        reconstructionPreview: preview,
        reconstructionMapConfidence: 0.77,
        reconstructionAverageSupport: 0.81,
        reconstructionAverageReliability: 0.74,
        reconstructionMatureLandmarks: 29,
      },
    },
  });

  assert.deepEqual(details.position, { x: 214, y: 156, z: 0 });
  assert.deepEqual(details.normal, { x: 0.2, y: -0.1, z: 0.97 });
  assert.deepEqual(details.planarTransform, { scale: 1.16, rotation: 0.21 });
  assert.equal(details.reconstructionPreview, preview);
  assert.equal(details.reconstructionMapConfidence, 0.77);
  assert.equal(details.reconstructionAverageSupport, 0.81);
  assert.equal(details.reconstructionMatureLandmarks, 29);
});

test('includes object support mask source and preview diagnostics', () => {
  const maskPreview = {
    source: 'warped-mask',
    bbox: { x: 20, y: 22, width: 80, height: 90 },
    sampleStride: 6,
    points: [{ x: 20, y: 22 }],
  };
  const details = collectDetails({
    anchorState: {
      anchored: true,
      state: 'mapping',
      metrics: {
        keypointCount: 20,
        templateQuality: 0.28,
        currentObjectSupportMaskSource: 'warped-mask',
        currentObjectSupportMaskPreview: maskPreview,
      },
    },
  });

  assert.equal(details.objectSupportMaskSource, 'warped-mask');
  assert.deepEqual(details.objectSupportMaskPreview, maskPreview);
});

test('includes support growth and landmark refresh diagnostics', () => {
  const details = collectDetails({
    segmentationRefresh: {
      status: 'rejected',
      trigger: 'object-ownership-recovery',
      outcomeReason: 'discontinuous-mask',
      maskSource: null,
    },
    anchorState: {
      anchored: true,
      state: 'mapping',
      metrics: {
        keypointCount: 20,
        templateQuality: 0.28,
        segmentationRefreshReason: 'tap-local-support-growth',
        segmentationRefreshFrame: 12,
        landmarkRefreshReason: 'support-growth',
        landmarkRefreshAdded: 18,
        landmarkRefreshTotal: 38,
        landmarkRefreshRejectedByMask: 4,
        landmarkRefreshCoverageBefore: 0.33,
        landmarkRefreshCoverageAfter: 0.56,
        landmarkRefreshCoverageCellCount: 9,
        landmarkRefreshOccupiedBefore: 3,
        landmarkRefreshOccupiedAfter: 5,
        trackingRegion: { x: 28, y: 18, width: 112, height: 96 },
        currentObjectSupportMaskBounds: { x: 35, y: 22, width: 90, height: 82 },
        reconstructionRegion: { x: 28, y: 18, width: 112, height: 96 },
        poseRejectedReason: 'Insufficient pose inliers',
        reconstructionPoseRejectedReason: 'Map not mature',
      },
    },
  });

  assert.equal(details.segmentationRefreshReason, 'tap-local-support-growth');
  assert.equal(details.segmentationRefreshFrame, 12);
  assert.equal(details.segmentationRefreshStatus, 'rejected');
  assert.equal(details.segmentationRefreshTrigger, 'object-ownership-recovery');
  assert.equal(details.segmentationRefreshOutcomeReason, 'discontinuous-mask');
  assert.equal(details.segmentationRefreshMaskSource, null);
  assert.equal(details.landmarkRefreshReason, 'support-growth');
  assert.equal(details.landmarkRefreshAdded, 18);
  assert.equal(details.landmarkRefreshTotal, 38);
  assert.equal(details.landmarkRefreshRejectedByMask, 4);
  assert.equal(details.landmarkRefreshCoverageBefore, 0.33);
  assert.equal(details.landmarkRefreshCoverageAfter, 0.56);
  assert.equal(details.landmarkRefreshCoverageCellCount, 9);
  assert.equal(details.landmarkRefreshOccupiedBefore, 3);
  assert.equal(details.landmarkRefreshOccupiedAfter, 5);
  assert.deepEqual(details.trackingRegion, { x: 28, y: 18, width: 112, height: 96 });
  assert.deepEqual(details.currentObjectSupportMaskBounds, { x: 35, y: 22, width: 90, height: 82 });
  assert.deepEqual(details.reconstructionRegion, { x: 28, y: 18, width: 112, height: 96 });
  assert.equal(details.poseRejectedReason, 'Insufficient pose inliers');
  assert.equal(details.reconstructionPoseRejectedReason, 'Map not mature');
});

test('includes object surface and pose candidate diagnostics', () => {
  const rejected = {
    reference_similarity_transform: { reason: 'insufficient-object-ownership', score: 0.31 },
  };
  const details = collectDetails({
    anchorState: {
      anchored: true,
      state: 'stable',
      metrics: {
        keypointCount: 28,
        templateQuality: 0.42,
        surfaceCoverage: 0.68,
        surfacePrior: 'tapered-cylinder',
        surfaceLockedLandmarks: 19,
        surfaceContourSegments: 5,
        silhouetteCoverage: 0.52,
        contourFitResidual: 2.6,
        landmarksInsideMask: 24,
        landmarksOutsideMask: 4,
        occlusionState: 'visible',
        poseOverlayCandidateSource: 'sparse-reconstruction',
        poseOverlayCandidateScore: 0.77,
        poseAttachmentCandidateSource: 'sparse-reconstruction',
        poseAttachmentCandidateScore: 0.76,
        posePositionCandidateSource: 'reference_similarity_transform',
        posePositionCandidateScore: 0.81,
        posePositionRole: 'tracker',
        posePositionReason: 'depth-fusion-tracker-spine',
        poseNormalCandidateSource: 'sparse-reconstruction',
        poseNormalRole: 'reconstruction',
        poseNormalReason: 'reconstruction-surface-evidence',
        normalPoseRejectedCandidates: {
          'object-pose-affine': 'weak-inconsistent-reconstruction-normal',
        },
        rejectedPoseCandidates: rejected,
      },
    },
  });

  assert.equal(details.surfaceCoverage, 0.68);
  assert.equal(details.surfacePrior, 'tapered-cylinder');
  assert.equal(details.surfaceLockedLandmarks, 19);
  assert.equal(details.surfaceContourSegments, 5);
  assert.equal(details.silhouetteCoverage, 0.52);
  assert.equal(details.contourFitResidual, 2.6);
  assert.equal(details.landmarksInsideMask, 24);
  assert.equal(details.landmarksOutsideMask, 4);
  assert.equal(details.occlusionState, 'visible');
  assert.equal(details.poseOverlayCandidateSource, 'sparse-reconstruction');
  assert.equal(details.poseOverlayCandidateScore, 0.77);
  assert.equal(details.poseAttachmentCandidateSource, 'sparse-reconstruction');
  assert.equal(details.poseAttachmentCandidateScore, 0.76);
  assert.equal(details.posePositionCandidateSource, 'reference_similarity_transform');
  assert.equal(details.posePositionCandidateScore, 0.81);
  assert.equal(details.posePositionRole, 'tracker');
  assert.equal(details.posePositionReason, 'depth-fusion-tracker-spine');
  assert.equal(details.poseNormalCandidateSource, 'sparse-reconstruction');
  assert.equal(details.poseNormalRole, 'reconstruction');
  assert.equal(details.poseNormalReason, 'reconstruction-surface-evidence');
  assert.deepEqual(details.normalPoseRejectedCandidates, {
    'object-pose-affine': 'weak-inconsistent-reconstruction-normal',
  });
  assert.equal(details.rejectedPoseCandidates, rejected);
});
