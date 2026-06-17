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

export const BENCHMARK_BACKGROUND_VARIANTS = ['desk', 'shelf', 'busy', 'window', 'kitchen'];

export const BENCHMARK_OBJECT_CASES = [
  {
    id: 'planar-book',
    targetClass: 'book',
    geometry: 'planar',
    create: options => createPlanarBookSequence({ kind: 'planar-book', ...options }),
  },
  {
    id: 'dark-book',
    targetClass: 'book',
    geometry: 'planar-low-light',
    create: options => createPlanarBookSequence({ kind: 'dark-book', ...options }),
  },
  {
    id: 'depth-book',
    targetClass: 'book',
    geometry: 'planar-depth-texture',
    create: options => createPlanarBookSequence({ kind: 'depth-book', ...options }),
  },
  {
    id: 'glossy-phone',
    targetClass: 'cell phone',
    geometry: 'planar-glossy',
    create: options => createGlossyPhoneSequence(options),
  },
  {
    id: 'laminated-card',
    targetClass: 'card',
    geometry: 'planar-glossy',
    create: options => createLaminatedCardSequence(options),
  },
  {
    id: 'snack-pouch',
    targetClass: 'bag',
    geometry: 'deformable-planar',
    create: options => createSnackPouchSequence(options),
  },
  {
    id: 'cylindrical-can',
    targetClass: 'can',
    geometry: 'cylindrical',
    create: options => createCylindricalCanSequence(options),
  },
  {
    id: 'label-bottle',
    targetClass: 'bottle',
    geometry: 'curved-label',
    create: options => createLabelBottleSequence(options),
  },
  {
    id: 'textured-cup',
    targetClass: 'cup',
    geometry: 'tapered-cylinder',
    create: options => createTexturedCupSequence(options),
  },
  {
    id: 'handled-mug',
    targetClass: 'mug',
    geometry: 'handled-tapered-cylinder',
    create: options => createHandledMugSequence(options),
  },
  {
    id: 'textured-ball',
    targetClass: 'ball',
    geometry: 'ellipsoid',
    create: options => createTexturedBallSequence(options),
  },
  {
    id: 'rigid-box',
    targetClass: 'box',
    geometry: 'multi-plane',
    create: options => createRigidBoxSequence(options),
  },
];

const occlusionFramesFor = (frameCount, profile) => {
  if (profile === 'clean') return [];
  if (profile === 'early') return [5, 6, 7].filter(index => index < frameCount - 2);
  if (profile === 'late') return [frameCount - 10, frameCount - 9, frameCount - 8].filter(index => index > 1);
  if (profile === 'repeated') {
    const secondStart = Math.floor(frameCount * 0.62);
    return [6, 7, secondStart, secondStart + 1].filter(index => index > 1 && index < frameCount - 2);
  }
  return [
    Math.floor(frameCount * 0.42),
    Math.floor(frameCount * 0.42) + 1,
    Math.floor(frameCount * 0.42) + 2,
  ];
};

export const BENCHMARK_MOTION_PROFILES = [
  {
    id: 'standard-clean',
    motion: 'standard',
    frameCount: 32,
    occlusion: 'clean',
  },
  {
    id: 'fast-early-occlusion',
    motion: 'fast',
    frameCount: 22,
    occlusion: 'early',
  },
  {
    id: 'standard-mid-occlusion',
    motion: 'standard',
    frameCount: 34,
    occlusion: 'mid',
  },
  {
    id: 'slow-late-occlusion',
    motion: 'slow',
    frameCount: 44,
    occlusion: 'late',
  },
  {
    id: 'fast-repeated-occlusion',
    motion: 'fast',
    frameCount: 24,
    occlusion: 'repeated',
  },
];

const lightingForBackground = background => ({
  desk: 'soft-desk',
  shelf: 'horizontal-edge-clutter',
  busy: 'moving-high-frequency-clutter',
  window: 'high-contrast-backlight',
  kitchen: 'tiled-specular-clutter',
})[background];

const backgroundForRepresentativeCase = (objectIndex, profileIndex) => (
  BENCHMARK_BACKGROUND_VARIANTS[(objectIndex * 2 + profileIndex) % BENCHMARK_BACKGROUND_VARIANTS.length]
);

const createScenario = ({ objectCase, objectIndex, profile, profileIndex, background, seedOffset }) => {
  const occlusionFrames = occlusionFramesFor(profile.frameCount, profile.occlusion);
  const axes = {
    object: objectCase.id,
    targetClass: objectCase.targetClass,
    geometry: objectCase.geometry,
    background,
    lighting: lightingForBackground(background),
    motion: profile.motion,
    occlusion: profile.occlusion,
    frameCount: profile.frameCount,
    backgroundSeed: 2000 + objectIndex * 101 + profileIndex * 17 + seedOffset,
  };

  return {
    name: [
      axes.object,
      axes.background,
      axes.motion,
      axes.occlusion,
    ].join(' / '),
    axes,
    create: () => objectCase.create({
      frameCount: profile.frameCount,
      occlusionFrames,
      backgroundVariant: background,
      backgroundSeed: axes.backgroundSeed,
    }),
  };
};

export const createVisionBenchmarkMatrix = ({ size = 'representative' } = {}) => {
  const objectCases = size === 'quick'
    ? BENCHMARK_OBJECT_CASES.filter(objectCase => (
        objectCase.id === 'planar-book' ||
        objectCase.id === 'textured-cup' ||
        objectCase.id === 'handled-mug' ||
        objectCase.id === 'rigid-box'
      ))
    : BENCHMARK_OBJECT_CASES;
  const profiles = size === 'quick'
    ? BENCHMARK_MOTION_PROFILES.filter(profile => (
        profile.id === 'standard-clean' ||
        profile.id === 'fast-early-occlusion' ||
        profile.id === 'fast-repeated-occlusion'
      ))
    : BENCHMARK_MOTION_PROFILES;
  const scenarios = [];

  objectCases.forEach((objectCase, objectIndex) => {
    profiles.forEach((profile, profileIndex) => {
      const backgrounds = size === 'full'
        ? BENCHMARK_BACKGROUND_VARIANTS
        : [backgroundForRepresentativeCase(objectIndex, profileIndex)];
      backgrounds.forEach((background, backgroundIndex) => {
        scenarios.push(createScenario({
          objectCase,
          objectIndex,
          profile,
          profileIndex,
          background,
          seedOffset: backgroundIndex * 13,
        }));
      });
    });
  });

  return scenarios;
};
