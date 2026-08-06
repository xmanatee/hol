import { createHash } from 'node:crypto';
import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import {
  createSyntheticDepthFrame,
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';
import { createVisionBenchmarkMatrix } from '../src/cv/synthetic/visionBenchmarkMatrix.js';
import { createVisionBenchmarkAnalysis } from '../src/cv/synthetic/visionBenchmarkAnalysis.js';
import {
  compareHardVisionBenchmarkContract,
  HARD_VISION_BENCHMARK_CONTRACT,
  projectHardVisionBenchmarkContract,
} from '../src/cv/synthetic/visionBenchmarkContract.js';
import { summarizeVisionBenchmarkCoverage } from '../src/cv/synthetic/visionBenchmarkCoverage.js';
import {
  summarizeVisionBenchmarkPerformance,
  VISION_PERFORMANCE_BUDGETS,
} from '../src/cv/synthetic/visionBenchmarkPerformance.js';
import {
  compareVisionRefreshCadence,
  mergeVisionRefreshCadence,
  QUICK_VISION_QUALITY_PROJECTION_SHA256,
  QUICK_VISION_REFRESH_CADENCE_CONTRACT,
  summarizeVisionRefreshCadence,
} from '../src/cv/synthetic/visionRefreshCadence.js';
import {
  compactVisionBenchmarkAnalysis,
  filterVisionBenchmarkRuns,
  formatVisionBenchmarkOutput,
  parseVisionBenchmarkArgs,
} from '../src/cv/synthetic/visionBenchmarkCli.js';
import { RECONSTRUCTION_MODES } from '../src/cv/anchor.reconstructionModes.js';
import { ANCHOR_TRACKING_INTERVAL_MS } from '../src/utils/cvScheduling.js';
import {
  VISION_QUALITY_THRESHOLDS,
  scoreVisionPipelineQuality,
  summarizeVisionQualityReports,
} from '../src/cv/stageQualityScoring.js';

const SYNTHETIC_OBJECT_SUPPORT = 'synthetic-object-mask';

const { size, summaryOnly, quiet, failOnSevere, outputPath, filters } = parseVisionBenchmarkArgs(
  process.argv.slice(2),
);
const { scenarios, modes } = filterVisionBenchmarkRuns({
  scenarios: createVisionBenchmarkMatrix({ size }),
  modes: RECONSTRUCTION_MODES,
  filters,
});
const cv = await loadOpenCvForNode();
const reports = [];
const refreshCadenceRuns = [];
const totalRuns = scenarios.length * modes.length;
let completedRuns = 0;

const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const max = (values) => (values.length ? Math.max(...values) : null);

const percentile = (values, ratio) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};

const summarizeStageTimings = (frames) => {
  const accumulators = {};
  for (const frame of frames) {
    for (const [stage, value] of Object.entries(frame.runtime?.stageTimings || {})) {
      if (!Number.isFinite(value)) continue;
      const accumulator = accumulators[stage] || {
        sum: 0,
        count: 0,
        maxMs: 0,
      };
      accumulator.sum += value;
      accumulator.count++;
      accumulator.maxMs = Math.max(accumulator.maxMs, value);
      accumulators[stage] = accumulator;
    }
  }

  return Object.fromEntries(
    Object.entries(accumulators)
      .map(([stage, accumulator]) => [
        stage,
        {
          meanMs: accumulator.sum / Math.max(1, accumulator.count),
          maxMs: accumulator.maxMs,
          frameCount: accumulator.count,
        },
      ])
      .sort(
        (left, right) =>
          right[1].meanMs - left[1].meanMs ||
          right[1].maxMs - left[1].maxMs ||
          left[0].localeCompare(right[0]),
      ),
  );
};

const runtimeFromReplay = ({ replay, wallTimeMs }) => {
  const updateTimes = replay.frames.map((frame) => frame.runtime?.updateWallTimeMs).filter(Number.isFinite);

  const sourceFrameCount = replay.cadence.sourceFrameCount;
  const displayFrameCount =
    (sourceFrameCount * replay.cadence.sourceFrameIntervalMs) /
    VISION_PERFORMANCE_BUDGETS.displayFrameIntervalMs;
  const poseAges = replay.frames.map((frame) => frame.runtime?.poseAgeMs).filter(Number.isFinite);
  const presentationPredictionTimes = replay.frames
    .map((frame) => frame.runtime?.presentationPredictionMs)
    .filter(Number.isFinite);

  return {
    replayWallTimeMs: wallTimeMs,
    sourceFrameCount,
    displayFrameCount,
    admittedUpdateCount: replay.cadence.admittedUpdateCount,
    heldFrameCount: replay.cadence.heldFrameCount,
    updateIntervalMs: replay.cadence.updateIntervalMs,
    meanActiveUpdateTimeMs: mean(updateTimes),
    displayAmortizedUpdateTimeMs: displayFrameCount
      ? updateTimes.reduce((sum, value) => sum + value, 0) / displayFrameCount
      : null,
    p95ActiveUpdateTimeMs: percentile(updateTimes, 0.95),
    maxActiveUpdateTimeMs: max(updateTimes),
    maxPoseAgeMs: max(poseAges),
    presentationPredictionFrameCount: presentationPredictionTimes.length,
    meanPresentationPredictionTimeMs: mean(presentationPredictionTimes),
    maxPresentationPredictionTimeMs: max(presentationPredictionTimes),
    stageTimings: summarizeStageTimings(replay.frames),
  };
};

const depthFrameFactoryFor = ({ mode, scenario }) => {
  if (!mode.requiresDepthFrame) return null;
  if (!scenario.replayOptions.suppressDepthWhenTargetAbsent) return createSyntheticDepthFrame;
  return (options) => (options.frame.targetVisible === false ? null : createSyntheticDepthFrame(options));
};

for (const scenario of scenarios) {
  const sequence = scenario.create();
  for (const mode of modes) {
    const runStart = performance.now();
    const replay = await replayImageAnchorSequence({
      cv,
      sequence,
      trackingMode: mode.id,
      targetClassOverride: scenario.targetClassOverride,
      useObjectSupportMask: true,
      refreshObjectSupportMask: scenario.replayOptions.refreshObjectSupportMask,
      depthFrameForFrame: depthFrameFactoryFor({ mode, scenario }),
      updateIntervalMs: ANCHOR_TRACKING_INTERVAL_MS,
    });
    const runtime = runtimeFromReplay({
      replay,
      wallTimeMs: performance.now() - runStart,
    });
    refreshCadenceRuns.push(summarizeVisionRefreshCadence(replay.frames));
    const summary = summarizeReplay(replay);
    const headPose = scoreHeadPoseReplay({ replay, sequence });
    const quality = scoreVisionPipelineQuality({
      name: `${mode.id}/${scenario.name}`,
      replay,
      summary,
      headPose,
      thresholds: VISION_QUALITY_THRESHOLDS,
    });

    completedRuns++;
    if (!quiet && completedRuns % 12 === 0) {
      console.error(`benchmark ${completedRuns}/${totalRuns}`);
    }

    reports.push({
      name: scenario.name,
      kind: sequence.kind,
      mode: mode.id,
      targetClass: scenario.targetClassOverride || sequence.targetClass,
      axes: scenario.axes,
      objectSupportMask: SYNTHETIC_OBJECT_SUPPORT,
      overallStatus: quality.overallStatus,
      failedStages: quality.failedStages,
      stages: quality.stages,
      runtime,
    });
  }
}

const qualitySummary = summarizeVisionQualityReports(reports);
const benchmark = createVisionBenchmarkAnalysis(reports);
const performanceSummary = summarizeVisionBenchmarkPerformance(reports);
const refreshCadenceSummary = mergeVisionRefreshCadence(refreshCadenceRuns);
const coverageSummary = summarizeVisionBenchmarkCoverage({ scenarios, modes });
const outputBenchmark = summaryOnly ? compactVisionBenchmarkAnalysis(benchmark) : benchmark;
const qualityProjectionSha256 = createHash('sha256')
  .update(
    JSON.stringify({
      coverageSummary,
      qualitySummary,
      benchmark: outputBenchmark,
    }),
  )
  .digest('hex');
const canonicalQuickRun = size === 'quick' && summaryOnly && Object.keys(filters).length === 0;
const canonicalHardRun = size === 'hard' && summaryOnly && Object.keys(filters).length === 0;
const refreshCadenceMismatches = canonicalQuickRun
  ? compareVisionRefreshCadence(refreshCadenceSummary, QUICK_VISION_REFRESH_CADENCE_CONTRACT)
  : [];
if (canonicalQuickRun && qualityProjectionSha256 !== QUICK_VISION_QUALITY_PROJECTION_SHA256) {
  refreshCadenceMismatches.push({
    field: 'qualityProjectionSha256',
    expected: QUICK_VISION_QUALITY_PROJECTION_SHA256,
    actual: qualityProjectionSha256,
  });
}
const hardContractActual = projectHardVisionBenchmarkContract({ qualitySummary, benchmark });
const hardContractMismatches = canonicalHardRun
  ? compareHardVisionBenchmarkContract(hardContractActual, HARD_VISION_BENCHMARK_CONTRACT)
  : [];
const output = {
  size,
  scenarioCount: scenarios.length,
  modeCount: modes.length,
  replayCount: reports.length,
  coverageSummary,
  qualitySummary,
  performanceSummary,
  refreshCadenceSummary,
  deterministicContract: {
    enforced: canonicalQuickRun,
    passed: canonicalQuickRun ? refreshCadenceMismatches.length === 0 : null,
    qualityProjectionSha256,
    mismatches: refreshCadenceMismatches,
  },
  hardRegressionContract: {
    enforced: canonicalHardRun,
    passed: canonicalHardRun ? hardContractMismatches.length === 0 : null,
    expected: HARD_VISION_BENCHMARK_CONTRACT,
    actual: hardContractActual,
    mismatches: hardContractMismatches,
  },
  benchmark: outputBenchmark,
};

console.log(await formatVisionBenchmarkOutput(output, { outputPath, summaryOnly }));

if (failOnSevere && benchmark.aggregate.byRiskBand.severe) {
  process.exitCode = 1;
}
if (canonicalQuickRun && refreshCadenceMismatches.length > 0) {
  process.exitCode = 1;
}
if (canonicalHardRun && hardContractMismatches.length > 0) {
  process.exitCode = 1;
}
