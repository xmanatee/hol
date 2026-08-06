import test from 'node:test';
import assert from 'node:assert/strict';

import { computeTapVidMetrics, TAP_VID_STABLE_REDETECTION_DURATION_MS } from './tapVidMetrics.js';

test('TAP-Vid first-query metrics match the official threshold Jaccard and occlusion definitions', () => {
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 30,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: Array.from({ length: 6 }, () => [0, 0]),
        groundTruthOccluded: [false, false, false, true, true, false],
        predictedPoints: [
          [0, 0],
          [0, 0],
          [3, 0],
          [0, 0],
          [0, 0],
          [20, 0],
        ],
        predictedOccluded: [false, false, false, false, true, true],
      },
    ],
  });

  assert.equal(metrics.evaluationPointCount, 5);
  assert.equal(metrics.visibleGroundTruthPointCount, 3);
  assert.equal(metrics.predictedVisiblePointCount, 3);
  assert.equal(metrics.visibilityTruePositiveCount, 2);
  assert.equal(metrics.visibilityTrueNegativeCount, 1);
  assert.equal(metrics.visibilityFalsePositiveCount, 1);
  assert.equal(metrics.visibilityFalseNegativeCount, 1);
  assert.equal(metrics.occlusionAccuracy, 3 / 5);
  assert.equal(metrics.meanVisiblePointError, 23 / 3);
  assert.equal(metrics.p50VisiblePointError, 3);
  assert.equal(metrics.p95VisiblePointError, 18.299999999999997);
  assert.equal(metrics.ptsWithin1, 1 / 3);
  assert.equal(metrics.ptsWithin2, 1 / 3);
  assert.equal(metrics.ptsWithin4, 2 / 3);
  assert.equal(metrics.ptsWithin8, 2 / 3);
  assert.equal(metrics.ptsWithin16, 2 / 3);
  assert.equal(metrics.averagePointsWithinThreshold, 8 / 15);
  assert.equal(metrics.jaccard1, 1 / 5);
  assert.equal(metrics.jaccard2, 1 / 5);
  assert.equal(metrics.jaccard4, 1 / 2);
  assert.equal(metrics.jaccard8, 1 / 2);
  assert.equal(metrics.jaccard16, 1 / 2);
  assert.equal(metrics.averageJaccard, 0.38);
});

test('TAP-Vid metrics scale source raster coordinates to the official 256px evaluation raster', () => {
  const metrics = computeTapVidMetrics({
    width: 512,
    height: 512,
    framesPerSecond: 30,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: [
          [100, 100],
          [102, 100],
        ],
        groundTruthOccluded: [false, false],
        predictedPoints: [
          [100, 100],
          [104, 100],
        ],
        predictedOccluded: [false, false],
      },
    ],
  });

  assert.equal(metrics.ptsWithin1, 0, 'the official metric uses a strict less-than boundary');
  assert.equal(metrics.ptsWithin2, 1);
});

test('TAP-Vid metrics aggregate counters across independent queries instead of averaging track ratios', () => {
  const track = ({ frameCount, predictedX }) => ({
    queryFrame: 0,
    groundTruthPoints: Array.from({ length: frameCount }, () => [0, 0]),
    groundTruthOccluded: Array.from({ length: frameCount }, () => false),
    predictedPoints: Array.from({ length: frameCount }, () => [predictedX, 0]),
    predictedOccluded: Array.from({ length: frameCount }, () => false),
  });
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 30,
    tracks: [track({ frameCount: 2, predictedX: 0 }), track({ frameCount: 4, predictedX: 20 })],
  });

  assert.equal(metrics.ptsWithin16, 1 / 4);
  assert.equal(metrics.jaccard16, 1 / 7);
});

test('TAP-Vid re-detection AJ measures only record-length post-reappearance segments', () => {
  const frameCount = 15;
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 30,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: Array.from({ length: frameCount }, () => [0, 0]),
        groundTruthOccluded: [
          false,
          true,
          false,
          false,
          true,
          false,
          true,
          true,
          true,
          true,
          false,
          false,
          false,
          false,
          false,
        ],
        predictedPoints: Array.from({ length: frameCount }, () => [0, 0]),
        predictedOccluded: Array.from({ length: frameCount }, () => false),
      },
    ],
  });

  assert.equal(metrics.eligibleReappearanceCount, 2);
  assert.equal(metrics.maximumEligibleUndetectableFrames, 4);
  assert.deepEqual(metrics.reDetectionAverageJaccardByMinimumUndetectableFrames, {
    1: 13 / 18,
    4: 1,
    16: null,
    64: null,
    256: null,
  });
  assert.equal(metrics.reDetectionAverageJaccard, 31 / 36);
});

test('temporal robustness measures persistent false visibility and stable re-detection latency', () => {
  const frameCount = 13;
  const predictedPoints = Array.from({ length: frameCount }, () => [32, 32]);
  predictedPoints[5] = [64, 32];
  predictedPoints[6] = [64, 32];
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 30,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: Array.from({ length: frameCount }, () => [32, 32]),
        groundTruthOccluded: [
          false,
          true,
          true,
          true,
          true,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
        ],
        predictedPoints,
        predictedOccluded: [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
        ],
      },
    ],
  });

  assert.equal(TAP_VID_STABLE_REDETECTION_DURATION_MS, 100);
  assert.equal(metrics.stableReDetectionRequiredFrames, 3);
  assert.equal(metrics.maximumFalseVisibleStreakFrames, 4);
  assert.equal(metrics.maximumFalseVisibleDurationMs, 400 / 3);
  assert.equal(metrics.stableReDetectionEligibleCount, 1);
  assert.equal(metrics.stableReDetectionRecoveredCount, 1);
  assert.equal(metrics.stableReDetectionRecall, 1);
  assert.equal(metrics.meanStableReDetectionLatencyFrames, 2);
  assert.equal(metrics.maximumStableReDetectionLatencyFrames, 2);
  assert.deepEqual(metrics.stableReDetectionEvents, [
    {
      trackIndex: 0,
      reappearanceFrame: 5,
      undetectableFrames: 4,
      undetectableDurationMs: 400 / 3,
      visibleRunFrames: 8,
      visibleRunDurationMs: 800 / 3,
      recoveredFrame: 7,
      latencyFrames: 2,
      latencyMs: 200 / 3,
    },
  ]);
});

test('temporal robustness rejects clustered and delayed failures hidden by aggregate TAP metrics', () => {
  const frameCount = 100;
  const groundTruthOccluded = Array.from(
    { length: frameCount },
    (_, frameIndex) => (frameIndex >= 1 && frameIndex <= 20) || (frameIndex >= 26 && frameIndex <= 30),
  );
  const predictedOccluded = Array.from(
    { length: frameCount },
    (_, frameIndex) => frameIndex >= 11 && frameIndex <= 30,
  );
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 30,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: Array.from({ length: frameCount }, () => [0, 0]),
        groundTruthOccluded,
        predictedPoints: Array.from({ length: frameCount }, () => [0, 0]),
        predictedOccluded,
      },
    ],
  });

  assert.ok(metrics.averageJaccard > 0.75, 'whole-track AJ hides the clustered failure');
  assert.ok(metrics.occlusionAccuracy > 0.8, 'whole-track OA hides the clustered failure');
  assert.ok(metrics.reDetectionAverageJaccard > 0.75, 'tail AJ_RD hides delayed recovery');
  assert.equal(metrics.maximumFalseVisibleStreakFrames, 10);
  assert.ok(Math.abs(metrics.maximumFalseVisibleDurationMs - 1000 / 3) < 1e-9);
  assert.equal(metrics.stableReDetectionEligibleCount, 1);
  assert.equal(metrics.stableReDetectionRecoveredCount, 0);
  assert.equal(metrics.stableReDetectionRecall, 0);
  assert.equal(metrics.meanStableReDetectionLatencyFrames, null);
  assert.equal(metrics.maximumStableReDetectionLatencyFrames, null);
  assert.equal(metrics.maximumStableReDetectionLatencyMs, null);
  assert.equal(metrics.maximumMissedVisibleStreakFrames, 5);
  assert.equal(metrics.visibleTrackFragmentationCount, 0);
  assert.equal(metrics.missedVisibleStreaks[0].fragmentsTrack, false);
});

test('temporal robustness exposes a long visible-target outage hidden by aggregate and recovery metrics', () => {
  const frameCount = 120;
  const groundTruthOccluded = Array.from(
    { length: frameCount },
    (_, frameIndex) => frameIndex >= 1 && frameIndex <= 6,
  );
  const predictedOccluded = groundTruthOccluded.map(
    (occluded, frameIndex) => occluded || (frameIndex >= 40 && frameIndex <= 54),
  );
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 30,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: Array.from({ length: frameCount }, () => [0, 0]),
        groundTruthOccluded,
        predictedPoints: Array.from({ length: frameCount }, () => [0, 0]),
        predictedOccluded,
      },
    ],
  });

  assert.ok(metrics.averageJaccard > 0.8, 'whole-track AJ hides the concentrated outage');
  assert.ok(metrics.occlusionAccuracy > 0.8, 'whole-track OA hides the concentrated outage');
  assert.ok(metrics.reDetectionAverageJaccard > 0.8, 'tail AJ_RD hides the later outage');
  assert.equal(metrics.maximumFalseVisibleDurationMs, 0);
  assert.equal(metrics.stableReDetectionRecall, 1);
  assert.equal(metrics.maximumStableReDetectionLatencyMs, 0);
  assert.equal(metrics.maximumMissedVisibleStreakFrames, 15);
  assert.equal(metrics.maximumMissedVisibleDurationMs, 500);
  assert.equal(metrics.visibleTrackFragmentationCount, 1);
  assert.deepEqual(metrics.missedVisibleStreaks, [
    {
      trackIndex: 0,
      startFrame: 40,
      endFrameExclusive: 55,
      durationFrames: 15,
      durationMs: 500,
      fragmentsTrack: true,
    },
  ]);
});

test('temporal robustness counts repeated one-frame visible-track interruptions hidden by averages', () => {
  const frameCount = 100;
  const missedFrames = new Set([20, 30, 40, 50, 60]);
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 30,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: Array.from({ length: frameCount }, () => [0, 0]),
        groundTruthOccluded: Array.from({ length: frameCount }, () => false),
        predictedPoints: Array.from({ length: frameCount }, () => [0, 0]),
        predictedOccluded: Array.from({ length: frameCount }, (_, frameIndex) =>
          missedFrames.has(frameIndex),
        ),
      },
    ],
  });

  assert.ok(metrics.averageJaccard > 0.9, 'whole-track AJ hides sparse interruptions');
  assert.ok(metrics.occlusionAccuracy > 0.9, 'whole-track OA hides sparse interruptions');
  assert.equal(metrics.maximumMissedVisibleStreakFrames, 1);
  assert.equal(metrics.maximumMissedVisibleDurationMs, 100 / 3);
  assert.equal(metrics.visibleTrackFragmentationCount, missedFrames.size);
  assert.equal(metrics.missedVisibleStreaks.length, missedFrames.size);
  assert.ok(metrics.missedVisibleStreaks.every((streak) => streak.fragmentsTrack));
});

test('the visible query initializes continuity without evaluating its prediction', () => {
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 30,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: Array.from({ length: 3 }, () => [0, 0]),
        groundTruthOccluded: [false, false, false],
        predictedPoints: Array.from({ length: 3 }, () => [0, 0]),
        predictedOccluded: [true, true, false],
      },
    ],
  });

  assert.equal(metrics.maximumMissedVisibleStreakFrames, 1);
  assert.equal(metrics.visibleTrackFragmentationCount, 1);
  assert.equal(metrics.missedVisibleStreaks[0].fragmentsTrack, true);
});

test('temporal robustness normalizes its stable evidence window across source frame rates', () => {
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 60,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: Array.from({ length: 8 }, () => [0, 0]),
        groundTruthOccluded: [false, true, false, false, false, false, false, false],
        predictedPoints: Array.from({ length: 8 }, () => [0, 0]),
        predictedOccluded: [false, true, false, false, false, false, false, false],
      },
    ],
  });

  assert.equal(metrics.stableReDetectionRequiredFrames, 6);
  assert.equal(metrics.stableReDetectionRecall, 1);
  assert.equal(metrics.stableReDetectionEvents[0].visibleRunDurationMs, 100);
});

test('stable re-detection keeps the strict TAP boundary and rejects a partial stability window', () => {
  const metrics = computeTapVidMetrics({
    width: 256,
    height: 256,
    framesPerSecond: 30,
    tracks: [
      {
        queryFrame: 0,
        groundTruthPoints: Array.from({ length: 5 }, () => [0, 0]),
        groundTruthOccluded: [false, true, false, false, false],
        predictedPoints: [
          [0, 0],
          [0, 0],
          [16, 0],
          [0, 0],
          [0, 0],
        ],
        predictedOccluded: [false, true, false, false, false],
      },
    ],
  });

  assert.equal(metrics.stableReDetectionEligibleCount, 1);
  assert.equal(metrics.stableReDetectionRecoveredCount, 0);
  assert.equal(metrics.stableReDetectionEvents[0].recoveredFrame, null);
});

test('TAP-Vid metrics reject incomplete predictions and unevaluable tracks', () => {
  const valid = {
    queryFrame: 0,
    groundTruthPoints: [
      [0, 0],
      [0, 0],
    ],
    groundTruthOccluded: [false, false],
    predictedPoints: [[0, 0]],
    predictedOccluded: [false, false],
  };
  assert.throws(
    () => computeTapVidMetrics({ width: 256, height: 256, tracks: [] }),
    /framesPerSecond must be greater than 0 and at most 120/,
  );

  assert.throws(
    () => computeTapVidMetrics({ width: 256, height: 256, framesPerSecond: 30, tracks: [valid] }),
    /predictedPoints must match the ground-truth frame count/,
  );

  assert.throws(
    () =>
      computeTapVidMetrics({
        width: 256,
        height: 256,
        framesPerSecond: 30,
        tracks: [
          {
            ...valid,
            groundTruthOccluded: [false, true],
            predictedPoints: [
              [0, 0],
              [0, 0],
            ],
          },
        ],
      }),
    /must contain a visible evaluation point/,
  );

  assert.throws(
    () =>
      computeTapVidMetrics({
        width: 256,
        height: 256,
        framesPerSecond: 30,
        tracks: [
          {
            ...valid,
            groundTruthOccluded: [true, false],
            predictedPoints: [
              [0, 0],
              [0, 0],
            ],
          },
        ],
      }),
    /query frame must be visible/,
  );
});
