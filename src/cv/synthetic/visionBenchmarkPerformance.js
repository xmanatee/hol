export const VISION_PERFORMANCE_BUDGETS = {
  frameBudgetMs: 16.67,
  trackingFrameBudgetMs: 4,
  opencvStageBudgetMs: 6,
};

const ENVELOPE_STAGE_TIMINGS = new Set([
  'totalMs',
  'keypointUpdateMs',
]);

const finiteMetric = value => Number.isFinite(value) ? value : null;

const sortMetric = value => Number.isFinite(value) ? value : -Infinity;

const meanOrNull = (sum, count) => count ? sum / count : null;

const positiveFrameCount = value => Number.isFinite(value) && value > 0 ? value : null;

const maxNullable = (current, value) => (
  current === null ? value : Math.max(current, value)
);

const createAccumulator = () => ({
  count: 0,
  invalidRuntimeCount: 0,
  missingProcessingReports: 0,
  wallTimeSum: 0,
  frameCount: 0,
  processingTimeSum: 0,
  processingFrameCount: 0,
  maxReplayWallTimeMs: null,
  maxFrameProcessingTimeMs: null,
  maxP95FrameProcessingTimeMs: null,
  stageTimings: {},
});

const addRuntime = (accumulator, runtime) => {
  const wallTimeMs = finiteMetric(runtime?.wallTimeMs);
  const frameCount = positiveFrameCount(runtime?.frameCount);
  const meanProcessingTimeMs = finiteMetric(runtime?.meanProcessingTimeMs);
  const p95ProcessingTimeMs = finiteMetric(runtime?.p95ProcessingTimeMs);
  const maxProcessingTimeMs = finiteMetric(runtime?.maxProcessingTimeMs);

  accumulator.count++;
  if (wallTimeMs === null || frameCount === null) {
    accumulator.invalidRuntimeCount++;
  } else {
    accumulator.wallTimeSum += wallTimeMs;
    accumulator.frameCount += frameCount;
    accumulator.maxReplayWallTimeMs = maxNullable(accumulator.maxReplayWallTimeMs, wallTimeMs);
  }

  if (meanProcessingTimeMs === null || frameCount === null) {
    accumulator.missingProcessingReports++;
  } else {
    accumulator.processingTimeSum += meanProcessingTimeMs * frameCount;
    accumulator.processingFrameCount += frameCount;
  }

  if (maxProcessingTimeMs !== null) {
    accumulator.maxFrameProcessingTimeMs = maxNullable(
      accumulator.maxFrameProcessingTimeMs,
      maxProcessingTimeMs
    );
  }

  if (p95ProcessingTimeMs !== null) {
    accumulator.maxP95FrameProcessingTimeMs = maxNullable(
      accumulator.maxP95FrameProcessingTimeMs,
      p95ProcessingTimeMs
    );
  }

  for (const [stage, timing] of Object.entries(runtime?.stageTimings || {})) {
    const stageFrameCount = positiveFrameCount(timing.frameCount) || frameCount;
    const meanMs = finiteMetric(timing.meanMs);
    const maxMs = finiteMetric(timing.maxMs);
    if (stageFrameCount === null || meanMs === null) {
      continue;
    }
    const stageAccumulator = accumulator.stageTimings[stage] || {
      timeSum: 0,
      frameCount: 0,
      maxMs: null,
    };
    stageAccumulator.timeSum += meanMs * stageFrameCount;
    stageAccumulator.frameCount += stageFrameCount;
    if (maxMs !== null) {
      stageAccumulator.maxMs = maxNullable(stageAccumulator.maxMs, maxMs);
    }
    accumulator.stageTimings[stage] = stageAccumulator;
  }
};

const finalizeStageTimings = (stageTimings, totalFrameCount) => Object.fromEntries(Object.entries(stageTimings)
  .map(([stage, timing]) => [stage, {
    meanMs: meanOrNull(timing.timeSum, timing.frameCount),
    maxMs: timing.maxMs,
    frameCount: timing.frameCount,
    coverageRatio: meanOrNull(timing.frameCount, totalFrameCount),
    amortizedMeanMs: meanOrNull(timing.timeSum, totalFrameCount),
  }])
  .sort((left, right) => (
    sortMetric(right[1].amortizedMeanMs) - sortMetric(left[1].amortizedMeanMs) ||
    sortMetric(right[1].meanMs) - sortMetric(left[1].meanMs) ||
    sortMetric(right[1].maxMs) - sortMetric(left[1].maxMs) ||
    left[0].localeCompare(right[0])
  )));

const budgetStageReport = ([stage, timing]) => ({
  stage,
  meanMs: timing.meanMs,
  maxMs: timing.maxMs,
  frameCount: timing.frameCount,
  coverageRatio: timing.coverageRatio,
  amortizedMeanMs: timing.amortizedMeanMs,
});

const budgetFor = finalized => ({
  frameBudgetMs: VISION_PERFORMANCE_BUDGETS.frameBudgetMs,
  trackingFrameBudgetMs: VISION_PERFORMANCE_BUDGETS.trackingFrameBudgetMs,
  opencvStageBudgetMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs,
  meanFrameProcessingOverBudget: Number.isFinite(finalized.meanFrameProcessingTimeMs) &&
    finalized.meanFrameProcessingTimeMs > VISION_PERFORMANCE_BUDGETS.trackingFrameBudgetMs,
  p95FrameProcessingOverBudget: Number.isFinite(finalized.maxP95FrameProcessingTimeMs) &&
    finalized.maxP95FrameProcessingTimeMs > VISION_PERFORMANCE_BUDGETS.frameBudgetMs,
  maxFrameProcessingOverBudget: Number.isFinite(finalized.maxFrameProcessingTimeMs) &&
    finalized.maxFrameProcessingTimeMs > VISION_PERFORMANCE_BUDGETS.frameBudgetMs,
  stageOverages: Object.entries(finalized.stageTimings)
    .filter(([stage]) => !ENVELOPE_STAGE_TIMINGS.has(stage))
    .filter(([, timing]) => (
      Number.isFinite(timing.amortizedMeanMs) &&
        timing.amortizedMeanMs > VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs
    ))
    .map(budgetStageReport),
  stageSpikeOverages: Object.entries(finalized.stageTimings)
    .filter(([stage]) => !ENVELOPE_STAGE_TIMINGS.has(stage))
    .filter(([, timing]) => !(
      Number.isFinite(timing.amortizedMeanMs) &&
        timing.amortizedMeanMs > VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs
    ))
    .filter(([, timing]) => (
      Number.isFinite(timing.meanMs) &&
        timing.meanMs > VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs
    ) || (
      Number.isFinite(timing.maxMs) &&
        timing.maxMs > VISION_PERFORMANCE_BUDGETS.frameBudgetMs
    ))
    .map(budgetStageReport),
  excludedStageTimings: Object.entries(finalized.stageTimings)
    .filter(([stage]) => ENVELOPE_STAGE_TIMINGS.has(stage))
    .map(budgetStageReport),
});

const finalizeAccumulator = accumulator => {
  const validRuntimeCount = accumulator.count - accumulator.invalidRuntimeCount;
  const finalized = {
    count: accumulator.count,
    invalidRuntimeCount: accumulator.invalidRuntimeCount,
    missingProcessingReports: accumulator.missingProcessingReports,
    frameCount: accumulator.frameCount,
    totalWallTimeMs: accumulator.wallTimeSum,
    meanReplayWallTimeMs: meanOrNull(accumulator.wallTimeSum, validRuntimeCount),
    meanFrameWallTimeMs: meanOrNull(accumulator.wallTimeSum, accumulator.frameCount),
    meanFrameProcessingTimeMs: meanOrNull(accumulator.processingTimeSum, accumulator.processingFrameCount),
    maxReplayWallTimeMs: accumulator.maxReplayWallTimeMs,
    maxFrameProcessingTimeMs: accumulator.maxFrameProcessingTimeMs,
    maxP95FrameProcessingTimeMs: accumulator.maxP95FrameProcessingTimeMs,
    stageTimings: finalizeStageTimings(accumulator.stageTimings, accumulator.frameCount),
  };
  return {
    ...finalized,
    budget: budgetFor(finalized),
  };
};

const addToGroup = (groups, key, runtime) => {
  const group = groups[key] || createAccumulator();
  addRuntime(group, runtime);
  groups[key] = group;
};

const finalizeGroups = groups => Object.entries(groups)
  .map(([name, accumulator]) => ({
    name,
    ...finalizeAccumulator(accumulator),
  }))
  .sort((left, right) => (
    sortMetric(right.meanFrameProcessingTimeMs) - sortMetric(left.meanFrameProcessingTimeMs) ||
    sortMetric(right.maxFrameProcessingTimeMs) - sortMetric(left.maxFrameProcessingTimeMs) ||
    sortMetric(right.meanReplayWallTimeMs) - sortMetric(left.meanReplayWallTimeMs) ||
    left.name.localeCompare(right.name)
  ));

export const summarizeVisionBenchmarkPerformance = reports => {
  const aggregate = createAccumulator();
  const groups = {
    byMode: {},
    byObject: {},
    byBackground: {},
    byMotion: {},
    byOcclusion: {},
  };

  for (const report of reports) {
    addRuntime(aggregate, report.runtime);
    addToGroup(groups.byMode, report.mode, report.runtime);
    addToGroup(groups.byObject, report.axes.object, report.runtime);
    addToGroup(groups.byBackground, report.axes.background, report.runtime);
    addToGroup(groups.byMotion, report.axes.motion, report.runtime);
    addToGroup(groups.byOcclusion, report.axes.occlusion, report.runtime);
  }

  return {
    aggregate: finalizeAccumulator(aggregate),
    byMode: finalizeGroups(groups.byMode),
    byObject: finalizeGroups(groups.byObject),
    byBackground: finalizeGroups(groups.byBackground),
    byMotion: finalizeGroups(groups.byMotion),
    byOcclusion: finalizeGroups(groups.byOcclusion),
    slowestReports: [...reports]
      .sort((left, right) => (
        sortMetric(right.runtime?.maxProcessingTimeMs) - sortMetric(left.runtime?.maxProcessingTimeMs) ||
        sortMetric(right.runtime?.p95ProcessingTimeMs) - sortMetric(left.runtime?.p95ProcessingTimeMs) ||
        sortMetric(right.runtime?.meanProcessingTimeMs) - sortMetric(left.runtime?.meanProcessingTimeMs) ||
        sortMetric(right.runtime?.wallTimeMs) - sortMetric(left.runtime?.wallTimeMs) ||
        left.name.localeCompare(right.name) ||
        left.mode.localeCompare(right.mode)
      ))
      .slice(0, 12)
      .map(report => ({
        name: report.name,
        mode: report.mode,
        axes: report.axes,
        runtime: report.runtime,
      })),
  };
};
