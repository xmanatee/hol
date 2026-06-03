import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHeadLocalRotation } from './headPose.js';

test('anchored head local rotation keeps manual offsets instead of camera look-at', () => {
  const manualRotation = { x: 0.11, y: -0.2, z: 0.04 };

  assert.deepEqual(computeHeadLocalRotation(manualRotation), manualRotation);
});
