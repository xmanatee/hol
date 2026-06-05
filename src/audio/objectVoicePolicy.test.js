import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoStartObjectVoice } from './objectVoicePolicy.js';

test('object voice does not auto-start from anchor or reconstruction events', () => {
  assert.equal(shouldAutoStartObjectVoice({
    trackingMode: 'object-pose',
    reconstructionReady: false,
    hasUserGesture: false,
  }), false);

  assert.equal(shouldAutoStartObjectVoice({
    trackingMode: 'sparse-reconstruction',
    reconstructionReady: true,
    hasUserGesture: false,
  }), false);
});

test('object voice can start from user gestures once the selected tracking mode is ready', () => {
  assert.equal(shouldAutoStartObjectVoice({
    trackingMode: 'object-pose',
    reconstructionReady: false,
    hasUserGesture: true,
  }), true);

  assert.equal(shouldAutoStartObjectVoice({
    trackingMode: 'sparse-reconstruction',
    reconstructionReady: false,
    hasUserGesture: true,
  }), false);

  assert.equal(shouldAutoStartObjectVoice({
    trackingMode: 'sparse-reconstruction',
    reconstructionReady: true,
    hasUserGesture: true,
  }), true);
});

test('object voice policy rejects unsupported tracking modes', () => {
  assert.throws(() => shouldAutoStartObjectVoice({
    trackingMode: 'unknown-mode',
    reconstructionReady: true,
    hasUserGesture: true,
  }), /Unsupported object voice tracking mode/);
});
