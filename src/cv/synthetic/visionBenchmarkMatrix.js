import {
  createCylindricalCanSequence,
  createGlossyCanSequence,
  createGlossyPhoneSequence,
  createHandledMugSequence,
  createHumanSilhouetteSequence,
  createLabelBottleSequence,
  createLaminatedCardSequence,
  createPlanarBookSequence,
  createRigidBoxSequence,
  createSnackPouchSequence,
  createTexturedBallSequence,
  createTexturedCupSequence,
} from './visionFixtures.js';
import { applyCaptureCondition } from './captureDegradation.js';
import { HARD_BENCHMARK_CASES } from './visionHardBenchmarkCases.js';

export const BENCHMARK_BACKGROUND_VARIANTS = ['desk', 'shelf', 'busy', 'window', 'kitchen'];
const BENCHMARK_SIZES = new Set(['quick', 'representative', 'full', 'hard']);

export const BENCHMARK_OBJECT_CASES = [
  {
    id: 'planar-book',
    targetClass: 'book',
    geometry: 'planar',
    create: (options) => createPlanarBookSequence({ kind: 'planar-book', ...options }),
  },
  {
    id: 'dark-book',
    targetClass: 'book',
    geometry: 'planar-low-light',
    create: (options) => createPlanarBookSequence({ kind: 'dark-book', ...options }),
  },
  {
    id: 'depth-book',
    targetClass: 'book',
    geometry: 'planar-depth-texture',
    create: (options) => createPlanarBookSequence({ kind: 'depth-book', ...options }),
  },
  {
    id: 'glossy-phone',
    targetClass: 'cell phone',
    geometry: 'planar-glossy',
    create: (options) => createGlossyPhoneSequence(options),
  },
  {
    id: 'laminated-card',
    targetClass: 'card',
    geometry: 'planar-glossy',
    create: (options) => createLaminatedCardSequence(options),
  },
  {
    id: 'snack-pouch',
    targetClass: 'bag',
    geometry: 'deformable-planar',
    create: (options) => createSnackPouchSequence(options),
  },
  {
    id: 'cylindrical-can',
    targetClass: 'can',
    geometry: 'cylindrical',
    create: (options) => createCylindricalCanSequence(options),
  },
  {
    id: 'glossy-can',
    targetClass: 'can',
    geometry: 'cylindrical-specular',
    create: (options) => createGlossyCanSequence(options),
  },
  {
    id: 'label-bottle',
    targetClass: 'bottle',
    geometry: 'curved-label',
    create: (options) => createLabelBottleSequence(options),
  },
  {
    id: 'textured-cup',
    targetClass: 'cup',
    geometry: 'tapered-cylinder',
    create: (options) => createTexturedCupSequence(options),
  },
  {
    id: 'handled-mug',
    targetClass: 'mug',
    geometry: 'handled-tapered-cylinder',
    create: (options) => createHandledMugSequence(options),
  },
  {
    id: 'textured-ball',
    targetClass: 'ball',
    geometry: 'ellipsoid',
    create: (options) => createTexturedBallSequence(options),
  },
  {
    id: 'rigid-box',
    targetClass: 'box',
    geometry: 'multi-plane',
    create: (options) => createRigidBoxSequence(options),
  },
  {
    id: 'generic-free-tap-can',
    targetClass: 'generic-object',
    targetClassOverride: 'generic-object',
    geometry: 'cylindrical-free-tap',
    create: (options) => createCylindricalCanSequence(options),
  },
  {
    id: 'human-silhouette',
    targetClass: 'person',
    geometry: 'non-convex-human',
    create: (options) => createHumanSilhouetteSequence(options),
  },
];

const occlusionFramesFor = (frameCount, profile) => {
  if (profile === 'clean') return [];
  if (profile === 'early') return [5, 6, 7].filter((index) => index < frameCount - 2);
  if (profile === 'late')
    return [frameCount - 10, frameCount - 9, frameCount - 8].filter((index) => index > 1);
  if (profile === 'repeated') {
    const secondStart = Math.floor(frameCount * 0.62);
    return [6, 7, secondStart, secondStart + 1].filter((index) => index > 1 && index < frameCount - 2);
  }
  return [
    Math.floor(frameCount * 0.42),
    Math.floor(frameCount * 0.42) + 1,
    Math.floor(frameCount * 0.42) + 2,
  ];
};

export const BENCHMARK_MOTION_VARIANTS = [
  {
    motion: 'standard',
    frameCount: 34,
  },
  {
    motion: 'fast',
    frameCount: 24,
  },
  {
    motion: 'slow',
    frameCount: 44,
  },
];

export const BENCHMARK_OCCLUSION_PROFILES = [
  { id: 'clean' },
  { id: 'early' },
  { id: 'mid' },
  { id: 'late' },
  { id: 'repeated' },
];

const QUICK_OCCLUSION_PROFILES = [{ id: 'clean' }, { id: 'early' }, { id: 'repeated' }];

const QUICK_MOTION_BY_OBJECT = {
  'planar-book': {
    clean: 'fast',
    early: 'standard',
    repeated: 'slow',
  },
  'glossy-can': {
    clean: 'standard',
    early: 'fast',
    repeated: 'slow',
  },
  'textured-cup': {
    clean: 'slow',
    early: 'fast',
    repeated: 'fast',
  },
  'handled-mug': {
    clean: 'standard',
    early: 'slow',
    repeated: 'fast',
  },
  'rigid-box': {
    clean: 'slow',
    early: 'fast',
    repeated: 'standard',
  },
  'generic-free-tap-can': {
    clean: 'standard',
    early: 'fast',
    repeated: 'slow',
  },
  'human-silhouette': {
    clean: 'slow',
    early: 'standard',
    repeated: 'standard',
  },
};

const lightingForBackground = (background) =>
  ({
    desk: 'soft-desk',
    shelf: 'horizontal-edge-clutter',
    busy: 'moving-high-frequency-clutter',
    window: 'high-contrast-backlight',
    kitchen: 'tiled-specular-clutter',
  })[background];

const backgroundForRepresentativeCase = (objectIndex, profileIndex) =>
  BENCHMARK_BACKGROUND_VARIANTS[(objectIndex * 2 + profileIndex) % BENCHMARK_BACKGROUND_VARIANTS.length];

const backgroundVariantIndex = (background) => BENCHMARK_BACKGROUND_VARIANTS.indexOf(background);

const motionVariantFor = (motion) => {
  const variant = BENCHMARK_MOTION_VARIANTS.find((item) => item.motion === motion);
  if (!variant) {
    throw new Error(`Unknown benchmark motion: ${motion}`);
  }
  return variant;
};

const frameCountForCondition = ({ motion, occlusion }) => {
  if (motion === 'fast' && occlusion === 'early') return 22;
  if (motion === 'standard' && occlusion === 'clean') return 32;
  return motionVariantFor(motion).frameCount;
};

const occlusionProfileIndex = (occlusion) => {
  const index = BENCHMARK_OCCLUSION_PROFILES.findIndex((profile) => profile.id === occlusion);
  return index === -1 ? BENCHMARK_OCCLUSION_PROFILES.length : index;
};

const backgroundSeedFor = ({ objectCase, background, occlusion }) =>
  2000 +
  BENCHMARK_OBJECT_CASES.indexOf(objectCase) * 101 +
  occlusionProfileIndex(occlusion) * 17 +
  backgroundVariantIndex(background) * 13;

const selectBalancedMotion = ({ objectIndex, occlusionIndex, backgroundIndex }) =>
  BENCHMARK_MOTION_VARIANTS[
    (objectIndex + occlusionIndex + backgroundIndex + 2) % BENCHMARK_MOTION_VARIANTS.length
  ];

const createScenario = ({
  objectCase,
  condition,
  background,
  capture = 'nominal',
  event = 'continuous',
  sequenceFactory = null,
  replayOptions = null,
}) => {
  const motion = condition.motion;
  const occlusion = condition.occlusion;
  const frameCount = condition.frameCount;
  const occlusionFrames = occlusionFramesFor(frameCount, occlusion);
  const axes = {
    object: objectCase.id,
    targetClass: objectCase.targetClass,
    targetClassOverride: objectCase.targetClassOverride || null,
    geometry: objectCase.geometry,
    background,
    lighting: lightingForBackground(background),
    motion,
    occlusion,
    condition: `${motion}-${occlusion}`,
    capture,
    event,
    frameCount,
    backgroundSeed: backgroundSeedFor({ objectCase, background, occlusion }),
  };

  return {
    name: [
      axes.object,
      axes.background,
      axes.motion,
      axes.occlusion,
      ...(capture === 'nominal' ? [] : [capture]),
    ].join(' / '),
    axes,
    create: () => {
      const sequence = (sequenceFactory || objectCase.create)({
        frameCount,
        occlusionFrames,
        backgroundVariant: background,
        backgroundSeed: axes.backgroundSeed,
      });
      return capture === 'nominal' ? sequence : applyCaptureCondition(sequence, capture);
    },
    targetClassOverride: objectCase.targetClassOverride || null,
    replayOptions: replayOptions || {
      refreshObjectSupportMask: true,
      suppressDepthWhenTargetAbsent: false,
    },
  };
};

export const createVisionBenchmarkMatrix = ({ size = 'representative' } = {}) => {
  if (!BENCHMARK_SIZES.has(size)) {
    throw new Error(`Unknown vision benchmark size: ${size}`);
  }
  if (size === 'hard') {
    return HARD_BENCHMARK_CASES.map((hardCase) => {
      const objectCase = BENCHMARK_OBJECT_CASES.find((candidate) => candidate.id === hardCase.object);
      return createScenario({
        objectCase,
        condition: {
          motion: hardCase.motion,
          frameCount: hardCase.frameCount || frameCountForCondition(hardCase),
          occlusion: hardCase.occlusion,
        },
        background: hardCase.background,
        capture: hardCase.capture,
        event: hardCase.event,
        sequenceFactory: hardCase.create,
        replayOptions: hardCase.replayOptions,
      });
    });
  }

  const objectCases =
    size === 'quick'
      ? BENCHMARK_OBJECT_CASES.filter(
          (objectCase) =>
            objectCase.id === 'planar-book' ||
            objectCase.id === 'generic-free-tap-can' ||
            objectCase.id === 'glossy-can' ||
            objectCase.id === 'textured-cup' ||
            objectCase.id === 'human-silhouette' ||
            objectCase.id === 'handled-mug' ||
            objectCase.id === 'rigid-box',
        )
      : BENCHMARK_OBJECT_CASES;
  const scenarios = [];

  objectCases.forEach((objectCase, objectIndex) => {
    if (size === 'quick') {
      QUICK_OCCLUSION_PROFILES.forEach((profile, conditionIndex) => {
        const motionName = QUICK_MOTION_BY_OBJECT[objectCase.id]?.[profile.id];
        const motion = motionVariantFor(motionName);
        const background = backgroundForRepresentativeCase(objectIndex, conditionIndex);
        scenarios.push(
          createScenario({
            objectCase,
            condition: {
              motion: motion.motion,
              frameCount: frameCountForCondition({
                motion: motion.motion,
                occlusion: profile.id,
              }),
              occlusion: profile.id,
            },
            background,
          }),
        );
      });
      return;
    }

    BENCHMARK_OCCLUSION_PROFILES.forEach((occlusionProfile, occlusionIndex) => {
      const backgrounds =
        size === 'full'
          ? BENCHMARK_BACKGROUND_VARIANTS
          : [backgroundForRepresentativeCase(objectIndex, occlusionIndex)];
      backgrounds.forEach((background, backgroundIndex) => {
        const motion = selectBalancedMotion({ objectIndex, occlusionIndex, backgroundIndex });
        scenarios.push(
          createScenario({
            objectCase,
            condition: {
              motion: motion.motion,
              frameCount: frameCountForCondition({
                motion: motion.motion,
                occlusion: occlusionProfile.id,
              }),
              occlusion: occlusionProfile.id,
            },
            background,
          }),
        );
      });
    });
  });

  return scenarios;
};
