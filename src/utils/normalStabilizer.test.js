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

test('surface normal stabilizer accepts confident foreshortened turns after face-on tracking', () => {
  const stabilizer = new SurfaceNormalStabilizer();

  for (let i = 0; i < 3; i++) {
    stabilizer.update({ x: 0, y: 0, z: 1 }, { confidence: 0.97, inliers: 25, foreshortening: 0.99 });
  }

  const normal = stabilizer.update(
    { x: 0.86, y: 0.05, z: 0.51 },
    { confidence: 0.62, inliers: 14, foreshortening: 0.51 }
  );

  assert.ok(normal.x > 0.34);
  assert.ok(normal.z < 0.95);
});

test('surface normal stabilizer returns toward face-on after confident frontal pose', () => {
  const stabilizer = new SurfaceNormalStabilizer();

  for (let i = 0; i < 3; i++) {
    stabilizer.update({ x: 0, y: 0, z: 1 }, { confidence: 0.97, inliers: 25, foreshortening: 0.99 });
  }

  const turned = stabilizer.update(
    { x: 0.86, y: 0.05, z: 0.51 },
    { confidence: 0.62, inliers: 14, foreshortening: 0.51 }
  );
  const returned = stabilizer.update(
    { x: 0, y: 0, z: 1 },
    { confidence: 0.58, inliers: 12, foreshortening: 0.98 }
  );

  assert.ok(returned.x < turned.x * 0.72);
  assert.ok(returned.z > turned.z);
});

test('surface normal stabilizer reacquires pose after a tracking gap', () => {
  const stabilizer = new SurfaceNormalStabilizer({
    historySize: 7,
    outlierRadians: 0.2,
  });

  for (let i = 0; i < 7; i++) {
    stabilizer.update(
      { x: 0.72, y: 0.16, z: 0.68 },
      { confidence: 0.72, inliers: 14, foreshortening: 0.68 }
    );
  }

  const reacquired = stabilizer.update(
    { x: -0.42, y: 0.09, z: 0.90 },
    { confidence: 0.52, inliers: 8, foreshortening: 0.9, reacquired: true }
  );

  assert.ok(reacquired.x < 0.15);
  assert.ok(reacquired.z > 0.78);
});

test('surface normal stabilizer trusts mature reconstruction corrections', () => {
  const stabilizer = new SurfaceNormalStabilizer({
    historySize: 7,
    outlierRadians: 0.2,
  });

  for (let i = 0; i < 6; i++) {
    stabilizer.update(
      { x: 0.36, y: -0.08, z: 0.93 },
      { confidence: 0.82, inliers: 18 }
    );
  }

  const corrected = stabilizer.update(
    { x: -0.58, y: 0.08, z: 0.81 },
    { confidence: 0.9, inliers: 38, trusted: true }
  );

  assert.ok(corrected.x < -0.08, `corrected x ${corrected.x.toFixed(3)}`);
  assert.ok(corrected.z < 0.98);
});
