import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioAnalyzer,
  createAudioAnalysisFromFrequencyData,
} from './lipSync.js';

test('frequency analysis maps ElevenLabs output volume and spectrum into normalized lip-sync data', () => {
  const lowBand = new Uint8Array([0, 180, 40, 0, 0, 0, 0, 0]);
  const highBand = new Uint8Array([0, 0, 0, 0, 0, 40, 180, 0]);

  const low = createAudioAnalysisFromFrequencyData(lowBand, 0.5);
  const high = createAudioAnalysisFromFrequencyData(highBand, 0.5);

  assert.equal(low.energy, 0.5);
  assert.equal(high.energy, 0.5);
  assert.ok(low.centroid < high.centroid);
  assert.equal(low.spectrum.length, lowBand.length);
});

test('agent analysis is silent without real output audio data', () => {
  const analyzer = new AudioAnalyzer();
  const analysis = analyzer.getAnalysis(true, 1000);

  assert.deepEqual(analysis, {
    energy: 0,
    centroid: 0,
    spectrum: new Array(128).fill(0),
  });
});
