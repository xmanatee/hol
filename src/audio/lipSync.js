// Lip-sync implementation for facial morph targets.

import { logger } from '../utils/logger.js';

// Standard viseme mapping for facial animation
export const STANDARD_VISEMES = {
  M: 'closed', // Mouth closed (consonants like M, B, P)
  A: 'open_wide', // Open mouth (A sound, surprise)
  E: 'open_mid', // Medium open (E sound)
  I: 'open_narrow', // Narrow open (I sound, smile)
  O: 'open_round', // Round mouth (O sound)
  U: 'pucker' // Pursed lips (U sound, OO)
};

const clamp01 = value => Math.max(0, Math.min(1, value));

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

const ARKIT_52_VISEME_WEIGHTS = {
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

const ARKIT_52_EXPRESSION_WEIGHTS = {
  neutral: [],
  happy: [
    ['mouthSmileLeft', 0.32],
    ['mouthSmileRight', 0.32],
    ['cheekSquintLeft', 0.08],
    ['cheekSquintRight', 0.08],
    ['browInnerUp', 0.06],
  ],
  sassy: [
    ['mouthSmileRight', 0.34],
    ['mouthDimpleRight', 0.22],
    ['browOuterUpRight', 0.16],
    ['browDownLeft', 0.08],
  ],
  wise: [
    ['mouthSmileLeft', 0.13],
    ['mouthSmileRight', 0.13],
    ['browInnerUp', 0.12],
    ['browOuterUpLeft', 0.08],
    ['browOuterUpRight', 0.08],
  ],
  gruff: [
    ['browDownLeft', 0.24],
    ['browDownRight', 0.24],
    ['mouthPressLeft', 0.12],
    ['mouthPressRight', 0.12],
  ],
  dramatic: [
    ['browInnerUp', 0.24],
    ['browOuterUpLeft', 0.18],
    ['browOuterUpRight', 0.18],
    ['jawOpen', 0.08],
    ['mouthFunnel', 0.08],
  ],
};

const EXPRESSION_ALIASES = {
  bubbly: 'happy',
  cheerful: 'happy',
  sarcastic: 'sassy',
};

const performanceGain = intensity => 0.85 + clamp01(intensity) * 0.75;

const ARKIT_NAME_TO_INDEX = Object.fromEntries(
  ARKIT_52_BLENDSHAPES.map((name, index) => [name, index])
);

const normalizeMorphName = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const getAlignmentStarts = alignment => alignment?.char_start_times_ms || alignment?.charStartTimesMs || [];
const getAlignmentDurations = alignment => alignment?.char_durations_ms || alignment?.charDurationsMs || alignment?.chars_durations_ms || [];

export const visemeFromCharacter = (character) => {
  const normalized = String(character || '').toLowerCase();

  if (!normalized) {
    return null;
  }

  if ('a'.includes(normalized)) return 'A';
  if ('e'.includes(normalized)) return 'E';
  if ('iy'.includes(normalized)) return 'I';
  if ('o'.includes(normalized)) return 'O';
  if ('uwq'.includes(normalized)) return 'U';
  if ('mbp'.includes(normalized)) return 'M';

  return null;
};

export const pickVisemeFromAlignment = (alignment, elapsedMs) => {
  const chars = alignment?.chars || [];
  const starts = getAlignmentStarts(alignment);
  const durations = getAlignmentDurations(alignment);

  if (!chars.length || !starts.length || !durations.length) {
    return null;
  }

  const index = chars.findIndex((_, charIndex) => {
    const start = starts[charIndex];
    const end = start + durations[charIndex];
    return elapsedMs >= start && elapsedMs < end;
  });

  if (index === -1) {
    return null;
  }

  return visemeFromCharacter(chars[index]);
};

// Create viseme map from 52 morph targets to standard visemes
// This maps the glTF model's morph target names to our viseme system
export class VisemeMapper {
  constructor(morphTargetDictionary) {
    this.morphDict = morphTargetDictionary || {};
    this.visemeMap = this.createVisemeMapping();
  }

  createVisemeMapping() {
    // Expanded naming patterns for facial morph targets (more inclusive)
    const patterns = {
      M: ['mouthclose', 'lipsclose', 'closed', 'press', 'seal', 'mshape', 'bilabial', 'close', 'shut', 'mm'],
      A: ['mouthopen', 'jawopen', 'openwide', 'ashape', 'ahopen', 'surprise', 'open', 'wide', 'aa', 'ah', 'jaw'],
      E: ['mouthmid', 'eshape', 'ehopen', 'midopen', 'smileopen', 'mouthstretch', 'eh', 'mid', 'teeth'],
      I: ['mouthsmile', 'smile', 'grin', 'ishape', 'eeshape', 'narrowopen', 'teethshow', 'ii', 'ee', 'narrow'],
      O: ['mouthfunnel', 'oshape', 'ohopen', 'round', 'ovalopen', 'oo', 'oh', 'oval'],
      U: ['mouthpucker', 'pucker', 'ushape', 'ooshape', 'lipspucker', 'whistle', 'uu', 'kiss']
    };

    const mapping = {};
    
    // Initialize empty arrays for each viseme
    Object.keys(STANDARD_VISEMES).forEach(viseme => {
      mapping[viseme] = [];
    });

    // Map morph targets to visemes based on name patterns
    Object.keys(this.morphDict).forEach(morphName => {
      const lowerName = normalizeMorphName(morphName);
      let bestMatch = null;
      let bestScore = 0;

      // Find best matching viseme for this morph target
      Object.entries(patterns).forEach(([viseme, keywords]) => {
        const score = keywords.reduce((sum, keyword) => {
          return sum + (lowerName.includes(keyword) ? keyword.length : 0);
        }, 0);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = viseme;
        }
      });

      if (bestMatch && bestScore > 0) {
        this.addMapping(mapping, bestMatch, {
          name: morphName,
          index: this.morphDict[morphName],
          weight: 1
        });
      }
    });

    if (this.hasGenericArkitTargets()) {
      this.addArkit52Mappings(mapping);
    }

    return mapping;
  }

  hasGenericArkitTargets() {
    return ARKIT_52_BLENDSHAPES.every((_, index) => {
      return Number.isInteger(this.morphDict[`target_${index}`]);
    });
  }

  addMapping(mapping, viseme, morph) {
    const alreadyMapped = mapping[viseme].some(existing => existing.index === morph.index);
    if (!alreadyMapped) {
      mapping[viseme].push(morph);
    }
  }

  addArkit52Mappings(mapping) {
    Object.entries(ARKIT_52_VISEME_WEIGHTS).forEach(([viseme, weights]) => {
      weights.forEach(([blendShapeName, weight]) => {
        const arkitIndex = ARKIT_NAME_TO_INDEX[blendShapeName];
        const targetName = `target_${arkitIndex}`;
        const index = this.morphDict[targetName];

        this.addMapping(mapping, viseme, {
          name: targetName,
          index,
          weight,
        });
      });
    });
  }

  getMorphIndicesForViseme(viseme) {
    return this.visemeMap[viseme] || [];
  }

  getAllMappedIndices() {
    const indices = new Set();
    Object.values(this.visemeMap).forEach(morphs => {
      morphs.forEach(morph => indices.add(morph.index));
    });
    return Array.from(indices);
  }
}

const createSilentAnalysis = () => ({
  energy: 0,
  centroid: 0,
  spectrum: new Array(128).fill(0)
});

export const createAudioAnalysisFromFrequencyData = (frequencyData, volume) => {
  const spectrum = Array.from(frequencyData);
  const totalMagnitude = spectrum.reduce((sum, value) => sum + value, 0);
  const weightedFrequency = spectrum.reduce((sum, value, index) => {
    return sum + value * index;
  }, 0);
  const maxIndex = Math.max(1, spectrum.length - 1);
  const spectralEnergy = spectrum.length ? totalMagnitude / (255 * spectrum.length) : 0;

  return {
    energy: clamp01(Math.max(volume, spectralEnergy * 1.4)),
    centroid: totalMagnitude > 0 ? (weightedFrequency / totalMagnitude) / maxIndex : 0,
    spectrum
  };
};

// Silence source used until real microphone or ElevenLabs output analysis arrives.
export class AudioAnalyzer {
  constructor() {}

  initialize() {}

  getAnalysis() {
    return createSilentAnalysis();
  }

  dispose() {}
}

// Heuristic viseme picker with hysteresis and smoothing
export class VisemePicker {
  constructor() {
    this.currentViseme = 'M';
    this.smoothingBuffer = new Array(3).fill('M'); // Short buffer keeps agent speech responsive
    this.energyThreshold = 0.02; // Lower threshold for real microphone input
    this.lastTransitionTime = 0;
    this.hysteresisDelay = 45; // Min time between transitions (ms)
  }

  spectrumToViseme(centroid, energy) {
    if (energy < this.energyThreshold) {
      return 'M'; // Closed mouth for low energy
    }

    // Map spectral centroid to vowel positions
    // Lower frequencies = back vowels (O, U)
    // Higher frequencies = front vowels (I, E, A)
    
    if (centroid < 0.2) return 'U'; // Low freq - back rounded
    if (centroid < 0.35) return 'O'; // Low-mid freq - mid rounded  
    if (centroid < 0.5) return 'A'; // Mid freq - open
    if (centroid < 0.7) return 'E'; // High-mid freq - front mid
    return 'I'; // High freq - front close
  }

  pickViseme(energy, centroid, timeMs) {
    const newViseme = this.spectrumToViseme(centroid, energy);
    
    // Add to smoothing buffer
    this.smoothingBuffer.shift();
    this.smoothingBuffer.push(newViseme);
    
    // Apply hysteresis - don't change too quickly
    const timeSinceLastTransition = timeMs - this.lastTransitionTime;
    if (timeSinceLastTransition < this.hysteresisDelay && newViseme !== this.currentViseme) {
      return this.currentViseme; // Keep current viseme
    }

    // Use most common viseme in smoothing buffer (EMA-like behavior)
    const visemeCounts = {};
    this.smoothingBuffer.forEach(v => {
      visemeCounts[v] = (visemeCounts[v] || 0) + 1;
    });
    
    const smoothedViseme = Object.keys(visemeCounts).reduce((a, b) => 
      visemeCounts[a] > visemeCounts[b] ? a : b
    );

    // Update if viseme changed
    if (smoothedViseme !== this.currentViseme) {
      this.currentViseme = smoothedViseme;
      this.lastTransitionTime = timeMs;
    }

    return this.currentViseme;
  }
}

// Morph target controller for real-time facial animation
export class MorphController {
  constructor(mesh, visemeMapper) {
    this.mesh = mesh;
    this.visemeMapper = visemeMapper;
    this.currentInfluences = {};
    this.targetInfluences = {};
    this.expressionInfluences = {};
    this.blendSpeed = 0.15; // EMA smoothing factor
    this.maxInfluence = 1.0;
    this.performanceIntensity = 0.65;
    
    this.blinkTimer = 0;
    this.nextBlinkTime = this.getRandomBlinkTime();
    this.isBlinking = false;
    this.blinkDuration = 200; // ms

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
    const arkitIndex = ARKIT_NAME_TO_INDEX[blendShapeName];
    const genericTargetName = `target_${arkitIndex}`;

    if (Number.isInteger(morphDict[genericTargetName])) {
      return morphDict[genericTargetName];
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

  setPerformanceIntensity(intensity = 0.65) {
    this.performanceIntensity = clamp01(intensity);
  }

  setExpression(expression, intensity = 1.0) {
    Object.keys(this.expressionInfluences).forEach(index => {
      this.expressionInfluences[index] = 0;
    });

    const normalizedExpression = EXPRESSION_ALIASES[expression] || expression;
    const weights = ARKIT_52_EXPRESSION_WEIGHTS[normalizedExpression] || ARKIT_52_EXPRESSION_WEIGHTS.neutral;
    const expressionGain = performanceGain(this.performanceIntensity);
    weights.forEach(([blendShapeName, weight]) => {
      const index = this.resolveBlendShapeIndex(blendShapeName);
      if (Number.isInteger(index)) {
        this.expressionInfluences[index] = clamp01(weight * intensity * expressionGain);
      }
    });

    this.applyExpressionTargets();
  }

  setViseme(viseme, intensity = 1.0) {
    this.applyExpressionTargets();

    // Set target influences for this viseme
    const morphs = this.visemeMapper.getMorphIndicesForViseme(viseme);
    const visemeGain = 1.15 + this.performanceIntensity * 0.8;
    morphs.forEach(morph => {
      const weight = morph.weight ?? 1;
      const visemeInfluence = Math.min(this.maxInfluence, clamp01(intensity * weight * visemeGain));
      this.targetInfluences[morph.index] = Math.max(this.targetInfluences[morph.index] || 0, visemeInfluence);
    });
  }

  resetTargets() {
    Object.keys(this.targetInfluences).forEach(index => {
      const expressionInfluence = this.expressionInfluences[index] || 0;
      this.targetInfluences[index] = expressionInfluence;
      this.currentInfluences[index] = expressionInfluence;
      if (this.mesh?.morphTargetInfluences) {
        this.mesh.morphTargetInfluences[index] = expressionInfluence;
      }
    });
  }

  getRandomBlinkTime() {
    return 3000 + Math.random() * 3000; // 3-6 seconds
  }

  updateBlink(deltaTimeMs) {
    this.blinkTimer += deltaTimeMs;

    if (!this.isBlinking && this.blinkTimer >= this.nextBlinkTime) {
      // Start blink
      this.isBlinking = true;
      this.blinkTimer = 0;
      this.nextBlinkTime = this.getRandomBlinkTime();
    }

    if (this.isBlinking) {
      const blinkProgress = this.blinkTimer / this.blinkDuration;
      
      if (blinkProgress >= 1.0) {
        // End blink
        this.isBlinking = false;
        this.setBlinkInfluence(0);
      } else {
        const blinkValue = this._naturalBlinkValue(blinkProgress) * (0.88 + this.performanceIntensity * 0.12);
        
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
    // Find eyelid/blink morph targets
    const morphDict = this.mesh.morphTargetDictionary;
    const blinkPatterns = ['blink', 'eyelid', 'eye_close', 'eyes_close'];
    const genericBlinkIndices = [
      morphDict.target_0,
      morphDict.target_7,
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

  update(deltaTimeMs) {
    if (!this.mesh?.morphTargetInfluences) {
      logger.error('MorphController', 'Cannot update - no morphTargetInfluences array');
      return;
    }
    
    // Update blink animation
    this.updateBlink(deltaTimeMs);

    // Smooth blend towards targets
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

export class LipSyncMetrics {
  constructor() {
    this.audioEnvelope = [];
    this.mouthOpenness = [];
    this.frameCount = 0;
    this.visemeChanges = 0;
    this.activeVisemes = 0;
    this.startTime = performance.now();
  }

  recordFrame(energy, currentViseme, morphInfluences) {
    const now = performance.now();
    
    // Record audio envelope
    this.audioEnvelope.push({ time: now, energy });
    
    // Record mouth openness (sum of non-M viseme influences)
    const mouthOpen = Object.values(morphInfluences).reduce((sum, influence) => sum + influence, 0);
    this.mouthOpenness.push({ time: now, openness: mouthOpen });
    
    // Track viseme stability
    if (this.lastViseme && this.lastViseme !== currentViseme) {
      this.visemeChanges++;
    }
    this.lastViseme = currentViseme;
    
    // Count active visemes
    const activeCount = Object.values(morphInfluences).filter(inf => inf > 0.1).length;
    this.activeVisemes += activeCount;
    
    this.frameCount++;
    
    // Keep only last 2 seconds of data
    const twoSecondsAgo = now - 2000;
    this.audioEnvelope = this.audioEnvelope.filter(d => d.time > twoSecondsAgo);
    this.mouthOpenness = this.mouthOpenness.filter(d => d.time > twoSecondsAgo);
  }

  calculateAVSync() {
    if (this.audioEnvelope.length < 10 || this.mouthOpenness.length < 10) {
      return 0; // Not enough data
    }

    // Simple cross-correlation to find sync offset
    let bestOffset = 0;
    let bestCorrelation = -1;
    
    for (let offset = -200; offset <= 200; offset += 10) {
      let correlation = 0;
      let count = 0;
      
      this.audioEnvelope.forEach(audio => {
        const mouth = this.mouthOpenness.find(m => 
          Math.abs(m.time - (audio.time + offset)) < 50
        );
        
        if (mouth) {
          correlation += audio.energy * mouth.openness;
          count++;
        }
      });
      
      if (count > 0) {
        correlation /= count;
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation;
          bestOffset = offset;
        }
      }
    }
    
    return bestOffset; // ms offset (negative = audio leads, positive = audio lags)
  }

  getVisemeStability() {
    if (this.frameCount === 0) return 100;
    
    const avgActiveVisemes = this.activeVisemes / this.frameCount;
    const stabilityScore = avgActiveVisemes <= 2 ? 100 : Math.max(0, 100 - ((avgActiveVisemes - 2) * 25));
    
    return stabilityScore;
  }

  getMetrics() {
    return {
      avSyncError: Math.abs(this.calculateAVSync()),
      visemeStability: this.getVisemeStability(),
      frameRate: this.frameCount / ((performance.now() - this.startTime) / 1000),
      totalFrames: this.frameCount
    };
  }
}
