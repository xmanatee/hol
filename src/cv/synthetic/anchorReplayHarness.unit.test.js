import test from 'node:test';
import assert from 'node:assert/strict';

import { ANCHOR_TRACKING_INTERVAL_MS } from '../../utils/cvScheduling.js';
import { replayImageAnchorSequence, summarizeReplay } from './anchorReplayHarness.js';
import { loadOpenCvForNode } from './opencvNodeLoader.js';
import { createPlanarBookSequence } from './visionFixtures.js';

test('production-cadence replay scores every source frame while holding poses between admitted updates', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createPlanarBookSequence({ frameCount: 31 });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'parametric-surface',
    updateIntervalMs: ANCHOR_TRACKING_INTERVAL_MS,
  });

  assert.equal(replay.frames.length, 30);
  assert.deepEqual(replay.cadence, {
    sourceFrameIntervalMs: 1000 / 30,
    updateIntervalMs: ANCHOR_TRACKING_INTERVAL_MS,
    sourceFrameCount: 30,
    admittedUpdateCount: 15,
    heldFrameCount: 15,
    presentationMotion: {
      model: 'bounded-constant-velocity',
      maxPredictionAgeMs: 1000 / 15,
      maxPresentationSpeedPxPerMs: 12 / (1000 / 30),
      maxPresentationStepPx: 12,
      frameIntervalMs: 1000 / 60,
    },
  });
  assert.deepEqual(
    replay.frames.filter((frame) => frame.runtime.admittedUpdate).map((frame) => frame.index),
    [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29],
  );

  const admitted = replay.frames[0];
  const held = replay.frames[1];
  assert.equal(admitted.runtime.poseAgeMs, 0);
  assert.ok(Math.abs(held.runtime.poseAgeMs - 1000 / 30) < 1e-6);
  assert.deepEqual(held.predicted, admitted.predicted);
  assert.notDeepEqual(held.groundTruth.anchor, admitted.groundTruth.anchor);
  assert.ok(
    replay.frames.some(
      (frame, index) =>
        !frame.runtime.admittedUpdate &&
        index > 0 &&
        frame.predicted.x !== replay.frames[index - 1].predicted.x,
    ),
  );

  const consecutiveJumps = replay.frames
    .slice(1)
    .map((frame, index) =>
      Math.hypot(
        frame.predicted.x - replay.frames[index].predicted.x,
        frame.predicted.y - replay.frames[index].predicted.y,
      ),
    );
  assert.ok(Math.max(...consecutiveJumps) <= 12 + 1e-9);

  const profiledUpdates = replay.frames.filter(
    (frame) => frame.runtime.admittedUpdate && frame.runtime.stageTimings?.poseEstimationMs > 0,
  );
  assert.ok(profiledUpdates.length > 0);
  for (const frame of profiledUpdates) {
    assert.ok(frame.runtime.stageTimings.trackingValidationMs > 0);
    assert.ok(frame.runtime.stageTimings.poseSelectionMs > 0);
    assert.ok(frame.runtime.stageTimings.preliminaryAttachmentEvidenceMs > 0);
    assert.ok(frame.runtime.stageTimings.trackerAttachmentResolveMs > 0);
  }
  assert.ok(replay.frames.some((frame) => frame.runtime.stageTimings?.keypointRefreshMs > 0));
});

test('replay quality excludes absent-target frames and does not score re-entry as a frame jump', () => {
  const frame = ({ index, targetVisible, anchorError, predicted }) => ({
    index,
    targetVisible,
    success: true,
    targetPresent: true,
    anchorError,
    scaleError: 0,
    rollError: 0,
    normalError: 0,
    predicted,
    metrics: {},
  });
  const summary = summarizeReplay({
    frames: [
      frame({ index: 1, targetVisible: true, anchorError: 2, predicted: { x: 10, y: 10 } }),
      {
        ...frame({ index: 2, targetVisible: false, anchorError: 100, predicted: { x: 90, y: 90 } }),
        targetPresent: true,
      },
      frame({ index: 3, targetVisible: true, anchorError: 4, predicted: { x: 30, y: 30 } }),
      frame({ index: 4, targetVisible: true, anchorError: 3, predicted: { x: 33, y: 30 } }),
    ],
  });

  assert.equal(summary.visibleFrameCount, 3);
  assert.equal(summary.successfulFrames, 3);
  assert.equal(summary.maxAnchorError, 4);
  assert.equal(summary.meanAnchorError, 3);
  assert.equal(summary.maxFrameJump, 3);
  assert.equal(summary.targetAbsentFrameCount, 1);
  assert.equal(summary.targetPresentAbsentDisplayFrames, 1);
  assert.equal(summary.falseTrackedAbsentAdmittedFrames, 1);
  assert.equal(summary.targetLossRecoveredAt8, 1);
});
