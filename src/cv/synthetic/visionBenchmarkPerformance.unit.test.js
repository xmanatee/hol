import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeVisionBenchmarkPerformance } from './visionBenchmarkPerformance.js';

const report = ({
  name,
  mode,
  object,
  wallTimeMs,
  frameCount,
  meanProcessingTimeMs,
  maxProcessingTimeMs,
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
