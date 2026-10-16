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
    previousNormal: { x: -0.72, y: 0.02, z: 0.69 },
  });

  assert.equal(pose.success, true);
  assert.ok(pose.normal.x < -0.55);
  assert.ok(Math.abs(pose.normal.y) < 0.16);
});

test('perspective evidence resolves either affine tilt sign when leaving a face-on observation', () => {
  const estimator = new ObjectPoseEstimator();
  for (const direction of [-1, 1]) {
    for (const rotation of [-0.4, 0, 0.4]) {
      const transform = { tx: 17, ty: -11, scaleX: 0.72, scaleY: 1.2, rotation };
      const correspondences = createForeshortenedCorrespondences(transform);
      const anchorReference = { x: 137, y: 111 };
      const normalHint = {
        x: direction * Math.cos(rotation) * 0.8,
        y: direction * Math.sin(rotation) * 0.8,
        z: 0.6,
      };
      const pose = estimator.estimate({
        correspondences,
        anchorReference,
        previousNormal: { x: -direction * 0.1, y: 0, z: Math.sqrt(0.99) },
        normalHint,
      });
      assert.equal(pose.success, true);
      assert.ok(pose.normal.x * normalHint.x + pose.normal.y * normalHint.y > 0.6);
      const expected = transformPoint(anchorReference, transform);
      assert.ok(Math.hypot(pose.position.x - expected.x, pose.position.y - expected.y) < 1e-6);
    }
  }
});

test('an established affine tilt keeps its branch when a perspective estimate mirrors', () => {
  const estimator = new ObjectPoseEstimator();
  const pose = estimator.estimate({
    correspondences: createForeshortenedCorrespondences({
      tx: 4,
      ty: -3,
      scaleX: 0.6,
      scaleY: 1,
      rotation: 0,
    }),
    anchorReference: { x: 137, y: 111 },
    previousNormal: { x: -0.8, y: 0, z: 0.6 },
    normalHint: { x: 0.8, y: 0, z: 0.6 },
  });
  assert.equal(pose.success, true);
  assert.ok(pose.normal.x < -0.75);
});

test('perspective sign evidence does not manufacture tilt under pure similarity motion', () => {
  const pose = new ObjectPoseEstimator().estimate({
    correspondences: createForeshortenedCorrespondences({
      tx: -18,
      ty: 22,
      scaleX: 1.2,
      scaleY: 1.2,
      rotation: 0.4,
    }),
    anchorReference: { x: 137, y: 111 },
    normalHint: { x: -0.8, y: 0, z: 0.6 },
  });
  assert.equal(pose.success, true);
  assert.deepEqual(pose.normal, { x: 0, y: 0, z: 1 });
});

test('perspective evidence from a different tilt axis cannot select the affine branch', () => {
  const estimator = new ObjectPoseEstimator();
  const input = {
    correspondences: createForeshortenedCorrespondences({
      tx: 7,
      ty: -9,
      scaleX: 0.6,
      scaleY: 1,
      rotation: 0,
    }),
    anchorReference: { x: 137, y: 111 },
  };
  const pose = estimator.estimate({
    ...input,
    normalHint: { x: -0.2, y: 0.8, z: Math.sqrt(0.32) },
  });
  assert.deepEqual(pose, estimator.estimate(input));
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
