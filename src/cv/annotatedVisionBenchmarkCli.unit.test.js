import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compactAnnotatedVisionBenchmarkOutput,
  formatAnnotatedVisionBenchmarkOutput,
  parseAnnotatedVisionBenchmarkArgs,
} from './annotatedVisionBenchmarkCli.js';

const temporalMetrics = {
  stableReDetectionEligibleCount: 2,
  stableReDetectionRecoveredCount: 1,
  stableReDetectionRecall: 0.5,
  maximumStableReDetectionLatencyMs: 400,
  maximumFalseVisibleDurationMs: 1000,
  maximumMissedVisibleDurationMs: 600,
  visibleTrackFragmentationCount: 4,
};

const output = {
  summary: {
    fixtures: 1,
    frames: 250,
    independentQueries: 3,
    byDataset: { 'TAP-Vid-RGB-Stacking': 1 },
  },
  aggregate: {
    averageJaccard: 0.29,
    occlusionAccuracy: 0.78,
    reDetectionAverageJaccard: 0.24,
    ...temporalMetrics,
  },
  reports: [
    {
      id: 'rgb-stacking-34',
      dataset: 'TAP-Vid-RGB-Stacking',
      frameDerivation: { kind: 'identity', sourceWidth: 256, sourceHeight: 256 },
      frames: { width: 256, height: 256, count: 250, framesPerSecond: 30 },
      metrics: {
        averageJaccard: 0.29,
        occlusionAccuracy: 0.78,
        reDetectionAverageJaccard: 0.24,
        ...temporalMetrics,
      },
      querySets: [
        {
          id: 'primary',
          metrics: {
            averageJaccard: 0.29,
            occlusionAccuracy: 0.78,
            reDetectionAverageJaccard: 0.24,
            ...temporalMetrics,
          },
          queries: [
            {
              id: '1',
              anchorCreated: true,
              createFailure: null,
              evaluatedFrames: 249,
              admittedUpdates: 125,
              visiblePredictions: 175,
              metrics: {
                averageJaccard: 0.21,
                occlusionAccuracy: 0.7,
                reDetectionAverageJaccard: 0.12,
                ...temporalMetrics,
              },
              evidence: { visible: { frames: 200 }, occluded: { frames: 49 } },
            },
          ],
        },
      ],
    },
  ],
};

test('annotated benchmark arguments accept one explicit artifact path and reject ambiguity', () => {
  assert.deepEqual(parseAnnotatedVisionBenchmarkArgs([]), { outputPath: null });
  assert.deepEqual(parseAnnotatedVisionBenchmarkArgs(['--output=artifacts/annotated.json']), {
    outputPath: 'artifacts/annotated.json',
  });
  assert.deepEqual(parseAnnotatedVisionBenchmarkArgs(['--output', 'artifacts/annotated.json']), {
    outputPath: 'artifacts/annotated.json',
  });

  assert.throws(() => parseAnnotatedVisionBenchmarkArgs(['--output']), /Missing path after --output/);
  assert.throws(() => parseAnnotatedVisionBenchmarkArgs(['--output=']), /Missing path after --output/);
  assert.throws(
    () => parseAnnotatedVisionBenchmarkArgs(['--output=a.json', '--output=b.json']),
    /may be specified only once/,
  );
  assert.throws(() => parseAnnotatedVisionBenchmarkArgs(['--quiet']), /Unknown annotated benchmark flag/);
});

test('annotated benchmark stdout keeps decisions and omits verbose replay evidence', () => {
  const compact = compactAnnotatedVisionBenchmarkOutput(output);

  assert.deepEqual(compact.summary, output.summary);
  assert.deepEqual(compact.aggregate, output.aggregate);
  assert.deepEqual(compact.reports[0].frameDerivation, output.reports[0].frameDerivation);
  assert.deepEqual(compact.reports[0].frames, output.reports[0].frames);
  assert.equal(compact.reports[0].querySets[0].queries[0].metrics.averageJaccard, 0.21);
  assert.equal(compact.reports[0].querySets[0].queries[0].metrics.reDetectionAverageJaccard, 0.12);
  assert.equal(compact.reports[0].querySets[0].queries[0].metrics.stableReDetectionRecall, 0.5);
  assert.equal(compact.reports[0].querySets[0].queries[0].metrics.maximumFalseVisibleDurationMs, 1000);
  assert.equal(compact.reports[0].querySets[0].queries[0].metrics.maximumMissedVisibleDurationMs, 600);
  assert.equal(compact.reports[0].querySets[0].queries[0].metrics.visibleTrackFragmentationCount, 4);
  assert.equal(Object.hasOwn(compact.reports[0].querySets[0].queries[0], 'evidence'), false);
});

test('annotated benchmark stdout never traverses discarded replay evidence', async () => {
  const query = { ...output.reports[0].querySets[0].queries[0] };
  Object.defineProperty(query, 'evidence', {
    enumerable: true,
    get() {
      throw new Error('verbose evidence was observed');
    },
  });
  const guardedOutput = {
    ...output,
    reports: [
      {
        ...output.reports[0],
        querySets: [{ ...output.reports[0].querySets[0], queries: [query] }],
      },
    ],
  };

  const stdout = await formatAnnotatedVisionBenchmarkOutput(guardedOutput);

  assert.equal(JSON.parse(stdout).reports[0].querySets[0].queries[0].id, '1');
});

test('annotated benchmark writes full evidence only for an explicit artifact', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'hol-annotated-output-'));
  const outputPath = join(directory, 'nested', 'report.json');
  context.after(() => rm(directory, { recursive: true, force: true }));

  const stdout = await formatAnnotatedVisionBenchmarkOutput(output, { outputPath });

  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), output);
  assert.deepEqual(JSON.parse(stdout), {
    outputPath,
    fixtures: 1,
    frames: 250,
    independentQueries: 3,
    averageJaccard: 0.29,
    occlusionAccuracy: 0.78,
    reDetectionAverageJaccard: 0.24,
    stableReDetectionRecall: 0.5,
    maximumStableReDetectionLatencyMs: 400,
    maximumFalseVisibleDurationMs: 1000,
    maximumMissedVisibleDurationMs: 600,
    visibleTrackFragmentationCount: 4,
  });
});
