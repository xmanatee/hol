import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import {
  createSyntheticDepthFrame,
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';
import { createVisionBenchmarkMatrix } from '../src/cv/synthetic/visionBenchmarkMatrix.js';
import { createVisionBenchmarkAnalysis } from '../src/cv/synthetic/visionBenchmarkAnalysis.js';
import { summarizeVisionBenchmarkPerformance } from '../src/cv/synthetic/visionBenchmarkPerformance.js';
import { RECONSTRUCTION_MODES } from '../src/cv/anchor.reconstructionModes.js';
import {
  VISION_QUALITY_THRESHOLDS,
  scoreVisionPipelineQuality,
  summarizeVisionQualityReports,
} from '../src/cv/stageQualityScoring.js';

const SYNTHETIC_OBJECT_SUPPORT = 'synthetic-object-mask';

const argSet = new Set(process.argv.slice(2));
const size = argSet.has('--full') ? 'full' : argSet.has('--quick') ? 'quick' : 'representative';
const summaryOnly = argSet.has('--summary-only');
const quiet = argSet.has('--quiet');
const failOnSevere = argSet.has('--fail-on-severe');
const cv = await loadOpenCvForNode();
const scenarios = createVisionBenchmarkMatrix({ size });
const reports = [];
const totalRuns = scenarios.length * RECONSTRUCTION_MODES.length;
let completedRuns = 0;

const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

const max = values => values.length ? Math.max(...values) : 0;

const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};

const summarizeStageTimings = frames => {
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

  return Object.fromEntries(Object.entries(accumulators)
    .map(([stage, accumulator]) => [stage, {
      meanMs: accumulator.sum / Math.max(1, accumulator.count),
      maxMs: accumulator.maxMs,
      frameCount: accumulator.count,
    }])
    .sort((left, right) => (
      right[1].meanMs - left[1].meanMs ||
      right[1].maxMs - left[1].maxMs ||
      left[0].localeCompare(right[0])
    )));
};

const runtimeFromReplay = ({ replay, wallTimeMs }) => {
  const updateTimes = replay.frames
    .map(frame => frame.runtime?.updateWallTimeMs)
    .filter(Number.isFinite);

  return {
    wallTimeMs,
    frameCount: replay.frames.length,
    meanFrameWallTimeMs: wallTimeMs / Math.max(1, replay.frames.length),
    meanProcessingTimeMs: mean(updateTimes),
    p95ProcessingTimeMs: percentile(updateTimes, 0.95),
    maxProcessingTimeMs: max(updateTimes),
    stageTimings: summarizeStageTimings(replay.frames),
  };
};

for (const scenario of scenarios) {
  for (const mode of RECONSTRUCTION_MODES) {
    const sequence = scenario.create();
    const runStart = performance.now();
    const replay = await replayImageAnchorSequence({
      cv,
      sequence,
      trackingMode: mode.id,
      targetClassOverride: scenario.targetClassOverride,
      useObjectSupportMask: true,
      refreshObjectSupportMask: true,
      depthFrameForFrame: mode.requiresDepthFrame ? createSyntheticDepthFrame : null,
    });
    const runtime = runtimeFromReplay({
      replay,
      wallTimeMs: performance.now() - runStart,
    });
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
const output = {
  size,
  scenarioCount: scenarios.length,
  modeCount: RECONSTRUCTION_MODES.length,
  replayCount: reports.length,
  qualitySummary,
  performanceSummary,
  benchmark: summaryOnly
    ? {
        aggregate: benchmark.aggregate,
        weakPoints: benchmark.weakPoints,
        worstReports: benchmark.worstReports,
      }
    : benchmark,
};

console.log(JSON.stringify(output, null, 2));

if (failOnSevere && benchmark.aggregate.byRiskBand.severe) {
  process.exitCode = 1;
}
