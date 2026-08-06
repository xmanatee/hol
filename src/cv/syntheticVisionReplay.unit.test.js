import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCylindricalCanSequence,
  createGlossyCanSequence,
  createGlossyPhoneSequence,
  createHandledMugSequence,
  createHumanSilhouetteSequence,
  createLabelBottleSequence,
  createLaminatedCardSequence,
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
import {
  captureReplayScenarios,
  realisticReplayScenarios,
  stressReplayScenarios,
} from './synthetic/visionReplayScenarios.js';
import { RECONSTRUCTION_MODES } from './anchor.reconstructionModes.js';
import { ANCHOR_TRACKING_INTERVAL_MS } from '../utils/cvScheduling.js';

const SYNTHETIC_REPLAY_RECONSTRUCTION_MODES = RECONSTRUCTION_MODES.filter((mode) => !mode.requiresDepthFrame);
const LIMIT_EPSILON = 1e-6;
const withinLimit = (value, limit) => value - limit <= LIMIT_EPSILON;
const createFastRepeatedCupRecoveryFixture = () =>
  createTexturedCupSequence({
    frameCount: 24,
    occlusionFrames: [6, 7, 14, 15],
    backgroundVariant: 'shelf',
    backgroundSeed: 2249,
  });
const createFastEarlyCupRecoveryFixture = () =>
  createTexturedCupSequence({
    frameCount: 22,
    occlusionFrames: [5, 6, 7],
    backgroundVariant: 'desk',
    backgroundSeed: 2219,
  });
const createFastRepeatedMugRecoveryFixture = () =>
  createHandledMugSequence({
    frameCount: 24,
    occlusionFrames: [6, 7, 14, 15],
    backgroundVariant: 'window',
    backgroundSeed: 2376,
  });
const createSlowEarlyBusyMugRecoveryFixture = () =>
  createHandledMugSequence({
    frameCount: 44,
    occlusionFrames: [5, 6, 7],
    backgroundVariant: 'busy',
    backgroundSeed: 2346,
  });
const createMotionContradictionMugRecoveryFixture = () =>
  createHandledMugSequence({
    frameCount: 44,
    occlusionFrames: [5, 6, 7],
    backgroundVariant: 'busy',
    backgroundSeed: 3053,
  });
const createFastEarlyFreeTapCanRecoveryFixture = () =>
  createCylindricalCanSequence({
    frameCount: 22,
    occlusionFrames: [5, 6, 7],
    backgroundVariant: 'shelf',
    backgroundSeed: 2535,
  });
const createFastEarlyGlossyCanRecoveryFixture = () =>
  createGlossyCanSequence({
    frameCount: 22,
    occlusionFrames: [5, 6, 7],
    backgroundVariant: 'window',
    backgroundSeed: 2157,
  });
const createSlowRepeatedGlossyCanRecoveryFixture = () =>
  createGlossyCanSequence({
    frameCount: 44,
    occlusionFrames: [6, 7, 27, 28],
    backgroundVariant: 'kitchen',
    backgroundSeed: 2187,
  });
const createFastEarlyRigidBoxRecoveryFixture = () =>
  createRigidBoxSequence({
    frameCount: 22,
    occlusionFrames: [5, 6, 7],
    backgroundVariant: 'kitchen',
    backgroundSeed: 2473,
  });

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
  const unexpectedFailures = replay.frames.filter(
    (frame) =>
      frame.targetVisible !== false &&
      frame.occluded !== true &&
      (!frame.success || frame.targetPresent !== true),
  );
  assert.equal(
    unexpectedFailures.length,
    0,
    `${name}: ${unexpectedFailures
      .map((frame) => frame.failureReason)
      .filter(Boolean)
      .join(', ')}`,
  );
  assert.ok(
    summary.maxAnchorError <= limits.maxAnchorError,
    `${name}: max anchor error ${summary.maxAnchorError.toFixed(2)}px`,
  );
  assert.ok(
    summary.meanAnchorError <= limits.meanAnchorError,
    `${name}: mean anchor error ${summary.meanAnchorError.toFixed(2)}px`,
  );
  assert.ok(
    withinLimit(summary.maxFrameJump, limits.maxFrameJump),
    `${name}: max frame jump ${summary.maxFrameJump.toFixed(2)}px`,
  );
  if (limits.maxScaleError != null) {
    assert.ok(
      summary.maxScaleError <= limits.maxScaleError,
      `${name}: max scale error ${summary.maxScaleError.toFixed(3)}`,
    );
  }
  assert.equal(headPose.visibleMismatches, 0, `${name}: visible mismatches ${headPose.visibleMismatches}`);
  assert.ok(
    headPose.maxWorldPositionError <= limits.maxWorldPositionError,
    `${name}: head world error ${headPose.maxWorldPositionError.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxScaleLogError <= limits.maxScaleLogError,
    `${name}: head scale log error ${headPose.maxScaleLogError.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxRotationError <= limits.maxRotationError,
    `${name}: head rotation error ${headPose.maxRotationError.toFixed(3)}rad`,
  );
  assert.ok(
    headPose.maxHeadJumpExcess <= limits.maxHeadJumpExcess,
    `${name}: head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`,
  );
};

test('replay summary counts position and pose sources independently', () => {
  const summary = summarizeReplay({
    frames: [
      {
        success: true,
        targetPresent: true,
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
        targetPresent: true,
        positionSource: 'reference_similarity_transform',
        poseSource: null,
        method: 'reference_similarity_transform',
        predicted: { x: 22, y: 10 },
        groundTruth: { anchor: { x: 14, y: 10 } },
        planarTransform: { scale: 1, rotation: 0 },
        normal: { x: 0, y: 0, z: 1 },
        metrics: {
          poseInliers: 0,
          ownershipProbationLandmarks: 6,
          landmarkRefreshProbationary: 4,
          landmarkOwnershipPromoted: 2,
          landmarkRefreshCoverageBefore: 0.25,
          landmarkRefreshCoverageAfter: 0.5,
          landmarkRefreshOccupiedBefore: 2,
          landmarkRefreshOccupiedAfter: 4,
          objectSupportPositionCorrection: 'pose-dropout-recovery',
          objectSupportPositionStep: 6,
          objectSupportFrameStepLimited: true,
          objectSupportAnchorUv: { u: 0.5, v: 0.5 },
          objectSupportMaskBounds: { x: 20, y: 0, width: 10, height: 20 },
        },
        anchorError: 8,
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
  assert.deepEqual(summary.objectSupportCorrectionCounts, {
    'pose-dropout-recovery': 1,
  });
  assert.equal(summary.anchorAccuracyAt4, 0.5);
  assert.equal(summary.anchorAccuracyAt8, 1);
  assert.equal(summary.anchorAccuracyAt16, 1);
  assert.equal(summary.objectSupportCorrectionFrames, 1);
  assert.equal(summary.objectSupportFrameStepLimitedFrames, 1);
  assert.equal(summary.objectSupportRecoveryFrames, 1);
  assert.equal(summary.maxOwnershipProbationLandmarks, 6);
  assert.equal(summary.landmarkRefreshProbationaryLandmarks, 4);
  assert.equal(summary.landmarkOwnershipPromotions, 2);
  assert.equal(summary.landmarkRefreshCoverageFrames, 1);
  assert.equal(summary.landmarkRefreshCoverageGain, 0.25);
  assert.equal(summary.landmarkRefreshNewOccupiedCells, 2);
  assert.equal(summary.maxObjectSupportPositionStep, 6);
  assert.equal(summary.maxObjectSupportAnchorError, 11);
  assert.equal(summary.meanObjectSupportAnchorError, 11);
});

test('replay summary reports interpolated anchor-error percentiles', () => {
  const frame = ({ anchorError, success = true }) => ({
    success,
    targetPresent: success,
    positionSource: 'reference_similarity_transform',
    poseSource: 'sparse-reconstruction',
    method: 'reference_similarity_transform',
    predicted: { x: 20 + anchorError, y: 10 },
    groundTruth: { anchor: { x: 20, y: 10 } },
    planarTransform: { scale: 1, rotation: 0 },
    normal: { x: 0, y: 0, z: 1 },
    metrics: { poseInliers: 12 },
    anchorError,
    scaleError: 0,
    rollError: 0,
    normalError: 0,
  });
  const summary = summarizeReplay({
    frames: [
      frame({ anchorError: 20 }),
      frame({ anchorError: 1 }),
      frame({ anchorError: 10 }),
      frame({ anchorError: 3 }),
      frame({ anchorError: 8 }),
      frame({ anchorError: Infinity, success: false }),
    ],
  });

  assert.equal(summary.p50AnchorError, 8);
  assert.equal(summary.p95AnchorError, 18);
});

test('replay summary measures visible-frame recovery after occlusion', () => {
  const frame = ({ index, occluded, anchorError }) => ({
    index,
    occluded,
    success: true,
    targetPresent: true,
    positionSource: 'reference_similarity_transform',
    poseSource: 'sparse-reconstruction',
    method: 'reference_similarity_transform',
    predicted: { x: index * 5, y: 10 },
    groundTruth: { anchor: { x: index * 5 - anchorError, y: 10 } },
    planarTransform: { scale: 1, rotation: 0 },
    normal: { x: 0, y: 0, z: 1 },
    metrics: { poseInliers: 12 },
    anchorError,
    scaleError: 0,
    rollError: 0,
    normalError: 0,
  });
  const summary = summarizeReplay({
    frames: [
      frame({ index: 1, occluded: false, anchorError: 2 }),
      frame({ index: 2, occluded: true, anchorError: 40 }),
      frame({ index: 3, occluded: true, anchorError: 38 }),
      frame({ index: 4, occluded: false, anchorError: 14 }),
      frame({ index: 5, occluded: false, anchorError: 7 }),
      frame({ index: 6, occluded: false, anchorError: 4 }),
      frame({ index: 7, occluded: true, anchorError: 36 }),
      frame({ index: 8, occluded: false, anchorError: 11 }),
      frame({ index: 9, occluded: false, anchorError: 10 }),
    ],
  });

  assert.equal(summary.postOcclusionWindowCount, 2);
  assert.equal(summary.postOcclusionRecoveredAt8, 1);
  assert.equal(summary.postOcclusionFailedWindowsAt8, 1);
  assert.equal(summary.postOcclusionRecoveryRateAt8, 0.5);
  assert.equal(summary.maxPostOcclusionRecoveryFramesAt8, 2);
  assert.equal(summary.meanPostOcclusionRecoveryFramesAt8, 2);
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

test('head-pose replay scorer treats rendering during target loss as a visibility mismatch', () => {
  const { replay, sequence } = createPerfectHeadPoseReplay();
  replay.frames[0].targetVisible = false;

  const visibleDuringLoss = scoreHeadPoseReplay({ replay, sequence });
  assert.equal(visibleDuringLoss.frames[0].expected.visible, false);
  assert.equal(visibleDuringLoss.frames[0].visibleMismatch, true);

  replay.frames[0].metrics.readiness = { faceReady: false };
  const hiddenDuringLoss = scoreHeadPoseReplay({ replay, sequence });
  assert.equal(hiddenDuringLoss.frames[0].hiddenByPolicy, true);
  assert.equal(hiddenDuringLoss.frames[0].visibleMismatch, false);
});

test('synthetic object suite contains realistic textured planar and curved targets', () => {
  const suite = createSyntheticObjectSuite();

  assert.deepEqual(
    suite.map((item) => item.kind),
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
    ],
  );

  suite.forEach((sequence) => {
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
  const maskAt = (point) => {
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
          assert.ok(
            planarPoseFrames >= 6,
            `${mode.id}/${scenario.name}: planar pose frames ${planarPoseFrames}`,
          );
          assert.ok(
            selectedPoseFrames >= 1,
            `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`,
          );
        } else {
          assert.ok(
            selectedPoseFrames >= (scenario.minSelectedPoseFrames ?? 6),
            `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`,
          );
        }
        assert.equal(
          lastFrame.metrics.reconstructionPreview.surface.model,
          scenario.surfaceByMode[mode.id],
          `${mode.id}/${scenario.name}: surface model`,
        );
      }
    }
  }
});

test('label-bottle recovery stays continuous and bounded across repeated occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = realisticReplayScenarios.find(
    ({ name }) => name === 'label bottle on kitchen tile background',
  );
  assert.ok(scenario);

  for (const trackingMode of ['sparse-reconstruction', 'parametric-surface']) {
    const replay = await replayImageAnchorSequence({
      cv,
      sequence: scenario.create(),
      trackingMode,
      useObjectSupportMask: true,
      refreshObjectSupportMask: true,
    });
    const summary = summarizeReplay(replay);

    assert.equal(summary.failedFrames, 0, trackingMode);
    assert.ok(
      summary.maxFrameJump <= 12 + LIMIT_EPSILON,
      `${trackingMode}: max frame jump ${summary.maxFrameJump.toFixed(2)}px`,
    );
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

test('real OpenCV replay measures low-light blur and rolling-shutter capture conditions', async () => {
  const cv = await loadOpenCvForNode();

  for (const scenario of captureReplayScenarios) {
    for (const mode of SYNTHETIC_REPLAY_RECONSTRUCTION_MODES) {
      const sequence = scenario.create();
      const replay = await replayImageAnchorSequence({
        cv,
        sequence,
        trackingMode: mode.id,
        useObjectSupportMask: true,
        refreshObjectSupportMask: true,
      });
      const summary = summarizeReplay(replay);
      const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;

      assertReplayWithinLimits({
        name: `${mode.id}/${scenario.name}`,
        replay,
        summary,
        headPose,
        limits: scenario.limits,
      });
    }
  }
});

test('sparse stress replay rejects unobservable normals after occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenarios = stressReplayScenarios.filter(
    ({ name }) =>
      name === 'laminated card with glare on window background' ||
      name === 'handled mug on kitchen tile background',
  );

  for (const scenario of scenarios) {
    const sequence = scenario.create();
    const replay = await replayImageAnchorSequence({
      cv,
      sequence,
      trackingMode: 'sparse-reconstruction',
      useObjectSupportMask: true,
      refreshObjectSupportMask: true,
    });
    const poseReadyFrames = replay.frames.filter(
      (frame) =>
        frame.metrics.reconstructionReady === true &&
        (frame.poseSource === 'sparse-reconstruction' || frame.poseSource === 'planar-homography') &&
        (frame.metrics.poseInliers || 0) > 0,
    );
    const poseReadyFrameRatio = poseReadyFrames.length / replay.frames.length;
    const maxReadyNormalError = Math.max(...poseReadyFrames.map((frame) => frame.normalError), 0);
    const observabilityRejections = replay.frames.filter((frame) =>
      Object.values(frame.metrics.normalPoseRejectedCandidates || {}).some(
        (reason) => reason !== 'Normal unavailable',
      ),
    );
    const rejectedWithoutOwner = observabilityRejections.filter((frame) => !frame.poseSource);
    const normalDecisionCoverage =
      (poseReadyFrames.length + rejectedWithoutOwner.length) / replay.frames.length;
    const headPoseFrames = new Map(
      scoreHeadPoseReplay({ replay, sequence }).frames.map((frame) => [frame.index, frame]),
    );

    assert.ok(
      withinLimit(maxReadyNormalError, 1.2),
      `${scenario.name}: max ready normal error ${maxReadyNormalError.toFixed(3)}rad`,
    );
    assert.ok(
      poseReadyFrameRatio >= 0.45,
      `${scenario.name}: pose-ready frame ratio ${poseReadyFrameRatio.toFixed(3)}`,
    );
    assert.ok(
      normalDecisionCoverage >= 0.7,
      `${scenario.name}: normal decision coverage ${normalDecisionCoverage.toFixed(3)}`,
    );
    assert.ok(
      observabilityRejections.length >= 1,
      `${scenario.name}: expected at least one explicit normal observability rejection`,
    );
    assert.ok(
      rejectedWithoutOwner.length >= 1,
      `${scenario.name}: expected at least one rejected frame without a normal owner`,
    );
    assert.ok(
      rejectedWithoutOwner.every((frame) => headPoseFrames.get(frame.index).hiddenByPolicy),
      `${scenario.name}: rejected unowned normals must suppress attachment visibility`,
    );
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

      assert.equal(
        replay.anchorCreated,
        true,
        `${mode.id}/${scenario.name}: ${replay.createFailure || 'anchor failed'}`,
      );
      assert.equal(
        summary.failedFrames,
        0,
        `${mode.id}/${scenario.name}: ${summary.failureReasons.join(', ')}`,
      );
      const maxAnchorError = mode.id === 'sparse-reconstruction' && scenario.name === 'mug' ? 27 : 26;
      assert.ok(
        summary.maxAnchorError <= maxAnchorError,
        `${mode.id}/${scenario.name}: max anchor error ${summary.maxAnchorError.toFixed(2)}px`,
      );
      assert.ok(
        withinLimit(summary.maxFrameJump, 12),
        `${mode.id}/${scenario.name}: max jump ${summary.maxFrameJump.toFixed(2)}px`,
      );
      const maxScaleError =
        scenario.name === 'mug' && (mode.id === 'sparse-reconstruction' || mode.id === 'parametric-surface')
          ? 0.28
          : 0.24;
      assert.ok(
        summary.maxScaleError <= maxScaleError,
        `${mode.id}/${scenario.name}: max scale error ${summary.maxScaleError.toFixed(3)}`,
      );
      if (mode.id === 'parametric-surface' && scenario.name === 'cup') {
        assert.ok(
          summary.maxScaleError <= 0.18,
          `${mode.id}/${scenario.name}: parametric cup scale error ${summary.maxScaleError.toFixed(3)}`,
        );
      }

      if (mode.id !== 'sparse-reconstruction') {
        const selectedPoseFrames = summary.poseSourceCounts[mode.id] || 0;
        const planarPoseFrames = summary.poseSourceCounts['planar-homography'] || 0;
        if (mode.id === 'parametric-surface' && scenario.name === 'mug') {
          assert.equal(
            selectedPoseFrames,
            0,
            `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`,
          );
        } else if (scenario.rigidPlanarPoseOwner === true) {
          assert.ok(
            planarPoseFrames >= 6,
            `${mode.id}/${scenario.name}: planar pose frames ${planarPoseFrames}`,
          );
          assert.ok(
            selectedPoseFrames >= 1,
            `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`,
          );
        } else {
          assert.ok(
            selectedPoseFrames >= 6,
            `${mode.id}/${scenario.name}: selected pose frames ${selectedPoseFrames}`,
          );
        }
        assert.equal(
          lastFrame.metrics.reconstructionPreview.surface.model,
          scenario.surfaceByMode[mode.id],
          `${mode.id}/${scenario.name}: surface model`,
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
  assert.ok(
    replay.frames.every((frame) => frame.success),
    replay.frames.map((frame) => frame.failureReason).join(', '),
  );
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

    assert.equal(
      replay.anchorCreated,
      true,
      `${scenario.mode}/ball: ${replay.createFailure || 'anchor failed'}`,
    );
    assert.equal(summary.failedFrames, 0, `${scenario.mode}/ball: ${summary.failureReasons.join(', ')}`);
    assert.ok(selectedPoseFrames >= 10, `${scenario.mode}/ball: selected pose frames ${selectedPoseFrames}`);
    assert.equal(lastFrame.metrics.reconstructionPreview.surface.model, scenario.surface);
    assert.ok(
      summary.maxAnchorError <= 28,
      `${scenario.mode}/ball: max anchor error ${summary.maxAnchorError.toFixed(2)}px`,
    );
    assert.ok(
      summary.maxScaleError <= 0.14,
      `${scenario.mode}/ball: max scale error ${summary.maxScaleError.toFixed(3)}`,
    );
    assert.ok(
      headPose.maxScaleLogError <= 0.16,
      `${scenario.mode}/ball: head scale error ${headPose.maxScaleLogError.toFixed(3)}`,
    );
    assert.ok(
      headPose.maxRotationError <= 1.25,
      `${scenario.mode}/ball: head rotation error ${headPose.maxRotationError.toFixed(3)}rad`,
    );
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
  assert.ok(
    summary.sparsePositionUsage <= 0.32,
    `sparse position usage ${summary.sparsePositionUsage.toFixed(2)}`,
  );
  assert.ok(
    summary.planarPositionUsage +
      (summary.positionSourceCounts.reference_similarity_transform || 0) / summary.successfulFrames >=
      0.62,
    `tracked planar attachment usage ${JSON.stringify(summary.positionSourceCounts)}`,
  );
  assert.equal(headPose.visibleMismatches, 0);
  assert.ok(
    headPose.maxScaleLogError <= 0.16,
    `head scale log error ${headPose.maxScaleLogError.toFixed(3)}`,
  );
  assert.ok(headPose.maxHeadJumpExcess <= 0.06, `head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
  assert.ok(
    headPose.maxRotationError <= 0.9,
    `head rotation error ${headPose.maxRotationError.toFixed(3)}rad`,
  );
});

test('non-planar synthetic fixtures expose relative scale and roll ground truth', () => {
  const can = createCylindricalCanSequence({ frameCount: 30, occlusionFrames: [] });
  const box = createRigidBoxSequence({ frameCount: 28, occlusionFrames: [] });
  const canScales = can.frames.map((frame) => frame.groundTruth.scale);
  const boxScales = box.frames.map((frame) => frame.groundTruth.scale);
  const canRolls = can.frames.map((frame) => frame.groundTruth.roll);
  const boxRolls = box.frames.map((frame) => frame.groundTruth.roll);

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
  assert.ok(
    summary.planarPositionUsage >= 0.4,
    `planar position usage ${summary.planarPositionUsage.toFixed(2)}`,
  );
  assert.equal(summary.poseSourceCounts['nonplanar-calibration-hold'] || 0, 0);
  assert.equal(headPose.visibleMismatches, 0);
  assert.ok(
    headPose.maxWorldPositionError <= 0.16,
    `head world position error ${headPose.maxWorldPositionError.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxScaleLogError <= 0.12,
    `head scale log error ${headPose.maxScaleLogError.toFixed(3)}`,
  );
  assert.ok(headPose.maxHeadJumpExcess <= 0.06, `head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`);
  assert.ok(
    headPose.maxRotationError <= 1.1,
    `head rotation error ${headPose.maxRotationError.toFixed(3)}rad`,
  );
  assert.ok(
    headPose.meanRotationError <= 0.65,
    `mean head rotation error ${headPose.meanRotationError.toFixed(3)}rad`,
  );
});

test('depth book releases weak tracker ownership to mature reconstruction after occlusion', async () => {
  const cv = await loadOpenCvForNode();

  for (const trackingMode of ['direct-photometric', 'depth-fusion']) {
    const sequence = createPlanarBookSequence({
      kind: 'depth-book',
      frameCount: 36,
      occlusionFrames: [18, 19, 20],
    });
    const replay = await replayImageAnchorSequence({
      cv,
      sequence,
      trackingMode,
      useObjectSupportMask: true,
      refreshObjectSupportMask: true,
      depthFrameForFrame: trackingMode === 'depth-fusion' ? createSyntheticDepthFrame : null,
    });
    const summary = summarizeReplay(replay);
    const reconstructionRecoveryFrames = replay.frames.filter(
      (frame) =>
        frame.index > 20 &&
        frame.method === trackingMode &&
        frame.metrics.poseCandidates?.some(
          (candidate) =>
            candidate.role === 'tracker' && candidate.positionQualityRejected === 'weak-geometry',
        ),
    );

    assert.ok(
      summary.meanAnchorError <= 8,
      `${trackingMode}: mean anchor error ${summary.meanAnchorError.toFixed(2)}px`,
    );
    assert.ok(
      reconstructionRecoveryFrames.length >= 3,
      `${trackingMode}: expected mature reconstruction to replace weak tracker ownership`,
    );
  }
});

test('parametric plane fuses coherent tracker position after planar homography dropout', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createPlanarBookSequence({
    kind: 'dark-book',
    frameCount: 34,
    occlusionFrames: [8, 9, 22],
    backgroundVariant: 'shelf',
    backgroundSeed: 83,
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const consensusFrames = replay.frames.filter(
    (frame) => frame.metrics.positionFilterAdjustment === 'planar-reconstruction-consensus',
  );
  const weakTrackerReconstructionFrames = replay.frames.filter(
    (frame) =>
      frame.method === 'parametric-surface' &&
      frame.metrics.poseCandidates?.some(
        (candidate) => candidate.role === 'tracker' && candidate.positionQualityRejected === 'weak-geometry',
      ),
  );

  assert.ok(summary.maxAnchorError <= 16, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(consensusFrames.length >= 12, `consensus frames ${consensusFrames.length}`);
  assert.ok(
    consensusFrames.every((frame) => frame.method === 'parametric-surface'),
    `position ownership ${JSON.stringify(summary.positionSourceCounts)}`,
  );
  assert.ok(
    weakTrackerReconstructionFrames.length >= 3,
    `weak tracker handoffs ${weakTrackerReconstructionFrames.length}`,
  );
  assert.ok(
    weakTrackerReconstructionFrames.every(
      (frame) => frame.metrics.positionFilterAdjustment !== 'planar-reconstruction-consensus',
    ),
    'weak tracker position entered planar reconstruction consensus',
  );
});

test('rigid planar replay defers repeated occlusion map growth to descriptor relocalization', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createLaminatedCardSequence({
    frameCount: 24,
    occlusionFrames: [6, 7, 14, 15],
    backgroundVariant: 'busy',
    backgroundSeed: 2498,
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const occlusionGrowthFrames = replay.frames.filter(
    (frame) =>
      frame.metrics.landmarkRefreshReason === 'occlusion-support' &&
      (frame.metrics.landmarkRefreshAdded || 0) > 0,
  );
  const relocalizationFrames = replay.frames.filter(
    (frame) =>
      frame.metrics.updateTimings?.relocalizationMs > 0 && frame.metrics.relocalizationResult === 'success',
  );

  assert.ok(replay.frames[0].metrics.relocalizationKeyframes >= 1);
  assert.equal(occlusionGrowthFrames.length, 1);
  assert.ok(
    occlusionGrowthFrames[0].index < 14,
    `unexpected repeated growth at frame ${occlusionGrowthFrames[0].index}`,
  );
  assert.ok(relocalizationFrames.length >= 3, `relocalization frames ${relocalizationFrames.length}`);
  assert.ok(
    relocalizationFrames.every(
      (frame) =>
        frame.metrics.relocalizationQueryRegion.width < sequence.width &&
        frame.metrics.relocalizationQueryRegion.height < sequence.height,
    ),
  );
  assert.ok(summary.maxAnchorError <= 14, `maximum anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 10, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
});

test('mature rigid planar maps validate sparse LK support against descriptor geometry', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createLaminatedCardSequence({
    frameCount: 44,
    occlusionFrames: [18, 19, 20],
    backgroundVariant: 'desk',
    backgroundSeed: 2438,
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const relocalizationFrames = replay.frames.filter(
    (frame) =>
      frame.metrics.updateTimings?.relocalizationMs > 0 && frame.metrics.relocalizationResult === 'success',
  );

  assert.ok(relocalizationFrames.length >= 3, `relocalization frames ${relocalizationFrames.length}`);
  assert.ok(
    relocalizationFrames.every(
      (frame) =>
        frame.metrics.relocalizationQueryRegion.width < sequence.width &&
        frame.metrics.relocalizationQueryRegion.height < sequence.height &&
        frame.metrics.relocalizationInliers >= 9,
    ),
  );
  assert.ok(summary.meanAnchorError <= 8, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(
    replay.frames.at(-1).anchorError <= 5,
    `final anchor error ${replay.frames.at(-1).anchorError.toFixed(2)}px`,
  );
});

test('clean rigid planar replay preserves the visible pose branch through a wide turn', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createLaminatedCardSequence({
    frameCount: 32,
    occlusionFrames: [],
    backgroundVariant: 'window',
    backgroundSeed: 2443,
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;
  const temporalBranchFrames = replay.frames.filter(
    (frame) => frame.index >= 20 && frame.metrics.planarPnpBranchSelection === 'temporal-branch',
  );

  assert.equal(replay.frames[0].metrics.planarPnpBranchSelection, 'fresh');
  assert.ok(temporalBranchFrames.length >= 4, 'expected temporal branch disambiguation during the wide turn');
  assert.ok(summary.maxNormalError <= 1.2, `maximum normal error ${summary.maxNormalError.toFixed(3)}rad`);
  assert.ok(
    headPose.maxRotationError <= 0.9,
    `head rotation error ${headPose.maxRotationError.toFixed(3)}rad`,
  );
});

test('rigid planar replay resets temporal PnP continuity across a geometric dropout', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createLaminatedCardSequence({
    frameCount: 22,
    occlusionFrames: [5, 6, 7],
    backgroundVariant: 'kitchen',
    backgroundSeed: 2473,
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const dropoutFrames = replay.frames.filter((frame) => frame.index >= 13 && frame.index <= 14);
  const reacquiredPlanarFrame = replay.frames.find(
    (frame) => frame.index > 14 && frame.poseSource === 'planar-homography',
  );

  assert.ok(dropoutFrames.every((frame) => frame.poseSource === null));
  assert.ok(reacquiredPlanarFrame, 'expected planar pose reacquisition after the dropout');
  assert.equal(reacquiredPlanarFrame.metrics.planarPnpBranchSelection, 'fresh');
  assert.ok(summary.maxNormalError <= 1.2, `maximum normal error ${summary.maxNormalError.toFixed(3)}rad`);
});

test('depth fusion cup bridges late pose dropout without accepting weak tracker drift', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createTexturedCupSequence({
    frameCount: 28,
    occlusionFrames: [18, 19],
    backgroundVariant: 'shelf',
    backgroundSeed: 121,
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'depth-fusion',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    depthFrameForFrame: createSyntheticDepthFrame,
  });
  const summary = summarizeReplay(replay);
  const bridgedFrames = replay.frames.filter(
    (frame) => frame.index > 19 && frame.metrics.positionFilterAdjustment === 'curved-motion-hold',
  );

  assert.ok(summary.maxAnchorError <= 27, `maximum anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(
    bridgedFrames.length >= 3,
    `expected mature depth motion to bridge dropout, got ${bridgedFrames.length} frames`,
  );
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
  assert.ok(
    headPose.maxRotationError <= 1.25,
    `can head rotation error ${headPose.maxRotationError.toFixed(3)}rad`,
  );
  assert.ok(
    headPose.meanRotationError <= 0.9,
    `can mean head rotation error ${headPose.meanRotationError.toFixed(3)}rad`,
  );
  assert.ok(
    headPose.maxHeadJumpExcess <= 0.08,
    `can head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxScaleLogError <= 0.28,
    `can head scale log error ${headPose.maxScaleLogError.toFixed(3)}`,
  );
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
    targetClassOverride: 'generic-object',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;

  assert.equal(replay.anchorCreated, true, replay.createFailure || 'anchor was not created');
  assert.equal(summary.failedFrames, 0, summary.failureReasons.join(', '));
  assert.ok(
    summary.maxAnchorError <= 26,
    `generic can max anchor error ${summary.maxAnchorError.toFixed(2)}px`,
  );
  assert.ok(
    summary.meanAnchorError <= 11,
    `generic can mean anchor error ${summary.meanAnchorError.toFixed(2)}px`,
  );
  assert.ok(summary.maxFrameJump <= 18, `generic can max frame jump ${summary.maxFrameJump.toFixed(2)}px`);
  assert.equal(headPose.visibleMismatches, 0);
  assert.ok(
    headPose.maxWorldPositionError <= 0.16,
    `generic can head world error ${headPose.maxWorldPositionError.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxHeadJumpExcess <= 0.06,
    `generic can head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`,
  );
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
  const pnpFrames = replay.frames.filter((frame) => (frame.metrics.reconstructionPnpInliers || 0) >= 12);
  const maxPnpResidual = Math.max(
    ...pnpFrames.map((frame) => frame.metrics.reconstructionPnpAverageResidual),
    0,
  );

  assert.equal(replay.anchorCreated, true, replay.createFailure || 'anchor was not created');
  assert.equal(summary.failedFrames, 0, summary.failureReasons.join(', '));
  assert.ok(
    summary.maxAnchorError <= 18,
    `off-center can max anchor error ${summary.maxAnchorError.toFixed(2)}px`,
  );
  assert.ok(
    summary.meanAnchorError <= 8,
    `off-center can mean anchor error ${summary.meanAnchorError.toFixed(2)}px`,
  );
  assert.ok(summary.maxScaleError <= 0.22, `off-center can scale error ${summary.maxScaleError.toFixed(3)}`);
  assert.ok(
    (summary.poseSourceCounts['parametric-surface'] || 0) >= 8,
    `parametric pose frames ${JSON.stringify(summary.poseSourceCounts)}`,
  );
  assert.ok(pnpFrames.length >= 8, `curved PnP frames ${pnpFrames.length}`);
  assert.ok(maxPnpResidual <= 7, `curved PnP residual ${maxPnpResidual.toFixed(2)}`);
  assert.equal(headPose.visibleMismatches, 0);
  assert.ok(
    headPose.maxWorldPositionError <= 0.14,
    `off-center can head world error ${headPose.maxWorldPositionError.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxRotationError <= 1.15,
    `off-center can head rotation error ${headPose.maxRotationError.toFixed(3)}rad`,
  );
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
  assert.ok(
    headPose.maxHeadJumpExcess <= 0.08,
    `cup head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxScaleLogError <= 0.2,
    `cup head scale log error ${headPose.maxScaleLogError.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxRotationError <= 1.35,
    `cup head rotation error ${headPose.maxRotationError.toFixed(3)}rad`,
  );
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
  assert.ok(
    headPose.maxWorldPositionError <= 0.24,
    `cup head world error ${headPose.maxWorldPositionError.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxHeadJumpExcess <= 0.08,
    `cup head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxScaleLogError <= 0.2,
    `cup head scale log error ${headPose.maxScaleLogError.toFixed(3)}`,
  );
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
  assert.ok(
    headPose.maxRotationError <= 0.95,
    `box head rotation error ${headPose.maxRotationError.toFixed(3)}rad`,
  );
  assert.ok(
    headPose.maxHeadJumpExcess <= 0.1,
    `box head jump excess ${headPose.maxHeadJumpExcess.toFixed(3)}`,
  );
  assert.ok(
    headPose.maxScaleLogError <= 0.32,
    `box head scale log error ${headPose.maxScaleLogError.toFixed(3)}`,
  );
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
      targetClassOverride: 'generic-object',
      maxAnchorError: 28,
      meanAnchorError: 16,
      minOwnershipRatio: 0.6,
    },
  ];

  for (const scenario of scenarios) {
    if (scenario.sequence.kind === 'human-silhouette') {
      const firstFrame = scenario.sequence.frames[0];
      const maskAt = (point) => {
        const x = Math.round(point.x);
        const y = Math.round(point.y);
        return firstFrame.objectMask.data[y * scenario.sequence.width + x] > 0;
      };
      assert.equal(
        maskAt(firstFrame.maskProbePoints.object),
        true,
        `${scenario.name}: tap should be object support`,
      );
      assert.equal(
        maskAt(firstFrame.maskProbePoints.betweenLegs),
        false,
        `${scenario.name}: between-leg background should stay outside support`,
      );
      assert.equal(
        maskAt(firstFrame.maskProbePoints.armGap),
        false,
        `${scenario.name}: arm-gap background should stay outside support`,
      );
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
      .filter((frame) => frame.success && (frame.metrics.activeLandmarkCount || 0) >= 8)
      .map((frame) => (frame.metrics.objectOwnedLandmarks || 0) / frame.metrics.activeLandmarkCount);

    assert.equal(replay.anchorCreated, true, `${scenario.name}: ${replay.createFailure || 'anchor failed'}`);
    assert.equal(replay.createResult.objectSupportMaskSource, 'synthetic-object-mask');
    assert.equal(summary.failedFrames, 0, `${scenario.name}: ${summary.failureReasons.join(', ')}`);
    assert.ok(
      summary.maxAnchorError <= scenario.maxAnchorError,
      `${scenario.name}: max anchor error ${summary.maxAnchorError.toFixed(2)}px`,
    );
    assert.ok(
      summary.meanAnchorError <= scenario.meanAnchorError,
      `${scenario.name}: mean anchor error ${summary.meanAnchorError.toFixed(2)}px`,
    );
    assert.ok(ownershipRatios.length >= 12, `${scenario.name}: ownership samples ${ownershipRatios.length}`);
    assert.ok(
      Math.min(...ownershipRatios) >= (scenario.minOwnershipRatio || 0.72),
      `${scenario.name}: min ownership ratio ${Math.min(...ownershipRatios).toFixed(2)}`,
    );
    if (scenario.sequence.kind === 'human-silhouette') {
      assert.ok(
        replay.frames.some((frame) => frame.metrics.objectSupportPositionCorrection),
        `${scenario.name}: should exercise segmentation-owned support correction`,
      );
    }
  }
});

test('replay records segmentation support correction on the corrected frame', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createHumanSilhouetteSequence({
    frameCount: 24,
    occlusionFrames: [8, 9, 18],
    backgroundVariant: 'busy',
    backgroundSeed: 211,
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
    targetClassOverride: 'generic-object',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const correctedFrames = replay.frames.filter((frame) => frame.metrics.objectSupportPositionCorrection);
  const firstCorrected = correctedFrames[0];

  assert.ok(correctedFrames.length >= 1);
  assert.ok(
    firstCorrected.anchorError <= 17,
    `first corrected frame should record corrected position, got ${firstCorrected.anchorError.toFixed(2)}px`,
  );
});

test('replay keeps direct curved motion stable through repeated cup occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastRepeatedCupRecoveryFixture(),
    trackingMode: 'direct-photometric',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const heldFrames = replay.frames.filter(
    (frame) => frame.metrics.positionFilterAdjustment === 'curved-motion-hold',
  );
  const occlusionRecoveryFrames = replay.frames.filter(
    (frame) =>
      frame.occluded &&
      (frame.metrics.positionFilterAdjustment === 'curved-motion-hold' ||
        frame.metrics.relocalizationSuccessFrame === frame.index),
  );
  const recoveryCorrections = replay.frames.filter(
    (frame) => frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery',
  );
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));

  assert.ok(heldFrames.length >= 1);
  assert.ok(occlusionRecoveryFrames.length >= 2);
  assert.ok(recoveryCorrections.length <= 1);
  assert.ok(maxAnchorError <= 19, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('replay avoids stale depth-fusion cup motion hold through repeated occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastRepeatedCupRecoveryFixture(),
    trackingMode: 'depth-fusion',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    depthFrameForFrame: createSyntheticDepthFrame,
  });
  const heldFrames = replay.frames.filter(
    (frame) => frame.metrics.positionFilterAdjustment === 'curved-motion-hold',
  );
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));

  assert.equal(heldFrames.length, 0);
  assert.ok(maxAnchorError <= 22, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('replay bounds depth-fusion cup support recovery during early occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastEarlyCupRecoveryFixture(),
    trackingMode: 'depth-fusion',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    depthFrameForFrame: createSyntheticDepthFrame,
  });
  const supportCorrections = replay.frames.filter(
    (frame) => frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery',
  );
  const maxSupportStep = Math.max(
    ...supportCorrections.map((frame) => frame.metrics.objectSupportPositionStep || 0),
    0,
  );
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));
  const meanAnchorError =
    replay.frames.reduce((sum, frame) => sum + frame.anchorError, 0) / Math.max(1, replay.frames.length);
  const depthFusionPositionFrames = replay.frames.filter((frame) => frame.positionSource === 'depth-fusion');

  assert.ok(supportCorrections.length >= 1);
  assert.ok(maxSupportStep <= 5 + LIMIT_EPSILON);
  assert.ok(depthFusionPositionFrames.length >= 4);
  assert.ok(maxAnchorError <= 22, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
  assert.ok(
    meanAnchorError <= 9,
    `mean anchor error should stay bounded, got ${meanAnchorError.toFixed(2)}px`,
  );
});

test('sparse cup uses recovery support for landmarks without recentering the anchor', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createTexturedCupSequence({
    frameCount: 36,
    occlusionFrames: [10, 11, 24],
    backgroundVariant: 'busy',
    backgroundSeed: 111,
  });
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const recoveryCorrections = replay.frames.filter(
    (frame) => frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery',
  );
  const recoveryRefreshes = replay.frames.filter(
    (frame) => frame.metrics.segmentationRefreshReason === 'pose-dropout-recovery',
  );

  assert.equal(recoveryCorrections.length, 0);
  assert.ok(recoveryRefreshes.length >= 1, `recovery refreshes ${recoveryRefreshes.length}`);
  assert.ok(summary.maxAnchorError <= 25, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 8, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
});

test('replay keeps mug repeated recovery bounded without stale motion holds', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastRepeatedMugRecoveryFixture(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const heldCorrections = replay.frames.filter(
    (frame) => frame.metrics.positionFilterAdjustment === 'curved-motion-hold',
  );
  const recoveryCorrections = replay.frames.filter(
    (frame) =>
      frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery' ||
      frame.metrics.objectSupportPositionCorrection === 'curved-object-recovery',
  );
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));
  const meanAnchorError =
    replay.frames.reduce((sum, frame) => sum + frame.anchorError, 0) / Math.max(1, replay.frames.length);
  const maxSupportStep = Math.max(
    ...recoveryCorrections.map((frame) => frame.metrics.objectSupportPositionStep || 0),
    0,
  );

  assert.equal(heldCorrections.length, 0);
  assert.ok(recoveryCorrections.length <= 8);
  assert.ok(maxSupportStep <= 12 + LIMIT_EPSILON);
  assert.ok(maxAnchorError <= 40, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
  assert.ok(
    meanAnchorError <= 18,
    `mean anchor error should stay bounded, got ${meanAnchorError.toFixed(2)}px`,
  );
});

test('replay corrects parametric mug vertical drift during repeated recovery', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastRepeatedMugRecoveryFixture(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));
  const meanAnchorError =
    replay.frames.reduce((sum, frame) => sum + frame.anchorError, 0) / Math.max(1, replay.frames.length);

  assert.ok(maxAnchorError <= 32, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
  assert.ok(
    meanAnchorError <= 16,
    `mean anchor error should stay bounded, got ${meanAnchorError.toFixed(2)}px`,
  );
});

test('depth-fusion mug uses object-wide consensus after tap-local reference deformation', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastRepeatedMugRecoveryFixture(),
    trackingMode: 'depth-fusion',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    depthFrameForFrame: createSyntheticDepthFrame,
  });
  const summary = summarizeReplay(replay);
  const objectWideRecoveryFrames = replay.frames.filter(
    (frame) =>
      frame.metrics.trackerReferenceScope === 'object-wide' &&
      frame.metrics.trackerLocalReferenceResidual >= 24,
  );

  assert.ok(objectWideRecoveryFrames.length >= 4);
  assert.ok(objectWideRecoveryFrames.every((frame) => frame.metrics.keypointCount <= 45));
  assert.ok(summary.maxAnchorError <= 17, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 11.5, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.p95AnchorError <= 16, `p95 anchor error ${summary.p95AnchorError.toFixed(2)}px`);
});

test('direct mug relocalizes a deformed reference before repeated-occlusion drift compounds', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastRepeatedMugRecoveryFixture(),
    trackingMode: 'direct-photometric',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const objectWideRecoveryFrames = replay.frames.filter(
    (frame) =>
      frame.metrics.trackerReferenceScope === 'object-wide' &&
      frame.metrics.trackerLocalReferenceResidual >= 24,
  );
  const successfulRelocalizationFrames = replay.frames.filter(
    (frame) =>
      frame.metrics.updateTimings?.relocalizationMs > 0 && frame.metrics.relocalizationResult === 'success',
  );

  assert.ok(objectWideRecoveryFrames.length >= 3);
  assert.equal(successfulRelocalizationFrames[0]?.index, 12);
  assert.ok(summary.maxAnchorError <= 21, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 13, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.p95AnchorError <= 20, `p95 anchor error ${summary.p95AnchorError.toFixed(2)}px`);
});

test('replay caps generic free-tap recovery impulses in dense modes', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastEarlyFreeTapCanRecoveryFixture(),
    trackingMode: 'direct-photometric',
    targetClassOverride: 'generic-object',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxSupportStep = Math.max(
    ...replay.frames.map((frame) => frame.metrics.objectSupportPositionStep || 0),
    0,
  );
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));
  const meanAnchorError =
    replay.frames.reduce((sum, frame) => sum + frame.anchorError, 0) / Math.max(1, replay.frames.length);

  assert.ok(maxSupportStep <= 10 + LIMIT_EPSILON);
  assert.ok(maxAnchorError <= 22, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
  assert.ok(
    meanAnchorError <= 12,
    `mean anchor error should stay bounded, got ${meanAnchorError.toFixed(2)}px`,
  );
});

test('replay caps glossy can sparse recovery jumps', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastEarlyGlossyCanRecoveryFixture(),
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxSupportStep = Math.max(
    ...replay.frames.map((frame) => frame.metrics.objectSupportPositionStep || 0),
    0,
  );
  const maxFrameJump = Math.max(
    ...replay.frames
      .slice(1)
      .map((frame, index) =>
        Math.hypot(
          frame.predicted.x - replay.frames[index].predicted.x,
          frame.predicted.y - replay.frames[index].predicted.y,
        ),
      ),
    0,
  );
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));

  assert.ok(maxSupportStep <= 10 + LIMIT_EPSILON);
  assert.ok(maxFrameJump <= 17, `max frame jump should stay bounded, got ${maxFrameJump.toFixed(2)}px`);
  assert.ok(maxAnchorError <= 18, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('established parametric can map survives repeated support recovery', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createSlowRepeatedGlossyCanRecoveryFixture(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const establishedRecoveryFrames = replay.frames.filter(
    (frame) =>
      frame.metrics.landmarkRefreshReferenceSource === 'recovery-prior' &&
      frame.metrics.reconstructionFrames >= 12,
  );
  const lateReinitializations = replay.frames.filter(
    (frame) => frame.index >= 20 && frame.metrics.keypointReinitializationResult === 'reinitialized',
  );

  assert.ok(establishedRecoveryFrames.length >= 2);
  assert.ok(establishedRecoveryFrames.every((frame) => frame.metrics.landmarkRefreshRecovered >= 12));
  assert.equal(lateReinitializations.length, 0);
  assert.ok(summary.maxAnchorError <= 34, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 12, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.p95AnchorError <= 22, `p95 anchor error ${summary.p95AnchorError.toFixed(2)}px`);
});

test('replay rejects divergent high-residual glossy can direct poses during repeated occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createSlowRepeatedGlossyCanRecoveryFixture(),
    trackingMode: 'direct-photometric',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const divergentSelectedPoses = replay.frames.filter(
    (frame) =>
      frame.positionSource === 'direct-photometric' &&
      (frame.metrics.reconstructionTrackerDelta || 0) >= 32 &&
      (frame.metrics.poseAverageResidual || 0) > 6.5,
  );

  assert.equal(divergentSelectedPoses.length, 0);
  assert.ok(
    summary.meanAnchorError <= 14.3,
    `mean anchor error should stay bounded, got ${summary.meanAnchorError.toFixed(2)}px`,
  );
});

test('direct mug relocalization preserves attachment motion after early occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createSlowEarlyBusyMugRecoveryFixture(),
    trackingMode: 'direct-photometric',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const motionAlignedRelocalizations = replay.frames.filter(
    (frame) => frame.metrics.relocalizationAnchorAdjustment === 'curved-motion-prior',
  );

  assert.deepEqual(
    motionAlignedRelocalizations.map((frame) => frame.index),
    [8],
  );
  assert.ok(motionAlignedRelocalizations[0].metrics.relocalizationAnchorAdjustmentStep <= 18 + LIMIT_EPSILON);
  assert.ok(
    summary.maxAnchorError <= 24,
    `max anchor error should stay bounded, got ${summary.maxAnchorError.toFixed(2)}px`,
  );
  assert.ok(
    summary.meanAnchorError <= 14,
    `mean anchor error should stay bounded, got ${summary.meanAnchorError.toFixed(2)}px`,
  );
});

test('fresh motion bridges weak direct mug position reversal during early occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createMotionContradictionMugRecoveryFixture(),
    trackingMode: 'direct-photometric',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const motionBridgeFrames = replay.frames.filter(
    (frame) => frame.metrics.positionFilterAdjustment === 'weak-mug-motion-bridge',
  );

  assert.ok(motionBridgeFrames.length >= 2);
  assert.equal(summary.postOcclusionRecoveredAt8, 1);
  assert.ok(summary.maxAnchorError <= 32, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 14, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
});

test('cadenced parametric mug consumes recovery support before periodic refresh can overwrite it', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createMotionContradictionMugRecoveryFixture(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    updateIntervalMs: ANCHOR_TRACKING_INTERVAL_MS,
  });
  const summary = summarizeReplay(replay);
  const recoveryRefreshes = replay.frames.filter(
    (frame) => frame.metrics.landmarkRefreshReason === 'support-recovery',
  );

  assert.ok(recoveryRefreshes.length >= 1, 'expected recovery support to reach an admitted CV update');
  assert.equal(summary.postOcclusionRecoveredAt8, 1);
  assert.ok(summary.maxFrameJump <= 14, `recovery jump ${summary.maxFrameJump.toFixed(2)}px`);
});

test('cadenced depth-fusion mug redetects after its unready dense map loses reference geometry', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createMotionContradictionMugRecoveryFixture(),
    trackingMode: 'depth-fusion',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    depthFrameForFrame: createSyntheticDepthFrame,
    updateIntervalMs: ANCHOR_TRACKING_INTERVAL_MS,
  });
  const summary = summarizeReplay(replay);
  const reinitializedFrames = replay.frames.filter(
    (frame) => frame.metrics.keypointReinitializationResult === 'reinitialized',
  );

  assert.ok(reinitializedFrames.length >= 1, 'expected detector-style recovery for the unready map');
  assert.equal(summary.postOcclusionRecoveredAt8, 1);
});

test('cadenced sparse mug can relocalize from its trusted tap frame after early occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix({ size: 'quick' }).find(
    (item) =>
      item.axes.object === 'handled-mug' &&
      item.axes.background === 'busy' &&
      item.axes.motion === 'slow' &&
      item.axes.occlusion === 'early',
  );
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    updateIntervalMs: ANCHOR_TRACKING_INTERVAL_MS,
  });
  const summary = summarizeReplay(replay);
  const firstSuccessfulRelocalization = replay.frames.find(
    (frame) => frame.metrics.relocalizationResult === 'success',
  );
  const weaklyObservedNormalFrames = replay.frames.filter(
    (frame) =>
      frame.metrics.normalPoseRejectedCandidates?.['sparse-reconstruction'] === 'weak-normal-innovation',
  );
  const acceptedReadyNormals = replay.frames.filter(
    (frame) => frame.metrics.reconstructionReady === true && frame.poseSource === 'sparse-reconstruction',
  );
  const meanAcceptedNormalError =
    acceptedReadyNormals.reduce((sum, frame) => sum + frame.normalError, 0) /
    Math.max(1, acceptedReadyNormals.length);
  const maxAcceptedNormalError = Math.max(...acceptedReadyNormals.map((frame) => frame.normalError), 0);

  assert.ok(replay.frames[0].metrics.relocalizationKeyframes >= 1);
  assert.ok(firstSuccessfulRelocalization);
  assert.ok(firstSuccessfulRelocalization.index <= 15);
  assert.ok(
    firstSuccessfulRelocalization.metrics.relocalizationInliers >= 8,
    `relocalization inliers ${firstSuccessfulRelocalization.metrics.relocalizationInliers}`,
  );
  assert.ok(summary.sparsePositionUsage >= 0.4, `sparse position usage ${summary.sparsePositionUsage}`);
  assert.ok(summary.meanAnchorError <= 10.25, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.p95AnchorError <= 23, `p95 anchor error ${summary.p95AnchorError.toFixed(2)}px`);
  assert.ok(summary.maxAnchorError <= 26, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(weaklyObservedNormalFrames.length >= 2);
  assert.ok(
    weaklyObservedNormalFrames.every((frame) => frame.metrics.poseObs < 0.05 && frame.poseSource === null),
  );
  assert.ok(
    meanAcceptedNormalError <= 0.3,
    `mean accepted normal error ${meanAcceptedNormalError.toFixed(3)}rad`,
  );
  assert.ok(
    maxAcceptedNormalError <= 0.53,
    `max accepted normal error ${maxAcceptedNormalError.toFixed(3)}rad`,
  );
});

test('cadenced sparse generic recovery reinitializes from agreeing mask and tracker evidence', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix({ size: 'quick' }).find(
    (item) =>
      item.axes.object === 'generic-free-tap-can' &&
      item.axes.background === 'shelf' &&
      item.axes.motion === 'fast' &&
      item.axes.occlusion === 'early',
  );
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'sparse-reconstruction',
    targetClassOverride: scenario.targetClassOverride,
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    updateIntervalMs: ANCHOR_TRACKING_INTERVAL_MS,
  });
  const summary = summarizeReplay(replay);
  const consensusFrame = replay.frames.find(
    (frame) => frame.metrics.recoveryReferencePositionSource === 'support-tracker-consensus',
  );

  assert.ok(consensusFrame, 'expected fresh support to corroborate the current tracker position');
  assert.equal(consensusFrame.metrics.keypointReinitializationResult, 'reinitialized');
  assert.equal(consensusFrame.metrics.keypointReinitializationFrameStepLimited, false);
  assert.ok(consensusFrame.metrics.keypointReinitializationAnchorDelta >= 30);
  assert.ok(summary.meanAnchorError <= 13.2, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.maxAnchorError <= 33, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.anchorAccuracyAt8 >= 0.35, `8px accuracy ${summary.anchorAccuracyAt8.toFixed(3)}`);
});

test('replay damps high-residual sparse cylinder recovery impulses', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix().find(
    (item) =>
      item.axes.object === 'glossy-can' &&
      item.axes.background === 'desk' &&
      item.axes.motion === 'fast' &&
      item.axes.occlusion === 'early',
  );
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxFrameJump = Math.max(
    ...replay.frames
      .slice(1)
      .map((frame, index) =>
        Math.hypot(
          frame.predicted.x - replay.frames[index].predicted.x,
          frame.predicted.y - replay.frames[index].predicted.y,
        ),
      ),
    0,
  );
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));

  assert.ok(maxFrameJump <= 17, `max frame jump should stay bounded, got ${maxFrameJump.toFixed(2)}px`);
  assert.ok(maxAnchorError <= 18, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('replay rejects stale sparse can poses during late occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix().find(
    (item) =>
      item.axes.object === 'cylindrical-can' &&
      item.axes.background === 'desk' &&
      item.axes.motion === 'slow' &&
      item.axes.occlusion === 'late',
  );
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxFrameJump = Math.max(
    ...replay.frames
      .slice(1)
      .map((frame, index) =>
        Math.hypot(
          frame.predicted.x - replay.frames[index].predicted.x,
          frame.predicted.y - replay.frames[index].predicted.y,
        ),
      ),
    0,
  );
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));

  assert.ok(maxFrameJump <= 13, `max frame jump should stay bounded, got ${maxFrameJump.toFixed(2)}px`);
  assert.ok(maxAnchorError <= 20, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('replay caps rigid-box periodic support recentering jumps', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastEarlyRigidBoxRecoveryFixture(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const maxPeriodicSupportStep = Math.max(
    ...replay.frames
      .filter((frame) => frame.metrics.objectSupportPositionCorrection === 'periodic-segmentation-refresh')
      .map((frame) => frame.metrics.objectSupportPositionStep || 0),
    0,
  );
  const maxFrameJump = Math.max(
    ...replay.frames
      .slice(1)
      .map((frame, index) =>
        Math.hypot(
          frame.predicted.x - replay.frames[index].predicted.x,
          frame.predicted.y - replay.frames[index].predicted.y,
        ),
      ),
    0,
  );

  assert.ok(maxPeriodicSupportStep <= 6 + LIMIT_EPSILON);
  assert.ok(maxFrameJump <= 16, `max frame jump should stay bounded, got ${maxFrameJump.toFixed(2)}px`);
});

test('replay leaves textured cup motion holds on pose-dropout recovery path', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastEarlyCupRecoveryFixture(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const mugRecoveryCorrections = replay.frames.filter(
    (frame) => frame.metrics.objectSupportPositionCorrection === 'curved-object-recovery',
  );

  assert.equal(mugRecoveryCorrections.length, 0);
});

test('replay bounds sparse mug support recovery during repeated occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: createFastRepeatedMugRecoveryFixture(),
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const supportCorrections = replay.frames.filter(
    (frame) => frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery',
  );
  const maxAnchorError = Math.max(...replay.frames.map((frame) => frame.anchorError));

  assert.ok(supportCorrections.length >= 1);
  assert.ok(supportCorrections.length <= 5);
  assert.ok(
    supportCorrections.every((frame) => frame.metrics.objectSupportPositionStep <= 6 + LIMIT_EPSILON),
  );
  assert.ok(maxAnchorError <= 40, `max anchor error should stay bounded, got ${maxAnchorError.toFixed(2)}px`);
});

test('sparse mug relocalizes catastrophic reference drift before its supported 3D pose collapses', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = createVisionBenchmarkMatrix({ size: 'full' }).find(
    (item) =>
      item.axes.object === 'handled-mug' &&
      item.axes.background === 'kitchen' &&
      item.axes.motion === 'slow' &&
      item.axes.occlusion === 'early',
  );
  assert.ok(scenario);
  const sequence = scenario.create();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const successfulRelocalizationFrames = replay.frames.filter(
    (frame) =>
      frame.metrics.updateTimings?.relocalizationMs > 0 && frame.metrics.relocalizationResult === 'success',
  );

  assert.equal(successfulRelocalizationFrames[0]?.index, 6);
  assert.ok(successfulRelocalizationFrames[0].metrics.keypointCount >= 24);
  assert.deepEqual(successfulRelocalizationFrames[0].metrics.relocalizationQueryRegion, {
    x: 0,
    y: 0,
    width: sequence.width,
    height: sequence.height,
  });
  assert.equal(summary.postOcclusionRecoveredAt8, 1);
  assert.ok(summary.maxAnchorError <= 35, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(summary.meanAnchorError <= 13, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.p95AnchorError <= 26, `p95 anchor error ${summary.p95AnchorError.toFixed(2)}px`);
});

test('parametric handled mug preserves its map and reacquires pose after repeated occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const scenario = stressReplayScenarios.find(
    ({ name }) => name === 'handled mug on kitchen tile background',
  );
  assert.ok(scenario);
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: scenario.create(),
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const recoveryFrame = replay.frames.find(
    (frame) => frame.metrics.landmarkRefreshReferenceSource === 'recovery-prior',
  );
  assert.ok(recoveryFrame, 'expected model-guided landmark recovery');
  assert.ok(
    recoveryFrame.metrics.landmarkRefreshRecovered >= 8,
    `recovered landmarks ${recoveryFrame.metrics.landmarkRefreshRecovered}`,
  );
  assert.equal(recoveryFrame.metrics.landmarkRefreshAdded, 0);
  assert.equal(recoveryFrame.metrics.reconstructionReady, true);
  assert.equal(recoveryFrame.metrics.keypointReinitializationResult, null);

  const reacquiredPose = replay.frames.find(
    (frame) =>
      frame.index > recoveryFrame.index &&
      frame.index <= recoveryFrame.index + 2 &&
      frame.metrics.reconstructionPoseInliers >= 8 &&
      frame.method === 'parametric-surface',
  );
  assert.ok(reacquiredPose, 'expected parametric pose within two frames of recovery');
  assert.ok(
    reacquiredPose.metrics.activeLandmarkCount >= 24,
    `active landmarks ${reacquiredPose.metrics.activeLandmarkCount}`,
  );
});

test('parametric handled mug recovers its attachment frame after early busy occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createSlowEarlyBusyMugRecoveryFixture();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'parametric-surface',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;
  const recoveryFrame = replay.frames.find(
    (frame) =>
      frame.metrics.landmarkRefreshReferenceSource === 'recovery-prior' &&
      frame.metrics.landmarkRefreshRecovered >= 8,
  );

  assert.ok(recoveryFrame, 'expected established landmarks to recover in the motion-aligned frame');
  assert.equal(recoveryFrame.metrics.recoveryReferencePositionSource, 'curved-motion-prediction');
  assert.equal(summary.postOcclusionRecoveredAt8, 1);
  assert.ok(summary.meanAnchorError <= 16, `mean anchor error ${summary.meanAnchorError.toFixed(2)}px`);
  assert.ok(summary.maxAnchorError <= 30, `max anchor error ${summary.maxAnchorError.toFixed(2)}px`);
  assert.ok(
    headPose.maxWorldPositionError <= 0.1,
    `world error ${headPose.maxWorldPositionError.toFixed(3)}`,
  );
  assert.ok(headPose.maxRotationError <= 0.5, `rotation error ${headPose.maxRotationError.toFixed(3)}rad`);
});

test('replay bounds sparse handled mug drift during early busy occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const sequence = createSlowEarlyBusyMugRecoveryFixture();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
  });
  const summary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;
  const supportCorrections = replay.frames.filter((frame) => frame.metrics.objectSupportPositionCorrection);
  const recoveryCorrections = supportCorrections.filter(
    (frame) => frame.metrics.objectSupportPositionCorrection === 'pose-dropout-recovery',
  );
  const periodicCorrections = supportCorrections.filter(
    (frame) => frame.metrics.objectSupportPositionCorrection === 'periodic-segmentation-refresh',
  );
  const weakDivergentSparseMugOwners = replay.frames.filter(
    (frame) =>
      frame.method === 'sparse-reconstruction' &&
      (frame.metrics.reconstructionTrackerDelta || 0) >= 25 &&
      (frame.metrics.reconstructionPoseInliers || 0) < 16 &&
      (frame.metrics.poseAverageResidual || 0) > 4.5,
  );
  const maxSupportStep = Math.max(
    ...supportCorrections.map((frame) => frame.metrics.objectSupportPositionStep || 0),
    0,
  );

  assert.ok(recoveryCorrections.length >= 1);
  assert.ok(periodicCorrections.length >= 2);
  assert.equal(weakDivergentSparseMugOwners.length, 0);
  assert.ok(maxSupportStep <= 8 + LIMIT_EPSILON);
  assert.ok(
    summary.maxFrameJump <= 16,
    `max frame jump should stay bounded, got ${summary.maxFrameJump.toFixed(2)}px`,
  );
  assert.ok(
    summary.maxAnchorError <= 50,
    `max anchor error should stay bounded, got ${summary.maxAnchorError.toFixed(2)}px`,
  );
  assert.ok(
    summary.meanAnchorError <= 32,
    `mean anchor error should stay bounded, got ${summary.meanAnchorError.toFixed(2)}px`,
  );
  assert.ok(
    summary.maxNormalError <= 1.22,
    `max normal error should stay bounded, got ${summary.maxNormalError.toFixed(3)}rad`,
  );
  assert.ok(
    headPose.maxRotationError <= 1.42,
    `head rotation should stay bounded, got ${headPose.maxRotationError.toFixed(3)}rad`,
  );
});
