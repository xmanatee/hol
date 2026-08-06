import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHeadLocalRotation, writeEyeGazeRotation } from './headPose.js';

test('anchored head local rotation keeps manual offsets instead of camera look-at', () => {
  const manualRotation = { x: 0.11, y: -0.2, z: 0.04 };

  assert.deepEqual(computeHeadLocalRotation(manualRotation), manualRotation);
});

test('eye gaze rotates toward the camera while clamping extreme angles', () => {
  const gaze = { x: 1, y: 1, z: 1 };
  assert.equal(writeEyeGazeRotation({ x: 0, y: 0, z: 0 }, { x: 4, y: 2, z: 3 }, gaze, 0.32, 0.2), gaze);

  assert.equal(gaze.y, 0.32);
  assert.equal(gaze.x, -0.2);
  assert.equal(gaze.z, 0);
});
