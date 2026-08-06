const increment = (counts, key) => {
  counts[key] = (counts[key] || 0) + 1;
};

export const QUICK_VISION_REFRESH_CADENCE_CONTRACT = Object.freeze({
  attempts: 209,
  refreshed: 70,
  failed: 139,
  noReferenceFailures: 139,
  candidateStagesEvaluated: 95,
  candidateStagesSkipped: 114,
  refreshGfttCalls: 70,
  refreshGfttPixels: 3873713,
  refreshGfttPreparations: 70,
  reinitializationGfttCalls: 25,
  reinitializationGfttPixels: 1180818,
  reinitializationGfttPreparations: 25,
  reinitialized: 25,
  reinitializationFailures: 0,
  orbKeyframeExtractionFrames: 254,
  learnedRelocalizationExtractionFrames: 26,
  failureReasons: { 'no-reference-transform': 139 },
});

export const QUICK_VISION_QUALITY_PROJECTION_SHA256 =
  '2d9df2e31dbba12bd734dac5a3cacfa6577adbea74cc16960c56e2fd787a361d';

export const compareVisionRefreshCadence = (actual, expected) =>
  Object.entries(expected).flatMap(([field, expectedValue]) => {
    const actualValue = actual[field];
    if (typeof expectedValue === 'object') {
      return JSON.stringify(actualValue) === JSON.stringify(expectedValue)
        ? []
        : [{ field, expected: expectedValue, actual: actualValue }];
    }
    return actualValue === expectedValue ? [] : [{ field, expected: expectedValue, actual: actualValue }];
  });

export const summarizeVisionRefreshCadence = (frames) => {
  const summary = {
    attempts: 0,
    refreshed: 0,
    failed: 0,
    noReferenceFailures: 0,
    candidateStagesEvaluated: 0,
    candidateStagesSkipped: 0,
    refreshGfttCalls: 0,
    refreshGfttPixels: 0,
    refreshGfttPreparations: 0,
    reinitializationGfttCalls: 0,
    reinitializationGfttPixels: 0,
    reinitializationGfttPreparations: 0,
    reinitialized: 0,
    reinitializationFailures: 0,
    orbKeyframeExtractionFrames: 0,
    learnedRelocalizationExtractionFrames: 0,
    failureReasons: {},
  };

  for (const frame of frames) {
    if (frame.runtime?.admittedUpdate !== true) continue;

    const metrics = frame.metrics || {};
    const stageTimings = frame.runtime.stageTimings || {};
    if (Number.isFinite(stageTimings.keyframeFeatureExtractionMs)) {
      summary.orbKeyframeExtractionFrames++;
    }
    if (Number.isFinite(stageTimings.relocalizationFeatureExtractionMs)) {
      summary.learnedRelocalizationExtractionFrames++;
    }

    let reinitializationGfttCallCount = 0;
    if (metrics.keypointReinitializationResult === 'reinitialized') {
      summary.reinitialized++;
    } else if (metrics.keypointReinitializationResult) {
      summary.reinitializationFailures++;
    }
    if (metrics.keypointReinitializationResult) {
      reinitializationGfttCallCount = metrics.keypointReinitializationGfttCallCount;
      const reinitializationGfttPixelCount = metrics.keypointReinitializationGfttPixelCount;
      const reinitializationGfttPreparationCount = metrics.keypointReinitializationGfttPreparationCount;
      if (
        !Number.isInteger(reinitializationGfttCallCount) ||
        !Number.isInteger(reinitializationGfttPixelCount) ||
        !Number.isInteger(reinitializationGfttPreparationCount)
      ) {
        throw new Error('Keypoint reinitialization is missing exact GFTT work telemetry');
      }
      summary.reinitializationGfttCalls += reinitializationGfttCallCount;
      summary.reinitializationGfttPixels += reinitializationGfttPixelCount;
      summary.reinitializationGfttPreparations += reinitializationGfttPreparationCount;
    }

    const gfttCallCount = metrics.landmarkRefreshGfttCallCount;
    if (!Number.isInteger(gfttCallCount)) continue;
    const gfttPixelCount = metrics.landmarkRefreshGfttPixelCount;
    const gfttPreparationCount = metrics.landmarkRefreshGfttPreparationCount;
    if (!Number.isInteger(gfttPixelCount) || !Number.isInteger(gfttPreparationCount)) {
      throw new Error('Landmark refresh is missing exact GFTT work telemetry');
    }

    summary.attempts++;
    summary.refreshGfttCalls += gfttCallCount;
    summary.refreshGfttPixels += gfttPixelCount;
    summary.refreshGfttPreparations += gfttPreparationCount;
    if (gfttCallCount > 0 || reinitializationGfttCallCount > 0) {
      summary.candidateStagesEvaluated++;
    } else {
      summary.candidateStagesSkipped++;
    }

    const failureReason = metrics.landmarkRefreshFailureReason;
    if (failureReason) {
      summary.failed++;
      increment(summary.failureReasons, failureReason);
      if (failureReason === 'no-reference-transform') {
        summary.noReferenceFailures++;
      }
    } else {
      summary.refreshed++;
    }
  }

  return summary;
};

export const mergeVisionRefreshCadence = (summaries) =>
  summaries.reduce((aggregate, summary) => {
    for (const key of [
      'attempts',
      'refreshed',
      'failed',
      'noReferenceFailures',
      'candidateStagesEvaluated',
      'candidateStagesSkipped',
      'refreshGfttCalls',
      'refreshGfttPixels',
      'refreshGfttPreparations',
      'reinitializationGfttCalls',
      'reinitializationGfttPixels',
      'reinitializationGfttPreparations',
      'reinitialized',
      'reinitializationFailures',
      'orbKeyframeExtractionFrames',
      'learnedRelocalizationExtractionFrames',
    ]) {
      aggregate[key] += summary[key];
    }
    for (const [reason, count] of Object.entries(summary.failureReasons)) {
      aggregate.failureReasons[reason] = (aggregate.failureReasons[reason] || 0) + count;
    }
    return aggregate;
  }, summarizeVisionRefreshCadence([]));
