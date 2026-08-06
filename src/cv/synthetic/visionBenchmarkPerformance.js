export const VISION_PERFORMANCE_BUDGETS = {
  frameBudgetMs: 16.67,
  displayFrameIntervalMs: 1000 / 60,
  trackingFrameBudgetMs: 4,
  opencvStageBudgetMs: 6,
};

const ENVELOPE_STAGE_TIMINGS = new Set(['totalMs', 'keypointUpdateMs']);

const STAGE_TIMING_CHILDREN = {
  trackingValidationMs: ['landmarkMetricsMs', 'preliminaryAttachmentEvidenceMs', 'relocalizationMs'],
  poseEstimationMs: ['objectPoseMs', 'reconstructionUpdateMs', 'planarPoseMs'],
  poseSelectionMs: ['trackerAttachmentEvidenceMs', 'trackerAttachmentResolveMs'],
  keyframeStoreMs: ['keyframeFeatureExtractionMs'],
  templateUpdateMs: ['keypointRefreshMs', 'keypointReinitializationMs'],
  relocalizationMs: ['relocalizationFeatureExtractionMs', 'relocalizationKeyframeSearchMs'],
};

const finiteMetric = (value) => (Number.isFinite(value) ? value : null);

const sortMetric = (value) => (Number.isFinite(value) ? value : -Infinity);

const meanOrNull = (sum, count) => (count ? sum / count : null);

const positiveFrameCount = (value) => (Number.isFinite(value) && value > 0 ? value : null);

const maxNullable = (current, value) => (current === null ? value : Math.max(current, value));

const createAccumulator = () => ({
  count: 0,
  invalidRuntimeCount: 0,
  missingProcessingReports: 0,
  replayWallTimeSum: 0,
  sourceFrameCount: 0,
  displayFrameCount: 0,
  admittedUpdateCount: 0,
  heldFrameCount: 0,
  activeUpdateTimeSum: 0,
  activeUpdateCount: 0,
  presentationPredictionTimeSum: 0,
  presentationPredictionFrameCount: 0,
  maxReplayWallTimeMs: null,
  maxActiveUpdateTimeMs: null,
  maxP95ActiveUpdateTimeMs: null,
  maxPoseAgeMs: null,
  maxPresentationPredictionTimeMs: null,
  cadenceLatencyOverageCount: 0,
  stageTimings: {},
});

const addRuntime = (accumulator, runtime) => {
  const replayWallTimeMs = finiteMetric(runtime?.replayWallTimeMs);
  const sourceFrameCount = positiveFrameCount(runtime?.sourceFrameCount);
  const displayFrameCount = positiveFrameCount(runtime?.displayFrameCount);
  const admittedUpdateCount = positiveFrameCount(runtime?.admittedUpdateCount);
  const heldFrameCount =
    Number.isFinite(runtime?.heldFrameCount) && runtime.heldFrameCount >= 0 ? runtime.heldFrameCount : null;
  const meanActiveUpdateTimeMs = finiteMetric(runtime?.meanActiveUpdateTimeMs);
  const p95ActiveUpdateTimeMs = finiteMetric(runtime?.p95ActiveUpdateTimeMs);
  const maxActiveUpdateTimeMs = finiteMetric(runtime?.maxActiveUpdateTimeMs);
  const maxPoseAgeMs = finiteMetric(runtime?.maxPoseAgeMs);
  const updateIntervalMs = finiteMetric(runtime?.updateIntervalMs);
  const presentationPredictionFrameCount = positiveFrameCount(runtime?.presentationPredictionFrameCount);
  const meanPresentationPredictionTimeMs = finiteMetric(runtime?.meanPresentationPredictionTimeMs);
  const maxPresentationPredictionTimeMs = finiteMetric(runtime?.maxPresentationPredictionTimeMs);

  accumulator.count++;
  if (
    replayWallTimeMs === null ||
    sourceFrameCount === null ||
    displayFrameCount === null ||
    admittedUpdateCount === null ||
    heldFrameCount === null
  ) {
    accumulator.invalidRuntimeCount++;
  } else {
    accumulator.replayWallTimeSum += replayWallTimeMs;
    accumulator.sourceFrameCount += sourceFrameCount;
    accumulator.displayFrameCount += displayFrameCount;
    accumulator.admittedUpdateCount += admittedUpdateCount;
    accumulator.heldFrameCount += heldFrameCount;
    accumulator.maxReplayWallTimeMs = maxNullable(accumulator.maxReplayWallTimeMs, replayWallTimeMs);
  }

  if (meanActiveUpdateTimeMs === null || admittedUpdateCount === null) {
    accumulator.missingProcessingReports++;
  } else {
    accumulator.activeUpdateTimeSum += meanActiveUpdateTimeMs * admittedUpdateCount;
    accumulator.activeUpdateCount += admittedUpdateCount;
  }

  if (presentationPredictionFrameCount !== null && meanPresentationPredictionTimeMs !== null) {
    accumulator.presentationPredictionTimeSum +=
      meanPresentationPredictionTimeMs * presentationPredictionFrameCount;
    accumulator.presentationPredictionFrameCount += presentationPredictionFrameCount;
  }
  if (maxPresentationPredictionTimeMs !== null) {
    accumulator.maxPresentationPredictionTimeMs = maxNullable(
      accumulator.maxPresentationPredictionTimeMs,
      maxPresentationPredictionTimeMs,
    );
  }

  if (maxActiveUpdateTimeMs !== null) {
    accumulator.maxActiveUpdateTimeMs = maxNullable(accumulator.maxActiveUpdateTimeMs, maxActiveUpdateTimeMs);
  }

  if (p95ActiveUpdateTimeMs !== null) {
    accumulator.maxP95ActiveUpdateTimeMs = maxNullable(
      accumulator.maxP95ActiveUpdateTimeMs,
      p95ActiveUpdateTimeMs,
    );
  }

  if (maxPoseAgeMs !== null) {
    accumulator.maxPoseAgeMs = maxNullable(accumulator.maxPoseAgeMs, maxPoseAgeMs);
  }

  if (
    p95ActiveUpdateTimeMs !== null &&
    updateIntervalMs !== null &&
    p95ActiveUpdateTimeMs > updateIntervalMs
  ) {
    accumulator.cadenceLatencyOverageCount++;
  }

  for (const [stage, timing] of Object.entries(runtime?.stageTimings || {})) {
    const stageFrameCount = positiveFrameCount(timing.frameCount) || admittedUpdateCount;
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

const exclusiveStageTime = (stage, timing, stageTimings) =>
  Math.max(
    0,
    timing.timeSum -
      (STAGE_TIMING_CHILDREN[stage] || []).reduce(
        (sum, child) => sum + (stageTimings[child]?.timeSum || 0),
        0,
      ),
  );

const finalizeStageTimings = (stageTimings, { sourceFrameCount, displayFrameCount, admittedUpdateCount }) =>
  Object.fromEntries(
    Object.entries(stageTimings)
      .map(([stage, timing]) => {
        const exclusiveTimeMs = exclusiveStageTime(stage, timing, stageTimings);
        return [
          stage,
          {
            ownership: ENVELOPE_STAGE_TIMINGS.has(stage) ? 'envelope' : 'owned',
            meanMs: meanOrNull(timing.timeSum, timing.frameCount),
            exclusiveMeanMs: meanOrNull(exclusiveTimeMs, timing.frameCount),
            maxMs: timing.maxMs,
            frameCount: timing.frameCount,
            sourceCoverageRatio: meanOrNull(timing.frameCount, sourceFrameCount),
            admittedCoverageRatio: meanOrNull(timing.frameCount, admittedUpdateCount),
            sourceAmortizedMeanMs: meanOrNull(timing.timeSum, sourceFrameCount),
            displayAmortizedMeanMs: meanOrNull(timing.timeSum, displayFrameCount),
            displayAmortizedExclusiveMeanMs: meanOrNull(exclusiveTimeMs, displayFrameCount),
            inclusiveTimeMs: timing.timeSum,
            exclusiveTimeMs,
          },
        ];
      })
      .sort(
        (left, right) =>
          sortMetric(right[1].displayAmortizedExclusiveMeanMs) -
            sortMetric(left[1].displayAmortizedExclusiveMeanMs) ||
          sortMetric(right[1].displayAmortizedMeanMs) - sortMetric(left[1].displayAmortizedMeanMs) ||
          sortMetric(right[1].meanMs) - sortMetric(left[1].meanMs) ||
          sortMetric(right[1].maxMs) - sortMetric(left[1].maxMs) ||
          left[0].localeCompare(right[0]),
      ),
  );

const budgetStageReport = ([stage, timing]) => ({
  stage,
  ownership: timing.ownership,
  meanMs: timing.meanMs,
  exclusiveMeanMs: timing.exclusiveMeanMs,
  maxMs: timing.maxMs,
  frameCount: timing.frameCount,
  sourceCoverageRatio: timing.sourceCoverageRatio,
  admittedCoverageRatio: timing.admittedCoverageRatio,
  sourceAmortizedMeanMs: timing.sourceAmortizedMeanMs,
  displayAmortizedMeanMs: timing.displayAmortizedMeanMs,
  displayAmortizedExclusiveMeanMs: timing.displayAmortizedExclusiveMeanMs,
});

const budgetFor = (finalized) => ({
  frameBudgetMs: VISION_PERFORMANCE_BUDGETS.frameBudgetMs,
  displayFrameIntervalMs: VISION_PERFORMANCE_BUDGETS.displayFrameIntervalMs,
  trackingFrameBudgetMs: VISION_PERFORMANCE_BUDGETS.trackingFrameBudgetMs,
  opencvStageBudgetMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs,
  displayAmortizedUpdateOverBudget:
    Number.isFinite(finalized.displayAmortizedUpdateTimeMs) &&
    finalized.displayAmortizedUpdateTimeMs > VISION_PERFORMANCE_BUDGETS.trackingFrameBudgetMs,
  cadenceLatencyOverageCount: finalized.cadenceLatencyOverageCount,
  stageOverages: Object.entries(finalized.stageTimings)
    .filter(([stage]) => !ENVELOPE_STAGE_TIMINGS.has(stage))
    .filter(
      ([, timing]) =>
        Number.isFinite(timing.displayAmortizedExclusiveMeanMs) &&
        timing.displayAmortizedExclusiveMeanMs > VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs,
    )
    .map(budgetStageReport),
  stageSpikeOverages: Object.entries(finalized.stageTimings)
    .filter(([stage]) => !ENVELOPE_STAGE_TIMINGS.has(stage))
    .filter(
      ([, timing]) =>
        !(
          Number.isFinite(timing.displayAmortizedExclusiveMeanMs) &&
          timing.displayAmortizedExclusiveMeanMs > VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs
        ),
    )
    .filter(
      ([stage, timing]) =>
        (Number.isFinite(timing.exclusiveMeanMs) &&
          timing.exclusiveMeanMs > VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs) ||
        (!STAGE_TIMING_CHILDREN[stage] &&
          Number.isFinite(timing.maxMs) &&
          timing.maxMs > VISION_PERFORMANCE_BUDGETS.frameBudgetMs),
    )
    .map(budgetStageReport),
  excludedStageTimings: Object.entries(finalized.stageTimings)
    .filter(([stage]) => ENVELOPE_STAGE_TIMINGS.has(stage))
    .map(budgetStageReport),
});

const finalizeAccumulator = (accumulator) => {
  const validRuntimeCount = accumulator.count - accumulator.invalidRuntimeCount;
  const stageTimings = finalizeStageTimings(accumulator.stageTimings, accumulator);
  const ownedStageTimeMs = Object.entries(stageTimings)
    .filter(([stage]) => !ENVELOPE_STAGE_TIMINGS.has(stage))
    .reduce((sum, [, timing]) => sum + timing.exclusiveTimeMs, 0);
  const unattributedUpdateTimeMs = Math.max(0, accumulator.activeUpdateTimeSum - ownedStageTimeMs);
  const finalized = {
    count: accumulator.count,
    invalidRuntimeCount: accumulator.invalidRuntimeCount,
    missingProcessingReports: accumulator.missingProcessingReports,
    sourceFrameCount: accumulator.sourceFrameCount,
    displayFrameCount: accumulator.displayFrameCount,
    admittedUpdateCount: accumulator.admittedUpdateCount,
    heldFrameCount: accumulator.heldFrameCount,
    admissionRatio: meanOrNull(accumulator.admittedUpdateCount, accumulator.sourceFrameCount),
    totalReplayWallTimeMs: accumulator.replayWallTimeSum,
    meanReplayWallTimeMs: meanOrNull(accumulator.replayWallTimeSum, validRuntimeCount),
    meanSourceFrameWallTimeMs: meanOrNull(accumulator.replayWallTimeSum, accumulator.sourceFrameCount),
    meanActiveUpdateTimeMs: meanOrNull(accumulator.activeUpdateTimeSum, accumulator.activeUpdateCount),
    displayAmortizedUpdateTimeMs: meanOrNull(accumulator.activeUpdateTimeSum, accumulator.displayFrameCount),
    presentationPredictionFrameCount: accumulator.presentationPredictionFrameCount,
    meanPresentationPredictionTimeMs: meanOrNull(
      accumulator.presentationPredictionTimeSum,
      accumulator.presentationPredictionFrameCount,
    ),
    displayAmortizedPresentationPredictionTimeMs: meanOrNull(
      accumulator.presentationPredictionTimeSum,
      accumulator.displayFrameCount,
    ),
    maxPresentationPredictionTimeMs: accumulator.maxPresentationPredictionTimeMs,
    maxReplayWallTimeMs: accumulator.maxReplayWallTimeMs,
    maxActiveUpdateTimeMs: accumulator.maxActiveUpdateTimeMs,
    maxP95ActiveUpdateTimeMs: accumulator.maxP95ActiveUpdateTimeMs,
    maxPoseAgeMs: accumulator.maxPoseAgeMs,
    cadenceLatencyOverageCount: accumulator.cadenceLatencyOverageCount,
    ownedStageTimeMs,
    displayAmortizedOwnedStageTimeMs: meanOrNull(ownedStageTimeMs, accumulator.displayFrameCount),
    timingCoverageRatio: meanOrNull(ownedStageTimeMs, accumulator.activeUpdateTimeSum),
    unattributedUpdateTimeMs,
    displayAmortizedUnattributedUpdateTimeMs: meanOrNull(
      unattributedUpdateTimeMs,
      accumulator.displayFrameCount,
    ),
    stageTimings,
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

const targetClassFor = (report) => report.axes.targetClass || 'missing-target-class';
const geometryFor = (report) => report.axes.geometry || 'missing-geometry';
const lightingFor = (report) => report.axes.lighting || 'missing-lighting';
const interactionKey = (...parts) => parts.join(' / ');

const finalizeGroups = (groups) =>
  Object.entries(groups)
    .map(([name, accumulator]) => ({
      name,
      ...finalizeAccumulator(accumulator),
    }))
    .sort(
      (left, right) =>
        sortMetric(right.displayAmortizedUpdateTimeMs) - sortMetric(left.displayAmortizedUpdateTimeMs) ||
        sortMetric(right.meanActiveUpdateTimeMs) - sortMetric(left.meanActiveUpdateTimeMs) ||
        sortMetric(right.maxActiveUpdateTimeMs) - sortMetric(left.maxActiveUpdateTimeMs) ||
        sortMetric(right.meanReplayWallTimeMs) - sortMetric(left.meanReplayWallTimeMs) ||
        left.name.localeCompare(right.name),
    );

export const summarizeVisionBenchmarkPerformance = (reports) => {
  const aggregate = createAccumulator();
  const groups = {
    byMode: {},
    byObject: {},
    byTargetClass: {},
    byGeometry: {},
    byBackground: {},
    byLighting: {},
    byMotion: {},
    byOcclusion: {},
    byModeObject: {},
    byModeGeometry: {},
  };

  for (const report of reports) {
    const geometry = geometryFor(report);
    addRuntime(aggregate, report.runtime);
    addToGroup(groups.byMode, report.mode, report.runtime);
    addToGroup(groups.byObject, report.axes.object, report.runtime);
    addToGroup(groups.byTargetClass, targetClassFor(report), report.runtime);
    addToGroup(groups.byGeometry, geometry, report.runtime);
    addToGroup(groups.byBackground, report.axes.background, report.runtime);
    addToGroup(groups.byLighting, lightingFor(report), report.runtime);
    addToGroup(groups.byMotion, report.axes.motion, report.runtime);
    addToGroup(groups.byOcclusion, report.axes.occlusion, report.runtime);
    addToGroup(groups.byModeObject, interactionKey(report.mode, report.axes.object), report.runtime);
    addToGroup(groups.byModeGeometry, interactionKey(report.mode, geometry), report.runtime);
  }

  return {
    aggregate: finalizeAccumulator(aggregate),
    byMode: finalizeGroups(groups.byMode),
    byObject: finalizeGroups(groups.byObject),
    byTargetClass: finalizeGroups(groups.byTargetClass),
    byGeometry: finalizeGroups(groups.byGeometry),
    byBackground: finalizeGroups(groups.byBackground),
    byLighting: finalizeGroups(groups.byLighting),
    byMotion: finalizeGroups(groups.byMotion),
    byOcclusion: finalizeGroups(groups.byOcclusion),
    byModeObject: finalizeGroups(groups.byModeObject),
    byModeGeometry: finalizeGroups(groups.byModeGeometry),
    slowestReports: [...reports]
      .sort(
        (left, right) =>
          sortMetric(right.runtime?.maxActiveUpdateTimeMs) -
            sortMetric(left.runtime?.maxActiveUpdateTimeMs) ||
          sortMetric(right.runtime?.p95ActiveUpdateTimeMs) -
            sortMetric(left.runtime?.p95ActiveUpdateTimeMs) ||
          sortMetric(right.runtime?.meanActiveUpdateTimeMs) -
            sortMetric(left.runtime?.meanActiveUpdateTimeMs) ||
          sortMetric(right.runtime?.replayWallTimeMs) - sortMetric(left.runtime?.replayWallTimeMs) ||
          left.name.localeCompare(right.name) ||
          left.mode.localeCompare(right.mode),
      )
      .slice(0, 12)
      .map((report) => ({
        name: report.name,
        mode: report.mode,
        axes: report.axes,
        runtime: report.runtime,
      })),
  };
};
