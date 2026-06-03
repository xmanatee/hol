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
      M: ['mouth_close', 'lips_close', 'closed', 'press', 'seal', 'm_shape', 'bilabial', 'close', 'shut', 'mm', 'mouthclose'],
      A: ['mouth_open', 'jaw_open', 'open_wide', 'a_shape', 'ah_open', 'surprise', 'open', 'wide', 'aa', 'ah', 'mouthopen', 'jaw'],
      E: ['mouth_mid', 'e_shape', 'eh_open', 'mid_open', 'smile_open', 'eh', 'mid', 'teeth'],
      I: ['smile', 'grin', 'i_shape', 'ee_shape', 'narrow_open', 'teeth_show', 'ii', 'ee', 'narrow'],
      O: ['o_shape', 'oh_open', 'round', 'oval_open', 'oo', 'oh', 'oval'],
      U: ['pucker', 'u_shape', 'oo_shape', 'lips_pucker', 'whistle', 'uu', 'kiss']
    };

    const mapping = {};
    
    // Initialize empty arrays for each viseme
    Object.keys(STANDARD_VISEMES).forEach(viseme => {
      mapping[viseme] = [];
    });

    // Map morph targets to visemes based on name patterns
    Object.keys(this.morphDict).forEach(morphName => {
      const lowerName = morphName.toLowerCase();
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
        mapping[bestMatch].push({
          name: morphName,
          index: this.morphDict[morphName]
        });
      }
    });

    return mapping;
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

// ElevenLabs agent audio simulation system
export class AudioAnalyzer {
  constructor() {}

  initialize() {}

  getAgentAnalysis(isAgentSpeaking, timeMs) {
    if (!isAgentSpeaking) {
      return {
        energy: 0,
        centroid: 0,
        spectrum: new Array(128).fill(0)
      };
    }

    // Simulate realistic audio analysis during speech
    const time = timeMs * 0.001;
    
    // Simulate varying energy levels during speech
    const baseEnergy = 0.3 + Math.sin(time * 8) * 0.2; // 0.1 to 0.5 range
    const noise = (Math.random() - 0.5) * 0.1;
    const energy = Math.max(0, Math.min(1, baseEnergy + noise));
    
    // Simulate spectral centroid for vowel variation
    const centroid = 0.3 + Math.sin(time * 3 + Math.PI/4) * 0.2; // 0.1 to 0.5 range
    
    // Create fake spectrum data
    const spectrum = new Array(128).fill(0);
    for (let i = 0; i < 128; i++) {
      const freq = i / 128;
      const magnitude = energy * Math.exp(-Math.pow(freq - centroid, 2) * 8);
      spectrum[i] = Math.floor(magnitude * 255);
    }

    return { energy, centroid, spectrum };
  }

  getAnalysis(isAgentSpeaking = false, timeMs = 0) {
    return this.getAgentAnalysis(isAgentSpeaking, timeMs);
  }

  dispose() {}
}

// Heuristic viseme picker with hysteresis and smoothing
export class VisemePicker {
  constructor() {
    this.currentViseme = 'M';
    this.smoothingBuffer = new Array(6).fill('M'); // 120ms smoothing at 20ms frames
    this.energyThreshold = 0.02; // Lower threshold for real microphone input
    this.lastTransitionTime = 0;
    this.hysteresisDelay = 100; // Min time between transitions (ms)
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
    this.blendSpeed = 0.15; // EMA smoothing factor
    this.maxInfluence = 1.0;
    
    this.blinkTimer = 0;
    this.nextBlinkTime = this.getRandomBlinkTime();
    this.isBlinking = false;
    this.blinkDuration = 200; // ms
    this.blinkStartTime = 0;

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
    }
  }

  setViseme(viseme, intensity = 1.0) {
    // Reset all targets to 0
    Object.keys(this.targetInfluences).forEach(index => {
      this.targetInfluences[index] = 0;
    });

    // Set target influences for this viseme
    const morphs = this.visemeMapper.getMorphIndicesForViseme(viseme);
    morphs.forEach(morph => {
      this.targetInfluences[morph.index] = Math.min(this.maxInfluence, intensity);
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
      this.blinkStartTime = this.blinkTimer;
      this.blinkTimer = 0;
      this.nextBlinkTime = this.getRandomBlinkTime();
    }

    if (this.isBlinking) {
      const blinkProgress = (this.blinkTimer - this.blinkStartTime) / this.blinkDuration;
      
      if (blinkProgress >= 1.0) {
        // End blink
        this.isBlinking = false;
        this.setBlinkInfluence(0);
      } else {
        // Animate blink (quick close, slower open)
        const blinkValue = blinkProgress < 0.3 
          ? blinkProgress / 0.3 // Quick close
          : 1.0 - ((blinkProgress - 0.3) / 0.7); // Slower open
        
        this.setBlinkInfluence(blinkValue);
      }
    }
  }

  setBlinkInfluence(value) {
    // Find eyelid/blink morph targets
    const morphDict = this.mesh.morphTargetDictionary;
    const blinkPatterns = ['blink', 'eyelid', 'eye_close', 'eyes_close'];
    
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
      const blended = current + this.blendSpeed * (target - current);

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
