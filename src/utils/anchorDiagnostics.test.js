import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAnchorState } from './anchorDiagnostics.js';

test('describes detection mode with selectable objects as ready to tap', () => {
  const result = describeAnchorState({
    cameraState: 'active',
    anchorSystemState: {
      mode: 'detection',
      detections: [{ class: 'bottle' }],
      activeAnchor: null,
      anchorState: null
    }
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.severity, 'good');
  assert.match(result.message, /Tap an object/);
  assert.match(result.recommendation, /detected outline/);
});

test('describes moderate-quality anchors as weak but usable', () => {
  const result = describeAnchorState({
    cameraState: 'active',
    anchorSystemState: {
      mode: 'anchor',
      activeAnchor: { keypoints: 18, quality: 0.17 },
      anchorState: {
        anchored: true,
        state: 'degraded',
        metrics: {
          keypointCount: 18,
          templateQuality: 0.17,
          recoveryAttempts: 0
        }
      }
    }
  });

  assert.equal(result.status, 'weak');
  assert.equal(result.severity, 'warn');
  assert.match(result.message, /Weak lock/);
  assert.match(result.recommendation, /textured/);
});

test('includes lost-anchor recovery context from service metrics', () => {
  const result = describeAnchorState({
    cameraState: 'active',
    anchorSystemState: {
      mode: 'anchor',
      activeAnchor: { keypoints: 6, quality: 0.2 },
      anchorState: {
        anchored: true,
        state: 'lost',
        metrics: {
          keypointCount: 6,
          templateQuality: 0.2,
          recoveryAttempts: 3,
          lastFailureReason: 'Insufficient keypoint tracking quality',
          lostFrameCount: 9
        }
      }
    }
  });

  assert.equal(result.status, 'recovering');
  assert.equal(result.severity, 'bad');
  assert.match(result.message, /recovery attempt 3/);
  assert.doesNotMatch(result.message, /\/5/);
  assert.equal(result.details.lastFailureReason, 'Insufficient keypoint tracking quality');
  assert.equal(result.details.lostFrameCount, 9);
});

test('includes reconstruction preview and current inferred pose for field controls visualization', () => {
  const preview = {
    ready: true,
    points: [{ id: 1, x: 0, y: 0, z: 0 }],
    current: {
      anchor: { x: 214, y: 156 },
      normal: { x: 0.2, y: -0.1, z: 0.97 },
    }
  };
  const result = describeAnchorState({
    cameraState: 'active',
    anchorSystemState: {
      mode: 'anchor',
      activeAnchor: { keypoints: 34, quality: 0.4 },
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
        }
      }
    }
  });

  assert.equal(result.status, 'stable');
  assert.deepEqual(result.details.position, { x: 214, y: 156, z: 0 });
  assert.deepEqual(result.details.normal, { x: 0.2, y: -0.1, z: 0.97 });
  assert.deepEqual(result.details.planarTransform, { scale: 1.16, rotation: 0.21 });
  assert.equal(result.details.reconstructionPreview, preview);
  assert.equal(result.details.reconstructionMapConfidence, 0.77);
  assert.equal(result.details.reconstructionAverageSupport, 0.81);
  assert.equal(result.details.reconstructionMatureLandmarks, 29);
});

test('includes object support mask source and preview diagnostics', () => {
  const maskPreview = {
    source: 'warped-mask',
    bbox: { x: 20, y: 22, width: 80, height: 90 },
    sampleStride: 6,
    points: [{ x: 20, y: 22 }],
  };
  const result = describeAnchorState({
    cameraState: 'active',
    anchorSystemState: {
      mode: 'anchor',
      activeAnchor: { keypoints: 20, quality: 0.28 },
      anchorState: {
        anchored: true,
        state: 'mapping',
        metrics: {
          keypointCount: 20,
          templateQuality: 0.28,
          currentObjectSupportMaskSource: 'warped-mask',
          currentObjectSupportMaskPreview: maskPreview,
        }
      }
    }
  });

  assert.equal(result.details.objectSupportMaskSource, 'warped-mask');
  assert.deepEqual(result.details.objectSupportMaskPreview, maskPreview);
});

test('includes support growth and landmark refresh diagnostics', () => {
  const result = describeAnchorState({
    cameraState: 'active',
    anchorSystemState: {
      mode: 'anchor',
      activeAnchor: { keypoints: 20, quality: 0.28 },
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
          trackingRegion: { x: 28, y: 18, width: 112, height: 96 },
          currentObjectSupportMaskBounds: { x: 35, y: 22, width: 90, height: 82 },
          reconstructionRegion: { x: 28, y: 18, width: 112, height: 96 },
          poseRejectedReason: 'Insufficient pose inliers',
          reconstructionPoseRejectedReason: 'Map not mature',
        }
      }
    }
  });

  assert.equal(result.details.segmentationRefreshReason, 'tap-local-support-growth');
  assert.equal(result.details.segmentationRefreshFrame, 12);
  assert.equal(result.details.landmarkRefreshReason, 'support-growth');
  assert.equal(result.details.landmarkRefreshAdded, 18);
  assert.equal(result.details.landmarkRefreshTotal, 38);
  assert.equal(result.details.landmarkRefreshRejectedByMask, 4);
  assert.deepEqual(result.details.trackingRegion, { x: 28, y: 18, width: 112, height: 96 });
  assert.deepEqual(result.details.currentObjectSupportMaskBounds, { x: 35, y: 22, width: 90, height: 82 });
  assert.deepEqual(result.details.reconstructionRegion, { x: 28, y: 18, width: 112, height: 96 });
  assert.equal(result.details.poseRejectedReason, 'Insufficient pose inliers');
  assert.equal(result.details.reconstructionPoseRejectedReason, 'Map not mature');
});

test('includes object surface and pose candidate diagnostics', () => {
  const rejected = {
    reference_similarity_transform: { reason: 'insufficient-object-ownership', score: 0.31 },
  };
  const result = describeAnchorState({
    cameraState: 'active',
    anchorSystemState: {
      mode: 'anchor',
      activeAnchor: { keypoints: 28, quality: 0.42 },
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
          poseCandidateSource: 'sparse-reconstruction',
          poseCandidateScore: 0.77,
          rejectedPoseCandidates: rejected,
        }
      }
    }
  });

  assert.equal(result.details.surfaceCoverage, 0.68);
  assert.equal(result.details.surfacePrior, 'tapered-cylinder');
  assert.equal(result.details.surfaceLockedLandmarks, 19);
  assert.equal(result.details.surfaceContourSegments, 5);
  assert.equal(result.details.silhouetteCoverage, 0.52);
  assert.equal(result.details.contourFitResidual, 2.6);
  assert.equal(result.details.landmarksInsideMask, 24);
  assert.equal(result.details.landmarksOutsideMask, 4);
  assert.equal(result.details.occlusionState, 'visible');
  assert.equal(result.details.poseCandidateSource, 'sparse-reconstruction');
  assert.equal(result.details.poseCandidateScore, 0.77);
  assert.equal(result.details.rejectedPoseCandidates, rejected);
});
