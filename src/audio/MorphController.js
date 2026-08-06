import {
  REST_MOUTH_WEIGHTS,
  getExpressionLayerWeights,
  getPerformanceProfile,
  getSpeechBlendShapeScale,
  performanceGain,
  resolveFacialExpression,
  speechEnvelope,
  speechGain,
} from './facialPerformance.js';

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const BILATERAL_MOUTH_BLENDSHAPE_PAIRS = [
  ['mouthSmileLeft', 'mouthSmileRight'],
  ['mouthDimpleLeft', 'mouthDimpleRight'],
  ['mouthFrownLeft', 'mouthFrownRight'],
  ['mouthStretchLeft', 'mouthStretchRight'],
  ['mouthPressLeft', 'mouthPressRight'],
  ['mouthLowerDownLeft', 'mouthLowerDownRight'],
  ['mouthUpperUpLeft', 'mouthUpperUpRight'],
];
const BLINK_NAME_PATTERNS = ['blink', 'eyelid', 'eye_close', 'eyes_close'];

export class MorphController {
  constructor(mesh, visemeMapper) {
    if (!mesh?.morphTargetDictionary || !Array.isArray(mesh.morphTargetInfluences)) {
      throw new TypeError('MorphController requires a mesh with morph targets.');
    }
    if (!visemeMapper) {
      throw new TypeError('MorphController requires a viseme mapper.');
    }
    this.mesh = mesh;
    this.visemeMapper = visemeMapper;
    this.targetCount = mesh.morphTargetInfluences.length;
    this.currentInfluences = new Array(this.targetCount).fill(0);
    this.targetInfluences = new Array(this.targetCount).fill(0);
    this.expressionInfluences = new Array(this.targetCount).fill(0);
    this.blendShapeIndexCache = new Map();
    this.bilateralMouthTargetPairs = [];
    this.blinkTargetIndices = [];
    this.restTargets = [];
    this.speechAccentTargets = [];
    this.maxInfluence = 1.0;
    this.performanceIntensity = 0.65;
    this.activeExpression = 'neutral';
    this.expressionIntensity = 1;
    this.expressionProfile = getPerformanceProfile(this.activeExpression);
    this.blinkTimer = 0;
    this.nextBlinkTime = this.getRandomBlinkTime();
    this.isBlinking = false;
    this.blinkDuration = 200;

    this.initializeInfluences();
    this.initializeStaticTargets();
    this.rebuildProfileTargets();
  }

  initializeInfluences() {
    for (let i = 0; i < this.targetCount; i++) {
      this.mesh.morphTargetInfluences[i] = 0;
    }
  }

  resolveBlendShapeIndex(blendShapeName) {
    if (this.blendShapeIndexCache.has(blendShapeName)) {
      return this.blendShapeIndexCache.get(blendShapeName);
    }
    const mapperIndex = this.visemeMapper.resolveBlendShapeIndex(blendShapeName);
    const resolvedIndex = Number.isInteger(mapperIndex) ? mapperIndex : null;
    this.blendShapeIndexCache.set(blendShapeName, resolvedIndex);
    return resolvedIndex;
  }

  initializeStaticTargets() {
    for (const [leftBlendShape, rightBlendShape] of BILATERAL_MOUTH_BLENDSHAPE_PAIRS) {
      const leftIndex = this.resolveBlendShapeIndex(leftBlendShape);
      const rightIndex = this.resolveBlendShapeIndex(rightBlendShape);
      if (Number.isInteger(leftIndex) && Number.isInteger(rightIndex)) {
        this.bilateralMouthTargetPairs.push([leftIndex, rightIndex]);
      }
    }

    const blinkTargetIndices = new Set([
      this.resolveBlendShapeIndex('eyeBlinkLeft'),
      this.resolveBlendShapeIndex('eyeBlinkRight'),
    ]);
    for (const [morphName, index] of Object.entries(this.mesh.morphTargetDictionary)) {
      const lowerName = morphName.toLowerCase();
      if (BLINK_NAME_PATTERNS.some((pattern) => lowerName.includes(pattern))) {
        blinkTargetIndices.add(index);
      }
    }
    blinkTargetIndices.delete(null);
    this.blinkTargetIndices = Array.from(blinkTargetIndices);
  }

  rebuildProfileTargets() {
    this.restTargets = [];
    for (const [blendShapeName, weight] of REST_MOUTH_WEIGHTS) {
      const index = this.resolveBlendShapeIndex(blendShapeName);
      if (Number.isInteger(index)) {
        this.restTargets.push([index, clamp01(weight * this.expressionProfile.restClosure)]);
      }
    }

    this.speechAccentTargets = [];
    for (const [blendShapeName, weight] of this.expressionProfile.speechAccentWeights) {
      const index = this.resolveBlendShapeIndex(blendShapeName);
      if (Number.isInteger(index)) {
        this.speechAccentTargets.push([index, weight]);
      }
    }
  }

  applyExpressionTargets() {
    for (let index = 0; index < this.targetCount; index++) {
      this.targetInfluences[index] = this.expressionInfluences[index];
    }
  }

  rebuildExpressionInfluences() {
    this.expressionInfluences.fill(0);

    const weights = getExpressionLayerWeights(this.activeExpression);
    const expressionGain = performanceGain(this.performanceIntensity);
    for (const [blendShapeName, weight] of weights) {
      const index = this.resolveBlendShapeIndex(blendShapeName);
      if (Number.isInteger(index)) {
        this.expressionInfluences[index] = clamp01(weight * this.expressionIntensity * expressionGain);
      }
    }

    this.applyExpressionTargets();
  }

  setPerformanceIntensity(intensity = 0.65) {
    this.performanceIntensity = clamp01(intensity);
    this.rebuildExpressionInfluences();
  }

  setExpression(expression, intensity = 1.0) {
    this.activeExpression = resolveFacialExpression(expression);
    this.expressionProfile = getPerformanceProfile(this.activeExpression);
    this.expressionIntensity = clamp01(intensity);
    this.rebuildProfileTargets();
    this.rebuildExpressionInfluences();
  }

  setRestPose() {
    this.applyExpressionTargets();
    for (let targetIndex = 0; targetIndex < this.restTargets.length; targetIndex++) {
      const target = this.restTargets[targetIndex];
      const index = target[0];
      this.targetInfluences[index] = Math.max(this.targetInfluences[index], target[1]);
    }
  }

  getMorphBlendShapeName(morph) {
    if (morph.blendShapeName) {
      return morph.blendShapeName;
    }

    return this.visemeMapper.getBlendShapeNameForMorph(morph.name);
  }

  applySpeechAccent(envelope) {
    const accentGain = envelope * (0.6 + this.performanceIntensity * 0.4);
    for (let targetIndex = 0; targetIndex < this.speechAccentTargets.length; targetIndex++) {
      const target = this.speechAccentTargets[targetIndex];
      const index = target[0];
      this.targetInfluences[index] = Math.max(this.targetInfluences[index], clamp01(target[1] * accentGain));
    }
  }

  setSpeechFrame(viseme, energy, voiceActive) {
    if (!voiceActive || energy <= 0) {
      this.setRestPose();
      return;
    }

    this.applyExpressionTargets();

    const morphs = this.visemeMapper.getMorphIndicesForViseme(viseme);
    const envelope = speechEnvelope(energy);
    const voiceGain = speechGain(this.performanceIntensity);
    for (let morphIndex = 0; morphIndex < morphs.length; morphIndex++) {
      const morph = morphs[morphIndex];
      const blendShapeName = this.getMorphBlendShapeName(morph);
      const shapeScale = getSpeechBlendShapeScale(blendShapeName, this.expressionProfile);
      const visemeInfluence = Math.min(
        this.maxInfluence,
        clamp01(envelope * morph.weight * voiceGain * shapeScale),
      );
      this.targetInfluences[morph.index] = Math.max(this.targetInfluences[morph.index], visemeInfluence);
    }

    this.applySpeechAccent(envelope);
  }

  getRandomBlinkTime() {
    const spread = this.expressionProfile.blinkIntervalMaxMs - this.expressionProfile.blinkIntervalMinMs;
    return this.expressionProfile.blinkIntervalMinMs + Math.random() * spread;
  }

  updateBlink(deltaTimeMs) {
    this.blinkTimer += deltaTimeMs;

    if (!this.isBlinking && this.blinkTimer >= this.nextBlinkTime) {
      this.isBlinking = true;
      this.blinkTimer = 0;
      this.nextBlinkTime = this.getRandomBlinkTime();
    }

    if (this.isBlinking) {
      const blinkProgress = this.blinkTimer / this.blinkDuration;

      if (blinkProgress >= 1.0) {
        this.isBlinking = false;
        this.setBlinkInfluence(0);
      } else {
        const blinkValue = this._naturalBlinkValue(blinkProgress) * this.expressionProfile.blinkStrength;

        this.setBlinkInfluence(blinkValue);
      }
    }
  }

  _naturalBlinkValue(progress) {
    if (progress < 0.28) {
      const closeProgress = progress / 0.28;
      return 1 - Math.pow(1 - closeProgress, 3);
    }
    if (progress < 0.38) {
      return 1;
    }
    const openProgress = (progress - 0.38) / 0.62;
    return Math.pow(1 - openProgress, 2.4);
  }

  setBlinkInfluence(value) {
    for (let targetIndex = 0; targetIndex < this.blinkTargetIndices.length; targetIndex++) {
      const index = this.blinkTargetIndices[targetIndex];
      this.targetInfluences[index] = value;
    }
  }

  balanceBilateralMouthTargets() {
    for (let pairIndex = 0; pairIndex < this.bilateralMouthTargetPairs.length; pairIndex++) {
      const pair = this.bilateralMouthTargetPairs[pairIndex];
      const leftIndex = pair[0];
      const rightIndex = pair[1];
      const balanced = Math.max(this.targetInfluences[leftIndex], this.targetInfluences[rightIndex]);
      this.targetInfluences[leftIndex] = balanced;
      this.targetInfluences[rightIndex] = balanced;
    }
  }

  update(deltaTimeMs) {
    this.updateBlink(deltaTimeMs);
    this.balanceBilateralMouthTargets();

    const attackBlend = 1 - Math.exp(-deltaTimeMs / 16);
    const releaseBlend = 1 - Math.exp(-deltaTimeMs / 80);
    for (let index = 0; index < this.targetCount; index++) {
      const target = this.targetInfluences[index];
      const current = this.currentInfluences[index];
      const blend = target > current ? attackBlend : releaseBlend;
      const blended = current + blend * (target - current);

      this.currentInfluences[index] = blended;
      this.mesh.morphTargetInfluences[index] = blended;
    }
  }
}
