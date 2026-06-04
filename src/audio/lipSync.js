export {
  ARKIT_52_BLENDSHAPES,
  STANDARD_VISEMES,
} from './facialRig.js';
export { MorphController } from './MorphController.js';
export { VisemeMapper } from './VisemeMapper.js';

const clamp01 = value => Math.max(0, Math.min(1, value));

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

const createSilentAnalysis = () => ({
  energy: 0,
  centroid: 0,
  spectrum: new Array(128).fill(0),
});

export const createAudioAnalysisFromFrequencyData = (frequencyData, volume) => {
  const spectrum = Array.from(frequencyData);
  const totalMagnitude = spectrum.reduce((sum, value) => sum + value, 0);
  const squaredMagnitude = spectrum.reduce((sum, value) => sum + value * value, 0);
  const weightedFrequency = spectrum.reduce((sum, value, index) => {
    return sum + value * index;
  }, 0);
  const maxIndex = Math.max(1, spectrum.length - 1);
  const spectralEnergy = spectrum.length ? totalMagnitude / (255 * spectrum.length) : 0;
  const spectralRms = spectrum.length ? Math.sqrt(squaredMagnitude / spectrum.length) / 255 : 0;
  const volumeGain = 1.2 + clamp01(volume) * 0.8;

  return {
    energy: clamp01(Math.max(spectralEnergy * 1.4, spectralRms * volumeGain * 1.45)),
    centroid: totalMagnitude > 0 ? (weightedFrequency / totalMagnitude) / maxIndex : 0,
    spectrum,
  };
};

export class AudioAnalyzer {
  constructor() {}

  initialize() {}

  getAnalysis() {
    return createSilentAnalysis();
  }

  dispose() {}
}

export class VisemePicker {
  constructor() {
    this.currentViseme = 'M';
    this.smoothingBuffer = new Array(3).fill('M');
    this.energyThreshold = 0.02;
    this.lastTransitionTime = 0;
    this.hysteresisDelay = 45;
  }

  spectrumToViseme(centroid, energy) {
    if (energy < this.energyThreshold) {
      return 'M';
    }

    if (centroid < 0.2) return 'U';
    if (centroid < 0.35) return 'O';
    if (centroid < 0.5) return 'A';
    if (centroid < 0.7) return 'E';
    return 'I';
  }

  pickViseme(energy, centroid, timeMs) {
    const newViseme = this.spectrumToViseme(centroid, energy);
    this.smoothingBuffer.shift();
    this.smoothingBuffer.push(newViseme);
    
    const timeSinceLastTransition = timeMs - this.lastTransitionTime;
    if (timeSinceLastTransition < this.hysteresisDelay && newViseme !== this.currentViseme) {
      return this.currentViseme;
    }

    const visemeCounts = {};
    this.smoothingBuffer.forEach(viseme => {
      visemeCounts[viseme] = (visemeCounts[viseme] || 0) + 1;
    });
    
    const smoothedViseme = Object.keys(visemeCounts).reduce((a, b) => {
      return visemeCounts[a] > visemeCounts[b] ? a : b;
    });

    if (smoothedViseme !== this.currentViseme) {
      this.currentViseme = smoothedViseme;
      this.lastTransitionTime = timeMs;
    }

    return this.currentViseme;
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
    this.audioEnvelope.push({ time: now, energy });
    
    const mouthOpen = Object.values(morphInfluences).reduce((sum, influence) => sum + influence, 0);
    this.mouthOpenness.push({ time: now, openness: mouthOpen });
    
    if (this.lastViseme && this.lastViseme !== currentViseme) {
      this.visemeChanges++;
    }
    this.lastViseme = currentViseme;
    
    const activeCount = Object.values(morphInfluences).filter(influence => influence > 0.1).length;
    this.activeVisemes += activeCount;
    this.frameCount++;
    
    const twoSecondsAgo = now - 2000;
    this.audioEnvelope = this.audioEnvelope.filter(frame => frame.time > twoSecondsAgo);
    this.mouthOpenness = this.mouthOpenness.filter(frame => frame.time > twoSecondsAgo);
  }

  calculateAVSync() {
    if (this.audioEnvelope.length < 10 || this.mouthOpenness.length < 10) {
      return 0;
    }

    let bestOffset = 0;
    let bestCorrelation = -1;
    
    for (let offset = -200; offset <= 200; offset += 10) {
      let correlation = 0;
      let count = 0;
      
      this.audioEnvelope.forEach(audio => {
        const mouth = this.mouthOpenness.find(frame => {
          return Math.abs(frame.time - (audio.time + offset)) < 50;
        });
        
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
    
    return bestOffset;
  }

  getVisemeStability() {
    if (this.frameCount === 0) return 100;
    
    const avgActiveVisemes = this.activeVisemes / this.frameCount;
    return avgActiveVisemes <= 2 ? 100 : Math.max(0, 100 - ((avgActiveVisemes - 2) * 25));
  }

  getMetrics() {
    return {
      avSyncError: Math.abs(this.calculateAVSync()),
      visemeStability: this.getVisemeStability(),
      frameRate: this.frameCount / ((performance.now() - this.startTime) / 1000),
      totalFrames: this.frameCount,
    };
  }
}
