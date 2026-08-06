import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { formatVisionQualityOutput, parseVisionQualityArgs } from './visionQualityCli.js';

const passingReport = {
  name: 'planar-book / clean',
  kind: 'planar',
  mode: 'planar-homography',
  targetClass: 'book',
  captureCondition: 'nominal',
  overallStatus: 'pass',
  failedStages: [],
  stages: { discardedPayload: 'passing-report-detail' },
};

const failingReport = {
  name: 'glossy-can / fast',
  kind: 'curved',
  mode: 'sparse-reconstruction',
  targetClass: 'can',
  captureCondition: 'low-light-motion',
  overallStatus: 'fail',
  failedStages: ['tracking'],
  stages: {
    selection: { discardedPayload: 'passing-stage-detail' },
    tracking: {
      status: 'fail',
      failures: [{ metric: 'meanAnchorError', actual: 14, expected: 6 }],
      metrics: { meanAnchorError: 14 },
    },
  },
};

const qualityOutput = {
  aggregate: {
    total: 2,
    byStatus: { pass: 1, fail: 1 },
    failedByStage: { tracking: 1 },
  },
  failedByMode: { 'sparse-reconstruction': 1 },
  failedByScenario: { 'glossy-can / fast': 1 },
  topFailingScenarios: [{ name: 'glossy-can / fast', count: 1 }],
  trackingSources: { discardedPayload: 'summary-detail' },
  reports: [passingReport, failingReport],
};

test('quality CLI parses one explicit artifact path and rejects ambiguous input', () => {
  assert.deepEqual(parseVisionQualityArgs([]), { outputPath: null });
  assert.deepEqual(parseVisionQualityArgs(['--output', '/tmp/quality.json']), {
    outputPath: '/tmp/quality.json',
  });
  assert.deepEqual(parseVisionQualityArgs(['--output=/tmp/quality.json']), {
    outputPath: '/tmp/quality.json',
  });

  assert.throws(() => parseVisionQualityArgs(['--output']), /Missing path after --output/);
  assert.throws(() => parseVisionQualityArgs(['--output=']), /Missing path after --output/);
  assert.throws(() => parseVisionQualityArgs(['--unknown']), /Unknown quality flag: --unknown/);
  assert.throws(
    () => parseVisionQualityArgs(['--output=a.json', '--output=b.json']),
    /Quality output path may be specified only once/,
  );
});

test('quality CLI stdout keeps aggregates and only failed-stage evidence', async () => {
  const stdout = await formatVisionQualityOutput(qualityOutput);
  const summary = JSON.parse(stdout);

  assert.ok(Buffer.byteLength(stdout) < 4_096);
  assert.doesNotMatch(stdout, /discardedPayload|passing-report-detail|passing-stage-detail/);
  assert.deepEqual(summary, {
    aggregate: qualityOutput.aggregate,
    failedByMode: qualityOutput.failedByMode,
    failedByScenario: qualityOutput.failedByScenario,
    topFailingScenarios: qualityOutput.topFailingScenarios,
    failingReports: [
      {
        name: failingReport.name,
        kind: failingReport.kind,
        mode: failingReport.mode,
        targetClass: failingReport.targetClass,
        captureCondition: failingReport.captureCondition,
        overallStatus: failingReport.overallStatus,
        failedStages: failingReport.failedStages,
        stages: { tracking: failingReport.stages.tracking },
      },
    ],
  });
});

test('quality CLI writes complete evidence only to an explicit artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hol-quality-cli-'));
  const outputPath = join(directory, 'quality.json');
  const stdout = await formatVisionQualityOutput(qualityOutput, { outputPath });

  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), qualityOutput);
  assert.deepEqual(JSON.parse(stdout), {
    outputPath,
    totalReports: 2,
    passedReports: 1,
    failedReports: 1,
    failedByStage: { tracking: 1 },
  });
});
