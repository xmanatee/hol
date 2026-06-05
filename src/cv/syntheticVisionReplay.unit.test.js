import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCylindricalCanSequence,
  createRigidBoxSequence,
  createSyntheticObjectSuite,
  createPlanarBookSequence,
} from './synthetic/visionFixtures.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';
import { replayImageAnchorSequence, summarizeReplay } from './synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from './synthetic/headPoseReplayHarness.js';

const createPerfectHeadPoseReplay = () => {
  const templateRegion = { x: 270, y: 178, width: 112, height: 126 };
  const sequence = {
    kind: 'perfect-head-pose',
    width: 640,
    height: 480,
    tap: { x: 320, y: 240 },
    boundingBox: { x1: 235, y1: 150, x2: 405, y2: 330 },
  };
  const frames = [
    {
      anchor: { x: 323, y: 239 },
      normal: { x: 0.08, y: -0.04, z: 0.996 },
      scale: 1.04,
      roll: 0.05,
    },
    {
      anchor: { x: 334, y: 246 },
      normal: { x: 0.16, y: -0.07, z: 0.985 },
      scale: 1.11,
      roll: 0.09,
    },
  ];

  return {
    sequence,
    replay: {
      sequenceKind: sequence.kind,
      anchorCreated: true,
      frames: frames.map((groundTruth, index) => ({
        index: index + 1,
        success: true,
        predicted: groundTruth.anchor,
        normal: groundTruth.normal,
        planarTransform: {
          scale: groundTruth.scale,
          rotation: groundTruth.roll,
        },
        groundTruth,
        metrics: {
          templateRegion,
        },
      })),
    },
  };
};

test('head-pose replay scorer measures the exact app overlay transform', () => {
  const { replay, sequence } = createPerfectHeadPoseReplay();
  const result = scoreHeadPoseReplay({ replay, sequence });

  assert.equal(result.summary.visibleMismatches, 0);
  assert.equal(result.summary.maxWorldPositionError, 0);
  assert.equal(result.summary.maxScaleLogError, 0);
  assert.equal(result.summary.maxRotationError, 0);
  assert.equal(result.summary.maxHeadJumpExcess, 0);
});

test('synthetic object suite contains realistic textured planar and curved targets', () => {
  const suite = createSyntheticObjectSuite();

  assert.deepEqual(
    suite.map(item => item.kind),
    ['planar-book', 'dark-book', 'cylindrical-can', 'rigid-box']
  );

  suite.forEach(sequence => {
    assert.ok(sequence.frames.length >= 24, `${sequence.kind} has enough motion frames`);
    assert.ok(sequence.metadata.hasBackground, `${sequence.kind} renders background`);
    assert.ok(sequence.metadata.hasDarkRegions, `${sequence.kind} renders dark object regions`);
    assert.ok(sequence.metadata.hasFineTexture, `${sequence.kind} renders fine texture`);
    assert.ok(sequence.metadata.hasLightingVariation, `${sequence.kind} renders lighting variation`);
    assert.ok(sequence.metadata.hasOcclusion, `${sequence.kind} includes occlusion`);

    const firstFrame = sequence.frames[0];
    assert.equal(firstFrame.imageData.width, sequence.width);
    assert.equal(firstFrame.imageData.height, sequence.height);
    assert.ok(firstFrame.boundingBox.width > 60);
    assert.ok(firstFrame.boundingBox.height > 60);
    assert.ok(firstFrame.groundTruth.anchor.x > 0);
    assert.ok(firstFrame.groundTruth.anchor.y > 0);
  });
});

test('non-planar synthetic fixtures expose relative scale and roll ground truth', () => {
  const can = createCylindricalCanSequence({ frameCount: 30, occlusionFrames: [] });
  const box = createRigidBoxSequence({ frameCount: 28, occlusionFrames: [] });
  const canScales = can.frames.map(frame => frame.groundTruth.scale);
  const boxScales = box.frames.map(frame => frame.groundTruth.scale);
  const canRolls = can.frames.map(frame => frame.groundTruth.roll);
  const boxRolls = box.frames.map(frame => frame.groundTruth.roll);

  assert.equal(canScales[0], 1);
  assert.equal(boxScales[0], 1);
  assert.equal(canRolls[0], 0);
  assert.equal(boxRolls[0], 0);
  assert.ok(Math.max(...canScales) - Math.min(...canScales) > 0.08);
  assert.ok(Math.max(...boxScales) - Math.min(...boxScales) > 0.06);
  assert.ok(Math.max(...canRolls.map(Math.abs)) > 0.05);
  assert.ok(Math.max(...boxRolls.map(Math.abs)) > 0.05);
});

test('real OpenCV replay keeps face transform attached to a textured book cover through perspective motion', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createPlanarBookSequence({
    kind: 'planar-book',
    frameCount: 32,
    occlusionFrames: [14, 15, 16, 17],
  });

  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
  });
  const summary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;

  assert.equal(replay.anchorCreated, true, replay.createFailure || 'anchor was not created');
  assert.equal(summary.failedFrames, 0, summary.failureReasons.join(', '));
  assert.ok(summary.maxAnchorError <= 21, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 9.2, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.maxScaleError <= 0.15, `max scale error ${summary.maxScaleError.toFixed(3)}`);
  assert.ok(summary.maxRollError <= 0.26, `max roll error ${summary.maxRollError.toFixed(3)}rad`);
  assert.ok(summary.maxFrameJump <= 14, `max frame jump ${summary.maxFrameJump.toFixed(2)}px`);
  assert.ok(summary.planarPoseUsage >= 0.4, `planar pose usage ${summary.planarPoseUsage.toFixed(2)}`);
  assert.equal(headPose.visibleMismatches, 0);
  assert.ok(headPose.maxWorldPositionError <= 0.16, `head world position error ${headPose.maxWorldPositionError.toFixed(3)}`);
  assert.ok(headPose.maxScaleLogError <= 0.12, `head scale log error ${headPose.maxScaleLogError.toFixed(3)}`);
  assert.ok(headPose.maxHeadJumpExcess <= 0.06, `head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
  assert.ok(headPose.maxRotationError <= 1.1, `head rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
  assert.ok(headPose.meanRotationError <= 0.65, `mean head rotation error ${headPose.meanRotationError.toFixed(3)}rad`);
});

test('real OpenCV replay creates and keeps an anchor on a textured cylindrical can', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createCylindricalCanSequence({
    frameCount: 30,
    occlusionFrames: [12, 13, 14],
  });

  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
  });
  const summary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;

  assert.equal(replay.anchorCreated, true, replay.createFailure || 'anchor was not created');
  assert.equal(summary.failedFrames, 0, summary.failureReasons.join(', '));
  assert.ok(summary.maxAnchorError <= 55, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 25, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.sparsePoseUsage >= 0.13, `sparse pose usage ${summary.sparsePoseUsage.toFixed(2)}`);
  assert.ok(summary.maxFrameJump <= 50, `max frame jump ${summary.maxFrameJump.toFixed(2)}px`);
  assert.ok(headPose.maxRotationError <= 1.25, `can head rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
  assert.ok(headPose.meanRotationError <= 0.9, `can mean head rotation error ${headPose.meanRotationError.toFixed(3)}rad`);
});

test('real OpenCV replay keeps a multi-plane rigid box attached through perspective motion', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createRigidBoxSequence({
    frameCount: 28,
    occlusionFrames: [10, 11, 12],
  });

  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
  });
  const summary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;

  assert.equal(replay.anchorCreated, true, replay.createFailure || 'anchor was not created');
  assert.equal(summary.failedFrames, 0, summary.failureReasons.join(', '));
  assert.ok(summary.maxAnchorError <= 35, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 14, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.maxFrameJump <= 24, `max frame jump ${summary.maxFrameJump.toFixed(2)}px`);
  assert.ok(summary.sparsePoseUsage >= 0.35, `sparse pose usage ${summary.sparsePoseUsage.toFixed(2)}`);
  assert.ok(headPose.maxRotationError <= 0.95, `box head rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
  assert.ok(headPose.maxHeadJumpExcess <= 0.1, `box head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
});
