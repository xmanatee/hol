import test from 'node:test';
import assert from 'node:assert/strict';
import { HomographyEstimator } from './anchor.homography.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';

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

const rotate3 = (point, pose) => {
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  const cr = Math.cos(pose.roll);
  const sr = Math.sin(pose.roll);
  const rollPoint = {
    x: cr * point.x - sr * point.y,
    y: sr * point.x + cr * point.y,
    z: point.z,
  };
  const pitchPoint = {
    x: rollPoint.x,
    y: cp * rollPoint.y - sp * rollPoint.z,
    z: sp * rollPoint.y + cp * rollPoint.z,
  };

  return {
    x: cy * pitchPoint.x + sy * pitchPoint.z,
    y: pitchPoint.y,
    z: -sy * pitchPoint.x + cy * pitchPoint.z,
  };
};

const projectPlanarPoint = ({ point, pose, cameraParams }) => {
  const rotated = rotate3(point, pose);
  const x = rotated.x + pose.tx;
  const y = rotated.y + pose.ty;
  const z = rotated.z + pose.distance;

  return {
    x: cameraParams.cx + cameraParams.fx * x / z,
    y: cameraParams.cy + cameraParams.fy * y / z,
  };
};

const normalAngle = (left, right) => {
  const dot = left.x * right.x + left.y * right.y + left.z * right.z;
  const leftLength = Math.hypot(left.x, left.y, left.z);
  const rightLength = Math.hypot(right.x, right.y, right.z);

  return Math.acos(Math.max(-1, Math.min(1, dot / (leftLength * rightLength))));
};

const createPlanarPnPCorrespondences = ({ anchorReference, pose, cameraParams }) => {
  const correspondences = [];
  for (let y = -90; y <= 90; y += 30) {
    for (let x = -70; x <= 70; x += 35) {
      correspondences.push({
        prev: { x: anchorReference.x + x, y: anchorReference.y + y },
        curr: projectPlanarPoint({
          point: { x, y, z: 0 },
          pose,
          cameraParams,
        }),
      });
    }
  }

  return correspondences;
};

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
  assert.equal(pose.foreshortening, pose.normal.z);
  assert.ok(pose.confidence > 0.95);
});

test('planar PnP pose estimation recovers book-like yaw pitch and depth from tracked patch points', async () => {
  const cv = await loadOpenCvForNode();
  const estimator = new HomographyEstimator();
  await estimator.initialize(cv, camera);
  const anchorReference = { x: 640, y: 360 };
  const pose = {
    yaw: 35 * Math.PI / 180,
    pitch: -14 * Math.PI / 180,
    roll: 11 * Math.PI / 180,
    tx: 12,
    ty: -8,
    distance: 720,
  };
  const expectedNormal = rotate3({ x: 0, y: 0, z: 1 }, pose);
  const correspondences = createPlanarPnPCorrespondences({
    anchorReference,
    pose,
    cameraParams: camera,
  });

  const result = estimator.estimatePlanarPnPPose(cv, correspondences, anchorReference);

  assert.equal(result.success, true);
  assert.equal(result.method, 'planar-pnp');
  assert.ok(normalAngle(result.normal, expectedNormal) < 0.05);
  assert.ok(result.averageResidual < 0.5);
  assert.ok(Math.abs(result.translation[2] - pose.distance) < 2);
});
