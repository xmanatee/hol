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
  targetClass = object,
  geometry = object,
  lighting = 'soft-desk',
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
    targetClass,
    geometry,
    background: 'desk',
    lighting,
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

test('benchmark performance summary groups runtime by target class', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'fast book cover',
      mode: 'depth-fusion',
      object: 'planar-book',
      targetClass: 'book',
      wallTimeMs: 80,
      frameCount: 20,
      meanProcessingTimeMs: 2,
      maxProcessingTimeMs: 5,
    }),
    report({
      name: 'slow dark book',
      mode: 'direct-photometric',
      object: 'dark-book',
      targetClass: 'book',
      wallTimeMs: 240,
      frameCount: 20,
      meanProcessingTimeMs: 6,
      maxProcessingTimeMs: 18,
    }),
    report({
      name: 'steady mug',
      mode: 'sparse-reconstruction',
      object: 'handled-mug',
      targetClass: 'mug',
      wallTimeMs: 120,
      frameCount: 20,
      meanProcessingTimeMs: 3,
      maxProcessingTimeMs: 9,
    }),
  ]);

  assert.equal(summary.byTargetClass[0].name, 'book');
  assert.equal(summary.byTargetClass[0].count, 2);
  assert.equal(summary.byTargetClass[0].meanFrameProcessingTimeMs, 4);
  assert.equal(summary.byTargetClass[0].maxFrameProcessingTimeMs, 18);
  assert.equal(summary.byTargetClass[1].name, 'mug');
});

test('benchmark performance summary groups runtime by geometry and lighting', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'fast planar book',
      mode: 'depth-fusion',
      object: 'planar-book',
      geometry: 'planar',
      lighting: 'soft-desk',
      wallTimeMs: 80,
      frameCount: 20,
      meanProcessingTimeMs: 2,
      maxProcessingTimeMs: 5,
    }),
    report({
      name: 'slow glossy card',
      mode: 'direct-photometric',
      object: 'laminated-card',
      geometry: 'planar-glossy',
      lighting: 'high-contrast-backlight',
      wallTimeMs: 260,
      frameCount: 20,
      meanProcessingTimeMs: 7,
      maxProcessingTimeMs: 20,
    }),
    report({
      name: 'slow glossy phone',
      mode: 'direct-photometric',
      object: 'glossy-phone',
      geometry: 'planar-glossy',
      lighting: 'high-contrast-backlight',
      wallTimeMs: 220,
      frameCount: 20,
      meanProcessingTimeMs: 5,
      maxProcessingTimeMs: 16,
    }),
  ]);

  assert.equal(summary.byGeometry[0].name, 'planar-glossy');
  assert.equal(summary.byGeometry[0].count, 2);
  assert.equal(summary.byGeometry[0].meanFrameProcessingTimeMs, 6);
  assert.equal(summary.byGeometry[0].maxFrameProcessingTimeMs, 20);
  assert.equal(summary.byLighting[0].name, 'high-contrast-backlight');
  assert.equal(summary.byLighting[0].count, 2);
  assert.equal(summary.byLighting[0].meanFrameProcessingTimeMs, 6);
  assert.equal(summary.byLighting[1].name, 'soft-desk');
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

test('benchmark performance summary separates stage coverage from amortized frame cost', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'occasional recovery',
      mode: 'sparse-reconstruction',
      object: 'mug',
      wallTimeMs: 120,
      frameCount: 10,
      meanProcessingTimeMs: 3,
      maxProcessingTimeMs: 40,
      stageTimings: {
        relocalizationMs: { meanMs: 30, maxMs: 40, frameCount: 2 },
      },
    }),
    report({
      name: 'steady reconstruction',
      mode: 'sparse-reconstruction',
      object: 'mug',
      wallTimeMs: 200,
      frameCount: 20,
      meanProcessingTimeMs: 4,
      maxProcessingTimeMs: 7,
      stageTimings: {
        reconstructionUpdateMs: { meanMs: 5, maxMs: 7, frameCount: 20 },
      },
    }),
  ]);

  assert.equal(summary.aggregate.stageTimings.reconstructionUpdateMs.frameCount, 20);
  assert.equal(summary.aggregate.stageTimings.reconstructionUpdateMs.coverageRatio, 20 / 30);
  assert.equal(summary.aggregate.stageTimings.reconstructionUpdateMs.amortizedMeanMs, 100 / 30);
  assert.equal(summary.aggregate.stageTimings.relocalizationMs.frameCount, 2);
  assert.equal(summary.aggregate.stageTimings.relocalizationMs.coverageRatio, 2 / 30);
  assert.equal(summary.aggregate.stageTimings.relocalizationMs.amortizedMeanMs, 60 / 30);
  assert.equal(summary.aggregate.stageTimings.reconstructionUpdateMs.meanMs, 5);
  assert.equal(summary.aggregate.stageTimings.relocalizationMs.meanMs, 30);
});

test('benchmark performance budget separates sustained stages from rare spikes and wrapper timings', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'mixed stage budget evidence',
      mode: 'sparse-reconstruction',
      object: 'mug',
      wallTimeMs: 300,
      frameCount: 30,
      meanProcessingTimeMs: 5,
      maxProcessingTimeMs: 55,
      stageTimings: {
        totalMs: {
          meanMs: 45,
          maxMs: 55,
          frameCount: 30,
        },
        keypointUpdateMs: {
          meanMs: 44,
          maxMs: 54,
          frameCount: 30,
        },
        reconstructionUpdateMs: {
          meanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 1,
          maxMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 2,
          frameCount: 30,
        },
        relocalizationMs: {
          meanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 34,
          maxMs: 55,
          frameCount: 2,
        },
        templateUpdateMs: {
          meanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs - 1,
          maxMs: VISION_PERFORMANCE_BUDGETS.frameBudgetMs + 1,
          frameCount: 1,
        },
      },
    }),
  ]);

  assert.deepEqual(summary.aggregate.budget.stageOverages.map(item => item.stage), [
    'reconstructionUpdateMs',
  ]);
  assert.deepEqual(summary.aggregate.budget.stageSpikeOverages.map(item => item.stage), [
    'relocalizationMs',
    'templateUpdateMs',
  ]);
  assert.deepEqual(summary.aggregate.budget.excludedStageTimings.map(item => item.stage), [
    'totalMs',
    'keypointUpdateMs',
  ]);
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
      frameCount: 30,
      coverageRatio: 1,
      amortizedMeanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 0.5,
    },
  ]);
  assert.equal(summary.slowestReports[0].runtime.maxProcessingTimeMs, VISION_PERFORMANCE_BUDGETS.frameBudgetMs + 3);
});
