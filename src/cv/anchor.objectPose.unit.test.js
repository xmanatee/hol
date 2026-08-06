import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectPoseEstimator } from './anchor.objectPose.js';

const transformPoint = (point, transform) => {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  const scaledX = point.x * transform.scaleX;
  const scaledY = point.y * transform.scaleY;

  return {
    x: transform.tx + cos * scaledX - sin * scaledY,
    y: transform.ty + sin * scaledX + cos * scaledY,
  };
};

const createForeshortenedCorrespondences = (transform) => {
  return Array.from({ length: 30 }, (_, index) => {
    const column = index % 6;
    const row = Math.floor(index / 6);
    const prev = {
      x: 72 + column * 28,
      y: 64 + row * 24,
    };

    return {
      prev,
      curr: transformPoint(prev, transform),
      response: 1,
      age: 30,
    };
  });
};

test('object pose projects the tapped anchor with the full affine transform under foreshortening', () => {
  const estimator = new ObjectPoseEstimator();
  const transform = {
    tx: 38,
    ty: -19,
    scaleX: 0.62,
    scaleY: 1.42,
    rotation: 0.31,
  };
  const anchorReference = { x: 137, y: 111 };
  const pose = estimator.estimate({
    correspondences: createForeshortenedCorrespondences(transform),
    anchorReference,
  });
  const expectedPosition = transformPoint(anchorReference, transform);

  assert.equal(pose.success, true);
  assert.ok(Math.abs(pose.position.x - expectedPosition.x) < 0.5);
  assert.ok(Math.abs(pose.position.y - expectedPosition.y) < 0.5);
  assert.ok(Math.abs(pose.planarTransform.scale - Math.sqrt(transform.scaleX * transform.scaleY)) < 0.04);
  assert.ok(Math.abs(pose.planarTransform.rotation - transform.rotation) < 0.04);
  assert.ok(Math.hypot(pose.normal.x, pose.normal.y) > 0.55);
  assert.ok(pose.normal.z < 0.84);
});

test('object pose uses previous normal continuity to resolve the foreshortening sign', () => {
  const estimator = new ObjectPoseEstimator();
  const transform = {
    tx: 10,
    ty: 14,
    scaleX: 0.54,
    scaleY: 1.2,
    rotation: 0,
  };

  const pose = estimator.estimate({
    correspondences: createForeshortenedCorrespondences(transform),
    anchorReference: { x: 140, y: 116 },
    previousPose: {
      normal: { x: -0.72, y: 0.02, z: 0.69 },
    },
  });

  assert.equal(pose.success, true);
  assert.ok(pose.normal.x < -0.55);
  assert.ok(Math.abs(pose.normal.y) < 0.16);
});

test('object pose scale follows projected area instead of the largest foreshortened axis', () => {
  const estimator = new ObjectPoseEstimator();
  const transform = {
    tx: 30,
    ty: 12,
    scaleX: 0.56,
    scaleY: 1.44,
    rotation: -0.18,
  };
  const pose = estimator.estimate({
    correspondences: createForeshortenedCorrespondences(transform),
    anchorReference: { x: 140, y: 116 },
  });
  const projectedAreaScale = Math.sqrt(transform.scaleX * transform.scaleY);

  assert.equal(pose.success, true);
  assert.ok(Math.abs(pose.planarTransform.scale - projectedAreaScale) < 0.04);
  assert.ok(pose.planarTransform.scale < 1);
});

test('object pose accepts strong absolute affine support when optical flow leaves half outliers', () => {
  const estimator = new ObjectPoseEstimator();
  const transform = {
    tx: 22,
    ty: -12,
    scaleX: 0.64,
    scaleY: 1.18,
    rotation: 0.16,
  };
  const coherent = createForeshortenedCorrespondences(transform).slice(0, 12);
  const outliers = createForeshortenedCorrespondences(transform)
    .slice(12, 24)
    .map((correspondence, index) => ({
      prev: correspondence.prev,
      curr: {
        x: 430 + index * 7,
        y: 80 + index * 11,
      },
    }));
  const anchorReference = { x: 137, y: 111 };
  const pose = estimator.estimate({
    correspondences: [...coherent, ...outliers],
    anchorReference,
  });
  const expectedPosition = transformPoint(anchorReference, transform);

  assert.equal(pose.success, true);
  assert.equal(pose.inlierCount, 12);
  assert.ok(Math.abs(pose.position.x - expectedPosition.x) < 1);
  assert.ok(Math.abs(pose.position.y - expectedPosition.y) < 1);
  assert.ok(Math.hypot(pose.normal.x, pose.normal.y) > 0.45);
});
