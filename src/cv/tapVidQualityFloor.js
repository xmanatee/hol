const assertMinimum = (owner, metrics, metricName, floor, floorName) => {
  if (!Number.isFinite(metrics[metricName]) || metrics[metricName] < floor[floorName]) {
    throw new Error(`${owner}${metricName} ${metrics[metricName]} is below ${floor[floorName]}`);
  }
};

const assertMaximum = (owner, metrics, metricName, floor, floorName) => {
  if (!Number.isFinite(metrics[metricName]) || metrics[metricName] > floor[floorName]) {
    throw new Error(`${owner}${metricName} ${metrics[metricName]} exceeds ${floor[floorName]}`);
  }
};

const AGGREGATE_MINIMUMS = Object.freeze([
  ['averageJaccard', 'minimumAverageJaccard'],
  ['averagePointsWithinThreshold', 'minimumAveragePointsWithinThreshold'],
  ['occlusionAccuracy', 'minimumOcclusionAccuracy'],
]);

const QUERY_MINIMUMS = Object.freeze([
  ['averageJaccard', 'minimumAverageJaccard'],
  ['averagePointsWithinThreshold', 'minimumAveragePointsWithinThreshold'],
  ['occlusionAccuracy', 'minimumOcclusionAccuracy'],
]);

const QUERY_MAXIMUMS = Object.freeze([
  ['p95VisiblePointError', 'maximumP95VisiblePointError'],
  ['maximumFalseVisibleDurationMs', 'maximumFalseVisibleDurationMs'],
  ['maximumMissedVisibleDurationMs', 'maximumMissedVisibleDurationMs'],
  ['visibleTrackFragmentationCount', 'maximumVisibleTrackFragmentationCount'],
]);

const assertCount = (owner, metrics, metricName, expected) => {
  if (metrics[metricName] !== expected) {
    throw new Error(`${owner}${metricName} ${metrics[metricName]} must be ${expected}`);
  }
};

const assertNull = (owner, metrics, metricName) => {
  if (metrics[metricName] !== null) {
    throw new Error(`${owner}${metricName} ${metrics[metricName]} must be null`);
  }
};

const assertEligibleReDetection = (owner, metrics, floor) => {
  if (!Number.isInteger(metrics.eligibleReappearanceCount) || metrics.eligibleReappearanceCount <= 0) {
    throw new Error(
      `${owner}eligibleReappearanceCount ${metrics.eligibleReappearanceCount} must be positive`,
    );
  }
  if (
    !Number.isInteger(metrics.stableReDetectionEligibleCount) ||
    metrics.stableReDetectionEligibleCount <= 0
  ) {
    throw new Error(
      `${owner}stableReDetectionEligibleCount ${metrics.stableReDetectionEligibleCount} must be positive`,
    );
  }
  if (
    !Number.isInteger(metrics.stableReDetectionRecoveredCount) ||
    metrics.stableReDetectionRecoveredCount < 0 ||
    metrics.stableReDetectionRecoveredCount > metrics.stableReDetectionEligibleCount
  ) {
    throw new Error(
      `${owner}stableReDetectionRecoveredCount ${metrics.stableReDetectionRecoveredCount} must be between 0 and stableReDetectionEligibleCount`,
    );
  }
  const expectedRecall = metrics.stableReDetectionRecoveredCount / metrics.stableReDetectionEligibleCount;
  if (metrics.stableReDetectionRecall !== expectedRecall) {
    throw new Error(
      `${owner}stableReDetectionRecall ${metrics.stableReDetectionRecall} is inconsistent with recovery counts`,
    );
  }
  assertMinimum(owner, metrics, 'reDetectionAverageJaccard', floor, 'minimumAverageJaccard');
  assertMinimum(owner, metrics, 'stableReDetectionRecall', floor, 'minimumStableRecall');
  if (metrics.stableReDetectionRecoveredCount === 0) {
    assertNull(owner, metrics, 'maximumStableReDetectionLatencyMs');
    return;
  }
  assertMaximum(owner, metrics, 'maximumStableReDetectionLatencyMs', floor, 'maximumStableLatencyMs');
};

const assertNotApplicableReDetection = (owner, metrics) => {
  assertCount(owner, metrics, 'eligibleReappearanceCount', 0);
  assertCount(owner, metrics, 'stableReDetectionEligibleCount', 0);
  assertCount(owner, metrics, 'stableReDetectionRecoveredCount', 0);
  assertNull(owner, metrics, 'reDetectionAverageJaccard');
  assertNull(owner, metrics, 'stableReDetectionRecall');
  assertNull(owner, metrics, 'maximumStableReDetectionLatencyMs');
};

const assertSegmentOnlyReDetection = (owner, metrics, floor) => {
  if (!Number.isInteger(metrics.eligibleReappearanceCount) || metrics.eligibleReappearanceCount <= 0) {
    throw new Error(
      `${owner}eligibleReappearanceCount ${metrics.eligibleReappearanceCount} must be positive`,
    );
  }
  assertMinimum(owner, metrics, 'reDetectionAverageJaccard', floor, 'minimumAverageJaccard');
  assertCount(owner, metrics, 'stableReDetectionEligibleCount', 0);
  assertCount(owner, metrics, 'stableReDetectionRecoveredCount', 0);
  assertNull(owner, metrics, 'stableReDetectionRecall');
  assertNull(owner, metrics, 'maximumStableReDetectionLatencyMs');
};

const assertReDetection = (owner, metrics, floor) => {
  if (floor.kind === 'not-applicable') {
    assertNotApplicableReDetection(owner, metrics);
  } else if (floor.kind === 'segment-only') {
    assertSegmentOnlyReDetection(owner, metrics, floor);
  } else {
    assertEligibleReDetection(owner, metrics, floor);
  }
};

export const assertTapVidAggregateQualityFloor = (metrics, floor) => {
  for (const [metricName, floorName] of AGGREGATE_MINIMUMS) {
    assertMinimum('', metrics, metricName, floor, floorName);
  }
  assertReDetection('', metrics, floor.reDetection);
  return metrics;
};

export const assertTapVidQueryQualityFloor = (id, metrics, floor) => {
  const owner = `${id} `;
  for (const [metricName, floorName] of QUERY_MINIMUMS) {
    assertMinimum(owner, metrics, metricName, floor, floorName);
  }
  for (const [metricName, floorName] of QUERY_MAXIMUMS) {
    assertMaximum(owner, metrics, metricName, floor, floorName);
  }
  assertReDetection(owner, metrics, floor.reDetection);
  return metrics;
};
