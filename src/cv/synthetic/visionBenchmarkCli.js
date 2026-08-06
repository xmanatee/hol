import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const KNOWN_FLAGS = new Set([
  '--full',
  '--hard',
  '--quick',
  '--summary-only',
  '--quiet',
  '--fail-on-severe',
  '--mode',
  '--object',
  '--motion',
  '--occlusion',
  '--background',
  '--capture',
  '--event',
]);

const FILTER_FLAGS = new Map([
  ['--mode', 'mode'],
  ['--object', 'object'],
  ['--motion', 'motion'],
  ['--occlusion', 'occlusion'],
  ['--background', 'background'],
  ['--capture', 'capture'],
  ['--event', 'event'],
]);

const missingValueError = (flag) => new Error(`Missing value after ${flag}`);

export const parseVisionBenchmarkArgs = (args) => {
  let quick = false;
  let full = false;
  let hard = false;
  let outputPath = null;
  const parsed = {
    size: 'representative',
    summaryOnly: false,
    quiet: false,
    failOnSevere: false,
    outputPath: null,
    filters: {},
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const inlineFilter = [...FILTER_FLAGS.entries()].find(([flag]) => arg.startsWith(`${flag}=`));

    if (arg === '--quick') {
      quick = true;
    } else if (arg === '--full') {
      full = true;
    } else if (arg === '--hard') {
      hard = true;
    } else if (arg === '--summary-only') {
      parsed.summaryOnly = true;
    } else if (arg === '--quiet') {
      parsed.quiet = true;
    } else if (arg === '--fail-on-severe') {
      parsed.failOnSevere = true;
    } else if (arg === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing path after --output');
      }
      outputPath = value;
      index++;
    } else if (arg.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length);
      if (!outputPath) {
        throw new Error('Missing path after --output');
      }
    } else if (FILTER_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw missingValueError(arg);
      }
      parsed.filters[FILTER_FLAGS.get(arg)] = value;
      index++;
    } else if (inlineFilter) {
      const [flag, field] = inlineFilter;
      const value = arg.slice(`${flag}=`.length);
      if (!value) {
        throw missingValueError(flag);
      }
      parsed.filters[field] = value;
    } else if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`Unknown benchmark flag: ${arg}`);
    }
  }

  if (quick && full) {
    throw new Error('Cannot use --quick and --full together');
  }
  if (Number(quick) + Number(full) + Number(hard) > 1) {
    throw new Error('Cannot combine benchmark matrix sizes');
  }

  parsed.size = hard ? 'hard' : full ? 'full' : quick ? 'quick' : 'representative';
  parsed.outputPath = outputPath;
  return parsed;
};

export const filterVisionBenchmarkRuns = ({ scenarios, modes, filters = {} }) => {
  const filteredScenarios = scenarios.filter(
    (scenario) =>
      (!filters.object || scenario.axes.object === filters.object) &&
      (!filters.motion || scenario.axes.motion === filters.motion) &&
      (!filters.occlusion || scenario.axes.occlusion === filters.occlusion) &&
      (!filters.background || scenario.axes.background === filters.background) &&
      (!filters.capture || scenario.axes.capture === filters.capture) &&
      (!filters.event || scenario.axes.event === filters.event),
  );
  const filteredModes = modes.filter((mode) => !filters.mode || mode.id === filters.mode);

  if (filteredScenarios.length === 0) {
    throw new Error('No benchmark scenarios match filters');
  }
  if (filteredModes.length === 0) {
    throw new Error('No reconstruction modes match filters');
  }

  return {
    scenarios: filteredScenarios,
    modes: filteredModes,
  };
};

export const compactVisionBenchmarkAnalysis = (benchmark) => ({
  aggregate: benchmark.aggregate,
  weakPoints: benchmark.weakPoints,
  postOcclusionRecovery: benchmark.postOcclusionRecovery,
  targetLossRecovery: benchmark.targetLossRecovery,
  worstReports: benchmark.worstReports,
});

const compactRisk = (risk) => ({
  score: risk.score,
  band: risk.band,
  primaryWeakness: risk.primaryWeakness,
});

const compactRiskReport = (report) => ({
  name: report.name,
  mode: report.mode,
  axes: report.axes,
  overallStatus: report.overallStatus,
  failedStages: report.failedStages,
  risk: compactRisk(report.risk),
});

const compactStageTiming = ([stage, timing]) => ({
  stage,
  meanMs: timing.meanMs,
  exclusiveMeanMs: timing.exclusiveMeanMs,
  maxMs: timing.maxMs,
  frameCount: timing.frameCount,
  displayAmortizedExclusiveMeanMs: timing.displayAmortizedExclusiveMeanMs,
});

const compactPerformanceAggregate = (aggregate) => ({
  count: aggregate.count,
  invalidRuntimeCount: aggregate.invalidRuntimeCount,
  missingProcessingReports: aggregate.missingProcessingReports,
  sourceFrameCount: aggregate.sourceFrameCount,
  displayFrameCount: aggregate.displayFrameCount,
  admittedUpdateCount: aggregate.admittedUpdateCount,
  heldFrameCount: aggregate.heldFrameCount,
  admissionRatio: aggregate.admissionRatio,
  totalReplayWallTimeMs: aggregate.totalReplayWallTimeMs,
  meanSourceFrameWallTimeMs: aggregate.meanSourceFrameWallTimeMs,
  meanActiveUpdateTimeMs: aggregate.meanActiveUpdateTimeMs,
  displayAmortizedUpdateTimeMs: aggregate.displayAmortizedUpdateTimeMs,
  maxActiveUpdateTimeMs: aggregate.maxActiveUpdateTimeMs,
  maxP95ActiveUpdateTimeMs: aggregate.maxP95ActiveUpdateTimeMs,
  maxPoseAgeMs: aggregate.maxPoseAgeMs,
  cadenceLatencyOverageCount: aggregate.cadenceLatencyOverageCount,
  timingCoverageRatio: aggregate.timingCoverageRatio,
  displayAmortizedUnattributedUpdateTimeMs: aggregate.displayAmortizedUnattributedUpdateTimeMs,
  budget: aggregate.budget,
  topOwnedStages: Object.entries(aggregate.stageTimings)
    .filter(([, timing]) => timing.ownership === 'owned')
    .slice(0, 5)
    .map(compactStageTiming),
});

const compactPerformanceReport = (report) => ({
  name: report.name,
  mode: report.mode,
  axes: report.axes,
  runtime: {
    replayWallTimeMs: report.runtime.replayWallTimeMs,
    meanActiveUpdateTimeMs: report.runtime.meanActiveUpdateTimeMs,
    displayAmortizedUpdateTimeMs: report.runtime.displayAmortizedUpdateTimeMs,
    p95ActiveUpdateTimeMs: report.runtime.p95ActiveUpdateTimeMs,
    maxActiveUpdateTimeMs: report.runtime.maxActiveUpdateTimeMs,
  },
});

export const compactVisionBenchmarkOutput = (output) => ({
  size: output.size,
  scenarioCount: output.scenarioCount,
  modeCount: output.modeCount,
  replayCount: output.replayCount,
  qualitySummary: {
    aggregate: output.qualitySummary.aggregate,
    failedByMode: output.qualitySummary.failedByMode,
    topFailingScenarios: output.qualitySummary.topFailingScenarios,
  },
  benchmark: {
    aggregate: output.benchmark.aggregate,
    postOcclusionRecovery: output.benchmark.postOcclusionRecovery.aggregate,
    targetLossRecovery: output.benchmark.targetLossRecovery,
    worstReports: output.benchmark.worstReports.slice(0, 5).map(compactRiskReport),
  },
  performanceSummary: {
    aggregate: compactPerformanceAggregate(output.performanceSummary.aggregate),
    slowestReports: output.performanceSummary.slowestReports.slice(0, 5).map(compactPerformanceReport),
  },
  refreshCadenceSummary: output.refreshCadenceSummary,
  deterministicContract: output.deterministicContract,
  hardRegressionContract: output.hardRegressionContract,
});

const artifactSummary = (output, outputPath) => ({
  outputPath,
  size: output.size,
  scenarioCount: output.scenarioCount,
  modeCount: output.modeCount,
  replayCount: output.replayCount,
  strictFailures: output.qualitySummary.aggregate.byStatus.fail,
  meanRiskScore: output.benchmark.aggregate.meanRiskScore,
});

export const formatVisionBenchmarkOutput = async (
  output,
  { outputPath = null, summaryOnly = false } = {},
) => {
  if (!outputPath) {
    return JSON.stringify(summaryOnly ? compactVisionBenchmarkOutput(output) : output, null, 2);
  }

  const json = JSON.stringify(output, null, 2);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${json}\n`, 'utf8');
  return JSON.stringify(artifactSummary(output, outputPath), null, 2);
};
