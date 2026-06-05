export const STANDARD_VISEMES = {
  M: 'closed',
  A: 'open_wide',
  E: 'open_mid',
  I: 'open_narrow',
  O: 'open_round',
  U: 'pucker',
};

export const ARKIT_52_BLENDSHAPES = [
  'eyeBlinkLeft',
  'eyeLookDownLeft',
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeSquintLeft',
  'eyeWideLeft',
  'eyeBlinkRight',
  'eyeLookDownRight',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeSquintRight',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawRight',
  'jawOpen',
  'mouthClose',
  'mouthFunnel',
  'mouthPucker',
  'mouthRight',
  'mouthLeft',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut',
];

export const MEDIAPIPE_MODEL_CARD_52_BLENDSHAPES = [
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawOpen',
  'jawRight',
  'mouthClose',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthFunnel',
  'mouthLeft',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut',
];

export const HOL_BUNDLED_HEAD_52_BLENDSHAPES = Array.from({ length: 52 }, (_, index) => `target_${index}`);

export const HOL_BUNDLED_HEAD_NAME_TO_INDEX = {
  browInnerUp: 0,
  browDownRight: 1,
  browDownLeft: 2,
  browOuterUpRight: 3,
  browOuterUpLeft: 4,
  cheekSquintRight: 7,
  cheekSquintLeft: 8,
  eyeSquintRight: 7,
  eyeSquintLeft: 8,
  eyeBlinkRight: 13,
  eyeBlinkLeft: 14,
  eyeWideRight: 17,
  eyeWideLeft: 18,
  cheekPuff: 19,
  noseSneerRight: 22,
  noseSneerLeft: 23,
  jawOpen: 24,
  mouthClose: 25,
  mouthRight: 26,
  mouthLeft: 27,
  mouthFunnel: 28,
  mouthPucker: 29,
  mouthSmileRight: 30,
  mouthSmileLeft: 31,
  mouthRollLower: 32,
  mouthRollUpper: 35,
  mouthStretchRight: 37,
  mouthStretchLeft: 38,
  mouthFrownRight: 39,
  mouthFrownLeft: 40,
  mouthDimpleRight: 41,
  mouthDimpleLeft: 42,
  mouthUpperUpRight: 43,
  mouthUpperUpLeft: 44,
  mouthLowerDownRight: 45,
  mouthLowerDownLeft: 46,
  mouthPressRight: 47,
  mouthPressLeft: 48,
};

export const STANDARD_VISEME_WEIGHTS = {
  M: [
    ['mouthClose', 1],
    ['mouthPressLeft', 0.35],
    ['mouthPressRight', 0.35],
  ],
  A: [
    ['jawOpen', 1],
    ['mouthLowerDownLeft', 0.35],
    ['mouthLowerDownRight', 0.35],
    ['mouthUpperUpLeft', 0.18],
    ['mouthUpperUpRight', 0.18],
  ],
  E: [
    ['jawOpen', 0.25],
    ['mouthSmileLeft', 0.55],
    ['mouthSmileRight', 0.55],
    ['mouthStretchLeft', 0.35],
    ['mouthStretchRight', 0.35],
  ],
  I: [
    ['jawOpen', 0.12],
    ['mouthSmileLeft', 0.85],
    ['mouthSmileRight', 0.85],
    ['mouthStretchLeft', 0.55],
    ['mouthStretchRight', 0.55],
  ],
  O: [
    ['jawOpen', 0.45],
    ['mouthFunnel', 0.9],
    ['mouthPucker', 0.35],
  ],
  U: [
    ['jawOpen', 0.18],
    ['mouthFunnel', 0.55],
    ['mouthPucker', 1],
  ],
};

export const ARKIT_NAME_TO_INDEX = Object.fromEntries(
  ARKIT_52_BLENDSHAPES.map((name, index) => [name, index])
);

export const MEDIAPIPE_MODEL_CARD_NAME_TO_INDEX = Object.fromEntries(
  MEDIAPIPE_MODEL_CARD_52_BLENDSHAPES.map((name, index) => [name, index])
);

export const GENERIC_TARGET_ORDERS = {
  arkit: ARKIT_52_BLENDSHAPES,
  mediapipeModelCard: MEDIAPIPE_MODEL_CARD_52_BLENDSHAPES,
  holBundledHead: HOL_BUNDLED_HEAD_52_BLENDSHAPES,
};

export const GENERIC_TARGET_INDEX_MAPS = {
  arkit: ARKIT_NAME_TO_INDEX,
  mediapipeModelCard: MEDIAPIPE_MODEL_CARD_NAME_TO_INDEX,
  holBundledHead: HOL_BUNDLED_HEAD_NAME_TO_INDEX,
};

export const resolveGenericTargetOrder = (order = 'holBundledHead') => {
  const resolved = GENERIC_TARGET_ORDERS[order];
  if (!resolved) {
    throw new Error(`Unknown generic target order: ${order}`);
  }
  return resolved;
};

export const resolveGenericTargetIndexMap = (order = 'holBundledHead') => {
  const resolved = GENERIC_TARGET_INDEX_MAPS[order];
  if (!resolved) {
    throw new Error(`Unknown generic target order: ${order}`);
  }
  return resolved;
};

export const normalizeMorphName = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
