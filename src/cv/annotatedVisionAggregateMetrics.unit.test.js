import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateAnnotatedVisionFixtureMetrics } from './annotatedVisionAggregateMetrics.js';

const metrics = (overrides = {}) => ({
  averageJaccard: 0.4,
  averagePointsWithinThreshold: 0.5,
  occlusionAccuracy: 0.8,
  reDetectionAverageJaccard: 0.3,
  ptsWithin1: 0.1,
  ptsWithin2: 0.2,
  ptsWithin4: 0.3,
  ptsWithin8: 0.4,
  ptsWithin16: 0.5,
  jaccard1: 0.1,
  jaccard2: 0.2,
  jaccard4: 0.3,
  jaccard8: 0.4,
  jaccard16: 0.5,
  stableReDetectionEligibleCount: 2,
  stableReDetectionRecoveredCount: 1,
  maximumStableReDetectionLatencyMs: 200,
  maximumFalseVisibleDurationMs: 300,
  maximumMissedVisibleDurationMs: 400,
  visibleTrackFragmentationCount: 2,
  ...overrides,
});

test('inapplicable fixtures do not dilute applicable recovery metrics', () => {
  const aggregate = aggregateAnnotatedVisionFixtureMetrics([
    { metrics: metrics() },
    {
      metrics: metrics({
        averageJaccard: 0.2,
        reDetectionAverageJaccard: null,
        stableReDetectionEligibleCount: 0,
        stableReDetectionRecoveredCount: 0,
        maximumStableReDetectionLatencyMs: null,
      }),
    },
  ]);

  assert.ok(Math.abs(aggregate.averageJaccard - 0.3) < Number.EPSILON);
  assert.equal(aggregate.reDetectionAverageJaccard, 0.3);
  assert.equal(aggregate.stableReDetectionRecall, 0.5);
  assert.equal(aggregate.maximumStableReDetectionLatencyMs, 200);
});

test('all-inapplicable recovery remains null instead of becoming zero', () => {
  const aggregate = aggregateAnnotatedVisionFixtureMetrics([
    {
      metrics: metrics({
        reDetectionAverageJaccard: null,
        stableReDetectionEligibleCount: 0,
        stableReDetectionRecoveredCount: 0,
        maximumStableReDetectionLatencyMs: null,
      }),
    },
  ]);

  assert.equal(aggregate.reDetectionAverageJaccard, null);
  assert.equal(aggregate.stableReDetectionRecall, null);
  assert.equal(aggregate.maximumStableReDetectionLatencyMs, null);
});
