import test from 'node:test';
import assert from 'node:assert/strict';
import { HomographyEstimator } from './anchor.homography.js';

const multiply3 = (a, b) => {
  const result = new Array(9).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      for (let k = 0; k < 3; k++) {
        result[row * 3 + col] += a[row * 3 + k] * b[k * 3 + col];
      }
    }
  }
  return result;
};

const camera = {
  fx: 900,
  fy: 900,
  cx: 640,
  cy: 360,
};

const k = [
  camera.fx, 0, camera.cx,
  0, camera.fy, camera.cy,
  0, 0, 1,
];

const kInverse = [
  1 / camera.fx, 0, -camera.cx / camera.fx,
  0, 1 / camera.fy, -camera.cy / camera.fy,
  0, 0, 1,
];

const homographyFromRotation = rotation => multiply3(multiply3(k, rotation), kInverse);

test('homography initialization stores camera intrinsics without OpenCV matrix allocation', async () => {
  const estimator = new HomographyEstimator();
  const cv = {
    matFromArray() {
      throw new Error('matFromArray should not be used for camera intrinsics');
    },
  };

  await estimator.initialize(cv, camera);

  assert.deepEqual(estimator.cameraParams, camera);
  assert.equal(estimator.cameraMatrix, null);
  assert.equal(estimator.initialized, true);
});

test('homography pose extraction recovers a large yaw normal instead of preferring face-on', () => {
  const estimator = new HomographyEstimator();
  estimator.initialized = true;
  estimator.cameraParams = camera;

  const yaw = 38 * Math.PI / 180;
  const rotation = [
    Math.cos(yaw), 0, Math.sin(yaw),
    0, 1, 0,
    -Math.sin(yaw), 0, Math.cos(yaw),
  ];
  const homography = { data64F: homographyFromRotation(rotation) };

  const pose = estimator._extractPoseFromHomography(null, homography);

  assert.equal(pose.success, true);
  assert.ok(pose.normal.x > 0.55);
  assert.ok(pose.normal.z < 0.85);
  assert.ok(pose.confidence > 0.95);
});
