export { ARKIT_52_BLENDSHAPES, STANDARD_VISEMES } from './facialRig.js';
export { MorphController } from './MorphController.js';
export { VisemeMapper } from './VisemeMapper.js';

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export const SILENT_AUDIO_ANALYSIS = Object.freeze({ energy: 0, centroid: 0 });

export const writeAudioAnalysisFromFrequencyData = (frequencyData, volume, target) => {
  let totalMagnitude = 0;
  let squaredMagnitude = 0;
  let weightedFrequency = 0;
  for (let index = 0; index < frequencyData.length; index++) {
    const magnitude = frequencyData[index];
    totalMagnitude += magnitude;
    squaredMagnitude += magnitude * magnitude;
    weightedFrequency += magnitude * index;
  }
  const maxIndex = Math.max(1, frequencyData.length - 1);
  const spectralEnergy = frequencyData.length ? totalMagnitude / (255 * frequencyData.length) : 0;
  const spectralRms = frequencyData.length ? Math.sqrt(squaredMagnitude / frequencyData.length) / 255 : 0;
  const volumeGain = 1.2 + clamp01(volume) * 0.8;

  target.energy = clamp01(Math.max(spectralEnergy * 1.4, spectralRms * volumeGain * 1.45));
  target.centroid = totalMagnitude > 0 ? weightedFrequency / totalMagnitude / maxIndex : 0;
  return target;
};

export class VisemePicker {
  constructor() {
    this.currentViseme = 'M';
    this.smoothingBuffer = new Array(3).fill('M');
    this.smoothingIndex = 0;
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
    this.smoothingBuffer[this.smoothingIndex] = newViseme;
    this.smoothingIndex = (this.smoothingIndex + 1) % this.smoothingBuffer.length;

    const timeSinceLastTransition = timeMs - this.lastTransitionTime;
    if (timeSinceLastTransition < this.hysteresisDelay && newViseme !== this.currentViseme) {
      return this.currentViseme;
    }

    const first = this.smoothingBuffer[0];
    const second = this.smoothingBuffer[1];
    const third = this.smoothingBuffer[2];
    const smoothedViseme =
      first === second || first === third ? first : second === third ? second : newViseme;

    if (smoothedViseme !== this.currentViseme) {
      this.currentViseme = smoothedViseme;
      this.lastTransitionTime = timeMs;
    }

    return this.currentViseme;
  }
}
