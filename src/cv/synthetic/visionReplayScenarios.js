import {
  createCylindricalCanSequence,
  createPlanarBookSequence,
  createRigidBoxSequence,
  createTexturedCupSequence,
} from './visionFixtures.js';

export const defaultReplayScenarios = [
  {
    name: 'planar book on desk',
    create: () => createPlanarBookSequence({
      kind: 'planar-book',
      frameCount: 32,
      occlusionFrames: [14, 15, 16, 17],
    }),
  },
  {
    name: 'dark book on desk',
    create: () => createPlanarBookSequence({
      kind: 'dark-book',
      frameCount: 32,
      occlusionFrames: [14, 15, 16, 17],
    }),
  },
  {
    name: 'depth book on desk',
    create: () => createPlanarBookSequence({
      kind: 'depth-book',
      frameCount: 36,
      occlusionFrames: [18, 19, 20],
    }),
  },
  {
    name: 'cylindrical can on desk',
    create: () => createCylindricalCanSequence({
      frameCount: 30,
      occlusionFrames: [12, 13, 14],
    }),
  },
  {
    name: 'tapered cup on desk',
    create: () => createTexturedCupSequence({
      frameCount: 32,
      occlusionFrames: [15, 16, 17],
    }),
  },
  {
    name: 'rigid box on desk',
    create: () => createRigidBoxSequence({
      frameCount: 28,
      occlusionFrames: [10, 11, 12],
    }),
  },
];

export const realisticReplayScenarios = [
  {
    name: 'book cover with early occlusion on busy moving background',
    create: () => createPlanarBookSequence({
      kind: 'planar-book',
      frameCount: 36,
      occlusionFrames: [9, 10, 24],
      backgroundVariant: 'busy',
      backgroundSeed: 71,
    }),
    limits: {
      maxAnchorError: 22,
      meanAnchorError: 10,
      maxFrameJump: 12,
      maxRotationError: 0.8,
      maxWorldPositionError: 0.16,
      maxScaleLogError: 0.15,
      maxHeadJumpExcess: 0.05,
    },
  },
  {
    name: 'dark book cover on shelf background',
    create: () => createPlanarBookSequence({
      kind: 'dark-book',
      frameCount: 34,
      occlusionFrames: [8, 9, 22],
      backgroundVariant: 'shelf',
      backgroundSeed: 83,
    }),
    limits: {
      maxAnchorError: 16,
      meanAnchorError: 8.5,
      maxFrameJump: 10,
      maxRotationError: 0.55,
      maxWorldPositionError: 0.12,
      maxScaleLogError: 0.11,
      maxHeadJumpExcess: 0.055,
    },
  },
  {
    name: 'depth book with repeated occlusion on busy moving background',
    create: () => createPlanarBookSequence({
      kind: 'depth-book',
      frameCount: 40,
      occlusionFrames: [8, 9, 27, 28],
      backgroundVariant: 'busy',
      backgroundSeed: 91,
    }),
    limits: {
      maxAnchorError: 21,
      meanAnchorError: 10,
      maxFrameJump: 12,
      maxRotationError: 1.2,
      maxWorldPositionError: 0.16,
      maxScaleLogError: 0.23,
      maxHeadJumpExcess: 0.055,
    },
  },
  {
    name: 'cylindrical can with repeated occlusion on shelf background',
    create: () => createCylindricalCanSequence({
      frameCount: 34,
      occlusionFrames: [8, 9, 22],
      backgroundVariant: 'shelf',
      backgroundSeed: 101,
    }),
    limits: {
      maxAnchorError: 15,
      meanAnchorError: 6,
      maxFrameJump: 12,
      maxRotationError: 0.95,
      maxWorldPositionError: 0.11,
      maxScaleLogError: 0.18,
      maxHeadJumpExcess: 0.065,
    },
  },
  {
    name: 'tapered cup with early repeated occlusion on busy moving background',
    create: () => createTexturedCupSequence({
      frameCount: 36,
      occlusionFrames: [10, 11, 24],
      backgroundVariant: 'busy',
      backgroundSeed: 111,
    }),
    limits: {
      maxAnchorError: 22,
      meanAnchorError: 14,
      maxFrameJump: 12,
      maxRotationError: 1.35,
      maxWorldPositionError: 0.16,
      maxScaleLogError: 0.15,
      maxHeadJumpExcess: 0.08,
    },
  },
  {
    name: 'tapered cup with late occlusion on shelf background',
    create: () => createTexturedCupSequence({
      frameCount: 28,
      occlusionFrames: [18, 19],
      backgroundVariant: 'shelf',
      backgroundSeed: 121,
    }),
    limits: {
      maxAnchorError: 27,
      meanAnchorError: 10,
      maxFrameJump: 12,
      maxRotationError: 1.12,
      maxWorldPositionError: 0.21,
      maxScaleLogError: 0.25,
      maxHeadJumpExcess: 0.07,
    },
  },
];

export const reportReplayScenarios = [
  ...defaultReplayScenarios,
  ...realisticReplayScenarios,
];
