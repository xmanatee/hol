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

test('frequency analysis maps ElevenLabs output spectrum into normalized lip-sync data', () => {
  const lowBand = new Uint8Array([0, 180, 40, 0, 0, 0, 0, 0]);
  const highBand = new Uint8Array([0, 0, 0, 0, 0, 40, 180, 0]);

  const low = createAudioAnalysisFromFrequencyData(lowBand, 0.5);
  const high = createAudioAnalysisFromFrequencyData(highBand, 0.5);

  assert.ok(low.energy > 0.3);
  assert.ok(high.energy > 0.3);
  assert.ok(low.centroid < high.centroid);
  assert.equal(low.spectrum.length, lowBand.length);
});

test('frequency analysis treats silent spectrum as silence even if output volume has floor', () => {
  const analysis = createAudioAnalysisFromFrequencyData(new Uint8Array(128).fill(0), 0.8);

  assert.equal(analysis.energy, 0);
  assert.equal(analysis.centroid, 0);
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

test('generic 52-target ARKit rigs remain supported when the target order is explicit', () => {
  const mapper = new VisemeMapper(createGenericArkitDictionary(), {
    genericTargetOrder: 'arkit',
  });

  assert.ok(mapper.getMorphIndicesForViseme('A').some(morph => morph.index === 17));
  assert.ok(mapper.getMorphIndicesForViseme('M').some(morph => morph.index === 18));
  assert.ok(mapper.getMorphIndicesForViseme('O').some(morph => morph.index === 19));
  assert.ok(mapper.getMorphIndicesForViseme('U').some(morph => morph.index === 20));
  assert.ok(mapper.getMorphIndicesForViseme('I').some(morph => morph.index === 23));
});

test('generic target-numbered rigs use the bundled MediaPipe model-card order', () => {
  const mapper = new VisemeMapper(createGenericArkitDictionary());

  assert.ok(mapper.getMorphIndicesForViseme('A').some(morph => morph.name === 'target_24'));
  assert.ok(mapper.getMorphIndicesForViseme('M').some(morph => morph.name === 'target_26'));
  assert.ok(mapper.getMorphIndicesForViseme('O').some(morph => morph.name === 'target_31'));
  assert.ok(mapper.getMorphIndicesForViseme('U').some(morph => morph.name === 'target_37'));
});

test('bundled head model mouth targets are mapped for lip-sync', () => {
  const gltf = JSON.parse(readFileSync(new URL('../../public/3d/untitled.gltf', import.meta.url), 'utf8'));
  const targetNames = gltf.meshes.find(mesh => mesh.name === 'mesh_2').extras.targetNames;
  const mapper = new VisemeMapper(Object.fromEntries(targetNames.map((name, index) => [name, index])));

  assert.equal(targetNames.length, 52);
  assert.ok(mapper.getMorphIndicesForViseme('A').some(morph => morph.name === 'target_24'));
  assert.ok(mapper.getMorphIndicesForViseme('O').some(morph => morph.name === 'target_31'));
  assert.ok(mapper.getMorphIndicesForViseme('U').some(morph => morph.name === 'target_37'));
});

test('bundled head model returns to closed mouth after speech completion', () => {
  const gltf = JSON.parse(readFileSync(new URL('../../public/3d/untitled.gltf', import.meta.url), 'utf8'));
  const targetNames = gltf.meshes.find(mesh => mesh.name === 'mesh_2').extras.targetNames;
  const mesh = {
    morphTargetDictionary: Object.fromEntries(targetNames.map((name, index) => [name, index])),
    morphTargetInfluences: new Array(targetNames.length).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setPerformanceIntensity(1);
  controller.setSpeechFrame({ viseme: 'A', energy: 1, voiceActive: true });
  controller.update(80);

  assert.ok(mesh.morphTargetInfluences[24] > 0.65);

  controller.setSpeechFrame({ viseme: 'M', energy: 0, voiceActive: false });
  controller.update(320);

  assert.ok(mesh.morphTargetInfluences[24] < 0.04);
  assert.ok(mesh.morphTargetInfluences[26] > 0.5);
  assert.ok(mesh.morphTargetInfluences[31] < 0.04);
  assert.ok(mesh.morphTargetInfluences[37] < 0.04);
});

test('morph controller opens the bundled jaw quickly on voice attack', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setSpeechFrame({ viseme: 'A', energy: 0.9, voiceActive: true });
  controller.update(16);

  assert.ok(mesh.morphTargetInfluences[24] > 0.25);
});

test('morph controller drives a more pronounced open-mouth viseme', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setSpeechFrame({ viseme: 'A', energy: 1, voiceActive: true });
  controller.update(16);

  assert.ok(mesh.morphTargetInfluences[24] > 0.55);
});

test('morph controller blinks bundled model-card eye targets while speaking', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setBlinkInfluence(0.85);

  assert.equal(controller.targetInfluences[8], 0.85);
  assert.equal(controller.targetInfluences[9], 0.85);
});

test('morph controller blinks the bundled model eyelid targets, not brow or cheek targets', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setBlinkInfluence(0.85);

  assert.equal(controller.targetInfluences[8], 0.85);
  assert.equal(controller.targetInfluences[9], 0.85);
  assert.equal(controller.targetInfluences[0], 0);
  assert.equal(controller.targetInfluences[7], 0);
});

test('speech blink completes near its configured duration after a delayed blink start', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);
  controller.nextBlinkTime = 120;

  controller.update(120);
  assert.equal(controller.isBlinking, true);

  controller.update(220);
  assert.equal(controller.isBlinking, false);
});

test('morph controller applies expression targets underneath speech visemes', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setExpression('happy', 1);
  controller.setRestPose();
  controller.update(16);

  assert.ok(mesh.morphTargetInfluences[43] > 0.05);
  assert.ok(mesh.morphTargetInfluences[44] > 0.05);
});

test('idle rest pose closes the mouth instead of leaving the exported base pose open', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setRestPose();
  controller.update(80);

  assert.ok(mesh.morphTargetInfluences[26] > 0.55);
  assert.equal(mesh.morphTargetInfluences[24], 0);
});

test('idle rest pose drives the bundled mouthClose target instead of an eye target', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setRestPose();
  controller.update(80);

  assert.ok(mesh.morphTargetInfluences[26] > 0.55);
  assert.equal(mesh.morphTargetInfluences[18], 0);
});

test('rest frame releases an open vowel back to closed mouth', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setSpeechFrame({ viseme: 'A', energy: 1, voiceActive: true });
  controller.update(80);
  assert.ok(mesh.morphTargetInfluences[24] > 0.4);

  controller.setSpeechFrame({ viseme: 'A', energy: 0, voiceActive: false });
  controller.update(240);

  assert.ok(mesh.morphTargetInfluences[24] < 0.05);
  assert.ok(mesh.morphTargetInfluences[26] > 0.55);
});

test('expression layer does not hold the jaw open when the agent is idle', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setPerformanceIntensity(1);
  controller.setExpression('dramatic', 1);
  controller.setRestPose();
  controller.update(120);

  assert.equal(mesh.morphTargetInfluences[24], 0);
  assert.ok(mesh.morphTargetInfluences[26] > 0.5);
  assert.ok(mesh.morphTargetInfluences[2] > 0.2);
});

test('cartoon performance profile exaggerates jaw and vertical mouth shapes', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setPerformanceIntensity(1);
  controller.setSpeechFrame({ viseme: 'A', energy: 1, voiceActive: true });
  controller.update(33);

  assert.ok(mesh.morphTargetInfluences[24] > 0.85);
  assert.ok(mesh.morphTargetInfluences[33] > 0.22);
  assert.ok(mesh.morphTargetInfluences[34] > 0.22);
});

test('emotional speech profile opens dramatic vowels more than calm speech', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const calm = new MorphController(mesh, mapper);

  calm.setPerformanceIntensity(0.25);
  calm.setExpression('wise', 1);
  calm.setSpeechFrame({ viseme: 'A', energy: 0.85, voiceActive: true });
  calm.update(33);
  const calmJawOpen = mesh.morphTargetInfluences[24];

  const dramaticMesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const dramatic = new MorphController(dramaticMesh, new VisemeMapper(dramaticMesh.morphTargetDictionary));
  dramatic.setPerformanceIntensity(1);
  dramatic.setExpression('dramatic', 1);
  dramatic.setSpeechFrame({ viseme: 'A', energy: 0.85, voiceActive: true });
  dramatic.update(33);

  assert.ok(dramaticMesh.morphTargetInfluences[24] > calmJawOpen + 0.18);
  assert.ok(dramaticMesh.morphTargetInfluences[33] > 0.25);
});

test('expression intensity controls upper-face exaggeration without snapping current influences', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setPerformanceIntensity(1);
  controller.setExpression('dramatic', 1);

  assert.equal(mesh.morphTargetInfluences[2], 0);

  controller.update(120);

  assert.ok(mesh.morphTargetInfluences[2] > 0.2);
  assert.ok(mesh.morphTargetInfluences[2] < 0.5);
});

test('speech blinks follow a natural close-open curve', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);
  controller.nextBlinkTime = 16;

  controller.update(16);
  controller.update(45);
  const closing = mesh.morphTargetInfluences[8];

  controller.update(45);
  const opening = mesh.morphTargetInfluences[8];

  controller.update(160);

  assert.ok(closing > 0.45);
  assert.ok(opening > 0.1);
  assert.ok(opening < closing);
  assert.equal(controller.isBlinking, false);
});

test('mouth expression pairs stay symmetric while upper-face expression can stay asymmetric', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setExpression('sassy', 1);
  controller.setRestPose();
  controller.update(120);

  assert.equal(Number(mesh.morphTargetInfluences[43].toFixed(4)), Number(mesh.morphTargetInfluences[44].toFixed(4)));
  assert.equal(Number(mesh.morphTargetInfluences[27].toFixed(4)), Number(mesh.morphTargetInfluences[28].toFixed(4)));
  assert.ok(mesh.morphTargetInfluences[4] > mesh.morphTargetInfluences[3]);
});

test('audio alignment characters resolve to the current spoken viseme', () => {
  const viseme = pickVisemeFromAlignment({
    chars: ['h', 'e', 'l', 'o'],
    charStartTimesMs: [0, 80, 160, 240],
    charDurationsMs: [80, 80, 80, 120],
  }, 95);

  assert.equal(viseme, 'E');
});
