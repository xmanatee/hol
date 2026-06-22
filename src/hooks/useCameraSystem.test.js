import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldLoadVisionRuntime,
} from './useCameraSystem.js';

test('vision runtime loading waits for an active camera session', () => {
  assert.equal(shouldLoadVisionRuntime({
    cameraState: 'idle',
    initialized: false,
    visionRequested: true,
  }), false);
  assert.equal(shouldLoadVisionRuntime({
    cameraState: 'requesting',
    initialized: false,
    visionRequested: true,
  }), false);
  assert.equal(shouldLoadVisionRuntime({
    cameraState: 'blocked',
    initialized: false,
    visionRequested: true,
  }), false);
  assert.equal(shouldLoadVisionRuntime({
    cameraState: 'error',
    initialized: false,
    visionRequested: true,
  }), false);
  assert.equal(shouldLoadVisionRuntime({
    cameraState: 'active',
    initialized: false,
    visionRequested: false,
  }), false);
  assert.equal(shouldLoadVisionRuntime({
    cameraState: 'active',
    initialized: true,
    visionRequested: true,
  }), false);
  assert.equal(shouldLoadVisionRuntime({
    cameraState: 'active',
    initialized: false,
    visionRequested: true,
  }), true);
});
