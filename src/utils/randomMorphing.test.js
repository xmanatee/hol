import test from 'node:test';
import assert from 'node:assert/strict';
import { RandomMorphController } from './randomMorphing.js';

test('idle morphing keeps non-blink targets neutral', () => {
  const mesh = {
    morphTargetInfluences: [0, 0, 0],
    morphTargetDictionary: {
      mouthOpen: 0,
      browRaise: 1,
      eyeBlinkLeft: 2,
    },
  };
  const controller = new RandomMorphController(mesh, {
    blinkInterval: 60_000,
    blinkVariation: 0,
    blinkIntensity: 0.8,
  });

  controller.update();

  assert.equal(mesh.morphTargetInfluences[0], 0);
  assert.equal(mesh.morphTargetInfluences[1], 0);
});
