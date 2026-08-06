import test from 'node:test';
import assert from 'node:assert/strict';

import {
  retireObjectVoiceSession,
  selectCameraLifecycleAction,
  shouldLoadVisionRuntime,
} from './useCameraSystem.js';

test('vision runtime loading waits for an active camera session', () => {
  assert.equal(
    shouldLoadVisionRuntime({
      cameraState: 'idle',
      initialized: false,
      visionRequested: true,
    }),
    false,
  );
  assert.equal(
    shouldLoadVisionRuntime({
      cameraState: 'requesting',
      initialized: false,
      visionRequested: true,
    }),
    false,
  );
  assert.equal(
    shouldLoadVisionRuntime({
      cameraState: 'blocked',
      initialized: false,
      visionRequested: true,
    }),
    false,
  );
  assert.equal(
    shouldLoadVisionRuntime({
      cameraState: 'error',
      initialized: false,
      visionRequested: true,
    }),
    false,
  );
  assert.equal(
    shouldLoadVisionRuntime({
      cameraState: 'active',
      initialized: false,
      visionRequested: false,
    }),
    false,
  );
  assert.equal(
    shouldLoadVisionRuntime({
      cameraState: 'active',
      initialized: true,
      visionRequested: true,
    }),
    false,
  );
  assert.equal(
    shouldLoadVisionRuntime({
      cameraState: 'active',
      initialized: false,
      visionRequested: true,
    }),
    true,
  );
});

test('camera lifecycle resets only the runtime whose coordinate space became invalid', () => {
  assert.equal(
    selectCameraLifecycleAction({
      newState: 'active',
      oldState: 'requesting',
      reason: null,
    }),
    null,
  );
  assert.equal(
    selectCameraLifecycleAction({
      newState: 'active',
      oldState: 'active',
      reason: 'dimensions-changed',
    }),
    'reset-vision',
  );
  assert.equal(
    selectCameraLifecycleAction({
      newState: 'active',
      oldState: 'interrupted',
      reason: 'dimensions-changed',
    }),
    'reset-vision',
  );
  assert.equal(
    selectCameraLifecycleAction({
      newState: 'interrupted',
      oldState: 'active',
      reason: 'track-muted',
    }),
    null,
  );
  assert.equal(
    selectCameraLifecycleAction({
      newState: 'interrupted',
      oldState: 'active',
      reason: 'track-ended',
    }),
    'replace-session',
  );
});

test('clearing an object retires personality and speech as one session boundary', () => {
  const calls = [];

  retireObjectVoiceSession({
    personality: { resetSubject: () => calls.push('personality') },
    tts: { stopCurrentAudio: () => calls.push('speech') },
  });

  assert.deepEqual(calls, ['personality', 'speech']);
});
