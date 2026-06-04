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
  assert.match(prompt, /Expressive cue: \[excited\]/);
  assert.match(prompt, /not a literal spoken word/);
  assert.match(prompt, /"\[excited\] Hey, look at me!"/);
  assert.doesNotMatch(prompt, /if it improves/);
});

test('stopping playback emits completion so facial animation can return to rest', () => {
  const client = new TTSClient({ agentId: 'agent_test' });
  const events = [];
  client.addListener({
    onPlaybackComplete: () => events.push('complete'),
  });

  client.conversation = {};
  client.isPlaying = true;
  client.stopCurrentAudio();

  assert.equal(client.isPlaying, false);
  assert.deepEqual(events, ['complete']);
});

test('sustained silent output completes playback when the agent does not emit listening mode', () => {
  const client = new TTSClient({
    agentId: 'agent_test',
    outputSilenceCompletionMs: 560,
  });
  const events = [];
  client.addListener({
    onAudioAnalysis: analysis => events.push(['analysis', analysis.energy]),
    onPlaybackComplete: () => events.push(['complete']),
  });

  client.conversation = {};
  client.isPlaying = true;
  client.currentRequestStart = 1000;
  client.currentRequest = { text: 'hello', voiceStyle: 'cheerful', emotionalDelivery: '' };
  client.speechStartedAt = 1000;
  client.lastOutputActivityAt = 1000;

  client._handleOutputAnalysis({ energy: 0.24, centroid: 800, spectrum: [] }, 1040);
  client._handleOutputAnalysis({ energy: 0, centroid: 0, spectrum: [] }, 1240);

  assert.equal(client.isPlaying, true);

  client._handleOutputAnalysis({ energy: 0, centroid: 0, spectrum: [] }, 1640);

  assert.equal(client.isPlaying, false);
  assert.deepEqual(events, [
    ['analysis', 0.24],
    ['analysis', 0],
    ['analysis', 0],
    ['complete'],
  ]);
});

test('output analysis errors complete playback so speech morphs cannot hang open', () => {
  const client = new TTSClient({ agentId: 'agent_test' });
  const events = [];
  client.addListener({
    onPlaybackComplete: () => events.push(['complete']),
    onError: ({ error }) => events.push(['error', error]),
  });

  client.conversation = {};
  client.isPlaying = true;
  client.currentRequestStart = 1000;
  client.currentRequest = { text: 'hello', voiceStyle: 'cheerful', emotionalDelivery: '' };

  client._handleOutputAnalysisError(new Error('output analyser failed'));

  assert.equal(client.isPlaying, false);
  assert.deepEqual(events, [
    ['complete'],
    ['error', 'output analyser failed'],
  ]);
});
