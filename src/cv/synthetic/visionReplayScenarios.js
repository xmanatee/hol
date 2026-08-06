import {
  createCylindricalCanSequence,
  createGlossyPhoneSequence,
  createHandledMugSequence,
  createLabelBottleSequence,
  createLaminatedCardSequence,
  createPlanarBookSequence,
  createRigidBoxSequence,
  createSnackPouchSequence,
  createTexturedBallSequence,
  createTexturedCupSequence,
} from './visionFixtures.js';
import { applyCaptureCondition } from './captureDegradation.js';

const OPTIONAL_SPARSE_RECONSTRUCTION_QUALITY = {
  reconstruction: {
    minReadyFrameRatio: 0,
    minPoseInliers: 0,
    minMapConfidence: 0,
  },
};

const STRESS_REPLAY_LIMITS = {
  maxAnchorError: 90,
  meanAnchorError: 22,
  maxScaleError: 0.37,
  maxFrameJump: 18,
  maxRotationError: 1.5,
  maxWorldPositionError: 0.25,
  maxScaleLogError: 0.35,
  maxHeadJumpExcess: 0.12,
};

const CAPTURE_REPLAY_LIMITS = {
  maxAnchorError: 18,
  meanAnchorError: 8,
  maxScaleError: 0.2,
  maxFrameJump: 12,
  maxRotationError: 1.2,
  maxWorldPositionError: 0.09,
  maxScaleLogError: 0.2,
  maxHeadJumpExcess: 0.06,
};

export const defaultReplayScenarios = [
  {
    name: 'planar book on desk',
    create: () =>
      createPlanarBookSequence({
        kind: 'planar-book',
        frameCount: 32,
        occlusionFrames: [14, 15, 16, 17],
      }),
  },
  {
    name: 'dark book on desk',
    create: () =>
      createPlanarBookSequence({
        kind: 'dark-book',
        frameCount: 32,
        occlusionFrames: [14, 15, 16, 17],
      }),
  },
  {
    name: 'depth book on desk',
    create: () =>
      createPlanarBookSequence({
        kind: 'depth-book',
        frameCount: 36,
        occlusionFrames: [18, 19, 20],
      }),
  },
  {
    name: 'cylindrical can on desk',
    create: () =>
      createCylindricalCanSequence({
        frameCount: 30,
        occlusionFrames: [12, 13, 14],
      }),
  },
  {
    name: 'tapered cup on desk',
    create: () =>
      createTexturedCupSequence({
        frameCount: 32,
        occlusionFrames: [15, 16, 17],
      }),
  },
  {
    name: 'rigid box on desk',
    create: () =>
      createRigidBoxSequence({
        frameCount: 28,
        occlusionFrames: [10, 11, 12],
      }),
    qualityThresholdsByMode: {
      'parametric-surface': {
        reconstruction: {
          maxNormalError: 1.45,
        },
      },
    },
  },
];

export const realisticReplayScenarios = [
  {
    name: 'book cover with early occlusion on busy moving background',
    create: () =>
      createPlanarBookSequence({
        kind: 'planar-book',
        frameCount: 36,
        occlusionFrames: [9, 10, 24],
        backgroundVariant: 'busy',
        backgroundSeed: 71,
      }),
    limits: {
      maxAnchorError: 22,
      meanAnchorError: 10,
      maxScaleError: 0.12,
      maxFrameJump: 12,
      maxRotationError: 0.8,
      maxWorldPositionError: 0.16,
      maxScaleLogError: 0.15,
      maxHeadJumpExcess: 0.05,
    },
  },
  {
    name: 'dark book cover on shelf background',
    create: () =>
      createPlanarBookSequence({
        kind: 'dark-book',
        frameCount: 34,
        occlusionFrames: [8, 9, 22],
        backgroundVariant: 'shelf',
        backgroundSeed: 83,
      }),
    limits: {
      maxAnchorError: 16,
      meanAnchorError: 8.5,
      maxScaleError: 0.11,
      maxFrameJump: 10,
      maxRotationError: 0.55,
      maxWorldPositionError: 0.12,
      maxScaleLogError: 0.11,
      maxHeadJumpExcess: 0.055,
    },
  },
  {
    name: 'depth book with repeated occlusion on busy moving background',
    create: () =>
      createPlanarBookSequence({
        kind: 'depth-book',
        frameCount: 40,
        occlusionFrames: [8, 9, 27, 28],
        backgroundVariant: 'busy',
        backgroundSeed: 91,
      }),
    limits: {
      maxAnchorError: 32,
      meanAnchorError: 15,
      maxScaleError: 0.14,
      maxFrameJump: 12,
      maxRotationError: 1.2,
      maxWorldPositionError: 0.16,
      maxScaleLogError: 0.23,
      maxHeadJumpExcess: 0.055,
    },
  },
  {
    name: 'cylindrical can with repeated occlusion on shelf background',
    create: () =>
      createCylindricalCanSequence({
        frameCount: 34,
        occlusionFrames: [8, 9, 22],
        backgroundVariant: 'shelf',
        backgroundSeed: 101,
      }),
    limits: {
      maxAnchorError: 15,
      meanAnchorError: 6,
      maxScaleError: 0.17,
      maxFrameJump: 12,
      maxRotationError: 0.95,
      maxWorldPositionError: 0.11,
      maxScaleLogError: 0.18,
      maxHeadJumpExcess: 0.065,
    },
    limitsByMode: {
      'parametric-surface': {
        maxAnchorError: 15,
        meanAnchorError: 6,
        maxScaleError: 0.17,
        maxFrameJump: 12,
        maxRotationError: 1.1,
        maxWorldPositionError: 0.12,
        maxScaleLogError: 0.18,
        maxHeadJumpExcess: 0.065,
      },
      'direct-photometric': {
        maxAnchorError: 15,
        meanAnchorError: 6,
        maxScaleError: 0.17,
        maxFrameJump: 12,
        maxRotationError: 1.1,
        maxWorldPositionError: 0.12,
        maxScaleLogError: 0.18,
        maxHeadJumpExcess: 0.065,
      },
    },
  },
  {
    name: 'tapered cup with early repeated occlusion on busy moving background',
    create: () =>
      createTexturedCupSequence({
        frameCount: 36,
        occlusionFrames: [10, 11, 24],
        backgroundVariant: 'busy',
        backgroundSeed: 111,
      }),
    limits: {
      maxAnchorError: 22,
      meanAnchorError: 14,
      maxScaleError: 0.17,
      maxFrameJump: 12,
      maxRotationError: 1.35,
      maxWorldPositionError: 0.16,
      maxScaleLogError: 0.15,
      maxHeadJumpExcess: 0.08,
    },
    limitsByMode: {
      'sparse-reconstruction': {
        maxAnchorError: 25,
        meanAnchorError: 16,
        maxScaleError: 0.37,
        maxFrameJump: 12,
        maxRotationError: 1.35,
        maxWorldPositionError: 0.19,
        maxScaleLogError: 0.2,
        maxHeadJumpExcess: 0.08,
      },
      'parametric-surface': {
        maxAnchorError: 25,
        meanAnchorError: 14,
        maxScaleError: 0.27,
        maxFrameJump: 20,
        maxRotationError: 1.35,
        maxWorldPositionError: 0.19,
        maxScaleLogError: 0.22,
        maxHeadJumpExcess: 0.08,
      },
      'direct-photometric': {
        maxAnchorError: 72,
        meanAnchorError: 34,
        maxScaleError: 0.27,
        maxFrameJump: 12,
        maxRotationError: 1.35,
        maxWorldPositionError: 0.19,
        maxScaleLogError: 0.22,
        maxHeadJumpExcess: 0.08,
      },
      'depth-fusion': {
        maxAnchorError: 26,
        meanAnchorError: 14,
        maxScaleError: 0.17,
        maxFrameJump: 12,
        maxRotationError: 1.35,
        maxWorldPositionError: 0.19,
        maxScaleLogError: 0.2,
        maxHeadJumpExcess: 0.08,
      },
    },
  },
  {
    name: 'tapered cup with late occlusion on shelf background',
    create: () =>
      createTexturedCupSequence({
        frameCount: 28,
        occlusionFrames: [18, 19],
        backgroundVariant: 'shelf',
        backgroundSeed: 121,
      }),
    limits: {
      maxAnchorError: 27,
      meanAnchorError: 10,
      maxScaleError: 0.26,
      maxFrameJump: 12,
      maxRotationError: 1.15,
      maxWorldPositionError: 0.21,
      maxScaleLogError: 0.25,
      maxHeadJumpExcess: 0.07,
    },
    limitsByMode: {
      'sparse-reconstruction': {
        maxAnchorError: 32,
        meanAnchorError: 10,
        maxScaleError: 0.26,
        maxFrameJump: 12,
        maxRotationError: 1.15,
        maxWorldPositionError: 0.25,
        maxScaleLogError: 0.25,
        maxHeadJumpExcess: 0.07,
      },
      'parametric-surface': {
        maxAnchorError: 84,
        meanAnchorError: 19,
        maxScaleError: 0.26,
        maxFrameJump: 12,
        maxRotationError: 1.35,
        maxWorldPositionError: 0.23,
        maxScaleLogError: 0.25,
        maxHeadJumpExcess: 0.07,
      },
      'direct-photometric': {
        maxAnchorError: 84,
        meanAnchorError: 19,
        maxScaleError: 0.26,
        maxFrameJump: 12,
        maxRotationError: 1.15,
        maxWorldPositionError: 0.23,
        maxScaleLogError: 0.25,
        maxHeadJumpExcess: 0.07,
      },
    },
  },
  {
    name: 'glossy phone with glare near window background',
    rigidPlanarPoseOwner: true,
    create: () =>
      createGlossyPhoneSequence({
        frameCount: 24,
        occlusionFrames: [8, 17],
        backgroundVariant: 'window',
        backgroundSeed: 67,
      }),
    limits: {
      maxAnchorError: 21,
      meanAnchorError: 10,
      maxScaleError: 0.12,
      maxFrameJump: 12,
      maxRotationError: 1.15,
      maxWorldPositionError: 0.16,
      maxScaleLogError: 0.12,
      maxHeadJumpExcess: 0.065,
    },
    surfaceByMode: {
      'parametric-surface': 'plane',
      'direct-photometric': 'photometric-surfels',
    },
  },
  {
    name: 'label bottle on kitchen tile background',
    create: () =>
      createLabelBottleSequence({
        frameCount: 24,
        occlusionFrames: [7, 16],
        backgroundVariant: 'kitchen',
        backgroundSeed: 79,
      }),
    limits: {
      maxAnchorError: 30,
      meanAnchorError: 15,
      maxScaleError: 0.26,
      maxFrameJump: 12,
      maxRotationError: 1.22,
      maxWorldPositionError: 0.16,
      maxScaleLogError: 0.26,
      maxHeadJumpExcess: 0.04,
    },
    limitsByMode: {
      'parametric-surface': {
        maxAnchorError: 37,
        meanAnchorError: 16.5,
        maxScaleError: 0.26,
        maxFrameJump: 12,
        maxRotationError: 1.22,
        maxWorldPositionError: 0.18,
        maxScaleLogError: 0.26,
        maxHeadJumpExcess: 0.04,
      },
      'direct-photometric': {
        maxAnchorError: 45,
        meanAnchorError: 22,
        maxScaleError: 0.26,
        maxFrameJump: 12,
        maxRotationError: 1.22,
        maxWorldPositionError: 0.18,
        maxScaleLogError: 0.26,
        maxHeadJumpExcess: 0.04,
      },
    },
    minSelectedPoseFrames: 2,
    qualityThresholdsByMode: {
      'sparse-reconstruction': OPTIONAL_SPARSE_RECONSTRUCTION_QUALITY,
      'parametric-surface': {
        reconstruction: {
          maxNormalError: 1.3,
        },
      },
    },
    surfaceByMode: {
      'parametric-surface': 'cylinder',
      'direct-photometric': 'photometric-surfels',
    },
  },
  {
    name: 'crinkled snack pouch on busy moving background',
    create: () =>
      createSnackPouchSequence({
        frameCount: 24,
        occlusionFrames: [9, 18],
        backgroundVariant: 'busy',
        backgroundSeed: 97,
      }),
    limits: {
      maxAnchorError: 23,
      meanAnchorError: 10,
      maxScaleError: 0.12,
      maxFrameJump: 12,
      maxRotationError: 0.85,
      maxWorldPositionError: 0.18,
      maxScaleLogError: 0.12,
      maxHeadJumpExcess: 0.05,
    },
    surfaceByMode: {
      'parametric-surface': 'plane',
      'direct-photometric': 'photometric-surfels',
    },
  },
];

export const stressReplayScenarios = [
  {
    name: 'laminated card with glare on window background',
    create: () =>
      createLaminatedCardSequence({
        frameCount: 24,
        occlusionFrames: [8, 17],
        backgroundVariant: 'window',
        backgroundSeed: 109,
      }),
    limits: STRESS_REPLAY_LIMITS,
    qualityThresholdsByMode: {
      'sparse-reconstruction': OPTIONAL_SPARSE_RECONSTRUCTION_QUALITY,
    },
  },
  {
    name: 'handled mug on kitchen tile background',
    create: () =>
      createHandledMugSequence({
        frameCount: 24,
        occlusionFrames: [8, 17],
        backgroundVariant: 'kitchen',
        backgroundSeed: 137,
      }),
    limits: STRESS_REPLAY_LIMITS,
    qualityThresholdsByMode: {
      'sparse-reconstruction': OPTIONAL_SPARSE_RECONSTRUCTION_QUALITY,
    },
  },
  {
    name: 'textured ball on busy moving background',
    create: () =>
      createTexturedBallSequence({
        frameCount: 24,
        occlusionFrames: [8, 17],
        backgroundVariant: 'busy',
        backgroundSeed: 149,
      }),
    limits: STRESS_REPLAY_LIMITS,
    qualityThresholdsByMode: {
      'sparse-reconstruction': OPTIONAL_SPARSE_RECONSTRUCTION_QUALITY,
    },
  },
];

export const captureReplayScenarios = [
  {
    name: 'planar book under low-light sensor noise',
    captureCondition: 'low-light',
    create: () =>
      applyCaptureCondition(
        createPlanarBookSequence({
          kind: 'planar-book',
          frameCount: 28,
          occlusionFrames: [],
          backgroundVariant: 'shelf',
          backgroundSeed: 181,
        }),
        'low-light',
      ),
    limits: CAPTURE_REPLAY_LIMITS,
  },
  {
    name: 'glossy phone under fast linear motion blur',
    captureCondition: 'motion-blur',
    create: () =>
      applyCaptureCondition(
        createGlossyPhoneSequence({
          frameCount: 22,
          occlusionFrames: [],
          backgroundVariant: 'window',
          backgroundSeed: 191,
        }),
        'motion-blur',
      ),
    limits: CAPTURE_REPLAY_LIMITS,
  },
  {
    name: 'cylindrical can under horizontal rolling shutter',
    captureCondition: 'rolling-shutter',
    create: () =>
      applyCaptureCondition(
        createCylindricalCanSequence({
          frameCount: 24,
          occlusionFrames: [],
          backgroundVariant: 'busy',
          backgroundSeed: 211,
        }),
        'rolling-shutter',
      ),
    limits: CAPTURE_REPLAY_LIMITS,
  },
];

export const reportReplayScenarios = [
  ...defaultReplayScenarios,
  ...realisticReplayScenarios,
  ...stressReplayScenarios,
  ...captureReplayScenarios,
];
