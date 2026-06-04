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
  assert.equal(typeof options.onAudioAlignment, 'function');
});

test('speech prompts carry explicit emotional delivery instructions', () => {
  const client = new TTSClient({ agentId: 'agent_test' });
  const prompt = client.buildExpressivePrompt(
    'Hey, look at me!',
    'dramatic',
    'big theatrical confidence with a little suspense'
  );

  assert.match(prompt, /Speak exactly this line/);
  assert.match(prompt, /big theatrical confidence/);
  assert.match(prompt, /\[excited\]/);
  assert.match(prompt, /"Hey, look at me!"/);
});
