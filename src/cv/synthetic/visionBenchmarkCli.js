import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const KNOWN_FLAGS = new Set([
  '--full',
  '--quick',
  '--summary-only',
  '--quiet',
  '--fail-on-severe',
  '--mode',
  '--object',
  '--motion',
  '--occlusion',
  '--background',
]);

const FILTER_FLAGS = new Map([
  ['--mode', 'mode'],
  ['--object', 'object'],
  ['--motion', 'motion'],
  ['--occlusion', 'occlusion'],
  ['--background', 'background'],
]);

const missingValueError = flag => new Error(`Missing value after ${flag}`);

export const parseVisionBenchmarkArgs = args => {
  let quick = false;
  let full = false;
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
    const inlineFilter = [...FILTER_FLAGS.entries()]
      .find(([flag]) => arg.startsWith(`${flag}=`));

    if (arg === '--quick') {
      quick = true;
    } else if (arg === '--full') {
      full = true;
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

  parsed.size = full ? 'full' : quick ? 'quick' : 'representative';
  parsed.outputPath = outputPath;
  return parsed;
};

export const filterVisionBenchmarkRuns = ({ scenarios, modes, filters = {} }) => {
  const filteredScenarios = scenarios.filter(scenario => (
    (!filters.object || scenario.axes.object === filters.object) &&
    (!filters.motion || scenario.axes.motion === filters.motion) &&
    (!filters.occlusion || scenario.axes.occlusion === filters.occlusion) &&
    (!filters.background || scenario.axes.background === filters.background)
  ));
  const filteredModes = modes.filter(mode => !filters.mode || mode.id === filters.mode);

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

export const compactVisionBenchmarkAnalysis = benchmark => ({
  aggregate: benchmark.aggregate,
  weakPoints: benchmark.weakPoints,
  postOcclusionRecovery: benchmark.postOcclusionRecovery,
  worstReports: benchmark.worstReports,
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

export const formatVisionBenchmarkOutput = async (output, { outputPath = null } = {}) => {
  const json = JSON.stringify(output, null, 2);
  if (!outputPath) {
    return json;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${json}\n`, 'utf8');
  return JSON.stringify(artifactSummary(output, outputPath), null, 2);
};
