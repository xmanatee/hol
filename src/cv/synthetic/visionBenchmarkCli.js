import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const KNOWN_FLAGS = new Set([
  '--full',
  '--quick',
  '--summary-only',
  '--quiet',
  '--fail-on-severe',
]);

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
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

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

const artifactSummary = (output, outputPath) => ({
  outputPath,
  size: output.size,
  scenarioCount: output.scenarioCount,
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
