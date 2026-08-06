import test from 'node:test';
import assert from 'node:assert/strict';
import { disposeCameraSessionServices } from './CameraSessionServices.js';

test('camera session disposal releases every owned browser resource', async () => {
  const disposed = [];
  const session = {
    camera: { stop: () => disposed.push('camera') },
    anchor: { dispose: () => disposed.push('anchor') },
    personality: { dispose: () => disposed.push('personality') },
    microphone: { dispose: async () => disposed.push('microphone') },
    tts: { dispose: async () => disposed.push('tts') },
  };

  await disposeCameraSessionServices(session);

  assert.deepEqual(disposed, ['camera', 'anchor', 'personality', 'microphone', 'tts']);
});
