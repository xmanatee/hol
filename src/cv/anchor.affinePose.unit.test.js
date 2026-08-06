import test from 'node:test';
import assert from 'node:assert/strict';
import { AffineParallaxPoseEstimator } from './anchor.affinePose.js';

const createGridCorrespondences = (transform, options = {}) => {
  const columns = options.columns ?? 5;
  const rows = options.rows ?? 4;
  const origin = options.origin ?? { x: 80, y: 70 };
  const step = options.step ?? { x: 22, y: 20 };

  return Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const prev = {
      x: origin.x + column * step.x,
      y: origin.y + row * step.y,
    };
    const centered = {
      x: prev.x - transform.center.x,
      y: prev.y - transform.center.y,
    };

    return {
      prev,
      curr: {
        x: transform.tx + transform.center.x + transform.xx * centered.x + transform.xy * centered.y,
        y: transform.ty + transform.center.y + transform.yx * centered.x + transform.yy * centered.y,
      },
    };
  });
};

test('affine parallax estimates object yaw from horizontal foreshortening', () => {
  const estimator = new AffineParallaxPoseEstimator();
  const pose = estimator.estimatePose(
    createGridCorrespondences({
      center: { x: 124, y: 100 },
      xx: 0.52,
      xy: 0,
      yx: 0,
      yy: 1,
      tx: 14,
      ty: 6,
    }),
  );

  assert.equal(pose.success, true);
  assert.equal(pose.method, 'affine-parallax');
  assert.ok(Math.abs(pose.normal.x) > 0.6);
  assert.ok(Math.abs(pose.normal.y) < 0.12);
  assert.ok(pose.normal.z < 0.82);
  assert.ok(pose.inlierRatio > 0.9);
});

test('affine parallax estimates object pitch from vertical foreshortening', () => {
  const estimator = new AffineParallaxPoseEstimator();
  const pose = estimator.estimatePose(
    createGridCorrespondences({
      center: { x: 124, y: 100 },
      xx: 1,
      xy: 0,
      yx: 0,
      yy: 0.58,
      tx: 8,
      ty: -9,
    }),
  );

  assert.equal(pose.success, true);
  assert.ok(Math.abs(pose.normal.y) > 0.55);
  assert.ok(Math.abs(pose.normal.x) < 0.12);
  assert.ok(pose.normal.z < 0.86);
});

test('affine parallax keeps pure similarity motion face-on with roll', () => {
  const estimator = new AffineParallaxPoseEstimator();
  const rotation = (22 * Math.PI) / 180;
  const scale = 1.18;
  const pose = estimator.estimatePose(
    createGridCorrespondences({
      center: { x: 124, y: 100 },
      xx: scale * Math.cos(rotation),
      xy: -scale * Math.sin(rotation),
      yx: scale * Math.sin(rotation),
      yy: scale * Math.cos(rotation),
      tx: 10,
      ty: 12,
    }),
  );

  assert.equal(pose.success, true);
  assert.ok(Math.abs(pose.normal.x) < 0.08);
  assert.ok(Math.abs(pose.normal.y) < 0.08);
  assert.ok(pose.normal.z > 0.99);
  assert.ok(Math.abs(pose.rotation - rotation) < 0.02);
  assert.ok(Math.abs(pose.scale - scale) < 0.03);
});

test('affine parallax rejects incoherent point clouds', () => {
  const estimator = new AffineParallaxPoseEstimator();
  const correspondences = createGridCorrespondences({
    center: { x: 124, y: 100 },
    xx: 0.62,
    xy: 0,
    yx: 0,
    yy: 1,
    tx: 12,
    ty: 4,
  }).map((correspondence, index) =>
    index % 3 === 0
      ? {
          prev: correspondence.prev,
          curr: { x: 260 + index * 9, y: 30 + index * 7 },
        }
      : correspondence,
  );

  const pose = estimator.estimatePose(correspondences, { maxResidual: 3 });

  assert.equal(pose.success, false);
  assert.equal(pose.reason, 'Low affine inlier ratio');
});
