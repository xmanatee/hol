import { logger } from '../utils/logger.js';
import {
  getExpressionLayerWeights,
  getPerformanceProfile,
  getRestMouthWeights,
  getSpeechBlendShapeScale,
  performanceGain,
  resolveFacialExpression,
  speechEnvelope,
  speechGain,
} from './facialPerformance.js';
import {
  normalizeMorphName,
} from './facialRig.js';

const clamp01 = value => Math.max(0, Math.min(1, value));

const BILATERAL_MOUTH_BLENDSHAPE_PAIRS = [
  ['mouthSmileLeft', 'mouthSmileRight'],
  ['mouthDimpleLeft', 'mouthDimpleRight'],
  ['mouthFrownLeft', 'mouthFrownRight'],
  ['mouthStretchLeft', 'mouthStretchRight'],
  ['mouthPressLeft', 'mouthPressRight'],
  ['mouthLowerDownLeft', 'mouthLowerDownRight'],
  ['mouthUpperUpLeft', 'mouthUpperUpRight'],
];

export class MorphController {
  constructor(mesh, visemeMapper) {
    this.mesh = mesh;
    this.visemeMapper = visemeMapper;
    this.currentInfluences = {};
    this.targetInfluences = {};
    this.expressionInfluences = {};
    this.maxInfluence = 1.0;
    this.performanceIntensity = 0.65;
    this.activeExpression = 'neutral';
    this.expressionIntensity = 1;
    this.expressionProfile = getPerformanceProfile(this.activeExpression);
    this.blinkTimer = 0;
    this.nextBlinkTime = this.getRandomBlinkTime();
    this.isBlinking = false;
    this.blinkDuration = 200;

    if (!mesh || !mesh.morphTargetInfluences) {
      logger.error('MorphController', 'Mesh has no morphTargetInfluences array!');
      return;
    }

    this.initializeInfluences();
  }

  initializeInfluences() {
    if (!this.mesh?.morphTargetInfluences) {
      return;
    }

    for (let i = 0; i < this.mesh.morphTargetInfluences.length; i++) {
      this.mesh.morphTargetInfluences[i] = 0;
      this.currentInfluences[i] = 0;
      this.targetInfluences[i] = 0;
      this.expressionInfluences[i] = 0;
    }
  }

  resolveBlendShapeIndex(blendShapeName) {
    const morphDict = this.mesh.morphTargetDictionary;
    const mapperIndex = this.visemeMapper?.resolveBlendShapeIndex?.(blendShapeName);

    if (Number.isInteger(mapperIndex)) {
      return mapperIndex;
    }

    const normalizedBlendShape = normalizeMorphName(blendShapeName);
    const matchingEntry = Object.entries(morphDict).find(([morphName]) => {
      return normalizeMorphName(morphName) === normalizedBlendShape;
    });

    return matchingEntry ? matchingEntry[1] : null;
  }

  applyExpressionTargets() {
    Object.keys(this.targetInfluences).forEach(index => {
      this.targetInfluences[index] = this.expressionInfluences[index] || 0;
    });
  }

  rebuildExpressionInfluences() {
    Object.keys(this.expressionInfluences).forEach(index => {
      this.expressionInfluences[index] = 0;
    });

    const weights = getExpressionLayerWeights(this.activeExpression);
    const expressionGain = performanceGain(this.performanceIntensity);
    weights.forEach(([blendShapeName, weight]) => {
      const index = this.resolveBlendShapeIndex(blendShapeName);
      if (Number.isInteger(index)) {
        this.expressionInfluences[index] = clamp01(weight * this.expressionIntensity * expressionGain);
      }
    });

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
    this.rebuildExpressionInfluences();
  }

  setBlendShapeTarget(blendShapeName, value) {
    const index = this.resolveBlendShapeIndex(blendShapeName);
    if (Number.isInteger(index)) {
      this.targetInfluences[index] = Math.max(this.targetInfluences[index] || 0, clamp01(value));
    }
  }

  setRestPose() {
    this.applyExpressionTargets();
    getRestMouthWeights(this.expressionProfile).forEach(([blendShapeName, weight]) => {
      this.setBlendShapeTarget(blendShapeName, weight);
    });
  }

  getMorphBlendShapeName(morph) {
    if (morph.blendShapeName) {
      return morph.blendShapeName;
    }

    return this.visemeMapper?.getBlendShapeNameForMorph?.(morph.name) || morph.name;
  }

  applySpeechAccent(envelope) {
    const accentGain = envelope * (0.6 + this.performanceIntensity * 0.4);
    this.expressionProfile.speechAccentWeights.forEach(([blendShapeName, weight]) => {
      this.setBlendShapeTarget(blendShapeName, weight * accentGain);
    });
  }

  setSpeechFrame({ viseme, energy, voiceActive }) {
    if (!voiceActive || energy <= 0) {
      this.setRestPose();
      return;
    }

    this.applyExpressionTargets();

    const morphs = this.visemeMapper.getMorphIndicesForViseme(viseme);
    const envelope = speechEnvelope(energy);
    const voiceGain = speechGain(this.performanceIntensity);
    morphs.forEach(morph => {
      const blendShapeName = this.getMorphBlendShapeName(morph);
      const shapeScale = getSpeechBlendShapeScale(blendShapeName, this.expressionProfile);
      const visemeInfluence = Math.min(this.maxInfluence, clamp01(envelope * morph.weight * voiceGain * shapeScale));
      this.targetInfluences[morph.index] = Math.max(this.targetInfluences[morph.index] || 0, visemeInfluence);
    });

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
      const t = progress / 0.28;
      return 1 - Math.pow(1 - t, 3);
    }
    if (progress < 0.38) {
      return 1;
    }
    const t = (progress - 0.38) / 0.62;
    return Math.pow(1 - t, 2.4);
  }

  setBlinkInfluence(value) {
    const morphDict = this.mesh.morphTargetDictionary;
    const blinkPatterns = ['blink', 'eyelid', 'eye_close', 'eyes_close'];
    const genericBlinkIndices = [
      this.resolveBlendShapeIndex('eyeBlinkLeft'),
      this.resolveBlendShapeIndex('eyeBlinkRight'),
    ].filter(Number.isInteger);
    
    genericBlinkIndices.forEach(index => {
      this.targetInfluences[index] = value;
    });

    Object.keys(morphDict).forEach(morphName => {
      const lowerName = morphName.toLowerCase();
      const isBlinkMorph = blinkPatterns.some(pattern => lowerName.includes(pattern));
      
      if (isBlinkMorph) {
        const index = morphDict[morphName];
        this.targetInfluences[index] = value;
      }
    });
  }

  balanceBilateralMouthTargets() {
    BILATERAL_MOUTH_BLENDSHAPE_PAIRS.forEach(([leftBlendShape, rightBlendShape]) => {
      const leftIndex = this.resolveBlendShapeIndex(leftBlendShape);
      const rightIndex = this.resolveBlendShapeIndex(rightBlendShape);
      if (!Number.isInteger(leftIndex) || !Number.isInteger(rightIndex)) {
        return;
      }

      const balanced = Math.max(this.targetInfluences[leftIndex] || 0, this.targetInfluences[rightIndex] || 0);
      this.targetInfluences[leftIndex] = balanced;
      this.targetInfluences[rightIndex] = balanced;
    });
  }

  update(deltaTimeMs) {
    if (!this.mesh?.morphTargetInfluences) {
      logger.error('MorphController', 'Cannot update - no morphTargetInfluences array');
      return;
    }
    
    this.updateBlink(deltaTimeMs);
    this.balanceBilateralMouthTargets();

    Object.keys(this.targetInfluences).forEach(index => {
      const target = this.targetInfluences[index];
      const current = this.currentInfluences[index] || 0;
      const attackBlend = 1 - Math.exp(-deltaTimeMs / 16);
      const releaseBlend = 1 - Math.exp(-deltaTimeMs / 80);
      const blend = target > current ? attackBlend : releaseBlend;
      const blended = current + blend * (target - current);

      this.currentInfluences[index] = blended;
      this.mesh.morphTargetInfluences[index] = blended;
    });
  }
}
