import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSClient } from './ttsClient.js';

test('ElevenLabs sessions are configured as voice conversations with WebRTC output analysis', () => {
  const client = new TTSClient({ agentId: 'agent_test' });
  const options = client._buildSessionOptions();

  assert.equal(options.agentId, 'agent_test');
  assert.equal(options.connectionType, 'webrtc');
  assert.equal(options.preferHeadphonesForIosDevices, true);
  assert.equal(typeof options.onModeChange, 'function');
});
