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
  assert.match(result.message, /Tap/);
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
  assert.match(result.message, /recovery 3/);
  assert.equal(result.details.lastFailureReason, 'Insufficient keypoint tracking quality');
  assert.equal(result.details.lostFrameCount, 9);
});
