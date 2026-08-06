const clamp01 = (value) => Math.max(0, Math.min(1, value));

export const EXPRESSION_ALIASES = {
  bubbly: 'happy',
  cheerful: 'happy',
  sarcastic: 'sassy',
};

export const EXPRESSION_LAYER_WEIGHTS = {
  neutral: [],
  happy: [
    ['mouthSmileLeft', 0.34],
    ['mouthSmileRight', 0.34],
    ['cheekSquintLeft', 0.11],
    ['cheekSquintRight', 0.11],
    ['browInnerUp', 0.05],
  ],
  sassy: [
    ['mouthSmileRight', 0.36],
    ['mouthDimpleRight', 0.22],
    ['eyeSquintRight', 0.08],
    ['browOuterUpRight', 0.17],
    ['browDownLeft', 0.08],
  ],
  wise: [
    ['mouthSmileLeft', 0.12],
    ['mouthSmileRight', 0.12],
    ['browInnerUp', 0.13],
    ['browOuterUpLeft', 0.08],
    ['browOuterUpRight', 0.08],
    ['eyeSquintLeft', 0.05],
    ['eyeSquintRight', 0.05],
  ],
  gruff: [
    ['browDownLeft', 0.25],
    ['browDownRight', 0.25],
    ['eyeSquintLeft', 0.07],
    ['eyeSquintRight', 0.07],
    ['mouthPressLeft', 0.1],
    ['mouthPressRight', 0.1],
  ],
  dramatic: [
    ['browInnerUp', 0.24],
    ['browOuterUpLeft', 0.18],
    ['browOuterUpRight', 0.18],
    ['eyeWideLeft', 0.08],
    ['eyeWideRight', 0.08],
  ],
};

export const PERFORMANCE_PROFILES = {
  neutral: {
    restClosure: 0.72,
    jawScale: 1,
    verticalMouthScale: 1,
    horizontalMouthScale: 1,
    roundMouthScale: 1,
    blinkStrength: 0.92,
    blinkIntervalMinMs: 3000,
    blinkIntervalMaxMs: 6000,
    speechAccentWeights: [],
  },
  happy: {
    restClosure: 0.68,
    jawScale: 1.08,
    verticalMouthScale: 1.12,
    horizontalMouthScale: 1.18,
    roundMouthScale: 0.95,
    blinkStrength: 0.88,
    blinkIntervalMinMs: 2400,
    blinkIntervalMaxMs: 4700,
    speechAccentWeights: [
      ['cheekSquintLeft', 0.1],
      ['cheekSquintRight', 0.1],
      ['mouthSmileLeft', 0.08],
      ['mouthSmileRight', 0.08],
    ],
  },
  sassy: {
    restClosure: 0.7,
    jawScale: 0.95,
    verticalMouthScale: 1,
    horizontalMouthScale: 1.16,
    roundMouthScale: 0.88,
    blinkStrength: 0.86,
    blinkIntervalMinMs: 2200,
    blinkIntervalMaxMs: 4300,
    speechAccentWeights: [
      ['eyeSquintRight', 0.08],
      ['mouthDimpleRight', 0.1],
      ['browOuterUpRight', 0.06],
    ],
  },
  wise: {
    restClosure: 0.76,
    jawScale: 0.56,
    verticalMouthScale: 0.72,
    horizontalMouthScale: 0.82,
    roundMouthScale: 0.76,
    blinkStrength: 0.94,
    blinkIntervalMinMs: 3600,
    blinkIntervalMaxMs: 7200,
    speechAccentWeights: [['browInnerUp', 0.05]],
  },
  gruff: {
    restClosure: 0.82,
    jawScale: 0.66,
    verticalMouthScale: 0.76,
    horizontalMouthScale: 0.78,
    roundMouthScale: 0.72,
    blinkStrength: 0.9,
    blinkIntervalMinMs: 3900,
    blinkIntervalMaxMs: 7600,
    speechAccentWeights: [
      ['browDownLeft', 0.06],
      ['browDownRight', 0.06],
      ['mouthPressLeft', 0.07],
      ['mouthPressRight', 0.07],
    ],
  },
  dramatic: {
    restClosure: 0.64,
    jawScale: 1.36,
    verticalMouthScale: 1.32,
    horizontalMouthScale: 1.1,
    roundMouthScale: 1.24,
    blinkStrength: 1,
    blinkIntervalMinMs: 1900,
    blinkIntervalMaxMs: 3900,
    speechAccentWeights: [
      ['browInnerUp', 0.12],
      ['eyeWideLeft', 0.1],
      ['eyeWideRight', 0.1],
    ],
  },
};

export const REST_MOUTH_WEIGHTS = [
  ['mouthClose', 1],
  ['mouthPressLeft', 0.13],
  ['mouthPressRight', 0.13],
  ['mouthShrugUpper', 0.05],
];

const VERTICAL_MOUTH_BLENDSHAPES = new Set([
  'jawOpen',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
]);

const HORIZONTAL_MOUTH_BLENDSHAPES = new Set([
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
]);

const ROUND_MOUTH_BLENDSHAPES = new Set(['mouthFunnel', 'mouthPucker']);

export const resolveFacialExpression = (expression) => {
  const resolved = EXPRESSION_ALIASES[expression] || expression;
  if (!Object.hasOwn(EXPRESSION_LAYER_WEIGHTS, resolved)) {
    throw new Error(`Unknown facial expression: ${expression}`);
  }
  return resolved;
};

export const getExpressionLayerWeights = (expression) => {
  return EXPRESSION_LAYER_WEIGHTS[resolveFacialExpression(expression)];
};

export const getPerformanceProfile = (expression) => {
  return PERFORMANCE_PROFILES[resolveFacialExpression(expression)];
};

export const performanceGain = (intensity) => 0.85 + clamp01(intensity) * 0.75;

export const speechGain = (intensity) => 1 + clamp01(intensity) * 0.75;

export const speechEnvelope = (energy) => Math.pow(clamp01(energy), 0.72);

export const getSpeechBlendShapeScale = (blendShapeName, profile) => {
  if (blendShapeName === 'jawOpen') {
    return profile.jawScale;
  }
  if (VERTICAL_MOUTH_BLENDSHAPES.has(blendShapeName)) {
    return profile.verticalMouthScale;
  }
  if (HORIZONTAL_MOUTH_BLENDSHAPES.has(blendShapeName)) {
    return profile.horizontalMouthScale;
  }
  if (ROUND_MOUTH_BLENDSHAPES.has(blendShapeName)) {
    return profile.roundMouthScale;
  }
  return 1;
};
