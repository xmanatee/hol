import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateFrameConsensus } from './anchor.frameConsensus.js';

const observations = [
  { id: 1, reference: { x: 0, y: 0 }, current: { x: 8, y: 4 }, quality: 1 },
  { id: 2, reference: { x: 40, y: 0 }, current: { x: 48, y: 4 }, quality: 1 },
  { id: 3, reference: { x: 0, y: 40 }, current: { x: 8, y: 44 }, quality: 1 },
  { id: 4, reference: { x: 40, y: 40 }, current: { x: 48, y: 44 }, quality: 1 },
];

const options = {
  minInliers: 4,
  threshold: 8,
  minInlierRatio: 0.5,
  model: 'similarity',
};

test('frame consensus reuses only the exact ordered evidence and estimator contract', () => {
  const first = evaluateFrameConsensus(null, observations, options);
  const reused = evaluateFrameConsensus(first, [...observations], { ...options });
  const reordered = evaluateFrameConsensus(
    first,
    [observations[1], observations[0], ...observations.slice(2)],
    options,
  );
  const clonedEvidence = evaluateFrameConsensus(
    first,
    observations.map((observation) => ({ ...observation })),
    options,
  );
  const changedThreshold = evaluateFrameConsensus(first, observations, { ...options, threshold: 9 });

  assert.equal(first.result.success, true);
  assert.equal(reused, first);
  assert.notEqual(reordered, first);
  assert.notEqual(clonedEvidence, first);
  assert.notEqual(changedThreshold, first);
});

test('frame consensus retains a completed failed evaluation for identical evidence', () => {
  const insufficient = observations.slice(0, 2);
  const first = evaluateFrameConsensus(null, insufficient, options);
  const reused = evaluateFrameConsensus(first, [...insufficient], { ...options });

  assert.equal(first.result.success, false);
  assert.equal(reused, first);
});
