const finiteMetric = value => Number.isFinite(value) ? value : 0;

const createAccumulator = () => ({
  count: 0,
  wallTimeSum: 0,
  frameCount: 0,
  processingTimeSum: 0,
  processingFrameCount: 0,
  maxReplayWallTimeMs: 0,
  maxFrameProcessingTimeMs: 0,
  stageTimings: {},
});

const addRuntime = (accumulator, runtime) => {
  const wallTimeMs = finiteMetric(runtime?.wallTimeMs);
  const frameCount = finiteMetric(runtime?.frameCount);
  const meanProcessingTimeMs = finiteMetric(runtime?.meanProcessingTimeMs);
  const maxProcessingTimeMs = finiteMetric(runtime?.maxProcessingTimeMs);

  accumulator.count++;
  accumulator.wallTimeSum += wallTimeMs;
  accumulator.frameCount += frameCount;
  accumulator.processingTimeSum += meanProcessingTimeMs * frameCount;
  accumulator.processingFrameCount += frameCount;
  accumulator.maxReplayWallTimeMs = Math.max(accumulator.maxReplayWallTimeMs, wallTimeMs);
  accumulator.maxFrameProcessingTimeMs = Math.max(accumulator.maxFrameProcessingTimeMs, maxProcessingTimeMs);

  for (const [stage, timing] of Object.entries(runtime?.stageTimings || {})) {
    const stageFrameCount = finiteMetric(timing.frameCount) || frameCount;
    const stageAccumulator = accumulator.stageTimings[stage] || {
      timeSum: 0,
      frameCount: 0,
      maxMs: 0,
    };
    stageAccumulator.timeSum += finiteMetric(timing.meanMs) * stageFrameCount;
    stageAccumulator.frameCount += stageFrameCount;
    stageAccumulator.maxMs = Math.max(stageAccumulator.maxMs, finiteMetric(timing.maxMs));
    accumulator.stageTimings[stage] = stageAccumulator;
  }
};

const finalizeStageTimings = stageTimings => Object.fromEntries(Object.entries(stageTimings)
  .map(([stage, timing]) => [stage, {
    meanMs: timing.timeSum / Math.max(1, timing.frameCount),
    maxMs: timing.maxMs,
  }])
  .sort((left, right) => (
    right[1].meanMs - left[1].meanMs ||
    right[1].maxMs - left[1].maxMs ||
    left[0].localeCompare(right[0])
  )));

const finalizeAccumulator = accumulator => ({
  count: accumulator.count,
  totalWallTimeMs: accumulator.wallTimeSum,
  meanReplayWallTimeMs: accumulator.wallTimeSum / Math.max(1, accumulator.count),
  meanFrameWallTimeMs: accumulator.wallTimeSum / Math.max(1, accumulator.frameCount),
  meanFrameProcessingTimeMs: accumulator.processingTimeSum / Math.max(1, accumulator.processingFrameCount),
  maxReplayWallTimeMs: accumulator.maxReplayWallTimeMs,
  maxFrameProcessingTimeMs: accumulator.maxFrameProcessingTimeMs,
  stageTimings: finalizeStageTimings(accumulator.stageTimings),
});

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
    right.meanReplayWallTimeMs - left.meanReplayWallTimeMs ||
    right.maxReplayWallTimeMs - left.maxReplayWallTimeMs ||
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
        finiteMetric(right.runtime?.wallTimeMs) - finiteMetric(left.runtime?.wallTimeMs) ||
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
