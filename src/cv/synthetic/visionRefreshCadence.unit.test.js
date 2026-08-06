import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVisionRefreshCadence,
  mergeVisionRefreshCadence,
  summarizeVisionRefreshCadence,
} from './visionRefreshCadence.js';

const frame = ({
  admittedUpdate = true,
  refreshReason = null,
  failureReason = null,
  gfttCallCount = null,
  gfttPixelCount = null,
  gfttPreparationCount = null,
  reinitializationResult = null,
  reinitializationGfttCallCount = null,
  reinitializationGfttPixelCount = null,
  reinitializationGfttPreparationCount = null,
  stageTimings = null,
} = {}) => ({
  runtime: { admittedUpdate, stageTimings },
  metrics: {
    landmarkRefreshReason: refreshReason,
    landmarkRefreshFailureReason: failureReason,
    landmarkRefreshGfttCallCount: gfttCallCount,
    landmarkRefreshGfttPixelCount: gfttPixelCount,
    landmarkRefreshGfttPreparationCount: gfttPreparationCount,
    keypointReinitializationResult: reinitializationResult,
    keypointReinitializationGfttCallCount: reinitializationGfttCallCount,
    keypointReinitializationGfttPixelCount: reinitializationGfttPixelCount,
    keypointReinitializationGfttPreparationCount: reinitializationGfttPreparationCount,
  },
});

test('refresh cadence comparison reports exact contract drift', () => {
  assert.deepEqual(
    compareVisionRefreshCadence(
      { attempts: 188, failureReasons: { 'no-reference-transform': 111 } },
      { attempts: 188, failureReasons: { 'no-reference-transform': 111 } },
    ),
    [],
  );
  assert.deepEqual(
    compareVisionRefreshCadence(
      { attempts: 187, failureReasons: { 'no-reference-transform': 110 } },
      { attempts: 188, failureReasons: { 'no-reference-transform': 111 } },
    ),
    [
      { field: 'attempts', expected: 188, actual: 187 },
      {
        field: 'failureReasons',
        expected: { 'no-reference-transform': 111 },
        actual: { 'no-reference-transform': 110 },
      },
    ],
  );
});

test('refresh cadence counts admitted attempts without duplicating held-frame telemetry', () => {
  const refreshed = frame({
    gfttCallCount: 1,
    gfttPixelCount: 5400,
    gfttPreparationCount: 1,
    stageTimings: { keyframeFeatureExtractionMs: 18 },
  });
  const blocked = frame({
    refreshReason: 'support-recovery',
    failureReason: 'no-reference-transform',
    gfttCallCount: 0,
    gfttPixelCount: 0,
    gfttPreparationCount: 0,
    reinitializationResult: 'reinitialized',
    reinitializationGfttCallCount: 1,
    reinitializationGfttPixelCount: 3200,
    reinitializationGfttPreparationCount: 1,
    stageTimings: { relocalizationFeatureExtractionMs: 22 },
  });
  const held = frame({
    admittedUpdate: false,
    refreshReason: 'support-recovery',
    failureReason: 'no-reference-transform',
    gfttCallCount: 0,
    gfttPixelCount: 0,
    gfttPreparationCount: 0,
    reinitializationResult: 'reinitialized',
    reinitializationGfttCallCount: 1,
    reinitializationGfttPixelCount: 3200,
    reinitializationGfttPreparationCount: 1,
  });

  assert.deepEqual(summarizeVisionRefreshCadence([refreshed, blocked, held]), {
    attempts: 2,
    refreshed: 1,
    failed: 1,
    noReferenceFailures: 1,
    candidateStagesEvaluated: 2,
    candidateStagesSkipped: 0,
    refreshGfttCalls: 1,
    refreshGfttPixels: 5400,
    refreshGfttPreparations: 1,
    reinitializationGfttCalls: 1,
    reinitializationGfttPixels: 3200,
    reinitializationGfttPreparations: 1,
    reinitialized: 1,
    reinitializationFailures: 0,
    orbKeyframeExtractionFrames: 1,
    learnedRelocalizationExtractionFrames: 1,
    failureReasons: { 'no-reference-transform': 1 },
  });
});

test('refresh cadence merges replay summaries without losing failure reasons', () => {
  const first = summarizeVisionRefreshCadence([
    frame({
      refreshReason: 'mapping-growth',
      gfttCallCount: 2,
      gfttPixelCount: 7200,
      gfttPreparationCount: 1,
    }),
  ]);
  const second = summarizeVisionRefreshCadence([
    frame({
      refreshReason: 'support-growth',
      failureReason: 'insufficient-candidates',
      gfttCallCount: 3,
      gfttPixelCount: 8400,
      gfttPreparationCount: 1,
      reinitializationResult: 'insufficient-candidates',
      reinitializationGfttCallCount: 2,
      reinitializationGfttPixelCount: 6100,
      reinitializationGfttPreparationCount: 1,
    }),
  ]);

  const merged = mergeVisionRefreshCadence([first, second]);

  assert.equal(merged.attempts, 2);
  assert.equal(merged.refreshed, 1);
  assert.equal(merged.failed, 1);
  assert.equal(merged.refreshGfttCalls, 5);
  assert.equal(merged.refreshGfttPixels, 15600);
  assert.equal(merged.refreshGfttPreparations, 2);
  assert.equal(merged.reinitializationGfttCalls, 2);
  assert.equal(merged.reinitializationGfttPixels, 6100);
  assert.equal(merged.reinitializationGfttPreparations, 1);
  assert.equal(merged.reinitializationFailures, 1);
  assert.deepEqual(merged.failureReasons, { 'insufficient-candidates': 1 });
});
