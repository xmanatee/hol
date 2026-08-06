import test from 'node:test';
import assert from 'node:assert/strict';
import { LazyTTSClient } from './lazyTTSClient.js';
import { SPEECH_INPUT_MAX_CHARACTERS } from '../contracts/objectContent.js';

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

class FakeTTSClient {
  constructor(config) {
    this.config = config;
    this.listeners = [];
    this.spoken = [];
    this.frame = { energy: 0.4, centroid: 0.7 };
  }

  addListener(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  async synthesizeSpeech(text, voiceStyle, emotionalDelivery) {
    this.spoken.push({ text, voiceStyle, emotionalDelivery });
    return true;
  }

  stopCurrentAudio() {
    this.stopped = true;
  }
  readFrame() {
    return this.frame;
  }
  getMetrics() {
    return { totalRequests: this.spoken.length };
  }
  async dispose() {
    this.disposed = true;
  }
}

const synthesizeTestSpeech = (client, text) =>
  client.synthesizeSpeech(text, 'cheerful', 'bright and playful');

test('lazy speech client does not load its runtime during listener registration or initialization', async () => {
  let loadCount = 0;
  const client = new LazyTTSClient({
    loadClient: async () => {
      loadCount++;
      return { TTSClient: FakeTTSClient };
    },
  });

  client.addListener({ onAudioStart: () => {} });
  assert.equal(client.initialize(), true);

  assert.equal(loadCount, 0);
  assert.equal(client.getMetrics().totalRequests, 0);
  assert.deepEqual(client.readFrame(), { energy: 0, centroid: 0 });
});

test('lazy speech client exposes the loaded analyser frame without a second scheduler', async () => {
  const client = new LazyTTSClient({ loadClient: async () => ({ TTSClient: FakeTTSClient }) });
  const realClient = await client._getClient();

  assert.equal(client.readFrame(), realClient.frame);
});

test('lazy speech client rejects ambiguous speech input before loading its runtime', () => {
  let loadCount = 0;
  const client = new LazyTTSClient({
    loadClient: async () => {
      loadCount++;
      return { TTSClient: FakeTTSClient };
    },
  });

  assert.throws(() => client.synthesizeSpeech(undefined), /must be a string/);
  assert.throws(() => client.synthesizeSpeech('  '), /must be non-empty/);
  assert.throws(() => client.synthesizeSpeech('hello'), /voice style must be a string/);
  assert.throws(() => client.synthesizeSpeech('hello', ''), /voice style must be non-empty/);
  assert.throws(() => client.synthesizeSpeech('hello', 'unknown', 'calm'), /unsupported voice style/);
  assert.throws(() => client.synthesizeSpeech('hello', 'wise'), /emotional delivery must be a string/);
  assert.throws(() => client.synthesizeSpeech('hello', 'wise', null), /emotional delivery/);
  assert.throws(() => client.synthesizeSpeech('hello', 'wise', '  '), /emotional delivery must be non-empty/);
  assert.throws(
    () => client.synthesizeSpeech('😀'.repeat(SPEECH_INPUT_MAX_CHARACTERS + 1), 'wise', 'calm and measured'),
    /Speech input must contain at most 240 characters/,
  );
  assert.equal(loadCount, 0);
});

test('lazy speech client loads once at synthesis and forwards queued listeners', async () => {
  let loadCount = 0;
  const client = new LazyTTSClient({
    baseUrl: 'http://127.0.0.1:8080/v1',
    loadClient: async () => {
      loadCount++;
      return { TTSClient: FakeTTSClient };
    },
  });
  const listener = { onAudioStart: () => {} };
  client.addListener(listener);

  await client.synthesizeSpeech('hello', 'dramatic', 'wide energy');
  await client.synthesizeSpeech('again', 'wise', 'calm');
  const realClient = await client._getClient();

  assert.equal(loadCount, 1);
  assert.deepEqual(realClient.listeners, [listener]);
  assert.equal(realClient.config.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(realClient.spoken.length, 2);
});

test('lazy speech client coalesces identical submissions before runtime load', async () => {
  const runtimeLoad = createDeferred();
  const client = new LazyTTSClient({ loadClient: () => runtimeLoad.promise });

  const first = client.synthesizeSpeech('hello', 'dramatic', 'wide energy');
  const duplicate = client.synthesizeSpeech('hello', 'dramatic', 'wide energy');

  assert.equal(first, duplicate);
  runtimeLoad.resolve({ TTSClient: FakeTTSClient });
  assert.equal(await first, true);
  const realClient = await client._getClient();
  assert.equal(realClient.spoken.length, 1);
});

test('stopping speech retires a synthesis queued behind lazy runtime loading', async () => {
  const runtimeLoad = createDeferred();
  const client = new LazyTTSClient({ loadClient: () => runtimeLoad.promise });

  const retired = synthesizeTestSpeech(client, 'old subject');
  await Promise.resolve();
  client.stopCurrentAudio();
  runtimeLoad.resolve({ TTSClient: FakeTTSClient });

  assert.equal(await retired, false);
  const realClient = await client._getClient();
  assert.deepEqual(realClient.spoken, []);
  assert.equal(await synthesizeTestSpeech(client, 'new subject'), true);
  assert.deepEqual(
    realClient.spoken.map((entry) => entry.text),
    ['new subject'],
  );
});

test('lazy speech disposal detaches listeners and releases the loaded client', async () => {
  const client = new LazyTTSClient({ loadClient: async () => ({ TTSClient: FakeTTSClient }) });
  client.addListener({ onAudioStart: () => {} });
  const realClient = await client._getClient();
  await client.dispose();

  assert.equal(realClient.disposed, true);
  assert.deepEqual(realClient.listeners, []);
  assert.equal(client.client, null);
  assert.equal(client.clientPromise, null);
});

test('lazy speech disposal invalidates a runtime load already in flight', async () => {
  let resolveRuntimeLoad;
  const client = new LazyTTSClient({
    loadClient: () =>
      new Promise((resolve) => {
        resolveRuntimeLoad = resolve;
      }),
  });

  const speech = synthesizeTestSpeech(client, 'hello');
  await Promise.resolve();
  await client.dispose();
  resolveRuntimeLoad({ TTSClient: FakeTTSClient });

  assert.equal(await speech, false);
  assert.equal(client.client, null);
});

test('lazy speech disposal wins a queued synthesis on an already loaded client', async () => {
  const client = new LazyTTSClient({ loadClient: async () => ({ TTSClient: FakeTTSClient }) });
  const realClient = await client._getClient();

  const speech = synthesizeTestSpeech(client, 'late speech');
  await client.dispose();

  assert.equal(await speech, false);
  assert.deepEqual(realClient.spoken, []);
  assert.equal(realClient.disposed, true);
});

test('lazy speech retries a transient rejected runtime load', async () => {
  let loadCount = 0;
  const client = new LazyTTSClient({
    loadClient: async () => {
      loadCount++;
      if (loadCount === 1) {
        throw new Error('transient chunk failure');
      }
      return { TTSClient: FakeTTSClient };
    },
  });

  await assert.rejects(() => synthesizeTestSpeech(client, 'first'), /transient chunk failure/);
  assert.equal(client.clientPromise, null);
  assert.equal(await synthesizeTestSpeech(client, 'second'), true);
  assert.equal(loadCount, 2);
});
