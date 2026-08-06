import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createAffineHypothesisWorkspace, scoreAffineHypothesis } from './anchor.affineHypothesis.js';
import { fitRobustAffine2D, fitRobustSimilarity, transformPoint2 } from './anchor.reconstructionRobust.js';

const affinePoint = (point) => ({
  x: 1.08 * point.x + 0.18 * point.y + 14,
  y: -0.09 * point.x + 0.94 * point.y + 22,
});

test('affine hypothesis workspace retains only elimination and result storage', () => {
  assert.deepEqual(Object.keys(createAffineHypothesisWorkspace()), [
    'augmented',
    'solution',
    'bestSolution',
    'score',
  ]);
});

test('affine hypothesis skips Euclidean norms outside exact scalar residual bounds', (t) => {
  const originalHypot = Math.hypot;
  let hypotCalls = 0;
  Math.hypot = (...values) => {
    hypotCalls++;
    return originalHypot(...values);
  };
  t.after(() => {
    Math.hypot = originalHypot;
  });

  const observations = [
    { reference: { x: 10, y: 12 }, current: { x: 10, y: 12 } },
    { reference: { x: 20, y: 24 }, current: { x: 16, y: 20 } },
    { reference: { x: 30, y: 36 }, current: { x: 24, y: 36 } },
    { reference: { x: 40, y: 48 }, current: { x: 40, y: 42 } },
    { reference: { x: 50, y: 60 }, current: { x: 47, y: 56 } },
  ];
  const score = new Float64Array(2);

  scoreAffineHypothesis(observations, new Float64Array([1, 0, 0, 0, 1, 0]), 5, score);

  assert.equal(hypotCalls, 2);
  assert.deepEqual(Array.from(score), [2, 2.5]);
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
        x: current.x + ((index % 3) - 1) * 0.2,
        y: current.y + ((index % 4) - 1.5) * 0.15,
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
  assert.deepEqual(
    {
      transform: fit.transform,
      inlierIds: fit.inliers.map((observation) => observation.id),
      inlierCount: fit.inlierCount,
      inlierRatio: fit.inlierRatio,
      averageResidual: fit.averageResidual,
      confidence: fit.confidence,
    },
    {
      transform: {
        rowX: [1.0800992425033176, 0.18017870236331301, 13.96851685015139],
        rowY: [-0.0899999433004621, 0.9413394908043171, 21.8874766609852],
      },
      inlierIds: Array.from({ length: 28 }, (_, index) => index),
      inlierCount: 28,
      inlierRatio: 0.7777777777777778,
      averageResidual: 0.21937726123869722,
      confidence: 0.8562676965600291,
    },
  );
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

  const observations = [...clutter, ...highRankedLineInliers, ...lowerRankedSurfaceInliers];
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
  assert.deepEqual(
    {
      transform: fit.transform,
      inlierIds: fit.inliers.map((observation) => observation.id),
      inlierRatio: fit.inlierRatio,
      averageResidual: fit.averageResidual,
      confidence: fit.confidence,
    },
    {
      transform: {
        tx: 11.999999999999986,
        ty: -8,
        scale: 1.1200000000000006,
        rotation: 0.08000000000000002,
      },
      inlierIds: Array.from({ length: 18 }, (_, index) => index),
      inlierRatio: 1,
      averageResidual: 3.311572377530781e-14,
      confidence: 0.9999999999999993,
    },
  );
});

test('robust affine fit preserves its deterministic quality and spatial corpus', () => {
  let randomState = 0x6d2b79f5;
  const random = () => {
    randomState = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
    randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), 61 | randomState);
    return ((randomState ^ (randomState >>> 14)) >>> 0) / 4294967296;
  };
  const reports = [];

  for (let caseIndex = 0; caseIndex < 100; caseIndex++) {
    const count = 12 + (caseIndex % 37);
    const outlierEvery = 4 + (caseIndex % 8);
    const observations = Array.from({ length: count }, (_, index) => {
      const reference = {
        x: 18 + (index % 8) * 19 + random() * 0.3,
        y: 24 + Math.floor(index / 8) * 21 + random() * 0.3,
      };
      const outlier = index % outlierEvery === outlierEvery - 1;
      return {
        id: `${caseIndex}:${index}`,
        reference,
        current: outlier
          ? { x: 30 + random() * 270, y: 20 + random() * 210 }
          : {
              x:
                (0.94 + caseIndex * 0.0007) * reference.x +
                (0.06 + caseIndex * 0.0002) * reference.y +
                8 +
                caseIndex * 0.05 +
                (random() - 0.5) * 0.5,
              y:
                (-0.04 + caseIndex * 0.0001) * reference.x +
                (1.03 - caseIndex * 0.0004) * reference.y +
                11 -
                caseIndex * 0.03 +
                (random() - 0.5) * 0.5,
            },
        quality: outlier ? 0.3 + random() * 0.2 : 1 + random(),
      };
    });
    const fit = fitRobustAffine2D(observations, {
      minInliers: Math.min(18, Math.max(8, Math.floor(count * 0.55))),
      threshold: 2.5 + (caseIndex % 5),
      maxSample: 12 + (caseIndex % 17),
      sampleCoverage: caseIndex % 2 ? 'spatial' : 'quality',
    });
    reports.push({
      success: fit.success,
      reason: fit.reason,
      transform: fit.transform,
      inlierIds: fit.inliers?.map((item) => item.id),
      inlierCount: fit.inlierCount,
      inlierRatio: fit.inlierRatio,
      averageResidual: fit.averageResidual,
      confidence: fit.confidence,
    });
  }

  assert.equal(reports.filter((report) => report.success).length, 100);
  assert.equal(
    createHash('sha256').update(JSON.stringify(reports)).digest('hex'),
    'db6c2d4b01610427b010a26a3b3ad204ddd207c26d7a6b404b606effcd40a878',
  );
});
