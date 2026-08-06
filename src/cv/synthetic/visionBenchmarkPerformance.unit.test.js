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
  sourceFrameCount = frameCount,
  admittedUpdateCount = frameCount,
  heldFrameCount = sourceFrameCount - admittedUpdateCount,
  displayFrameCount = sourceFrameCount,
  updateIntervalMs = 1000 / 15,
  presentationPredictionFrameCount = 0,
  meanPresentationPredictionTimeMs = null,
  maxPresentationPredictionTimeMs = null,
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
    replayWallTimeMs: wallTimeMs,
    meanActiveUpdateTimeMs: meanProcessingTimeMs,
    p95ActiveUpdateTimeMs: p95ProcessingTimeMs,
    maxActiveUpdateTimeMs: maxProcessingTimeMs,
    stageTimings,
    sourceFrameCount,
    admittedUpdateCount,
    heldFrameCount,
    displayFrameCount,
    updateIntervalMs,
    presentationPredictionFrameCount,
    meanPresentationPredictionTimeMs,
    maxPresentationPredictionTimeMs,
  },
});

test('benchmark performance separates active update latency from display-amortized cost and pose cadence', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'one production second',
      mode: 'direct-photometric',
      object: 'mug',
      wallTimeMs: 240,
      frameCount: 15,
      sourceFrameCount: 30,
      admittedUpdateCount: 15,
      heldFrameCount: 15,
      displayFrameCount: 60,
      meanProcessingTimeMs: 12,
      p95ProcessingTimeMs: 70,
      maxProcessingTimeMs: 74,
      updateIntervalMs: 1000 / 15,
      presentationPredictionFrameCount: 30,
      meanPresentationPredictionTimeMs: 0.02,
      maxPresentationPredictionTimeMs: 0.04,
    }),
  ]);

  assert.equal(summary.aggregate.sourceFrameCount, 30);
  assert.equal(summary.aggregate.admittedUpdateCount, 15);
  assert.equal(summary.aggregate.heldFrameCount, 15);
  assert.equal(summary.aggregate.displayFrameCount, 60);
  assert.equal(summary.aggregate.admissionRatio, 0.5);
  assert.equal(summary.aggregate.meanActiveUpdateTimeMs, 12);
  assert.equal(summary.aggregate.displayAmortizedUpdateTimeMs, 3);
  assert.equal(summary.aggregate.ownedStageTimeMs, 0);
  assert.equal(summary.aggregate.timingCoverageRatio, 0);
  assert.equal(summary.aggregate.unattributedUpdateTimeMs, 180);
  assert.equal(summary.aggregate.displayAmortizedUnattributedUpdateTimeMs, 3);
  assert.equal(summary.aggregate.presentationPredictionFrameCount, 30);
  assert.equal(summary.aggregate.meanPresentationPredictionTimeMs, 0.02);
  assert.equal(summary.aggregate.displayAmortizedPresentationPredictionTimeMs, 0.01);
  assert.equal(summary.aggregate.maxPresentationPredictionTimeMs, 0.04);
  assert.equal(summary.aggregate.budget.displayAmortizedUpdateOverBudget, false);
  assert.equal(summary.aggregate.budget.cadenceLatencyOverageCount, 1);
});

test('benchmark stage ownership subtracts inclusive child timings exactly once', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'one keyframe extraction',
      mode: 'direct-photometric',
      object: 'book',
      wallTimeMs: 80,
      frameCount: 15,
      sourceFrameCount: 30,
      admittedUpdateCount: 15,
      heldFrameCount: 15,
      displayFrameCount: 60,
      meanProcessingTimeMs: 4,
      maxProcessingTimeMs: 60,
      stageTimings: {
        keyframeStoreMs: { meanMs: 60, maxMs: 60, frameCount: 1 },
        keyframeFeatureExtractionMs: { meanMs: 54, maxMs: 54, frameCount: 1 },
      },
    }),
  ]);

  assert.equal(summary.aggregate.stageTimings.keyframeStoreMs.exclusiveMeanMs, 6);
  assert.equal(summary.aggregate.stageTimings.keyframeFeatureExtractionMs.exclusiveMeanMs, 54);
  assert.equal(summary.aggregate.ownedStageTimeMs, 60);
  assert.equal(summary.aggregate.displayAmortizedOwnedStageTimeMs, 1);
  assert.deepEqual(
    summary.aggregate.budget.stageSpikeOverages.map((item) => item.stage),
    ['keyframeFeatureExtractionMs'],
  );
});

test('benchmark timing coverage attributes nested keypoint phases without overlap', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'fully attributed update',
      mode: 'parametric-surface',
      object: 'book',
      wallTimeMs: 180,
      frameCount: 15,
      sourceFrameCount: 30,
      admittedUpdateCount: 15,
      heldFrameCount: 15,
      displayFrameCount: 60,
      meanProcessingTimeMs: 12,
      maxProcessingTimeMs: 12,
      stageTimings: {
        keypointUpdateMs: { meanMs: 12, maxMs: 12, frameCount: 15 },
        trackingValidationMs: { meanMs: 4, maxMs: 4, frameCount: 15 },
        landmarkMetricsMs: { meanMs: 1, maxMs: 1, frameCount: 15 },
        preliminaryAttachmentEvidenceMs: { meanMs: 2, maxMs: 2, frameCount: 15 },
        poseEstimationMs: { meanMs: 6, maxMs: 6, frameCount: 15 },
        objectPoseMs: { meanMs: 1, maxMs: 1, frameCount: 15 },
        planarPoseMs: { meanMs: 4, maxMs: 4, frameCount: 15 },
        poseSelectionMs: { meanMs: 2, maxMs: 2, frameCount: 15 },
        trackerAttachmentResolveMs: { meanMs: 1, maxMs: 1, frameCount: 15 },
      },
    }),
  ]);

  assert.equal(summary.aggregate.stageTimings.trackingValidationMs.exclusiveMeanMs, 1);
  assert.equal(summary.aggregate.stageTimings.poseEstimationMs.exclusiveMeanMs, 1);
  assert.equal(summary.aggregate.stageTimings.poseSelectionMs.exclusiveMeanMs, 1);
  assert.equal(summary.aggregate.ownedStageTimeMs, 180);
  assert.equal(summary.aggregate.timingCoverageRatio, 1);
  assert.equal(summary.aggregate.unattributedUpdateTimeMs, 0);
  assert.equal(summary.aggregate.displayAmortizedUnattributedUpdateTimeMs, 0);
});

test('benchmark timing coverage excludes keypoint recovery nested in template updates', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'template recovery',
      mode: 'parametric-surface',
      object: 'book',
      wallTimeMs: 120,
      frameCount: 10,
      sourceFrameCount: 20,
      admittedUpdateCount: 10,
      heldFrameCount: 10,
      displayFrameCount: 40,
      meanProcessingTimeMs: 12,
      maxProcessingTimeMs: 18,
      stageTimings: {
        templateUpdateMs: { meanMs: 12, maxMs: 18, frameCount: 10 },
        keypointRefreshMs: { meanMs: 2, maxMs: 2, frameCount: 4 },
        keypointReinitializationMs: { meanMs: 6, maxMs: 6, frameCount: 2 },
      },
    }),
  ]);

  assert.equal(summary.aggregate.stageTimings.templateUpdateMs.exclusiveTimeMs, 100);
  assert.equal(summary.aggregate.ownedStageTimeMs, 120);
  assert.equal(summary.aggregate.timingCoverageRatio, 1);
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
  assert.equal(summary.aggregate.totalReplayWallTimeMs, 400);
  assert.equal(summary.aggregate.meanReplayWallTimeMs, 200);
  assert.equal(summary.aggregate.meanSourceFrameWallTimeMs, 8);
  assert.equal(summary.aggregate.meanActiveUpdateTimeMs, 3.8);
  assert.equal(summary.byMode[0].name, 'direct-photometric');
  assert.equal(summary.byMode[0].maxActiveUpdateTimeMs, 14);
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
  assert.equal(summary.byTargetClass[0].meanActiveUpdateTimeMs, 4);
  assert.equal(summary.byTargetClass[0].maxActiveUpdateTimeMs, 18);
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
  assert.equal(summary.byGeometry[0].meanActiveUpdateTimeMs, 6);
  assert.equal(summary.byGeometry[0].maxActiveUpdateTimeMs, 20);
  assert.equal(summary.byLighting[0].name, 'high-contrast-backlight');
  assert.equal(summary.byLighting[0].count, 2);
  assert.equal(summary.byLighting[0].meanActiveUpdateTimeMs, 6);
  assert.equal(summary.byLighting[1].name, 'soft-desk');
});

test('benchmark performance summary exposes localized mode interaction bottlenecks', () => {
  const summary = summarizeVisionBenchmarkPerformance([
    report({
      name: 'fast direct book',
      mode: 'direct-photometric',
      object: 'planar-book',
      geometry: 'planar',
      wallTimeMs: 80,
      frameCount: 20,
      meanProcessingTimeMs: 2,
      maxProcessingTimeMs: 5,
    }),
    report({
      name: 'slow direct mug',
      mode: 'direct-photometric',
      object: 'handled-mug',
      geometry: 'handled-tapered-cylinder',
      wallTimeMs: 320,
      frameCount: 20,
      meanProcessingTimeMs: 8,
      maxProcessingTimeMs: 24,
    }),
    report({
      name: 'fast sparse mug',
      mode: 'sparse-reconstruction',
      object: 'handled-mug',
      geometry: 'handled-tapered-cylinder',
      wallTimeMs: 100,
      frameCount: 20,
      meanProcessingTimeMs: 3,
      maxProcessingTimeMs: 7,
    }),
  ]);

  assert.equal(summary.byModeObject[0].name, 'direct-photometric / handled-mug');
  assert.equal(summary.byModeObject[0].meanActiveUpdateTimeMs, 8);
  assert.equal(summary.byModeObject[0].maxActiveUpdateTimeMs, 24);
  assert.equal(summary.byModeGeometry[0].name, 'direct-photometric / handled-tapered-cylinder');
  assert.equal(summary.byModeGeometry[0].meanActiveUpdateTimeMs, 8);
  assert.equal(summary.byModeGeometry[1].name, 'sparse-reconstruction / handled-tapered-cylinder');
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
  assert.equal(summary.aggregate.stageTimings.reconstructionUpdateMs.sourceCoverageRatio, 20 / 30);
  assert.equal(summary.aggregate.stageTimings.reconstructionUpdateMs.sourceAmortizedMeanMs, 100 / 30);
  assert.equal(summary.aggregate.stageTimings.relocalizationMs.frameCount, 2);
  assert.equal(summary.aggregate.stageTimings.relocalizationMs.sourceCoverageRatio, 2 / 30);
  assert.equal(summary.aggregate.stageTimings.relocalizationMs.sourceAmortizedMeanMs, 60 / 30);
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

  assert.deepEqual(
    summary.aggregate.budget.stageOverages.map((item) => item.stage),
    ['reconstructionUpdateMs'],
  );
  assert.deepEqual(
    summary.aggregate.budget.stageSpikeOverages.map((item) => item.stage),
    ['relocalizationMs'],
  );
  assert.deepEqual(
    summary.aggregate.budget.excludedStageTimings.map((item) => item.stage),
    ['totalMs', 'keypointUpdateMs'],
  );
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
  assert.equal(summary.aggregate.meanActiveUpdateTimeMs, 4);
  assert.equal(
    summary.byMode.find((group) => group.name === 'direct-photometric').meanActiveUpdateTimeMs,
    null,
  );
  assert.equal(
    summary.byMode.find((group) => group.name === 'direct-photometric').maxActiveUpdateTimeMs,
    null,
  );
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

  assert.equal(summary.aggregate.budget.displayAmortizedUpdateOverBudget, true);
  assert.equal(summary.aggregate.budget.cadenceLatencyOverageCount, 0);
  assert.deepEqual(summary.aggregate.budget.stageOverages, [
    {
      stage: 'reconstructionUpdateMs',
      ownership: 'owned',
      meanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 0.5,
      exclusiveMeanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 0.5,
      maxMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 4,
      frameCount: 30,
      sourceCoverageRatio: 1,
      admittedCoverageRatio: 1,
      sourceAmortizedMeanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 0.5,
      displayAmortizedMeanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 0.5,
      displayAmortizedExclusiveMeanMs: VISION_PERFORMANCE_BUDGETS.opencvStageBudgetMs + 0.5,
    },
  ]);
  assert.equal(
    summary.slowestReports[0].runtime.maxActiveUpdateTimeMs,
    VISION_PERFORMANCE_BUDGETS.frameBudgetMs + 3,
  );
});
