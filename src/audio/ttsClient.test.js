import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '@elevenlabs/client';
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

const flushAsyncStart = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test('startConversation shares a single in-flight ElevenLabs WebRTC session', async (t) => {
  const originalStartSession = Conversation.startSession;
  t.after(() => {
    Conversation.startSession = originalStartSession;
  });
  let startCalls = 0;
  let releaseStart;
  const session = { sendUserMessage() {} };
  const startGate = new Promise(resolve => {
    releaseStart = resolve;
  });

  Conversation.startSession = async () => {
    startCalls++;
    await startGate;
    return session;
  };

  const client = new TTSClient({ agentId: 'agent_test' });
  client._ensureAudioContextReady = async () => {};
  client.requestMicrophoneAccess = async () => {};

  const firstStart = client.startConversation();
  const secondStart = client.startConversation();
  await flushAsyncStart();

  assert.equal(startCalls, 1);

  releaseStart();
  const [firstSession, secondSession] = await Promise.all([firstStart, secondStart]);

  assert.equal(firstSession, session);
  assert.equal(secondSession, session);
  assert.equal(client.conversation, session);
  assert.equal(startCalls, 1);

});

test('startConversation clears failed setup promises so the next attempt can retry', async () => {
  const client = new TTSClient({ agentId: 'agent_test' });
  let attempts = 0;

  client._ensureAudioContextReady = async () => {};
  client.requestMicrophoneAccess = async () => {
    attempts++;
    throw new Error('microphone denied');
  };

  await assert.rejects(() => client.startConversation(), /microphone denied/);
  assert.equal(client.conversationPromise, null);

  await assert.rejects(() => client.startConversation(), /microphone denied/);
  assert.equal(attempts, 2);
});

test('synthesizeSpeech waits for the in-flight conversation instead of opening another room', async (t) => {
  const originalStartSession = Conversation.startSession;
  t.after(() => {
    Conversation.startSession = originalStartSession;
  });
  let startCalls = 0;
  let releaseStart;
  const messages = [];
  const session = {
    sendUserMessage(message) {
      messages.push(message);
    }
  };
  const startGate = new Promise(resolve => {
    releaseStart = resolve;
  });

  Conversation.startSession = async () => {
    startCalls++;
    await startGate;
    return session;
  };

  const client = new TTSClient({ agentId: 'agent_test' });
  client._ensureAudioContextReady = async () => {};
  client.requestMicrophoneAccess = async () => {};

  const firstStart = client.startConversation();
  const speech = client.synthesizeSpeech('hello there', 'cheerful', 'warm');
  await flushAsyncStart();

  assert.equal(startCalls, 1);

  releaseStart();
  await firstStart;
  await speech;

  assert.equal(startCalls, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /hello there/);

});
