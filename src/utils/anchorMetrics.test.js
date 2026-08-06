import test from 'node:test';
import assert from 'node:assert/strict';

import { collectAnchorMetrics } from './anchorMetrics.js';

test('anchor metrics collector emits one canonical snapshot and preserves valid zero values', () => {
  const collected = collectAnchorMetrics({
    mode: 'anchor',
    activeAnchor: { createdAt: 1 },
    anchorState: {
      state: 'tracking',
      confidence: 0,
      normal: { x: 0, y: 0, z: 1 },
      planarTransform: { scale: 0, rotation: 0 },
      metrics: {
        keypointCount: 0,
        poseConfidence: 0,
        poseAverageResidual: 0,
        poseForeshortening: 0,
        templateQuality: 0,
      },
    },
  });

  assert.equal(collected['Object Count'], 1);
  assert.equal(collected['Stability score'], 0);
  assert.equal(collected['Planar scale'], 0);
  assert.equal(collected['Pose confidence'], 0);
  assert.equal(collected['Pose residual'], 0);
  assert.equal(collected['Pose foreshortening'], 0);
  assert.equal(collected['Template quality'], 0);
  assert.equal('Anchor State' in collected, false);
  assert.equal('Tracked scale' in collected, false);
  assert.equal('Normal (X,Y,Z)' in collected, false);
});
