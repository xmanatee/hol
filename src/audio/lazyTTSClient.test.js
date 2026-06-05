import test from 'node:test';
import assert from 'node:assert/strict';
import { LazyTTSClient } from './lazyTTSClient.js';

class FakeTTSClient {
  constructor(config) {
    this.config = config;
    this.listeners = [];
    this.started = false;
    this.spoken = [];
    this.stopped = false;
  }

  addListener(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(candidate => candidate !== listener);
    };
  }

  async initialize() {
    this.initialized = true;
  }

  async startConversation() {
    this.started = true;
  }

  async synthesizeSpeech(text, voiceStyle, emotionalDelivery) {
    this.spoken.push({ text, voiceStyle, emotionalDelivery });
    return true;
  }

  stopCurrentAudio() {
    this.stopped = true;
  }

  getMetrics() {
    return { totalRequests: this.spoken.length };
  }

  async dispose() {
    this.disposed = true;
  }
}

test('lazy TTS client does not load ElevenLabs runtime during listener registration or initialization', async () => {
  let loadCount = 0;
  const client = new LazyTTSClient({
    agentId: 'agent_test',
    loadClient: async () => {
      loadCount++;
      return { TTSClient: FakeTTSClient };
    }
  });

  client.addListener({ onAudioStart: () => {} });
  await client.initialize();

  assert.equal(loadCount, 0);
  assert.deepEqual(client.getMetrics(), {
    totalRequests: 0,
    successfulRequests: 0,
    averageLatency: 0,
    lastLatency: 0,
    successRate: 0
  });
});

test('lazy TTS client keeps the environment agent id when config agent id is undefined', () => {
  const client = new LazyTTSClient({
    agentId: undefined,
    loadClient: async () => ({ TTSClient: FakeTTSClient })
  });

  assert.equal(client.config.agentId, import.meta.env?.VITE_ELEVENLABS_AGENT_ID);
});

test('lazy TTS client loads once at the conversation boundary and forwards existing listeners', async () => {
  let loadCount = 0;
  const client = new LazyTTSClient({
    agentId: 'agent_test',
    loadClient: async () => {
      loadCount++;
      return { TTSClient: FakeTTSClient };
    }
  });
  const listener = { onAudioStart: () => {} };

  client.addListener(listener);
  await client.startConversation();
  await client.synthesizeSpeech('hello', 'dramatic', 'wide energy');

  const realClient = await client._getClient();
  assert.equal(loadCount, 1);
  assert.equal(realClient.started, true);
  assert.deepEqual(realClient.listeners, [listener]);
  assert.deepEqual(realClient.spoken, [
    { text: 'hello', voiceStyle: 'dramatic', emotionalDelivery: 'wide energy' }
  ]);
});

test('lazy TTS client removes queued listeners before runtime load', async () => {
  const listener = { onAudioStart: () => {} };
  const client = new LazyTTSClient({
    agentId: 'agent_test',
    loadClient: async () => ({ TTSClient: FakeTTSClient })
  });

  const removeListener = client.addListener(listener);
  removeListener();
  await client.startConversation();

  const realClient = await client._getClient();
  assert.deepEqual(realClient.listeners, []);
});
