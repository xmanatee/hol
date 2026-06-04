import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SurfaceNormalStabilizer,
  angularDistanceBetweenNormals,
} from './normalStabilizer.js';

test('surface normal stabilizer suppresses one-frame pose outliers', () => {
  const stabilizer = new SurfaceNormalStabilizer({
    historySize: 7,
    deadbandRadians: 0.02,
    outlierRadians: 0.18,
    baseAlpha: 0.08,
    fastAlpha: 0.22,
  });

  const front = { x: 0, y: 0, z: 1 };
  for (let i = 0; i < 7; i++) {
    stabilizer.update({
      x: i % 2 === 0 ? 0.025 : -0.02,
      y: i % 3 === 0 ? 0.018 : -0.012,
      z: 1,
    }, { confidence: 0.9, inliers: 26 });
  }

  const beforeOutlier = stabilizer.getNormal();
  const afterOutlier = stabilizer.update({ x: 0.55, y: -0.35, z: 0.76 }, { confidence: 0.5, inliers: 9 });

  assert.ok(angularDistanceBetweenNormals(front, beforeOutlier) < 0.05);
  assert.ok(angularDistanceBetweenNormals(front, afterOutlier) < 0.08);
});

test('surface normal stabilizer follows sustained object turns without snap jitter', () => {
  const stabilizer = new SurfaceNormalStabilizer({
    historySize: 7,
    deadbandRadians: 0.02,
    outlierRadians: 0.2,
    baseAlpha: 0.1,
    fastAlpha: 0.34,
  });

  for (let i = 0; i < 7; i++) {
    stabilizer.update({ x: 0, y: 0, z: 1 }, { confidence: 0.95, inliers: 28 });
  }

  let normal;
  for (let i = 0; i < 14; i++) {
    normal = stabilizer.update({
      x: 0.34 + (i % 2 === 0 ? 0.015 : -0.012),
      y: 0.04,
      z: 0.94,
    }, { confidence: 0.92, inliers: 24 });
  }

  assert.ok(normal.x > 0.22);
  assert.ok(normal.x < 0.38);
  assert.ok(normal.z > 0.9);
});
