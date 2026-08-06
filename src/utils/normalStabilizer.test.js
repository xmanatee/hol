import test from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceNormalStabilizer, angularDistanceBetweenNormals } from './normalStabilizer.js';

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
    stabilizer.update(
      {
        x: i % 2 === 0 ? 0.025 : -0.02,
        y: i % 3 === 0 ? 0.018 : -0.012,
        z: 1,
      },
      { confidence: 0.9, inliers: 26 },
    );
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
    normal = stabilizer.update(
      {
        x: 0.34 + (i % 2 === 0 ? 0.015 : -0.012),
        y: 0.04,
        z: 0.94,
      },
      { confidence: 0.92, inliers: 24 },
    );
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
    { confidence: 0.62, inliers: 14, foreshortening: 0.51 },
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
    { confidence: 0.62, inliers: 14, foreshortening: 0.51 },
  );
  const returned = stabilizer.update(
    { x: 0, y: 0, z: 1 },
    { confidence: 0.58, inliers: 12, foreshortening: 0.98 },
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
    stabilizer.update({ x: 0.72, y: 0.16, z: 0.68 }, { confidence: 0.72, inliers: 14, foreshortening: 0.68 });
  }

  const reacquired = stabilizer.update(
    { x: -0.42, y: 0.09, z: 0.9 },
    { confidence: 0.52, inliers: 8, foreshortening: 0.9, reacquired: true },
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
    stabilizer.update({ x: 0.36, y: -0.08, z: 0.93 }, { confidence: 0.82, inliers: 18 });
  }

  const corrected = stabilizer.update(
    { x: -0.58, y: 0.08, z: 0.81 },
    { confidence: 0.9, inliers: 38, trusted: true },
  );

  assert.ok(corrected.x < -0.08, `corrected x ${corrected.x.toFixed(3)}`);
  assert.ok(corrected.z < 0.98);
});

test('surface normal stabilizer follows a confident wide turn from face-on with modest homography inliers', () => {
  const stabilizer = new SurfaceNormalStabilizer({
    historySize: 7,
    outlierRadians: 0.2,
  });

  for (let i = 0; i < 6; i++) {
    stabilizer.update(
      { x: -0.04, y: 0.02, z: 0.999 },
      { confidence: 0.58, inliers: 8, foreshortening: 0.999 },
    );
  }

  const firstTurn = stabilizer.update(
    { x: -0.82, y: 0.04, z: 0.57 },
    { confidence: 0.64, inliers: 8, foreshortening: 0.57 },
  );
  const secondTurn = stabilizer.update(
    { x: -0.83, y: 0.02, z: 0.56 },
    { confidence: 0.63, inliers: 8, foreshortening: 0.56 },
  );

  assert.ok(firstTurn.x < -0.02, `first turn x ${firstTurn.x.toFixed(3)}`);
  assert.ok(secondTurn.x < -0.28, `second turn x ${secondTurn.x.toFixed(3)}`);
});

test('surface normal stabilizer rejects an abrupt mirrored homography turn after a stable turned pose', () => {
  const stabilizer = new SurfaceNormalStabilizer({
    historySize: 7,
    outlierRadians: 0.2,
  });

  for (let i = 0; i < 4; i++) {
    stabilizer.update(
      { x: -0.58, y: 0.18, z: 0.79 },
      { confidence: 0.86, inliers: 22, foreshortening: 0.79, trusted: true },
    );
  }

  const held = stabilizer.update(
    { x: 0.75, y: -0.3, z: 0.59 },
    { confidence: 0.65, inliers: 9, foreshortening: 0.59 },
  );

  assert.ok(held.x < -0.32, `held x ${held.x.toFixed(3)}`);
});

test('surface normal stabilizer rejects high-inlier mirror flips when foreshortening is still moderate', () => {
  const stabilizer = new SurfaceNormalStabilizer({
    historySize: 7,
    outlierRadians: 0.2,
  });

  for (let i = 0; i < 4; i++) {
    stabilizer.update(
      { x: 0.46, y: -0.16, z: 0.87 },
      { confidence: 0.84, inliers: 18, foreshortening: 0.86 },
    );
  }

  const held = stabilizer.update(
    { x: -0.57, y: -0.04, z: 0.82 },
    { confidence: 0.85, inliers: 23, foreshortening: 0.82 },
  );

  assert.ok(held.x > 0.34, `held x ${held.x.toFixed(3)}`);
  assert.ok(held.z > 0.84, `held z ${held.z.toFixed(3)}`);
});

test('surface normal stabilizer holds through repeated ambiguous low-confidence mirror poses', () => {
  const stabilizer = new SurfaceNormalStabilizer({
    historySize: 7,
    outlierRadians: 0.2,
  });

  for (let i = 0; i < 4; i++) {
    stabilizer.update(
      { x: -0.22, y: 0.09, z: 0.97 },
      { confidence: 0.72, inliers: 12, foreshortening: 0.97 },
    );
  }

  const ambiguous = [
    { normal: { x: 0.36, y: -0.48, z: 0.8 }, confidence: 0.49, foreshortening: 0.8 },
    { normal: { x: 0.39, y: -0.55, z: 0.74 }, confidence: 0.59, foreshortening: 0.74 },
    { normal: { x: 0.42, y: -0.54, z: 0.73 }, confidence: 0.49, foreshortening: 0.73 },
    { normal: { x: 0.52, y: -0.4, z: 0.75 }, confidence: 0.45, foreshortening: 0.75 },
  ];

  let held;
  for (const sample of ambiguous) {
    held = stabilizer.update(sample.normal, {
      confidence: sample.confidence,
      inliers: 8,
      foreshortening: sample.foreshortening,
    });
  }

  const recovered = stabilizer.update(
    { x: -0.82, y: 0.04, z: 0.57 },
    { confidence: 0.62, inliers: 8, foreshortening: 0.57 },
  );

  assert.ok(held.x < 0.02, `held x ${held.x.toFixed(3)}`);
  assert.ok(recovered.x < -0.42, `recovered x ${recovered.x.toFixed(3)}`);
});

test('surface normal stabilizer recenters quickly on modest-inlier face-on evidence', () => {
  const stabilizer = new SurfaceNormalStabilizer({
    historySize: 7,
    outlierRadians: 0.2,
  });

  for (let i = 0; i < 5; i++) {
    stabilizer.update(
      { x: 0.62, y: -0.05, z: 0.78 },
      { confidence: 0.75, inliers: 14, foreshortening: 0.78 },
    );
  }

  stabilizer.update(
    { x: -0.05, y: -0.08, z: 0.996 },
    { confidence: 0.64, inliers: 12, foreshortening: 0.996 },
  );
  const centered = stabilizer.update(
    { x: -0.01, y: 0.01, z: 1 },
    { confidence: 0.61, inliers: 10, foreshortening: 1 },
  );

  assert.ok(centered.x < 0.24, `centered x ${centered.x.toFixed(3)}`);
  assert.ok(centered.z > 0.9, `centered z ${centered.z.toFixed(3)}`);
});
