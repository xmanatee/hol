import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { fitRobustSimilarity } from './anchor.reconstructionRobust.js';
import {
  createSimilarityHypothesisWorkspace,
  fitSimilarityHypothesis,
  scoreSimilarityHypothesis,
} from './anchor.similarityHypothesis.js';

test('similarity hypotheses retain only the numeric score needed during search', () => {
  const workspace = createSimilarityHypothesisWorkspace();
  const left = {
    reference: { x: 0, y: 0 },
    current: { x: 10, y: -4 },
  };
  const right = {
    reference: { x: 20, y: 0 },
    current: { x: 10, y: 20 },
  };
  const observations = [
    left,
    right,
    {
      reference: { x: 0, y: 20 },
      current: { x: -14, y: -4 },
    },
    {
      reference: { x: 20, y: 20 },
      current: { x: 80, y: 70 },
    },
  ];

  assert.equal(fitSimilarityHypothesis(left, right, workspace.solution), true);
  scoreSimilarityHypothesis(observations, workspace.solution, 1, workspace.score);

  assert.ok(Math.abs(workspace.solution[0] - 10) < 1e-12);
  assert.ok(Math.abs(workspace.solution[1] + 4) < 1e-12);
  assert.ok(Math.abs(workspace.solution[2] - 1.2) < 1e-12);
  assert.ok(Math.abs(workspace.solution[3] - Math.PI / 2) < 1e-12);
  assert.equal(workspace.score[0], 3);
  assert.ok(workspace.score[1] < 1e-12);
});

test('robust similarity fit preserves its deterministic result corpus', () => {
  let randomState = 0x91e10da5;
  const random = () => {
    randomState = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
    randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), 61 | randomState);
    return ((randomState ^ (randomState >>> 14)) >>> 0) / 4294967296;
  };
  const reports = [];

  for (let caseIndex = 0; caseIndex < 120; caseIndex++) {
    const count = 12 + (caseIndex % 37);
    const outlierEvery = 4 + (caseIndex % 8);
    const scale = 0.84 + (caseIndex % 17) * 0.025;
    const rotation = -0.28 + (caseIndex % 23) * 0.026;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const tx = -18 + caseIndex * 0.31;
    const ty = 14 - caseIndex * 0.19;
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
              x: tx + scale * (cos * reference.x - sin * reference.y) + (random() - 0.5) * 0.5,
              y: ty + scale * (sin * reference.x + cos * reference.y) + (random() - 0.5) * 0.5,
            },
        quality: outlier ? 0.3 + random() * 0.2 : 1 + random(),
      };
    });
    const fit = fitRobustSimilarity(observations, {
      minInliers: Math.min(18, Math.max(8, Math.floor(count * 0.55))),
      threshold: 2.5 + (caseIndex % 5),
      maxSample: 10 + (caseIndex % 27),
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

  assert.equal(reports.filter((report) => report.success).length, 120);
  assert.equal(
    createHash('sha256').update(JSON.stringify(reports)).digest('hex'),
    '39538f2177bf36ac1e0bb742127d6ff55270f1e097b6407c6135f1766871c337',
  );
});
