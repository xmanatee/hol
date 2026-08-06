import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpeechInstructions } from './speechPerformance.js';

test('speech instructions preserve the complete normalized object performance', () => {
  assert.equal(
    buildSpeechInstructions(' dramatic ', ' big theatrical delivery '),
    'Perform as an animated object. Voice style: dramatic. Delivery: big theatrical delivery. Speak only the supplied input.',
  );
});

test('speech instructions never invent a style or delivery fallback', () => {
  assert.throws(() => buildSpeechInstructions(), /voice style must be a string/);
  assert.throws(() => buildSpeechInstructions('unknown', 'calm'), /unsupported voice style/);
  assert.throws(() => buildSpeechInstructions('wise', ''), /emotional delivery must be non-empty/);
});
