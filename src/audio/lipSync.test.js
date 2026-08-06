import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCapabilityAsset } from '../runtime/capabilityPacks.js';
import { MorphController, VisemeMapper, writeAudioAnalysisFromFrequencyData } from './lipSync.js';

const createGenericArkitDictionary = () =>
  Object.fromEntries(Array.from({ length: 52 }, (_, index) => [`target_${index}`, index]));

const readBundledHeadTargetNames = () => {
  const asset = getCapabilityAsset('face', 'hol-face-meshopt');
  const bytes = readFileSync(new URL(asset.url));
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(
    bytes
      .subarray(20, 20 + jsonLength)
      .toString()
      .replace(/\0+$/, ''),
  );
  return gltf.meshes.find((mesh) => mesh.primitives?.[0]?.targets?.length === 52).extras.targetNames;
};

test('frequency analysis maps speech bands into a reusable normalized lip-sync frame', () => {
  const lowBand = new Uint8Array([0, 180, 40, 0, 0, 0, 0, 0]);
  const highBand = new Uint8Array([0, 0, 0, 0, 0, 40, 180, 0]);
  const low = { energy: 0, centroid: 0 };
  const high = { energy: 0, centroid: 0 };

  assert.equal(writeAudioAnalysisFromFrequencyData(lowBand, 0.5, low), low);
  assert.equal(writeAudioAnalysisFromFrequencyData(highBand, 0.5, high), high);

  assert.ok(low.energy > 0.3);
  assert.ok(high.energy > 0.3);
  assert.ok(low.centroid < high.centroid);
  assert.deepEqual(Object.keys(low), ['energy', 'centroid']);
});

test('frequency analysis treats silent bands as silence even if output volume has floor', () => {
  const analysis = { energy: 1, centroid: 1 };
  writeAudioAnalysisFromFrequencyData(new Uint8Array(128).fill(0), 0.8, analysis);

  assert.equal(analysis.energy, 0);
  assert.equal(analysis.centroid, 0);
});

test('morph animation resolves named targets before entering its frame loop', () => {
  const dictionary = createGenericArkitDictionary();
  const mapper = new VisemeMapper(dictionary);
  const resolveBlendShapeIndex = mapper.resolveBlendShapeIndex.bind(mapper);
  let resolutionCount = 0;
  mapper.resolveBlendShapeIndex = (name) => {
    resolutionCount++;
    return resolveBlendShapeIndex(name);
  };
  const mesh = {
    morphTargetDictionary: dictionary,
    morphTargetInfluences: new Array(52).fill(0),
  };
  const controller = new MorphController(mesh, mapper);
  controller.setExpression('dramatic', 1);
  const initializationResolutionCount = resolutionCount;

  for (let frame = 0; frame < 30; frame++) {
    controller.setSpeechFrame(frame % 2 === 0 ? 'A' : 'O', 0.8, true);
    controller.update(16);
  }
  for (let frame = 0; frame < 30; frame++) {
    controller.setSpeechFrame('M', 0, false);
    controller.update(16);
  }

  assert.equal(resolutionCount, initializationResolutionCount);
});

test('morph animation rejects incomplete runtime collaborators immediately', () => {
  const mapper = new VisemeMapper(createGenericArkitDictionary());

  assert.throws(
    () => new MorphController({ morphTargetDictionary: {}, morphTargetInfluences: null }, mapper),
    /mesh with morph targets/,
  );
  assert.throws(
    () =>
      new MorphController(
        { morphTargetDictionary: createGenericArkitDictionary(), morphTargetInfluences: [] },
        null,
      ),
    /viseme mapper/,
  );
});

test('generic 52-target ARKit rigs remain supported when the target order is explicit', () => {
  const mapper = new VisemeMapper(createGenericArkitDictionary(), {
    genericTargetOrder: 'arkit',
  });

  assert.ok(mapper.getMorphIndicesForViseme('A').some((morph) => morph.index === 17));
  assert.ok(mapper.getMorphIndicesForViseme('M').some((morph) => morph.index === 18));
  assert.ok(mapper.getMorphIndicesForViseme('O').some((morph) => morph.index === 19));
  assert.ok(mapper.getMorphIndicesForViseme('U').some((morph) => morph.index === 20));
  assert.ok(mapper.getMorphIndicesForViseme('I').some((morph) => morph.index === 23));
});

test('generic target-numbered rigs use the bundled HOL head target order', () => {
  const mapper = new VisemeMapper(createGenericArkitDictionary());

  assert.ok(mapper.getMorphIndicesForViseme('A').some((morph) => morph.name === 'target_24'));
  assert.ok(mapper.getMorphIndicesForViseme('M').some((morph) => morph.name === 'target_25'));
  assert.ok(mapper.getMorphIndicesForViseme('O').some((morph) => morph.name === 'target_28'));
  assert.ok(mapper.getMorphIndicesForViseme('U').some((morph) => morph.name === 'target_29'));
});

test('bundled head model mouth targets are mapped for lip-sync', () => {
  const targetNames = readBundledHeadTargetNames();
  const mapper = new VisemeMapper(Object.fromEntries(targetNames.map((name, index) => [name, index])));

  assert.equal(targetNames.length, 52);
  assert.ok(mapper.getMorphIndicesForViseme('A').some((morph) => morph.name === 'target_24'));
  assert.ok(mapper.getMorphIndicesForViseme('M').some((morph) => morph.name === 'target_25'));
  assert.ok(mapper.getMorphIndicesForViseme('O').some((morph) => morph.name === 'target_28'));
  assert.ok(mapper.getMorphIndicesForViseme('U').some((morph) => morph.name === 'target_29'));
});

test('bundled head resolves observed eye and mouth controls instead of MediaPipe indices', () => {
  const mapper = new VisemeMapper(createGenericArkitDictionary());

  assert.equal(mapper.resolveBlendShapeIndex('eyeBlinkLeft'), 14);
  assert.equal(mapper.resolveBlendShapeIndex('eyeBlinkRight'), 13);
  assert.equal(mapper.resolveBlendShapeIndex('mouthClose'), 25);
  assert.equal(mapper.resolveBlendShapeIndex('mouthRight'), 26);
  assert.equal(mapper.resolveBlendShapeIndex('mouthLeft'), 27);
  assert.equal(mapper.resolveBlendShapeIndex('mouthFunnel'), 28);
  assert.equal(mapper.resolveBlendShapeIndex('mouthPucker'), 29);
});

test('bundled head model returns to closed mouth after speech completion', () => {
  const targetNames = readBundledHeadTargetNames();
  const mesh = {
    morphTargetDictionary: Object.fromEntries(targetNames.map((name, index) => [name, index])),
    morphTargetInfluences: new Array(targetNames.length).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setPerformanceIntensity(1);
  controller.setSpeechFrame('A', 1, true);
  controller.update(80);

  assert.ok(mesh.morphTargetInfluences[24] > 0.65);

  controller.setSpeechFrame('M', 0, false);
  controller.update(320);

  assert.ok(mesh.morphTargetInfluences[24] < 0.04);
  assert.ok(mesh.morphTargetInfluences[25] > 0.5);
  assert.ok(mesh.morphTargetInfluences[26] < 0.04);
  assert.ok(mesh.morphTargetInfluences[28] < 0.04);
  assert.ok(mesh.morphTargetInfluences[29] < 0.04);
});

test('morph controller opens the bundled jaw quickly on voice attack', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setSpeechFrame('A', 0.9, true);
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

  controller.setSpeechFrame('A', 1, true);
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

  assert.equal(controller.targetInfluences[13], 0.85);
  assert.equal(controller.targetInfluences[14], 0.85);
});

test('morph controller blinks the bundled model eyelid targets, not brow or cheek targets', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setBlinkInfluence(0.85);

  assert.equal(controller.targetInfluences[13], 0.85);
  assert.equal(controller.targetInfluences[14], 0.85);
  assert.equal(controller.targetInfluences[0], 0);
  assert.equal(controller.targetInfluences[7], 0);
  assert.equal(controller.targetInfluences[8], 0);
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

  assert.ok(mesh.morphTargetInfluences[30] > 0.05);
  assert.ok(mesh.morphTargetInfluences[31] > 0.05);
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

  assert.ok(mesh.morphTargetInfluences[25] > 0.55);
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

  assert.ok(mesh.morphTargetInfluences[25] > 0.55);
  assert.equal(mesh.morphTargetInfluences[18], 0);
  assert.equal(mesh.morphTargetInfluences[26], 0);
});

test('rest frame releases an open vowel back to closed mouth', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setSpeechFrame('A', 1, true);
  controller.update(80);
  assert.ok(mesh.morphTargetInfluences[24] > 0.4);

  controller.setSpeechFrame('A', 0, false);
  controller.update(240);

  assert.ok(mesh.morphTargetInfluences[24] < 0.05);
  assert.ok(mesh.morphTargetInfluences[25] > 0.55);
  assert.ok(mesh.morphTargetInfluences[26] < 0.05);
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
  assert.ok(mesh.morphTargetInfluences[25] > 0.5);
  assert.ok(mesh.morphTargetInfluences[0] > 0.2);
});

test('cartoon performance profile exaggerates jaw and vertical mouth shapes', () => {
  const mesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const mapper = new VisemeMapper(mesh.morphTargetDictionary);
  const controller = new MorphController(mesh, mapper);

  controller.setPerformanceIntensity(1);
  controller.setSpeechFrame('A', 1, true);
  controller.update(33);

  assert.ok(mesh.morphTargetInfluences[24] > 0.85);
  assert.ok(mesh.morphTargetInfluences[45] > 0.22);
  assert.ok(mesh.morphTargetInfluences[46] > 0.22);
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
  calm.setSpeechFrame('A', 0.85, true);
  calm.update(33);
  const calmJawOpen = mesh.morphTargetInfluences[24];

  const dramaticMesh = {
    morphTargetDictionary: createGenericArkitDictionary(),
    morphTargetInfluences: new Array(52).fill(0),
  };
  const dramatic = new MorphController(dramaticMesh, new VisemeMapper(dramaticMesh.morphTargetDictionary));
  dramatic.setPerformanceIntensity(1);
  dramatic.setExpression('dramatic', 1);
  dramatic.setSpeechFrame('A', 0.85, true);
  dramatic.update(33);

  assert.ok(dramaticMesh.morphTargetInfluences[24] > calmJawOpen + 0.18);
  assert.ok(dramaticMesh.morphTargetInfluences[45] > 0.25);
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

  assert.equal(mesh.morphTargetInfluences[0], 0);

  controller.update(120);

  assert.ok(mesh.morphTargetInfluences[0] > 0.2);
  assert.ok(mesh.morphTargetInfluences[0] < 0.5);
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
  const closing = mesh.morphTargetInfluences[13];

  controller.update(45);
  const opening = mesh.morphTargetInfluences[13];

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

  assert.equal(
    Number(mesh.morphTargetInfluences[30].toFixed(4)),
    Number(mesh.morphTargetInfluences[31].toFixed(4)),
  );
  assert.equal(
    Number(mesh.morphTargetInfluences[41].toFixed(4)),
    Number(mesh.morphTargetInfluences[42].toFixed(4)),
  );
  assert.ok(mesh.morphTargetInfluences[3] > mesh.morphTargetInfluences[4]);
});
