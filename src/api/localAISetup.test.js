import assert from 'node:assert/strict';
import test from 'node:test';
import { assessLocalAISetup } from './localAISetup.js';

const configured = {
  localAIBaseUrl: 'https://ai.example.test/v1',
  localAIModel: 'multimodal',
  localTTSModel: 'kokoro',
  localTTSVoice: 'af_heart',
};

test('local AI setup distinguishes personality and speech requirements without contacting providers', () => {
  assert.deepEqual(assessLocalAISetup({}), { personalityReady: false, speechReady: false });
  assert.deepEqual(assessLocalAISetup(configured), { personalityReady: true, speechReady: true });
  assert.deepEqual(assessLocalAISetup({ ...configured, localTTSVoice: undefined }), {
    personalityReady: true,
    speechReady: false,
  });
  assert.deepEqual(assessLocalAISetup({ ...configured, localAIModel: undefined }), {
    personalityReady: false,
    speechReady: true,
  });
});

test('stage-specific model configuration follows the same explicit precedence as inference', () => {
  assert.equal(assessLocalAISetup({ ...configured, localAIVisionModel: '' }).personalityReady, false);
  assert.equal(assessLocalAISetup({ ...configured, localAIPersonaModel: ' ' }).personalityReady, false);
  assert.equal(
    assessLocalAISetup({
      ...configured,
      localAIModel: undefined,
      localAIVisionModel: 'vision',
      localAIPersonaModel: 'persona',
    }).personalityReady,
    true,
  );
});

test('malformed and unsupported endpoint configuration cannot advertise ready AI features', () => {
  for (const localAIBaseUrl of ['', ' ', 'not a URL', 'file:///v1', 'ws://localhost/v1']) {
    assert.deepEqual(assessLocalAISetup({ ...configured, localAIBaseUrl }), {
      personalityReady: false,
      speechReady: false,
    });
  }
});
