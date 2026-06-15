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

test('includes reconstruction preview and current inferred pose for control panel visualization', () => {
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
