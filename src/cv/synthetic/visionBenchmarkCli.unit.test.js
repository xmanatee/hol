import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  compactVisionBenchmarkAnalysis,
  filterVisionBenchmarkRuns,
  formatVisionBenchmarkOutput,
  parseVisionBenchmarkArgs,
} from './visionBenchmarkCli.js';

const benchmarkOutput = {
  size: 'quick',
  scenarioCount: 21,
  modeCount: 4,
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
    filters: {},
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
  assert.throws(
    () => parseVisionBenchmarkArgs(['--mode']),
    /Missing value after --mode/
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
    modeCount: 4,
    replayCount: 84,
    strictFailures: 51,
    meanRiskScore: 32.4,
  });
});

test('benchmark CLI keeps full JSON on stdout when no output path is requested', async () => {
  const stdout = await formatVisionBenchmarkOutput(benchmarkOutput);

  assert.deepEqual(JSON.parse(stdout), benchmarkOutput);
});

test('benchmark CLI summary projection keeps recovery audit fields', () => {
  const benchmark = {
    aggregate: { meanRiskScore: 24 },
    weakPoints: { byMode: [] },
    postOcclusionRecovery: {
      aggregate: {
        windowCount: 5,
        recoveredAt8: 3,
      },
    },
    worstReports: [{ name: 'bad recovery' }],
    reports: [{ name: 'large full report payload' }],
  };

  assert.deepEqual(compactVisionBenchmarkAnalysis(benchmark), {
    aggregate: benchmark.aggregate,
    weakPoints: benchmark.weakPoints,
    postOcclusionRecovery: benchmark.postOcclusionRecovery,
    worstReports: benchmark.worstReports,
  });
});

test('benchmark CLI parses targeted run filters', () => {
  const parsed = parseVisionBenchmarkArgs([
    '--object',
    'handled-mug',
    '--mode=direct-photometric',
    '--motion',
    'slow',
    '--occlusion',
    'early',
    '--background=busy',
  ]);

  assert.deepEqual(parsed.filters, {
    object: 'handled-mug',
    mode: 'direct-photometric',
    motion: 'slow',
    occlusion: 'early',
    background: 'busy',
  });
});

test('benchmark CLI filters scenarios and modes before benchmark execution', () => {
  const scenarios = [
    {
      name: 'handled mug slow early',
      axes: {
        object: 'handled-mug',
        motion: 'slow',
        occlusion: 'early',
        background: 'busy',
      },
    },
    {
      name: 'glossy can fast clean',
      axes: {
        object: 'glossy-can',
        motion: 'fast',
        occlusion: 'clean',
        background: 'desk',
      },
    },
  ];
  const modes = [
    { id: 'sparse-reconstruction' },
    { id: 'direct-photometric' },
  ];

  const filtered = filterVisionBenchmarkRuns({
    scenarios,
    modes,
    filters: {
      object: 'handled-mug',
      mode: 'direct-photometric',
      motion: 'slow',
      occlusion: 'early',
      background: 'busy',
    },
  });

  assert.deepEqual(filtered.scenarios.map(scenario => scenario.name), ['handled mug slow early']);
  assert.deepEqual(filtered.modes.map(mode => mode.id), ['direct-photometric']);
});

test('benchmark CLI rejects filters with no matching scenarios or modes', () => {
  assert.throws(
    () => filterVisionBenchmarkRuns({
      scenarios: [{ name: 'book', axes: { object: 'planar-book' } }],
      modes: [{ id: 'sparse-reconstruction' }],
      filters: { object: 'handled-mug' },
    }),
    /No benchmark scenarios match filters/
  );
  assert.throws(
    () => filterVisionBenchmarkRuns({
      scenarios: [{ name: 'book', axes: { object: 'planar-book' } }],
      modes: [{ id: 'sparse-reconstruction' }],
      filters: { mode: 'direct-photometric' },
    }),
    /No reconstruction modes match filters/
  );
});
