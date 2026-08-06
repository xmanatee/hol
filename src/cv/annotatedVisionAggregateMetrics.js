const MEAN_METRICS = Object.freeze([
  'averageJaccard',
  'averagePointsWithinThreshold',
  'occlusionAccuracy',
  'ptsWithin1',
  'ptsWithin2',
  'ptsWithin4',
  'ptsWithin8',
  'ptsWithin16',
  'jaccard1',
  'jaccard2',
  'jaccard4',
  'jaccard8',
  'jaccard16',
]);

const requireReports = (reports) => {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new TypeError('fixtureReports must be a non-empty array');
  }
  return reports;
};

const finiteValues = (reports, metricName, { optional = false } = {}) => {
  const values = reports.map(({ metrics }) => metrics?.[metricName]);
  if (!optional && !values.every(Number.isFinite)) {
    throw new TypeError(`${metricName} must be finite for every fixture report`);
  }
  return values.filter(Number.isFinite);
};

const meanMetric = (reports, metricName, options) => {
  const values = finiteValues(reports, metricName, options);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
};

const maximumMetric = (reports, metricName, options) => {
  const values = finiteValues(reports, metricName, options);
  return values.length === 0 ? null : Math.max(...values);
};

const sumCount = (reports, metricName) =>
  reports.reduce((sum, { metrics }, index) => {
    const value = metrics?.[metricName];
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`fixtureReports[${index}].metrics.${metricName} must be a non-negative integer`);
    }
    return sum + value;
  }, 0);

export const aggregateAnnotatedVisionFixtureMetrics = (value) => {
  const reports = requireReports(value);
  const aggregate = Object.fromEntries(
    MEAN_METRICS.map((metricName) => [metricName, meanMetric(reports, metricName)]),
  );
  aggregate.reDetectionAverageJaccard = meanMetric(reports, 'reDetectionAverageJaccard', {
    optional: true,
  });
  aggregate.stableReDetectionEligibleCount = sumCount(reports, 'stableReDetectionEligibleCount');
  aggregate.stableReDetectionRecoveredCount = sumCount(reports, 'stableReDetectionRecoveredCount');
  if (aggregate.stableReDetectionRecoveredCount > aggregate.stableReDetectionEligibleCount) {
    throw new TypeError('stable re-detection recovered count must not exceed eligible count');
  }
  aggregate.stableReDetectionRecall =
    aggregate.stableReDetectionEligibleCount === 0
      ? null
      : aggregate.stableReDetectionRecoveredCount / aggregate.stableReDetectionEligibleCount;
  aggregate.maximumStableReDetectionLatencyMs = maximumMetric(reports, 'maximumStableReDetectionLatencyMs', {
    optional: true,
  });
  aggregate.maximumFalseVisibleDurationMs = maximumMetric(reports, 'maximumFalseVisibleDurationMs');
  aggregate.maximumMissedVisibleDurationMs = maximumMetric(reports, 'maximumMissedVisibleDurationMs');
  aggregate.visibleTrackFragmentationCount = sumCount(reports, 'visibleTrackFragmentationCount');
  return aggregate;
};
