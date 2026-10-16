import assert from 'node:assert/strict';
import test from 'node:test';
import { LazyPersonalityService } from './lazyPersonalityService.js';
import { LazyTTSClient } from '../audio/lazyTTSClient.js';
import { SPEECH_INPUT_MAX_CHARACTERS } from '../contracts/objectContent.js';

const adapters = [
  {
    name: 'personality',
    exportName: 'PersonalityService',
    create: (load) => new LazyPersonalityService({ loadService: load, baseUrl: 'http://localhost:8080' }),
    request: (service, text) => service.generatePersonality({ text }, { label: text }),
    reset: (service) => service.resetSubject(),
    cancelled: null,
  },
  {
    name: 'speech',
    exportName: 'TTSClient',
    create: (load) => new LazyTTSClient({ loadClient: load, baseUrl: 'http://localhost:8080' }),
    request: (service, text) => service.synthesizeSpeech(text, 'cheerful', 'bright and playful'),
    reset: (service) => service.stopCurrentAudio(),
    cancelled: false,
  },
];

const createRuntime = (exportName) => {
  const calls = [];
  const configs = [];
  const listeners = new Set();
  let disposals = 0;
  let resets = 0;
  const emit = (text) =>
    listeners.forEach((listener) => {
      listener.onResult(text);
    });
  class Runtime {
    constructor(config) {
      configs.push(config);
    }
    addListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    generatePersonality(imageData, bbox) {
      calls.push({ imageData, bbox });
      emit(imageData.text);
      return Promise.resolve({ tone: bbox.label });
    }
    synthesizeSpeech(text, voiceStyle, emotionalDelivery) {
      calls.push({ text, voiceStyle, emotionalDelivery });
      emit(text);
      return Promise.resolve(true);
    }
    resetSubject() {
      resets++;
    }
    stopCurrentAudio() {
      resets++;
    }
    getMetrics() {
      return { totalRequests: calls.length };
    }
    readFrame() {
      return { energy: 0.4, centroid: 0.7 };
    }
    dispose() {
      disposals++;
    }
  }
  return {
    module: { [exportName]: Runtime },
    calls,
    configs,
    emit,
    get disposals() {
      return disposals;
    },
    get resets() {
      return resets;
    },
  };
};

for (const adapter of adapters) {
  test(`lazy ${adapter.name} stays cold until a request and loads once for concurrent callers`, async () => {
    const runtime = createRuntime(adapter.exportName);
    let loads = 0;
    const service = adapter.create(async () => {
      loads++;
      return runtime.module;
    });
    const results = [];
    service.addListener({ onResult: (text) => results.push(text) });
    assert.equal(service.getMetrics().totalRequests, 0);
    adapter.reset(service);
    assert.equal(loads, 0);
    await Promise.all([adapter.request(service, 'first'), adapter.request(service, 'second')]);
    assert.equal(loads, 1);
    assert.deepEqual(results, ['first', 'second']);
    assert.equal(runtime.configs.length, 1);
    assert.deepEqual(runtime.configs[0], { baseUrl: 'http://localhost:8080' });
    assert.equal(service.getMetrics().totalRequests, 2);
    await service.dispose();
  });

  test(`lazy ${adapter.name} subscriptions can be removed before loading, during loading, and after loading`, async () => {
    const runtime = createRuntime(adapter.exportName);
    const load = Promise.withResolvers();
    const service = adapter.create(() => load.promise);
    const results = [];
    const listener = { onResult: (text) => results.push(text) };
    service.addListener(listener)();
    const request = adapter.request(service, 'first');
    service.addListener(listener)();
    load.resolve(runtime.module);
    await request;
    assert.deepEqual(results, []);
    const remove = service.addListener(listener);
    service.addListener(listener);
    await adapter.request(service, 'second');
    remove();
    remove();
    await adapter.request(service, 'third');
    assert.deepEqual(results, ['second']);
    service.addListener(listener);
    remove();
    await adapter.request(service, 'resubscribed');
    assert.deepEqual(results, ['second', 'resubscribed']);
    await service.dispose();
    runtime.emit('after disposal');
    assert.deepEqual(results, ['second', 'resubscribed']);
    assert.equal(runtime.disposals, 1);
    await service.dispose();
    assert.equal(runtime.disposals, 1);
    assert.throws(() => service.addListener(listener), /disposed/);
  });

  test(`lazy ${adapter.name} reset retires queued work without retiring the runtime`, async () => {
    const runtime = createRuntime(adapter.exportName);
    const load = Promise.withResolvers();
    const service = adapter.create(() => load.promise);
    const retired = adapter.request(service, 'old');
    adapter.reset(service);
    load.resolve(runtime.module);
    assert.equal(await retired, adapter.cancelled);
    assert.deepEqual(runtime.calls, []);
    await adapter.request(service, 'new');
    assert.equal(runtime.calls.length, 1);
    adapter.reset(service);
    assert.equal(runtime.resets, 1);
    await service.dispose();
  });

  for (const loaded of [false, true]) {
    test(`lazy ${adapter.name} disposal wins queued work with a ${loaded ? 'loaded' : 'pending'} runtime`, async () => {
      const runtime = createRuntime(adapter.exportName);
      const load = Promise.withResolvers();
      const service = adapter.create(() => load.promise);
      if (loaded) {
        load.resolve(runtime.module);
        await adapter.request(service, 'before');
      }
      const retired = adapter.request(service, 'retired');
      await service.dispose();
      load.resolve(runtime.module);
      assert.equal(await retired, adapter.cancelled);
      assert.equal(await adapter.request(service, 'after'), adapter.cancelled);
      assert.equal(runtime.configs.length, loaded ? 1 : 0);
      assert.equal(runtime.calls.length, loaded ? 1 : 0);
      assert.equal(runtime.disposals, loaded ? 1 : 0);
      assert.equal(service.getMetrics().totalRequests, 0);
    });
  }

  test(`lazy ${adapter.name} shares load failures, surfaces the cause, and retries only on request`, async () => {
    const runtime = createRuntime(adapter.exportName);
    const load = Promise.withResolvers();
    const failure = new Error('runtime unavailable');
    let loads = 0;
    const service = adapter.create(() => (++loads === 1 ? load.promise : Promise.resolve(runtime.module)));
    const first = adapter.request(service, 'first');
    const second = adapter.request(service, 'second');
    load.reject(failure);
    for (const result of await Promise.allSettled([first, second])) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason, failure);
    }
    assert.equal(loads, 1);
    await adapter.request(service, 'retry');
    assert.equal(loads, 2);
    assert.equal(runtime.calls.length, 1);
    await service.dispose();
  });

  test(`lazy ${adapter.name} rejects invalid loaders and malformed runtime exports explicitly`, async () => {
    for (const load of [null, false, 42, {}]) {
      assert.throws(() => adapter.create(load), /runtime loader must be a function/);
    }
    const service = adapter.create(async () => ({}));
    await assert.rejects(() => adapter.request(service, 'request'), /runtime must export/);
    await service.dispose();
  });
}

test('lazy speech validates input before loading, coalesces identical work, and exposes analyser frames', async () => {
  const runtime = createRuntime('TTSClient');
  let loads = 0;
  const client = new LazyTTSClient({
    loadClient: async () => {
      loads++;
      return runtime.module;
    },
  });
  assert.equal(client.initialize(), true);
  assert.deepEqual(client.readFrame(), { energy: 0, centroid: 0 });
  for (const args of [
    [undefined],
    ['  '],
    ['hello'],
    ['hello', ''],
    ['hello', 'unknown', 'calm'],
    ['hello', 'wise'],
    ['hello', 'wise', null],
    ['hello', 'wise', '  '],
    ['😀'.repeat(SPEECH_INPUT_MAX_CHARACTERS + 1), 'wise', 'calm'],
  ]) {
    assert.throws(() => client.synthesizeSpeech(...args), /must|unsupported/);
  }
  assert.equal(loads, 0);
  const first = client.synthesizeSpeech(' hello ', 'cheerful', 'bright and playful');
  assert.equal(first, adapters[1].request(client, 'hello'));
  assert.equal(await first, true);
  assert.deepEqual(runtime.calls, [
    { text: 'hello', voiceStyle: 'cheerful', emotionalDelivery: 'bright and playful' },
  ]);
  assert.deepEqual(client.readFrame(), { energy: 0.4, centroid: 0.7 });
  await client.dispose();
  assert.equal(client.initialize(), false);
  assert.deepEqual(client.readFrame(), { energy: 0, centroid: 0 });
});

test('lazy personality validates platform collaborators before loading', () => {
  for (const config of [null, []]) {
    assert.throws(() => new LazyPersonalityService(config), /config must be an object/);
  }
  assert.throws(() => new LazyPersonalityService({ createImageBitmap: null }), /must be a function/);
  assert.throws(() => new LazyPersonalityService({ createCanvas: {} }), /must be a function/);
});

test('default lazy personality forwards real runtime failures, events, state, and metrics', async () => {
  const failure = new Error('native image crop failed');
  const events = [];
  const service = new LazyPersonalityService({
    createImageBitmap: async () => {
      throw failure;
    },
  });
  service.addListener({
    onPersonalityStart: () => events.push('started'),
    onPersonalityGenerated: ({ error }) => events.push(error),
  });
  assert.equal(service.isProcessing, false);
  assert.equal(service.lastPersona, null);
  const request = service.generatePersonality(
    { width: 2, height: 2, data: new Uint8ClampedArray(16) },
    { x: 0, y: 0, width: 2, height: 2 },
  );
  await assert.rejects(request, (error) => error === failure);
  assert.deepEqual(events, ['started', failure.message]);
  assert.equal(service.isProcessing, false);
  assert.equal(service.lastPersona, null);
  assert.equal(service.getMetrics().failedRequests, 1);
  service.dispose();
});

test('default lazy speech surfaces runtime configuration errors without starting playback', async () => {
  const client = new LazyTTSClient({ model: '', voice: '' });
  await assert.rejects(() => adapters[1].request(client, 'hello'), /Set VITE_LOCAL_AI_TTS_MODEL/);
  assert.equal(client.getMetrics().totalRequests, 0);
  assert.deepEqual(client.readFrame(), { energy: 0, centroid: 0 });
  await client.dispose();
});
