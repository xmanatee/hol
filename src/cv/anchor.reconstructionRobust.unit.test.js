import test from 'node:test';
import assert from 'node:assert/strict';

import { fitRobustAffine2D, transformPoint2, fitRobustSimilarity } from './anchor.reconstructionRobust.js';

const affinePoint = point => ({
  x: 1.08 * point.x + 0.18 * point.y + 14,
  y: -0.09 * point.x + 0.94 * point.y + 22,
});

test('robust affine fit keeps the dominant transform with capped hypotheses', () => {
  const inliers = Array.from({ length: 28 }, (_, index) => {
    const reference = {
      x: 40 + (index % 7) * 18,
      y: 60 + Math.floor(index / 7) * 16,
    };
    const current = affinePoint(reference);
    return {
      id: index,
      reference,
      current: {
        x: current.x + (index % 3 - 1) * 0.2,
        y: current.y + (index % 4 - 1.5) * 0.15,
      },
      quality: 2,
    };
  });
  const outliers = Array.from({ length: 8 }, (_, index) => ({
    id: 100 + index,
    reference: { x: 30 + index * 11, y: 30 + index * 7 },
    current: { x: 280 - index * 9, y: 45 + index * 23 },
    quality: 0.4,
  }));

  const fit = fitRobustAffine2D([...inliers, ...outliers], {
    minInliers: 18,
    threshold: 3,
  });

  assert.equal(fit.success, true);
  assert.ok(fit.inlierCount >= 26);
  assert.ok(fit.averageResidual < 1);
});

test('robust affine fit keeps quality sampling by default and supports spatial coverage when requested', () => {
  const clutter = Array.from({ length: 24 }, (_, index) => ({
    id: `clutter-${index}`,
    reference: { x: index * 12, y: 0 },
    current: { x: 420 + index * 31, y: -260 + (index % 5) * 95 },
    quality: 10,
  }));
  const highRankedLineInliers = [0, 24, 48, 72].map((x, index) => {
    const reference = { x, y: 96 };
    return {
      id: `line-inlier-${index}`,
      reference,
      current: affinePoint(reference),
      quality: 9,
    };
  });
  const lowerRankedSurfaceInliers = [
    { x: 0, y: 32 },
    { x: 24, y: 32 },
    { x: 48, y: 32 },
    { x: 72, y: 32 },
    { x: 0, y: 128 },
    { x: 24, y: 128 },
    { x: 48, y: 128 },
    { x: 72, y: 128 },
  ].map((reference, index) => ({
    id: `surface-inlier-${index}`,
    reference,
    current: affinePoint(reference),
    quality: 1,
  }));

  const observations = [
    ...clutter,
    ...highRankedLineInliers,
    ...lowerRankedSurfaceInliers,
  ];
  const qualityFit = fitRobustAffine2D(observations, {
    minInliers: 10,
    threshold: 4,
    maxSample: 28,
  });
  const spatialFit = fitRobustAffine2D(observations, {
    minInliers: 10,
    threshold: 4,
    maxSample: 28,
    sampleCoverage: 'spatial',
  });

  assert.equal(qualityFit.success, false);
  assert.equal(spatialFit.success, true);
  assert.ok(spatialFit.inlierCount >= 12);
});

test('robust similarity fit respects explicit sample caps', () => {
  const observations = Array.from({ length: 18 }, (_, index) => {
    const reference = {
      x: 20 + (index % 6) * 20,
      y: 40 + Math.floor(index / 6) * 24,
    };
    const current = transformPoint2(reference, {
      tx: 12,
      ty: -8,
      scale: 1.12,
      rotation: 0.08,
    });
    return {
      id: index,
      reference,
      current,
      quality: 1,
    };
  });

  const fit = fitRobustSimilarity(observations, {
    minInliers: 12,
    threshold: 2,
    maxSample: 14,
  });

  assert.equal(fit.success, true);
  assert.equal(fit.inlierCount, 18);
});
