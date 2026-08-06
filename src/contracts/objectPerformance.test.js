import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONA_FACIAL_EXPRESSIONS,
  PERSONA_VOICE_STYLES,
  normalizeSpeechPerformance,
} from './objectPerformance.js';
import { PERSONA_CONTENT_LIMITS } from './objectContent.js';

test('object performance publishes the exact persona enums used across AI and speech', () => {
  assert.deepEqual(PERSONA_VOICE_STYLES, [
    'cheerful',
    'sassy',
    'wise',
    'gruff',
    'bubbly',
    'sarcastic',
    'dramatic',
  ]);
  assert.deepEqual(PERSONA_FACIAL_EXPRESSIONS, [
    'neutral',
    'happy',
    'sassy',
    'wise',
    'gruff',
    'bubbly',
    'sarcastic',
    'dramatic',
  ]);
});

test('speech performance normalizes a complete supported contract', () => {
  assert.deepEqual(normalizeSpeechPerformance(' dramatic ', ' big theatrical delivery '), {
    voiceStyle: 'dramatic',
    emotionalDelivery: 'big theatrical delivery',
  });
});

test('speech performance rejects missing, empty, and unsupported values', () => {
  assert.throws(() => normalizeSpeechPerformance(), /voice style must be a string/);
  assert.throws(() => normalizeSpeechPerformance('', 'calm'), /voice style must be non-empty/);
  assert.throws(() => normalizeSpeechPerformance('unknown', 'calm'), /unsupported voice style/);
  assert.throws(() => normalizeSpeechPerformance('wise'), /emotional delivery must be a string/);
  assert.throws(() => normalizeSpeechPerformance('wise', '  '), /emotional delivery must be non-empty/);
});

test('speech performance applies its JSON Schema Unicode-character budget at runtime', () => {
  const deliveryAtLimit = '😀'.repeat(PERSONA_CONTENT_LIMITS.maxEmotionalDeliveryCharacters);
  assert.equal(normalizeSpeechPerformance('dramatic', deliveryAtLimit).emotionalDelivery, deliveryAtLimit);
  assert.throws(
    () => normalizeSpeechPerformance('dramatic', `${deliveryAtLimit}😀`),
    /emotional delivery must contain at most 240 characters/,
  );
});
