import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  formatVisionBenchmarkOutput,
  parseVisionBenchmarkArgs,
} from './visionBenchmarkCli.js';

const benchmarkOutput = {
  size: 'quick',
  scenarioCount: 21,
  replayCount: 84,
  qualitySummary: {
    aggregate: {
      byStatus: {
        fail: 51,
      },
    },
  },
  benchmark: {
    aggregate: {
      meanRiskScore: 32.4,
    },
  },
};

test('benchmark CLI parses output paths and explicit matrix flags', () => {
  const parsed = parseVisionBenchmarkArgs([
    '--quick',
    '--summary-only',
    '--quiet',
    '--fail-on-severe',
    '--output',
    '/tmp/hol-benchmark.json',
  ]);

  assert.deepEqual(parsed, {
    size: 'quick',
    summaryOnly: true,
    quiet: true,
    failOnSevere: true,
    outputPath: '/tmp/hol-benchmark.json',
  });
});

test('benchmark CLI rejects ambiguous or unknown flags', () => {
  assert.throws(
    () => parseVisionBenchmarkArgs(['--quick', '--full']),
    /Cannot use --quick and --full together/
  );
  assert.throws(
    () => parseVisionBenchmarkArgs(['--wat']),
    /Unknown benchmark flag: --wat/
  );
  assert.throws(
    () => parseVisionBenchmarkArgs(['--output']),
    /Missing path after --output/
  );
});

test('benchmark CLI writes JSON artifacts and prints a compact artifact summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hol-benchmark-cli-'));
  const outputPath = join(dir, 'quick.json');

  const stdout = await formatVisionBenchmarkOutput(benchmarkOutput, { outputPath });
  const written = JSON.parse(await readFile(outputPath, 'utf8'));
  const printed = JSON.parse(stdout);

  assert.deepEqual(written, benchmarkOutput);
  assert.deepEqual(printed, {
    outputPath,
    size: 'quick',
    scenarioCount: 21,
    replayCount: 84,
    strictFailures: 51,
    meanRiskScore: 32.4,
  });
});

test('benchmark CLI keeps full JSON on stdout when no output path is requested', async () => {
  const stdout = await formatVisionBenchmarkOutput(benchmarkOutput);

  assert.deepEqual(JSON.parse(stdout), benchmarkOutput);
});
