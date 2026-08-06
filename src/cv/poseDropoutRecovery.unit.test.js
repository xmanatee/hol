import test from 'node:test';
import assert from 'node:assert/strict';

import { hasIndependentPositionMeasurement, hasPosePositionDropout } from './poseDropoutRecovery.js';

const dropoutMetrics = (overrides) => ({
  activeLandmarkCount: 24,
  trackingSuccessRate: 0.9,
  poseInliers: 0,
  poseSource: null,
  posePositionRole: 'tracker',
  ...overrides,
});
const sparseMugContext = {
  targetClass: 'mug',
  trackingMode: 'sparse-reconstruction',
};

test('independent pose owners distinguish orientation loss from position loss', () => {
  for (const posePositionRole of ['reconstruction', 'planar', 'object']) {
    const metrics = dropoutMetrics({ posePositionRole });
    assert.equal(hasIndependentPositionMeasurement(metrics), true);
    assert.equal(hasPosePositionDropout(metrics, sparseMugContext), false);
  }

  assert.equal(hasIndependentPositionMeasurement(dropoutMetrics()), false);
  assert.equal(hasPosePositionDropout(dropoutMetrics(), sparseMugContext), true);
  assert.equal(hasPosePositionDropout(dropoutMetrics({ posePositionRole: null }), sparseMugContext), true);
});

test('pose dropout policy preserves mode thresholds and sparse mug deferral', () => {
  assert.equal(
    hasPosePositionDropout(dropoutMetrics({ poseSource: 'object-pose-affine' }), sparseMugContext),
    false,
  );
  assert.equal(hasPosePositionDropout(dropoutMetrics({ activeLandmarkCount: 7 }), sparseMugContext), false);
  assert.equal(
    hasPosePositionDropout(dropoutMetrics({ trackingSuccessRate: 0.54 }), sparseMugContext),
    false,
  );
  assert.equal(hasPosePositionDropout(dropoutMetrics({ poseInliers: 8 }), sparseMugContext), false);

  const depthFusionMetrics = dropoutMetrics({ poseInliers: 10 });
  assert.equal(
    hasPosePositionDropout(depthFusionMetrics, {
      targetClass: 'can',
      trackingMode: 'depth-fusion',
    }),
    true,
  );
  assert.equal(
    hasPosePositionDropout(depthFusionMetrics, {
      targetClass: 'mug',
      trackingMode: 'depth-fusion',
    }),
    false,
  );

  assert.equal(
    hasPosePositionDropout(
      dropoutMetrics({
        reconstructionReady: true,
        reconstructionMapConfidence: 0.91,
        reconstructionMatureLandmarks: 39,
        reconstructionTrackerDelta: 3.9,
      }),
      {
        targetClass: 'mug',
        trackingMode: 'sparse-reconstruction',
      },
    ),
    false,
  );
});

test('normal quarantine does not trigger spatial support recovery in the same frame', () => {
  const quarantined = dropoutMetrics({
    poseObs: 0.006,
    normalPoseRejectedCandidates: {
      'sparse-reconstruction': 'weak-normal-innovation',
    },
  });

  assert.equal(hasPosePositionDropout(quarantined, sparseMugContext), false);

  quarantined.poseObs = null;
  assert.equal(hasPosePositionDropout(quarantined, sparseMugContext), true);

  quarantined.normalPoseRejectedCandidates['sparse-reconstruction'] = 'low-confidence';
  assert.equal(hasPosePositionDropout(quarantined, sparseMugContext), true);
});
