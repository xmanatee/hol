import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCylindricalCanSequence,
  createGlossyPhoneSequence,
  createHandledMugSequence,
  createHumanSilhouetteSequence,
  createLabelBottleSequence,
  createRigidBoxSequence,
  createSyntheticObjectSuite,
  createPlanarBookSequence,
  createTexturedBallSequence,
  createTexturedCupSequence,
} from './synthetic/visionFixtures.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';
import {
  createSyntheticDepthFrame,
  replayImageAnchorSequence,
  summarizeReplay,
} from './synthetic/anchorReplayHarness.js';
import { createVisionBenchmarkMatrix } from './synthetic/visionBenchmarkMatrix.js';
import { scoreHeadPoseReplay } from './synthetic/headPoseReplayHarness.js';
import { realisticReplayScenarios, stressReplayScenarios } from './synthetic/visionReplayScenarios.js';
import { RECONSTRUCTION_MODES } from './anchor.reconstructionModes.js';

const SYNTHETIC_REPLAY_RECONSTRUCTION_MODES = RECONSTRUCTION_MODES
  .filter(mode => !mode.requiresDepthFrame);
const LIMIT_EPSILON = 1e-6;
const withinLimit = (value, limit) => value - limit <= LIMIT_EPSILON;
const findQuickBenchmarkScenario = ({ object, motion, occlusion }) => {
  const scenario = createVisionBenchmarkMatrix({ size: 'quick' })
    .find(item => item.axes.object === object &&
      item.axes.motion === motion &&
      item.axes.occlusion === occlusion);
  assert.ok(scenario, `missing quick benchmark scenario ${object}/${motion}/${occlusion}`);
  return scenario;
};

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
          poseModel: 'object-pose',
        },
      })),
    },
  };
};

const assertReplayWithinLimits = ({ name, replay, summary, headPose, limits }) => {
  assert.equal(replay.anchorCreated, true, replay.createFailure || `${name}: anchor was not created`);
  assert.equal(summary.failedFrames, 0, `${name}: ${summary.failureReasons.join(', ')}`);
  assert.ok(summary.maxAnchorError <= limits.maxAnchorError, `${name}: max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= limits.meanAnchorError, `${name}: mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(withinLimit(summary.maxFrameJump, limits.maxFrameJump), `${name}: max frame jump ${summary.maxFrameJump.toFixed(2)}px`);
  if (limits.maxScaleError != null) {
    assert.ok(summary.maxScaleError <= limits.maxScaleError, `${name}: max scale error ${summary.maxScaleError.toFixed(3)}`);
  }
  assert.equal(headPose.visibleMismatches, 0, `${name}: visible mismatches ${headPose.visibleMismatches}`);
  assert.ok(headPose.maxWorldPositionError <= limits.maxWorldPositionError, `${name}: head world error ${headPose.maxWorldPositionError.toFixed(3)}`);
  assert.ok(headPose.maxScaleLogError <= limits.maxScaleLogError, `${name}: head scale log error ${headPose.maxScaleLogError.toFixed(3)}`);
  assert.ok(headPose.maxRotationError <= limits.maxRotationError, `${name}: head rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
  assert.ok(headPose.maxHeadJumpExcess <= limits.maxHeadJumpExcess, `${name}: head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
};

test('replay summary counts position and pose sources independently', () => {
  const summary = summarizeReplay({
    frames: [
      {
        success: true,
        positionSource: 'planar-homography',
        poseSource: 'planar-homography',
        method: 'planar-homography',
        predicted: { x: 10, y: 10 },
        groundTruth: { anchor: { x: 10, y: 10 } },
        planarTransform: { scale: 1, rotation: 0 },
        normal: { x: 0, y: 0, z: 1 },
        metrics: { poseInliers: 12 },
        anchorError: 0,
        scaleError: 0,
        rollError: 0,
        normalError: 0,
      },
      {
        success: true,
        positionSource: 'reference_similarity_transform',
        poseSource: null,
        method: 'reference_similarity_transform',
        predicted: { x: 14, y: 10 },
        groundTruth: { anchor: { x: 14, y: 10 } },
        planarTransform: { scale: 1, rotation: 0 },
        normal: { x: 0, y: 0, z: 1 },
        metrics: { poseInliers: 0 },
        anchorError: 0,
        scaleError: 0,
        rollError: 0,
        normalError: 0,
      },
    ],
  });

  assert.deepEqual(summary.positionSourceCounts, {
    'planar-homography': 1,
    reference_similarity_transform: 1,
  });
  assert.deepEqual(summary.poseSourceCounts, {
    'planar-homography': 1,
    none: 1,
  });
});

test('head-pose replay scorer measures the exact app overlay transform', () => {
  const { replay, sequence } = createPerfectHeadPoseReplay();
  const result = scoreHeadPoseReplay({ replay, sequence });

  assert.equal(result.summary.visibleMismatches, 0);
  assert.equal(result.summary.maxWorldPositionError, 0);
  assert.equal(result.summary.maxScaleLogError, 0);
  assert.equal(result.summary.maxRotationError, 0);
  assert.equal(result.summary.maxHeadJumpExcess, 0);
});

test('head-pose replay scorer follows the overlay readiness gate', () => {
  const { replay, sequence } = createPerfectHeadPoseReplay();
  replay.frames[0] = {
    ...replay.frames[0],
    predicted: { x: 20, y: 20 },
    metrics: {
      ...replay.frames[0].metrics,
      poseModel: 'parametric-surface',
      reconstructionReady: true,
      poseSource: null,
      readiness: {
        faceReady: false,
        reason: 'Recovering object pose before showing the face',
      },
    },
  };

  const result = scoreHeadPoseReplay({ replay, sequence });

  assert.equal(result.frames[0].hiddenByPolicy, true);
  assert.equal(result.frames[0].visibleMismatch, false);
  assert.equal(result.summary.hiddenByPolicyFrames, 1);
  assert.equal(result.summary.maxWorldPositionError, 0);
});

test('synthetic object suite contains realistic textured planar and curved targets', () => {
  const suite = createSyntheticObjectSuite();

  assert.deepEqual(
    suite.map(item => item.kind),
    [
      'planar-book',
      'dark-book',
      'depth-book',
      'cylindrical-can',
      'textured-cup',
      'rigid-box',
      'glossy-phone',
      'label-bottle',
      'snack-pouch',
      'laminated-card',
      'handled-mug',
      'textured-ball',
    ]
  );

  suite.forEach(sequence => {
    assert.ok(sequence.frames.length >= 24, `${sequence.kind} has enough motion frames`);
    assert.ok(sequence.metadata.hasBackground, `${sequence.kind} renders background`);
    assert.ok(sequence.metadata.hasDarkRegions, `${sequence.kind} renders dark object regions`);
    assert.ok(sequence.metadata.hasFineTexture, `${sequence.kind} renders fine texture`);
    assert.ok(sequence.metadata.hasLightingVariation, `${sequence.kind} renders lighting variation`);
    assert.ok(sequence.metadata.hasOcclusion, `${sequence.kind} includes occlusion`);
    assert.ok(sequence.metadata.hasMovingBackground, `${sequence.kind} includes moving background variation`);

    const firstFrame = sequence.frames[0];
    assert.equal(firstFrame.imageData.width, sequence.width);
    assert.equal(firstFrame.imageData.height, sequence.height);
    assert.ok(firstFrame.boundingBox.width > 60);
    assert.ok(firstFrame.boundingBox.height > 60);
    assert.ok(firstFrame.groundTruth.anchor.x > 0);
    assert.ok(firstFrame.groundTruth.anchor.y > 0);
  });
});

test('handled mug fixture keeps the handle opening outside object support', () => {
  const sequence = createHandledMugSequence({ frameCount: 24, occlusionFrames: [] });
  const firstFrame = sequence.frames[0];
  const maskAt = point => {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    return firstFrame.objectMask.data[y * sequence.width + x] > 0;
  };

  assert.equal(maskAt(firstFrame.maskProbePoints.object), true);
  assert.equal(maskAt(firstFrame.maskProbePoints.handleRim), true);
  assert.equal(maskAt(firstFrame.maskProbePoints.handleGap), false);
});

test('real OpenCV replay tracks a realistic multi-object background matrix', async () => {
  const cv = await loadOpenCvForNode();

  for (const scenario of realisticReplayScenarios) {
    for (const mode of SYNTHETIC_REPLAY_RECONSTRUCTION_MODES) {
      const sequence = scenario.create();
      const replay = await replayImageAnchorSequence({
        cv,
        sequence,
        trackingMode: mode.id,
      });
      const summary = summarizeReplay(replay);
      const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;
      const lastFrame = replay.frames.at(-1);

      assertReplayWithinLimits({
        name: `${mode.id}/${scenario.name}`,
        replay,
        summary,
        headPose,
        limits: scenario.limitsByMode?.[mode.id] || scenario.limits,
      });

      if (scenario.surfaceByMode && mode.id !== 'sparse-reconstruction') {
        const selectedPoseFrames = summary.poseSourceCounts[mode.id] || 0;
        const planarPoseFrames = summary.poseSourceCounts['planar-homography'] || 0;
        if (scenario.rigidPlanarPoseOwner === true) {
          assert.ok(planarPoseFrames >= 6, `${mode.id}/${scenario.name}: planar pose frames ${planarPoseFrames}`);
          assert.ok(selectedPoseFrames >= 1, `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`);
        } else {
          assert.ok(selectedPoseFrames >= (scenario.minSelectedPoseFrames ?? 6), `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`);
        }
        assert.equal(
          lastFrame.metrics.reconstructionPreview.surface.model,
          scenario.surfaceByMode[mode.id],
          `${mode.id}/${scenario.name}: surface model`
        );
      }
    }
  }
});

test('real OpenCV replay keeps full-object anchors on stress backgrounds', async () => {
  const cv = await loadOpenCvForNode();

  for (const scenario of stressReplayScenarios) {
    const sequence = scenario.create();
    const replay = await replayImageAnchorSequence({
      cv,
      sequence,
      trackingMode: 'sparse-reconstruction',
      useObjectSupportMask: true,
    });
    const summary = summarizeReplay(replay);
    const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;

    assertReplayWithinLimits({
      name: scenario.name,
      replay,
      summary,
      headPose,
      limits: {
        maxAnchorError: 42,
        meanAnchorError: 20,
        maxScaleError: 0.37,
        maxFrameJump: 18,
        maxRotationError: 1.5,
        maxWorldPositionError: 0.25,
        maxScaleLogError: 0.35,
        maxHeadJumpExcess: 0.12,
      },
    });
  }
});

test('real OpenCV replay exercises every selectable reconstruction engine on book can cup and mug', async () => {
  const cv = await loadOpenCvForNode();
  const scenarios = [
    {
      name: 'book',
      rigidPlanarPoseOwner: true,
      sequence: createPlanarBookSequence({ frameCount: 18, occlusionFrames: [] }),
      surfaceByMode: {
        'parametric-surface': 'plane',
        'direct-photometric': 'photometric-surfels',
      },
    },
    {
      name: 'can',
      sequence: createCylindricalCanSequence({ frameCount: 18, occlusionFrames: [] }),
      surfaceByMode: {
        'parametric-surface': 'cylinder',
        'direct-photometric': 'photometric-surfels',
      },
    },
    {
      name: 'cup',
      sequence: createTexturedCupSequence({ frameCount: 18, occlusionFrames: [] }),
      surfaceByMode: {
        'parametric-surface': 'tapered-cylinder',
        'direct-photometric': 'photometric-surfels',
      },
    },
    {
      name: 'mug',
      sequence: createHandledMugSequence({ frameCount: 18, occlusionFrames: [] }),
      surfaceByMode: {
        'parametric-surface': 'tapered-cylinder',
        'direct-photometric': 'photometric-surfels',
      },
    },
  ];

  for (const mode of SYNTHETIC_REPLAY_RECONSTRUCTION_MODES) {
    for (const scenario of scenarios) {
      const replay = await replayImageAnchorSequence({
        cv,
        sequence: scenario.sequence,
        trackingMode: mode.id,
      });
      const summary = summarizeReplay(replay);
      const lastFrame = replay.frames.at(-1);

      assert.equal(replay.anchorCreated, true, `${mode.id}/${scenario.name}: ${replay.createFailure || 'anchor failed'}`);
      assert.equal(summary.failedFrames, 0, `${mode.id}/${scenario.name}: ${summary.failureReasons.join(', ')}`);
      const maxAnchorError = mode.id === 'sparse-reconstruction' && scenario.name === 'mug'
        ? 27
        : 26;
      assert.ok(summary.maxAnchorError <= maxAnchorError, `${mode.id}/${scenario.name}: max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
      assert.ok(withinLimit(summary.maxFrameJump, 12), `${mode.id}/${scenario.name}: max jump ${summary.maxFrameJump.toFixed(2)}px`);
      const maxScaleError = (
        scenario.name === 'mug' &&
        (mode.id === 'sparse-reconstruction' || mode.id === 'parametric-surface')
      )
        ? 0.28
        : 0.24;
      assert.ok(summary.maxScaleError <= maxScaleError, `${mode.id}/${scenario.name}: max scale error ${summary.maxScaleError.toFixed(3)}`);
      if (mode.id === 'parametric-surface' && scenario.name === 'cup') {
        assert.ok(summary.maxScaleError <= 0.18, `${mode.id}/${scenario.name}: parametric cup scale error ${summary.maxScaleError.toFixed(3)}`);
      }

      if (mode.id !== 'sparse-reconstruction') {
        const selectedPoseFrames = summary.poseSourceCounts[mode.id] || 0;
        const planarPoseFrames = summary.poseSourceCounts['planar-homography'] || 0;
        if (mode.id === 'parametric-surface' && scenario.name === 'mug') {
          assert.equal(selectedPoseFrames, 0, `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`);
        } else if (scenario.rigidPlanarPoseOwner === true) {
          assert.ok(planarPoseFrames >= 6, `${mode.id}/${scenario.name}: planar pose frames ${planarPoseFrames}`);
          assert.ok(selectedPoseFrames >= 1, `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`);
        } else {
          assert.ok(selectedPoseFrames >= 6, `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`);
        }
        assert.equal(
          lastFrame.metrics.reconstructionPreview.surface.model,
          scenario.surfaceByMode[mode.id],
          `${mode.id}/${scenario.name}: surface model`
        );
      }
    }
  }
});

test('real OpenCV replay validates depth-fusion readiness with synthetic depth frames', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createTexturedCupSequence({ frameCount: 18, occlusionFrames: [] });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'depth-fusion',
    depthFrameForFrame: createSyntheticDepthFrame,
  });
  const summary = summarizeReplay(replay);
  const lastFrame = replay.frames.at(-1);

  assert.equal(replay.anchorCreated, true, replay.createFailure || 'anchor failed');
  assert.equal(summary.failedFrames, 0, summary.failureReasons.join(', '));
  assert.equal(lastFrame.metrics.reconstructionReady, true);
  assert.equal(lastFrame.metrics.reconstructionPreview.surface.model, 'depth-fusion-surfels');
  assert.equal(lastFrame.metrics.reconstructionDepthProvider, 'synthetic-depth');
  assert.ok(lastFrame.metrics.reconstructionLandmarks >= 90);
  assert.ok((summary.poseSourceCounts['depth-fusion'] || 0) >= 1);
});

test('real OpenCV replay keeps depth-fusion recoverable while depth is unavailable', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createTexturedCupSequence({ frameCount: 12, occlusionFrames: [] });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'depth-fusion',
  });
  const lastFrame = replay.frames.at(-1);

  assert.equal(replay.anchorCreated, true, replay.createFailure || 'anchor failed');
  assert.equal(lastFrame.metrics.reconstructionReady, false);
  assert.equal(lastFrame.metrics.reconstructionDepthStatus, 'idle');
  assert.match(lastFrame.metrics.reconstructionFailureReason, /Waiting for depth map/);
  assert.ok(replay.frames.every(frame => frame.success), replay.frames.map(frame => frame.failureReason).join(', '));
});

test('real OpenCV replay selects ellipsoid and photometric surfaces on a textured ball', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createTexturedBallSequence({ frameCount: 18, occlusionFrames: [] });
  const scenarios = [
    {
      mode: 'parametric-surface',
      surface: 'ellipsoid',
    },
    {
      mode: 'direct-photometric',
      surface: 'photometric-surfels',
    },
  ];

  for (const scenario of scenarios) {
    const replay = await replayImageAnchorSequence({
      cv,
      sequence,
      trackingMode: scenario.mode,
    });
    const summary = summarizeReplay(replay);
    const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;
    const selectedPoseFrames = summary.poseSourceCounts[scenario.mode] || 0;
    const lastFrame = replay.frames.at(-1);

    assert.equal(replay.anchorCreated, true, `${scenario.mode}/ball: ${replay.createFailure || 'anchor failed'}`);
    assert.equal(summary.failedFrames, 0, `${scenario.mode}/ball: ${summary.failureReasons.join(', ')}`);
    assert.ok(selectedPoseFrames >= 10, `${scenario.mode}/ball: selected pose frames ${selectedPoseFrames}`);
    assert.equal(lastFrame.metrics.reconstructionPreview.surface.model, scenario.surface);
    assert.ok(summary.maxAnchorError <= 28, `${scenario.mode}/ball: max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
    assert.ok(summary.maxScaleError <= 0.14, `${scenario.mode}/ball: max scale error ${summary.maxScaleError.toFixed(3)}`);
    assert.ok(headPose.maxScaleLogError <= 0.16, `${scenario.mode}/ball: head scale error ${headPose.maxScaleLogError.toFixed(3)}`);
    assert.ok(headPose.maxRotationError <= 1.25, `${scenario.mode}/ball: head rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
  }
});

test('real OpenCV replay scales and turns a face-on book through depth and perspective motion', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createPlanarBookSequence({
    kind: 'depth-book',
    frameCount: 36,
    occlusionFrames: [18, 19, 20],
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
  assert.ok(summary.maxAnchorError <= 22, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 11, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.maxScaleError <= 0.18, `max scale error ${summary.maxScaleError.toFixed(3)}`);
  assert.ok(summary.maxRollError <= 0.24, `max roll error ${summary.maxRollError.toFixed(3)}rad`);
  assert.ok(summary.sparsePositionUsage <= 0.32, `sparse position usage ${summary.sparsePositionUsage.toFixed(2)}`);
  assert.ok(
    summary.planarPositionUsage + ((summary.positionSourceCounts.reference_similarity_transform || 0) / summary.successfulFrames) >= 0.62,
    `tracked planar attachment usage ${JSON.stringify(summary.positionSourceCounts)}`
  );
  assert.equal(headPose.visibleMismatches, 0);
  assert.ok(headPose.maxScaleLogError <= 0.16, `head scale log error ${headPose.maxScaleLogError.toFixed(3)}`);
  assert.ok(headPose.maxHeadJumpExcess <= 0.06, `head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
  assert.ok(headPose.maxRotationError <= 0.9, `head rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
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
  assert.ok(summary.planarPositionUsage >= 0.4, `planar position usage ${summary.planarPositionUsage.toFixed(2)}`);
  assert.equal(summary.poseSourceCounts['nonplanar-calibration-hold'] || 0, 0);
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
  assert.ok(summary.maxFrameJump <= 50, `max frame jump ${summary.maxFrameJump.toFixed(2)}px`);
  assert.ok(headPose.maxRotationError <= 1.25, `can head rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
  assert.ok(headPose.meanRotationError <= 0.9, `can mean head rotation error ${headPose.meanRotationError.toFixed(3)}rad`);
  assert.ok(headPose.maxHeadJumpExcess <= 0.08, `can head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
  assert.ok(headPose.maxScaleLogError <= 0.28, `can head scale log error ${headPose.maxScaleLogError.toFixed(3)}`);
});

test('real OpenCV replay keeps a generic free-tap can attached through specular clutter', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createCylindricalCanSequence({
    frameCount: 30,
    occlusionFrames: [8, 9, 20],
    backgroundVariant: 'kitchen',
    backgroundSeed: 311,
  });

  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
    targetClassOverride: 'segmented-object',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;

  assert.equal(replay.anchorCreated, true, replay.createFailure || 'anchor was not created');
  assert.equal(summary.failedFrames, 0, summary.failureReasons.join(', '));
  assert.ok(summary.maxAnchorError <= 26, `generic can max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 11, `generic can mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.maxFrameJump <= 18, `generic can max frame jump ${summary.maxFrameJump.toFixed(2)}px`);
  assert.equal(headPose.visibleMismatches, 0);
  assert.ok(headPose.maxWorldPositionError <= 0.16, `generic can head world error ${headPose.maxWorldPositionError.toFixed(3)}`);
  assert.ok(headPose.maxHeadJumpExcess <= 0.06, `generic can head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
});

test('real OpenCV replay keeps an off-center can anchor attached through curved PnP projection', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createCylindricalCanSequence({
    frameCount: 30,
    occlusionFrames: [13, 14],
    backgroundVariant: 'shelf',
    backgroundSeed: 131,
    anchorPoint: { x: 42, y: 0, z: -15 },
    basisXPoint: { x: 54, y: 0, z: -28 },
    basisYPoint: { x: 42, y: 42, z: -15 },
  });

  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'parametric-surface',
  });
  const summary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;
  const pnpFrames = replay.frames.filter(frame => (frame.metrics.reconstructionPnpInliers || 0) >= 12);
  const maxPnpResidual = Math.max(...pnpFrames.map(frame => frame.metrics.reconstructionPnpAverageResidual), 0);

  assert.equal(replay.anchorCreated, true, replay.createFailure || 'anchor was not created');
  assert.equal(summary.failedFrames, 0, summary.failureReasons.join(', '));
  assert.ok(summary.maxAnchorError <= 18, `off-center can max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 8, `off-center can mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.maxScaleError <= 0.22, `off-center can scale error ${summary.maxScaleError.toFixed(3)}`);
  assert.ok((summary.poseSourceCounts['parametric-surface'] || 0) >= 8, `parametric pose frames ${JSON.stringify(summary.poseSourceCounts)}`);
  assert.ok(pnpFrames.length >= 8, `curved PnP frames ${pnpFrames.length}`);
  assert.ok(maxPnpResidual <= 7, `curved PnP residual ${maxPnpResidual.toFixed(2)}`);
  assert.equal(headPose.visibleMismatches, 0);
  assert.ok(headPose.maxWorldPositionError <= 0.14, `off-center can head world error ${headPose.maxWorldPositionError.toFixed(3)}`);
  assert.ok(headPose.maxRotationError <= 1.15, `off-center can head rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
});

test('real OpenCV replay creates and keeps an anchor on a tapered textured cup', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createTexturedCupSequence({
    frameCount: 32,
    occlusionFrames: [15, 16, 17],
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
  assert.ok(summary.maxAnchorError <= 28, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 14, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.maxFrameJump <= 54, `max frame jump ${summary.maxFrameJump.toFixed(2)}px`);
  assert.ok(headPose.visibleMismatches === 0);
  assert.ok(headPose.maxHeadJumpExcess <= 0.08, `cup head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
  assert.ok(headPose.maxScaleLogError <= 0.2, `cup head scale log error ${headPose.maxScaleLogError.toFixed(3)}`);
  assert.ok(headPose.maxRotationError <= 1.35, `cup head rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
});

test('real OpenCV replay keeps a tapered cup attached through early and repeated occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createTexturedCupSequence({
    frameCount: 36,
    occlusionFrames: [10, 11, 24],
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
  assert.ok(summary.maxAnchorError <= 30, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 14, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.maxFrameJump <= 32, `max frame jump ${summary.maxFrameJump.toFixed(2)}px`);
  assert.equal(headPose.visibleMismatches, 0);
  assert.ok(headPose.maxWorldPositionError <= 0.24, `cup head world error ${headPose.maxWorldPositionError.toFixed(3)}`);
  assert.ok(headPose.maxHeadJumpExcess <= 0.08, `cup head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
  assert.ok(headPose.maxScaleLogError <= 0.2, `cup head scale log error ${headPose.maxScaleLogError.toFixed(3)}`);
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
  assert.ok(headPose.maxScaleLogError <= 0.32, `box head scale log error ${headPose.maxScaleLogError.toFixed(3)}`);
});

test('real OpenCV replay covers label bottle and glossy phone object-building cases', async () => {
  const cv = await loadOpenCvForNode();
  const scenarios = [
    {
      name: 'label-bottle',
      sequence: createLabelBottleSequence({
        frameCount: 28,
        occlusionFrames: [8, 9, 20],
        backgroundVariant: 'kitchen',
        backgroundSeed: 79,
      }),
      limits: {
        maxAnchorError: 22,
        meanAnchorError: 13,
        maxScaleError: 0.19,
        maxFrameJump: 11,
        maxWorldPositionError: 0.16,
        maxScaleLogError: 0.19,
        maxRotationError: 0.78,
        maxHeadJumpExcess: 0.055,
      },
    },
    {
      name: 'glossy-phone',
      sequence: createGlossyPhoneSequence({
        frameCount: 28,
        occlusionFrames: [9, 10, 21],
        backgroundVariant: 'window',
        backgroundSeed: 67,
      }),
      limits: {
        maxAnchorError: 17,
        meanAnchorError: 8,
        maxScaleError: 0.15,
        maxFrameJump: 12,
        maxWorldPositionError: 0.13,
        maxScaleLogError: 0.14,
        maxRotationError: 1.0,
        maxHeadJumpExcess: 0.055,
      },
    },
  ];

  for (const scenario of scenarios) {
    const replay = await replayImageAnchorSequence({
      cv,
      sequence: scenario.sequence,
      trackingMode: 'sparse-reconstruction',
    });
    const summary = summarizeReplay(replay);
    const headPose = scoreHeadPoseReplay({ replay, sequence: scenario.sequence }).summary;

    assertReplayWithinLimits({
      name: scenario.name,
      replay,
      summary,
      headPose,
      limits: scenario.limits,
    });
  }
});

test('segmentation-owned replay keeps landmarks on weak objects despite detailed backgrounds', async () => {
  const cv = await loadOpenCvForNode();
  const scenarios = [
    {
      name: 'dark-book-shelf',
      sequence: createPlanarBookSequence({
        kind: 'dark-book',
        frameCount: 24,
        occlusionFrames: [8, 9, 18],
        backgroundVariant: 'shelf',
        backgroundSeed: 183,
      }),
      maxAnchorError: 18,
      meanAnchorError: 9,
    },
    {
      name: 'glossy-phone-window',
      sequence: createGlossyPhoneSequence({
        frameCount: 24,
        occlusionFrames: [8, 9, 18],
        backgroundVariant: 'window',
        backgroundSeed: 167,
      }),
      maxAnchorError: 18,
      meanAnchorError: 9,
    },
    {
      name: 'generic-human-nonconvex-busy-background',
      sequence: createHumanSilhouetteSequence({
        frameCount: 24,
        occlusionFrames: [8, 9, 18],
        backgroundVariant: 'busy',
        backgroundSeed: 211,
      }),
      targetClassOverride: 'segmented-object',
      maxAnchorError: 28,
      meanAnchorError: 16,
      minOwnershipRatio: 0.6,
    },
  ];

  for (const scenario of scenarios) {
    if (scenario.sequence.kind === 'human-silhouette') {
      const firstFrame = scenario.sequence.frames[0];
      const maskAt = point => {
        const x = Math.round(point.x);
        const y = Math.round(point.y);
        return firstFrame.objectMask.data[y * scenario.sequence.width + x] > 0;
      };
      assert.equal(maskAt(firstFrame.maskProbePoints.object), true, `${scenario.name}: tap should be object support`);
      assert.equal(maskAt(firstFrame.maskProbePoints.betweenLegs), false, `${scenario.name}: between-leg background should stay outside support`);
      assert.equal(maskAt(firstFrame.maskProbePoints.armGap), false, `${scenario.name}: arm-gap background should stay outside support`);
    }

    const replay = await replayImageAnchorSequence({
      cv,
      sequence: scenario.sequence,
      trackingMode: 'sparse-reconstruction',
      targetClassOverride: scenario.targetClassOverride,
      useObjectSupportMask: true,
      refreshObjectSupportMask: scenario.sequence.kind === 'human-silhouette',
    });
    const summary = summarizeReplay(replay);
    const ownershipRatios = replay.frames
      .filter(frame => frame.success && (frame.metrics.activeLandmarkCount || 0) >= 8)
      .map(frame => (frame.metrics.objectOwnedLandmarks || 0) / frame.metrics.activeLandmarkCount);

    assert.equal(replay.anchorCreated, true, `${scenario.name}: ${replay.createFailure || 'anchor failed'}`);
    assert.equal(replay.createResult.objectSupportMaskSource, 'synthetic-object-mask');
    assert.equal(summary.failedFrames, 0, `${scenario.name}: ${summary.failureReasons.join(', ')}`);
    assert.ok(summary.maxAnchorError <= scenario.maxAnchorError, `${scenario.name}: max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
    assert.ok(summary.meanAnchorError <= scenario.meanAnchorError, `${scenario.name}: mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
    assert.ok(ownershipRatios.length >= 12, `${scenario.name}: ownership samples ${ownershipRatios.length}`);
    assert.ok(
      Math.min(...ownershipRatios) >= (scenario.minOwnershipRatio || 0.72),
      `${scenario.name}: min ownership ratio ${Math.min(...ownershipRatios).toFixed(2)}`
    );
    if (scenario.sequence.kind === 'human-silhouette') {
      assert.ok(
        replay.frames.some(frame => frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery'),
        `${scenario.name}: should exercise pose-dropout object support recovery`
      );
    }
  }
});

test('replay records object support correction on the corrected frame', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = findQuickBenchmarkScenario({
    object: 'textured-cup',
    motion: 'fast',
    occlusion: 'repeated',
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'direct-photometric',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const correctedFrames = replay.frames.filter(frame => (
    frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery'
  ));
  const firstCorrected = correctedFrames[0];

  assert.ok(correctedFrames.length >= 1);
  assert.ok(
    firstCorrected.anchorError <= 17,
    `first corrected frame should record corrected position, got ${firstCorrected.anchorError.toFixed(2)}px`
  );
});

test('replay keeps direct curved motion stable through repeated cup occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = findQuickBenchmarkScenario({
    object: 'textured-cup',
    motion: 'fast',
    occlusion: 'repeated',
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'direct-photometric',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const heldFrames = replay.frames.filter(frame => frame.metrics.positionFilterAdjustment === 'curved-motion-hold');
  const recoveryCorrections = replay.frames.filter(frame => frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery');
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));

  assert.ok(heldFrames.length >= 2);
  assert.ok(recoveryCorrections.length <= 1);
  assert.ok(maxAnchorError <= 19, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('replay avoids stale depth-fusion cup motion hold through repeated occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = findQuickBenchmarkScenario({
    object: 'textured-cup',
    motion: 'fast',
    occlusion: 'repeated',
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'depth-fusion',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    depthFrameForFrame: createSyntheticDepthFrame,
  });
  const heldFrames = replay.frames.filter(frame => frame.metrics.positionFilterAdjustment === 'curved-motion-hold');
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));

  assert.equal(heldFrames.length, 0);
  assert.ok(maxAnchorError <= 22, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('replay bounds depth-fusion cup support recovery during early occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = findQuickBenchmarkScenario({
    object: 'textured-cup',
    motion: 'fast',
    occlusion: 'early',
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'depth-fusion',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    depthFrameForFrame: createSyntheticDepthFrame,
  });
  const supportCorrections = replay.frames.filter(frame => (
    frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery'
  ));
  const maxSupportStep = Math.max(...supportCorrections.map(frame => frame.metrics.objectSupportPositionStep || 0), 0);
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));
  const meanAnchorError = replay.frames.reduce((sum, frame) => sum + frame.anchorError, 0) /
    Math.max(1, replay.frames.length);
  const depthFusionPositionFrames = replay.frames.filter(frame => frame.positionSource === 'depth-fusion');

  assert.ok(supportCorrections.length >= 1);
  assert.ok(maxSupportStep <= 5 + LIMIT_EPSILON);
  assert.ok(depthFusionPositionFrames.length >= 4);
  assert.ok(maxAnchorError <= 22, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
  assert.ok(meanAnchorError <= 9, `mean anchor error should stay bounded, got ${meanAnchorError.toFixed(2)}px`);
});

test('replay keeps mug repeated recovery bounded without stale motion holds', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = findQuickBenchmarkScenario({
    object: 'handled-mug',
    motion: 'fast',
    occlusion: 'repeated',
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const heldCorrections = replay.frames.filter(frame => frame.metrics.positionFilterAdjustment === 'curved-motion-hold');
  const recoveryCorrections = replay.frames.filter(frame => (
    frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery' ||
    frame.metrics.objectSupportPositionCorrection === 'curved-object-recovery'
  ));
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));
  const meanAnchorError = replay.frames.reduce((sum, frame) => sum + frame.anchorError, 0) /
    Math.max(1, replay.frames.length);
  const maxSupportStep = Math.max(...recoveryCorrections.map(frame => frame.metrics.objectSupportPositionStep || 0), 0);

  assert.equal(heldCorrections.length, 0);
  assert.ok(recoveryCorrections.length <= 6);
  assert.ok(maxSupportStep <= 12 + LIMIT_EPSILON);
  assert.ok(maxAnchorError <= 40, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
  assert.ok(meanAnchorError <= 18, `mean anchor error should stay bounded, got ${meanAnchorError.toFixed(2)}px`);
});

test('replay corrects parametric mug vertical drift during repeated recovery', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix({ size: 'quick' })
    .find(item => item.axes.object === 'handled-mug' &&
      item.axes.background === 'window' &&
      item.axes.motion === 'fast' &&
      item.axes.occlusion === 'repeated');
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));
  const meanAnchorError = replay.frames.reduce((sum, frame) => sum + frame.anchorError, 0) /
    Math.max(1, replay.frames.length);

  assert.ok(maxAnchorError <= 32, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
  assert.ok(meanAnchorError <= 16, `mean anchor error should stay bounded, got ${meanAnchorError.toFixed(2)}px`);
});

test('replay caps generic free-tap recovery impulses in dense modes', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix({ size: 'quick' })
    .find(item => item.axes.object === 'generic-free-tap-can' &&
      item.axes.background === 'shelf' &&
      item.axes.motion === 'fast' &&
      item.axes.occlusion === 'early');
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'direct-photometric',
    targetClassOverride: scenario.targetClassOverride,
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxSupportStep = Math.max(...replay.frames.map(frame => frame.metrics.objectSupportPositionStep || 0), 0);
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));
  const meanAnchorError = replay.frames.reduce((sum, frame) => sum + frame.anchorError, 0) /
    Math.max(1, replay.frames.length);

  assert.ok(maxSupportStep <= 10 + LIMIT_EPSILON);
  assert.ok(maxAnchorError <= 22, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
  assert.ok(meanAnchorError <= 12, `mean anchor error should stay bounded, got ${meanAnchorError.toFixed(2)}px`);
});

test('replay caps glossy can sparse recovery jumps', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix({ size: 'quick' })
    .find(item => item.axes.object === 'glossy-can' &&
      item.axes.background === 'window' &&
      item.axes.motion === 'fast' &&
      item.axes.occlusion === 'early');
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxSupportStep = Math.max(...replay.frames.map(frame => frame.metrics.objectSupportPositionStep || 0), 0);
  const maxFrameJump = Math.max(...replay.frames.slice(1).map((frame, index) => Math.hypot(
    frame.predicted.x - replay.frames[index].predicted.x,
    frame.predicted.y - replay.frames[index].predicted.y
  )), 0);
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));

  assert.ok(maxSupportStep <= 10 + LIMIT_EPSILON);
  assert.ok(maxFrameJump <= 17, `max frame jump should stay bounded, got ${maxFrameJump.toFixed(2)}px`);
  assert.ok(maxAnchorError <= 18, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('replay damps high-residual sparse cylinder recovery impulses', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix()
    .find(item => item.axes.object === 'glossy-can' &&
      item.axes.background === 'desk' &&
      item.axes.motion === 'fast' &&
      item.axes.occlusion === 'early');
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxFrameJump = Math.max(...replay.frames.slice(1).map((frame, index) => Math.hypot(
    frame.predicted.x - replay.frames[index].predicted.x,
    frame.predicted.y - replay.frames[index].predicted.y
  )), 0);
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));

  assert.ok(maxFrameJump <= 14, `max frame jump should stay bounded, got ${maxFrameJump.toFixed(2)}px`);
  assert.ok(maxAnchorError <= 15, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('replay rejects stale sparse can poses during late occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix()
    .find(item => item.axes.object === 'cylindrical-can' &&
      item.axes.background === 'desk' &&
      item.axes.motion === 'slow' &&
      item.axes.occlusion === 'late');
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxFrameJump = Math.max(...replay.frames.slice(1).map((frame, index) => Math.hypot(
    frame.predicted.x - replay.frames[index].predicted.x,
    frame.predicted.y - replay.frames[index].predicted.y
  )), 0);
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));

  assert.ok(maxFrameJump <= 13, `max frame jump should stay bounded, got ${maxFrameJump.toFixed(2)}px`);
  assert.ok(maxAnchorError <= 20, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('replay caps rigid-box periodic support recentering jumps', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix({ size: 'quick' })
    .find(item => item.axes.object === 'rigid-box' &&
      item.axes.background === 'kitchen' &&
      item.axes.motion === 'fast' &&
      item.axes.occlusion === 'early');
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxPeriodicSupportStep = Math.max(...replay.frames
    .filter(frame => frame.metrics.objectSupportPositionCorrection === 'periodic-segmentation-refresh')
    .map(frame => frame.metrics.objectSupportPositionStep || 0), 0);
  const maxFrameJump = Math.max(...replay.frames.slice(1).map((frame, index) => Math.hypot(
    frame.predicted.x - replay.frames[index].predicted.x,
    frame.predicted.y - replay.frames[index].predicted.y
  )), 0);

  assert.ok(maxPeriodicSupportStep <= 6 + LIMIT_EPSILON);
  assert.ok(maxFrameJump <= 16, `max frame jump should stay bounded, got ${maxFrameJump.toFixed(2)}px`);
});

test('replay leaves textured cup motion holds on pose-dropout recovery path', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = findQuickBenchmarkScenario({
    object: 'textured-cup',
    motion: 'fast',
    occlusion: 'early',
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const mugRecoveryCorrections = replay.frames.filter(frame => (
    frame.metrics.objectSupportPositionCorrection === 'curved-object-recovery'
  ));

  assert.equal(mugRecoveryCorrections.length, 0);
});

test('replay bounds sparse mug support recovery during repeated occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = findQuickBenchmarkScenario({
    object: 'handled-mug',
    motion: 'fast',
    occlusion: 'repeated',
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const supportCorrections = replay.frames.filter(frame => (
    frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery'
  ));
  const maxAnchorError = Math.max(...replay.frames.map(frame => frame.anchorError));

  assert.ok(supportCorrections.length >= 1);
  assert.ok(supportCorrections.length <= 5);
  assert.ok(supportCorrections.every(frame => frame.metrics.objectSupportPositionStep <= 4 + LIMIT_EPSILON));
  assert.ok(maxAnchorError <= 26, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});
