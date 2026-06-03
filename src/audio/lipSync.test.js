import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AudioAnalyzer,
  MorphController,
  VisemeMapper,
  createAudioAnalysisFromFrequencyData,
  pickVisemeFromAlignment,
} from './lipSync.js';

const createGenericArkitDictionary = () => Object.fromEntries(
  Array.from({ length: 52 }, (_, index) => [`target_${index}`, index])
);

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

test('generic 52-target ARKit rigs map standard visemes to mouth blendshapes', () => {
  const mapper = new VisemeMapper(createGenericArkitDictionary());

  assert.ok(mapper.getMorphIndicesForViseme('A').some(morph => morph.index === 17));
  assert.ok(mapper.getMorphIndicesForViseme('M').some(morph => morph.index === 18));
  assert.ok(mapper.getMorphIndicesForViseme('O').some(morph => morph.index === 19));
  assert.ok(mapper.getMorphIndicesForViseme('U').some(morph => morph.index === 20));
  assert.ok(mapper.getMorphIndicesForViseme('I').some(morph => morph.index === 23));
});

test('bundled head model mouth targets are mapped for lip-sync', () => {
  const gltf = JSON.parse(readFileSync(new URL('../../public/3d/untitled.gltf', import.meta.url), 'utf8'));
  const targetNames = gltf.meshes.find(mesh => mesh.name === 'mesh_2').extras.targetNames;
  const mapper = new VisemeMapper(Object.fromEntries(targetNames.map((name, index) => [name, index])));

  assert.equal(targetNames.length, 52);
  assert.ok(mapper.getMorphIndicesForViseme('A').some(morph => morph.name === 'target_17'));
  assert.ok(mapper.getMorphIndicesForViseme('O').some(morph => morph.name === 'target_19'));
  assert.ok(mapper.getMorphIndicesForViseme('U').some(morph => morph.name === 'target_20'));
});

test('morph controller opens the ARKit jaw quickly on voice attack', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setViseme('A', 0.9);
  controller.update(16);

  assert.ok(mesh.morphTargetInfluences[17] > 0.25);
});

test('audio alignment characters resolve to the current spoken viseme', () => {
  const viseme = pickVisemeFromAlignment({
    chars: ['h', 'e', 'l', 'o'],
    charStartTimesMs: [0, 80, 160, 240],
    charDurationsMs: [80, 80, 80, 120],
  }, 95);

  assert.equal(viseme, 'E');
});
