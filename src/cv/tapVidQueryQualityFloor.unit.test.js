import assert from 'node:assert/strict';
import test from 'node:test';

import { assertTapVidAggregateQualityFloor, assertTapVidQueryQualityFloor } from './tapVidQualityFloor.js';

const aggregateFloor = {
  minimumAverageJaccard: 0.25,
  minimumAveragePointsWithinThreshold: 0.4,
  minimumOcclusionAccuracy: 0.7,
  reDetection: {
    kind: 'eligible',
    minimumAverageJaccard: 0.1,
    minimumStableRecall: 0.5,
    maximumStableLatencyMs: 400,
  },
};

const commonQueryFloor = {
  minimumAverageJaccard: 0.3,
  minimumAveragePointsWithinThreshold: 0.5,
  minimumOcclusionAccuracy: 0.8,
  maximumP95VisiblePointError: 50,
  maximumFalseVisibleDurationMs: 0,
  maximumMissedVisibleDurationMs: 0,
  maximumVisibleTrackFragmentationCount: 0,
};

const eligibleFloor = (overrides = {}) => ({
  ...commonQueryFloor,
  reDetection: {
    kind: 'eligible',
    minimumAverageJaccard: 0.2,
    minimumStableRecall: 1,
    maximumStableLatencyMs: 400,
    ...overrides,
  },
});

const queryMetrics = (overrides = {}) => ({
  averageJaccard: 0.32,
  averagePointsWithinThreshold: 0.52,
  occlusionAccuracy: 0.84,
  p95VisiblePointError: 48,
  maximumFalseVisibleDurationMs: 0,
  maximumMissedVisibleDurationMs: 0,
  visibleTrackFragmentationCount: 0,
  eligibleReappearanceCount: 1,
  reDetectionAverageJaccard: 0.22,
  stableReDetectionEligibleCount: 1,
  stableReDetectionRecoveredCount: 1,
  stableReDetectionRecall: 1,
  maximumStableReDetectionLatencyMs: 400,
  ...overrides,
});

test('aggregate and eligible query contracts enforce their own metric surfaces', () => {
  const aggregate = {
    averageJaccard: 0.26,
    averagePointsWithinThreshold: 0.42,
    occlusionAccuracy: 0.72,
    reDetectionAverageJaccard: 0.11,
    eligibleReappearanceCount: 1,
    stableReDetectionEligibleCount: 2,
    stableReDetectionRecoveredCount: 1,
    stableReDetectionRecall: 0.5,
    maximumStableReDetectionLatencyMs: 400,
  };
  assert.equal(assertTapVidAggregateQualityFloor(aggregate, aggregateFloor), aggregate);

  const query = queryMetrics();
  assert.equal(assertTapVidQueryQualityFloor('track-12', query, eligibleFloor()), query);
  assert.throws(
    () =>
      assertTapVidQueryQualityFloor(
        'track-12',
        queryMetrics({ averagePointsWithinThreshold: 0.49 }),
        eligibleFloor(),
      ),
    /track-12 averagePointsWithinThreshold 0.49 is below 0.5/,
  );
});

test('aggregate quality contracts reject every named metric regression', () => {
  const metrics = {
    averageJaccard: 0.26,
    averagePointsWithinThreshold: 0.42,
    occlusionAccuracy: 0.72,
    reDetectionAverageJaccard: 0.11,
    eligibleReappearanceCount: 1,
    stableReDetectionEligibleCount: 2,
    stableReDetectionRecoveredCount: 1,
    stableReDetectionRecall: 0.5,
    maximumStableReDetectionLatencyMs: 400,
  };
  const regressions = [
    ['averageJaccard', { minimumAverageJaccard: 0.27 }, /averageJaccard 0.26 is below 0.27/],
    [
      'averagePointsWithinThreshold',
      { minimumAveragePointsWithinThreshold: 0.43 },
      /averagePointsWithinThreshold 0.42 is below 0.43/,
    ],
    ['occlusionAccuracy', { minimumOcclusionAccuracy: 0.73 }, /occlusionAccuracy 0.72 is below 0.73/],
  ];

  for (const [metricName, floorOverride, message] of regressions) {
    assert.throws(
      () => assertTapVidAggregateQualityFloor(metrics, { ...aggregateFloor, ...floorOverride }),
      message,
      metricName,
    );
  }
  for (const [metricName, reDetection, message] of [
    [
      'reDetectionAverageJaccard',
      { ...aggregateFloor.reDetection, minimumAverageJaccard: 0.12 },
      /reDetectionAverageJaccard 0.11 is below 0.12/,
    ],
    [
      'stableReDetectionRecall',
      { ...aggregateFloor.reDetection, minimumStableRecall: 0.51 },
      /stableReDetectionRecall 0.5 is below 0.51/,
    ],
    [
      'maximumStableReDetectionLatencyMs',
      { ...aggregateFloor.reDetection, maximumStableLatencyMs: 399 },
      /maximumStableReDetectionLatencyMs 400 exceeds 399/,
    ],
  ]) {
    assert.throws(
      () => assertTapVidAggregateQualityFloor(metrics, { ...aggregateFloor, reDetection }),
      message,
      metricName,
    );
  }
});

test('eligible query contracts reject every spatial and temporal regression', () => {
  const regressions = [
    ['averageJaccard', 0.29, /track-12 averageJaccard 0.29 is below 0.3/],
    ['averagePointsWithinThreshold', 0.49, /track-12 averagePointsWithinThreshold 0.49 is below 0.5/],
    ['occlusionAccuracy', 0.79, /track-12 occlusionAccuracy 0.79 is below 0.8/],
    ['p95VisiblePointError', 51, /track-12 p95VisiblePointError 51 exceeds 50/],
    ['maximumFalseVisibleDurationMs', 1, /track-12 maximumFalseVisibleDurationMs 1 exceeds 0/],
    ['maximumMissedVisibleDurationMs', 1, /track-12 maximumMissedVisibleDurationMs 1 exceeds 0/],
    ['visibleTrackFragmentationCount', 1, /track-12 visibleTrackFragmentationCount 1 exceeds 0/],
  ];

  for (const [metricName, regressedValue, message] of regressions) {
    assert.throws(
      () =>
        assertTapVidQueryQualityFloor(
          'track-12',
          queryMetrics({ [metricName]: regressedValue }),
          eligibleFloor(),
        ),
      message,
      metricName,
    );
  }
  assert.throws(
    () =>
      assertTapVidQueryQualityFloor(
        'track-12',
        queryMetrics(),
        eligibleFloor({ minimumAverageJaccard: 0.23 }),
      ),
    /reDetectionAverageJaccard 0.22 is below 0.23/,
  );
  assert.throws(
    () =>
      assertTapVidQueryQualityFloor(
        'track-12',
        queryMetrics({ stableReDetectionRecoveredCount: 0, stableReDetectionRecall: 0 }),
        eligibleFloor(),
      ),
    /stableReDetectionRecall 0 is below 1/,
  );
  assert.throws(
    () =>
      assertTapVidQueryQualityFloor(
        'track-12',
        queryMetrics({ maximumStableReDetectionLatencyMs: 401 }),
        eligibleFloor(),
      ),
    /maximumStableReDetectionLatencyMs 401 exceeds 400/,
  );
});

test('always-visible query contracts require re-detection metrics to be inapplicable', () => {
  const floor = { ...commonQueryFloor, reDetection: { kind: 'not-applicable' } };
  const metrics = queryMetrics({
    eligibleReappearanceCount: 0,
    reDetectionAverageJaccard: null,
    stableReDetectionEligibleCount: 0,
    stableReDetectionRecoveredCount: 0,
    stableReDetectionRecall: null,
    maximumStableReDetectionLatencyMs: null,
  });
  assert.equal(assertTapVidQueryQualityFloor('always-visible', metrics, floor), metrics);

  for (const [metricName, value, message] of [
    ['eligibleReappearanceCount', 1, /eligibleReappearanceCount 1 must be 0/],
    ['stableReDetectionEligibleCount', 1, /stableReDetectionEligibleCount 1 must be 0/],
    ['stableReDetectionRecoveredCount', 1, /stableReDetectionRecoveredCount 1 must be 0/],
    ['reDetectionAverageJaccard', 0, /reDetectionAverageJaccard 0 must be null/],
    ['stableReDetectionRecall', 0, /stableReDetectionRecall 0 must be null/],
    ['maximumStableReDetectionLatencyMs', 0, /maximumStableReDetectionLatencyMs 0 must be null/],
  ]) {
    assert.throws(
      () => assertTapVidQueryQualityFloor('always-visible', { ...metrics, [metricName]: value }, floor),
      message,
      metricName,
    );
  }
});

test('short reappearance segments gate AJ while stable recovery stays inapplicable', () => {
  const floor = {
    ...commonQueryFloor,
    reDetection: { kind: 'segment-only', minimumAverageJaccard: 0.1 },
  };
  const metrics = queryMetrics({
    eligibleReappearanceCount: 1,
    reDetectionAverageJaccard: 0.11,
    stableReDetectionEligibleCount: 0,
    stableReDetectionRecoveredCount: 0,
    stableReDetectionRecall: null,
    maximumStableReDetectionLatencyMs: null,
  });
  assert.equal(assertTapVidQueryQualityFloor('short-segment', metrics, floor), metrics);
  assert.throws(
    () =>
      assertTapVidQueryQualityFloor(
        'short-segment',
        { ...metrics, stableReDetectionEligibleCount: 1 },
        floor,
      ),
    /stableReDetectionEligibleCount 1 must be 0/,
  );
});

test('eligible zero-recall baselines keep a finite future latency ceiling', () => {
  const floor = eligibleFloor({ minimumStableRecall: 0, maximumStableLatencyMs: 500 });
  const unrecovered = queryMetrics({
    stableReDetectionRecoveredCount: 0,
    stableReDetectionRecall: 0,
    maximumStableReDetectionLatencyMs: null,
  });
  assert.equal(assertTapVidQueryQualityFloor('unrecovered', unrecovered, floor), unrecovered);
  assert.throws(
    () =>
      assertTapVidQueryQualityFloor('inconsistent', { ...unrecovered, stableReDetectionRecall: 1 }, floor),
    /stableReDetectionRecall 1 is inconsistent with recovery counts/,
  );
});

test('one query cannot borrow temporal headroom from a weaker sibling', () => {
  const regressedStrongTrack = queryMetrics({
    maximumMissedVisibleDurationMs: 1000 / 30,
    visibleTrackFragmentationCount: 1,
  });
  const weakFloor = {
    ...eligibleFloor(),
    maximumMissedVisibleDurationMs: 1834,
    maximumVisibleTrackFragmentationCount: 3,
  };
  assert.equal(assertTapVidQueryQualityFloor('weak', regressedStrongTrack, weakFloor), regressedStrongTrack);
  assert.throws(
    () => assertTapVidQueryQualityFloor('strong', regressedStrongTrack, eligibleFloor()),
    /strong maximumMissedVisibleDurationMs 33.333333333333336 exceeds 0/,
  );
});
