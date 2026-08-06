import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { formatVisionBenchmarkOutput } from './visionBenchmarkCli.js';

const benchmarkOutput = {
  size: 'quick',
  scenarioCount: 21,
  modeCount: 4,
  replayCount: 84,
  coverageSummary: { discardedPayload: 'coverage-detail' },
  qualitySummary: {
    aggregate: { byStatus: { fail: 51 } },
    failedByMode: { reconstruction: 12 },
    topFailingScenarios: [{ name: 'glossy-can / fast', count: 4 }],
    trackingTransitions: { discardedPayload: 'quality-detail' },
  },
  performanceSummary: {
    aggregate: {
      count: 84,
      invalidRuntimeCount: 0,
      missingProcessingReports: 0,
      sourceFrameCount: 2_716,
      displayFrameCount: 5_432,
      admittedUpdateCount: 1_400,
      heldFrameCount: 1_316,
      admissionRatio: 0.515,
      totalReplayWallTimeMs: 28_640,
      meanSourceFrameWallTimeMs: 10.5,
      meanActiveUpdateTimeMs: 18.25,
      displayAmortizedUpdateTimeMs: 4.7,
      maxActiveUpdateTimeMs: 93.9,
      maxP95ActiveUpdateTimeMs: 92.8,
      maxPoseAgeMs: 33.3,
      cadenceLatencyOverageCount: 2,
      timingCoverageRatio: 0.997,
      displayAmortizedUnattributedUpdateTimeMs: 0.01,
      stageTimings: {
        totalMs: { ownership: 'envelope', displayAmortizedExclusiveMeanMs: 4.69 },
        planarPoseMs: {
          ownership: 'owned',
          meanMs: 4.69,
          exclusiveMeanMs: 4.69,
          maxMs: 29,
          frameCount: 1_276,
          displayAmortizedExclusiveMeanMs: 1.1,
        },
      },
      budget: { displayAmortizedUpdateOverBudget: true, stageSpikeOverages: [] },
    },
    slowestReports: [
      {
        name: 'glossy-can / fast',
        mode: 'reconstruction',
        axes: { object: 'glossy-can' },
        runtime: {
          replayWallTimeMs: 754,
          meanActiveUpdateTimeMs: 22,
          displayAmortizedUpdateTimeMs: 5.5,
          p95ActiveUpdateTimeMs: 90,
          maxActiveUpdateTimeMs: 94,
        },
      },
    ],
    byMode: { discardedPayload: 'performance-detail' },
  },
  refreshCadenceSummary: { attempts: 209, refreshed: 70 },
  deterministicContract: { enforced: true, passed: true, mismatches: [] },
  hardRegressionContract: { enforced: false, passed: null, mismatches: [] },
  discardedPayload: 'x'.repeat(100_000),
  benchmark: {
    aggregate: { meanRiskScore: 32.4, byRiskBand: { severe: 8 } },
    postOcclusionRecovery: {
      aggregate: { windowCount: 40, recoveredAt8: 27 },
      byMode: { discardedPayload: 'recovery-detail' },
    },
    targetLossRecovery: { reportCount: 4, falseTrackedAbsentAdmittedFrames: 0 },
    worstReports: [
      {
        name: 'glossy-can / fast',
        mode: 'reconstruction',
        axes: { object: 'glossy-can' },
        overallStatus: 'fail',
        failedStages: ['tracking'],
        risk: {
          score: 62,
          band: 'severe',
          primaryWeakness: 'tracking.meanAnchorError',
          components: [{ discardedPayload: 'risk-detail' }],
        },
        metrics: { discardedPayload: 'report-detail' },
      },
    ],
    weakPoints: { discardedPayload: 'weak-point-detail' },
  },
};

test('benchmark output writes complete JSON only to an explicit artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hol-benchmark-cli-'));
  const outputPath = join(directory, 'quick.json');
  const stdout = await formatVisionBenchmarkOutput(benchmarkOutput, { outputPath });

  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), benchmarkOutput);
  assert.deepEqual(JSON.parse(stdout), {
    outputPath,
    size: 'quick',
    scenarioCount: 21,
    modeCount: 4,
    replayCount: 84,
    strictFailures: 51,
    meanRiskScore: 32.4,
  });
});

test('benchmark output keeps full JSON on stdout outside summary-only mode', async () => {
  assert.deepEqual(JSON.parse(await formatVisionBenchmarkOutput(benchmarkOutput)), benchmarkOutput);
});

test('benchmark summary is bounded and keeps decision-critical evidence', async () => {
  const stdout = await formatVisionBenchmarkOutput(benchmarkOutput, { summaryOnly: true });
  const summary = JSON.parse(stdout);

  assert.ok(Buffer.byteLength(stdout) < 8_192);
  assert.doesNotMatch(stdout, /discardedPayload|risk-detail|report-detail/);
  assert.deepEqual(summary.qualitySummary, {
    aggregate: benchmarkOutput.qualitySummary.aggregate,
    failedByMode: benchmarkOutput.qualitySummary.failedByMode,
    topFailingScenarios: benchmarkOutput.qualitySummary.topFailingScenarios,
  });
  assert.deepEqual(summary.benchmark, {
    aggregate: benchmarkOutput.benchmark.aggregate,
    postOcclusionRecovery: benchmarkOutput.benchmark.postOcclusionRecovery.aggregate,
    targetLossRecovery: benchmarkOutput.benchmark.targetLossRecovery,
    worstReports: [
      {
        name: 'glossy-can / fast',
        mode: 'reconstruction',
        axes: { object: 'glossy-can' },
        overallStatus: 'fail',
        failedStages: ['tracking'],
        risk: {
          score: 62,
          band: 'severe',
          primaryWeakness: 'tracking.meanAnchorError',
        },
      },
    ],
  });
  assert.deepEqual(summary.performanceSummary.aggregate.topOwnedStages, [
    {
      stage: 'planarPoseMs',
      meanMs: 4.69,
      exclusiveMeanMs: 4.69,
      maxMs: 29,
      frameCount: 1_276,
      displayAmortizedExclusiveMeanMs: 1.1,
    },
  ]);
  assert.deepEqual(summary.refreshCadenceSummary, benchmarkOutput.refreshCadenceSummary);
  assert.deepEqual(summary.deterministicContract, benchmarkOutput.deterministicContract);
  assert.deepEqual(summary.hardRegressionContract, benchmarkOutput.hardRegressionContract);
});

test('benchmark summary never serializes discarded detail', async () => {
  const output = { ...benchmarkOutput };
  Object.defineProperty(output, 'discardedPayload', {
    enumerable: true,
    get() {
      throw new Error('full benchmark detail was serialized');
    },
  });

  await assert.doesNotReject(formatVisionBenchmarkOutput(output, { summaryOnly: true }));
  await assert.rejects(formatVisionBenchmarkOutput(output), /full benchmark detail was serialized/);
});
