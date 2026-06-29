import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VISION_PERFORMANCE_BUDGETS,
  summarizeVisionBenchmarkPerformance,
} from './visionBenchmarkPerformance.js';

const report = ({
  name,
  mode,
  object,
  wallTimeMs,
  frameCount,
  meanProcessingTimeMs,
  maxProcessingTimeMs,
  p95ProcessingTimeMs,
  stageTimings = null,
}) => ({
  name,
  mode,
  axes: {
    object,
    background: 'desk',
    motion: 'fast',
    occlusion: 'clean',
  },
  runtime: {
    wallTimeMs,
    frameCount,
    meanProcessingTimeMs,
    p95ProcessingTimeMs,
    maxProcessingTimeMs,
    stageTimings,
  },
});

test('benchmark performance summary ranks slow modes and reports weighted frame processing', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'fast depth',
      mode: 'depth-fusion',
      object: 'book',
      wallTimeMs: 100,
      frameCount: 20,
      meanProcessingTimeMs: 2,
      maxProcessingTimeMs: 6,
    }),
    report({
      name: 'slow direct',
      mode: 'direct-photometric',
      object: 'mug',
      wallTimeMs: 300,
      frameCount: 30,
      meanProcessingTimeMs: 5,
      maxProcessingTimeMs: 14,
    }),
  ]);

  assert.equal(summary.aggregate.count, 2);
  assert.equal(summary.aggregate.totalWallTimeMs, 400);
  assert.equal(summary.aggregate.meanReplayWallTimeMs, 200);
  assert.equal(summary.aggregate.meanFrameWallTimeMs, 8);
  assert.equal(summary.aggregate.meanFrameProcessingTimeMs, 3.8);
  assert.equal(summary.byMode[0].name, 'direct-photometric');
  assert.equal(summary.byMode[0].maxFrameProcessingTimeMs, 14);
  assert.equal(summary.slowestReports[0].name, 'slow direct');
});

test('benchmark performance summary aggregates per-stage frame timing', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'fast depth',
      mode: 'depth-fusion',
      object: 'book',
      wallTimeMs: 100,
      frameCount: 20,
      meanProcessingTimeMs: 2,
      maxProcessingTimeMs: 6,
      stageTimings: {
        keypointTrackMs: { meanMs: 1, maxMs: 4 },
        reconstructionUpdateMs: { meanMs: 0.5, maxMs: 2 },
      },
    }),
    report({
      name: 'slow direct',
      mode: 'direct-photometric',
      object: 'mug',
      wallTimeMs: 300,
      frameCount: 30,
      meanProcessingTimeMs: 5,
      maxProcessingTimeMs: 14,
      stageTimings: {
        keypointTrackMs: { meanMs: 3, maxMs: 10 },
        reconstructionUpdateMs: { meanMs: 4, maxMs: 12 },
      },
    }),
  ]);

  assert.equal(summary.aggregate.stageTimings.keypointTrackMs.meanMs, 2.2);
  assert.equal(summary.aggregate.stageTimings.keypointTrackMs.maxMs, 10);
  assert.equal(summary.aggregate.stageTimings.reconstructionUpdateMs.meanMs, 2.6);
  assert.equal(summary.byMode[0].stageTimings.reconstructionUpdateMs.maxMs, 12);
});

test('benchmark performance summary reports missing runtime instead of scoring it as zero cost', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'valid run',
      mode: 'depth-fusion',
      object: 'book',
      wallTimeMs: 120,
      frameCount: 20,
      meanProcessingTimeMs: 4,
      maxProcessingTimeMs: 9,
    }),
    {
      name: 'missing runtime',
      mode: 'direct-photometric',
      axes: {
        object: 'mug',
        background: 'desk',
        motion: 'fast',
        occlusion: 'clean',
      },
      runtime: {},
    },
  ]);

  assert.equal(summary.aggregate.count, 2);
  assert.equal(summary.aggregate.invalidRuntimeCount, 1);
  assert.equal(summary.aggregate.missingProcessingReports, 1);
  assert.equal(summary.aggregate.meanFrameProcessingTimeMs, 4);
  assert.equal(summary.byMode.find(group => group.name === 'direct-photometric').meanFrameProcessingTimeMs, null);
  assert.equal(summary.byMode.find(group => group.name === 'direct-photometric').maxFrameProcessingTimeMs, null);
});

test('benchmark performance summary flags mobile frame budget overages by report and stage', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'over budget direct',
      mode: 'direct-photometric',
      object: 'mug',
      wallTimeMs: 300,
      frameCount: 30,
      meanProcessingTimeMs: VISION_PERFORMANCE_BUDGETS.trackingFrameBudgetMs + 1,
      p95ProcessingTimeMs: VISION_PERFORMANCE_BUDGETS.frameBudgetMs + 0.5,
      maxProcessingTimeMs: VISION_PERFORMANCE_BUDGETS.frameBudgetMs + 3,
      stageTimings: {
        reconstructionUpdateMs: {
          meanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 0.5,
          maxMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 4,
          frameCount: 30,
        },
      },
    }),
  ]);

  assert.equal(summary.aggregate.budget.meanFrameProcessingOverBudget, true);
  assert.equal(summary.aggregate.budget.maxFrameProcessingOverBudget, true);
  assert.deepEqual(summary.aggregate.budget.stageOverages, [
    {
      stage: 'reconstructionUpdateMs',
      meanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 0.5,
      maxMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 4,
    },
  ]);
  assert.equal(summary.slowestReports[0].runtime.maxProcessingTimeMs, VISION_PERFORMANCE_BUDGETS.frameBudgetMs + 3);
});
