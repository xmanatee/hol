import assert from 'node:assert/strict';
import test from 'node:test';
import { LazyPersonalityService } from './lazyPersonalityService.js';

const EMPTY_METRICS = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  cancelledRequests: 0,
  averageRTT: 0,
  lastRTT: 0,
  successRate: 0,
};

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class FakePersonalityService {
  constructor(config) {
    this.config = config;
    this.listeners = [];
    this.requests = [];
    this.resetCount = 0;
    this.disposed = false;
  }

  addListener(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  async generatePersonality(imageData, bbox) {
    this.requests.push({ imageData, bbox });
    return { tone: bbox.label };
  }

  resetSubject() {
    this.resetCount++;
  }

  getMetrics() {
    return { ...EMPTY_METRICS, totalRequests: this.requests.length };
  }

  dispose() {
    this.disposed = true;
  }
}

test('lazy personality keeps optional AI code out of listener registration and idle metrics', () => {
  let loadCount = 0;
  const service = new LazyPersonalityService({
    loadService: async () => {
      loadCount++;
      return { PersonalityService: FakePersonalityService };
    },
  });

  service.addListener({ onPersonalityStart() {} });

  assert.equal(loadCount, 0);
  assert.deepEqual(service.getMetrics(), EMPTY_METRICS);
});

test('lazy personality loads once on first request and forwards config and listeners', async () => {
  let loadCount = 0;
  const listener = { onPersonalityGenerated() {} };
  const service = new LazyPersonalityService({
    baseUrl: 'http://127.0.0.1:8080/v1',
    loadService: async () => {
      loadCount++;
      return { PersonalityService: FakePersonalityService };
    },
  });
  service.addListener(listener);

  const first = await service.generatePersonality({ id: 'first' }, { label: 'first' });
  const second = await service.generatePersonality({ id: 'second' }, { label: 'second' });
  const loaded = await service._getService();

  assert.equal(loadCount, 1);
  assert.deepEqual(first, { tone: 'first' });
  assert.deepEqual(second, { tone: 'second' });
  assert.equal(loaded.config.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.deepEqual(loaded.listeners, [listener]);
  assert.equal(service.getMetrics().totalRequests, 2);
});

test('reset retires a personality request queued behind runtime loading', async () => {
  const runtimeLoad = createDeferred();
  const service = new LazyPersonalityService({ loadService: () => runtimeLoad.promise });

  const retired = service.generatePersonality({ id: 'old' }, { label: 'old' });
  service.resetSubject();
  runtimeLoad.resolve({ PersonalityService: FakePersonalityService });

  assert.equal(await retired, null);
  const loaded = await service._getService();
  assert.deepEqual(loaded.requests, []);

  assert.deepEqual(await service.generatePersonality({ id: 'new' }, { label: 'new' }), {
    tone: 'new',
  });
  assert.equal(loaded.requests.length, 1);
});

test('dispose wins a personality request queued behind runtime loading', async () => {
  const runtimeLoad = createDeferred();
  const service = new LazyPersonalityService({ loadService: () => runtimeLoad.promise });

  const retired = service.generatePersonality({ id: 'late' }, { label: 'late' });
  service.dispose();
  runtimeLoad.resolve({ PersonalityService: FakePersonalityService });

  assert.equal(await retired, null);
  assert.equal(service.service, null);
  assert.equal(service.servicePromise, null);
  assert.deepEqual(service.getMetrics(), EMPTY_METRICS);
});

test('lazy personality retries a rejected runtime load', async () => {
  let loadCount = 0;
  const service = new LazyPersonalityService({
    loadService: async () => {
      loadCount++;
      if (loadCount === 1) {
        throw new Error('transient personality chunk failure');
      }
      return { PersonalityService: FakePersonalityService };
    },
  });

  await assert.rejects(
    () => service.generatePersonality({ id: 'first' }, { label: 'first' }),
    /transient personality chunk failure/,
  );
  assert.equal(service.servicePromise, null);
  assert.deepEqual(await service.generatePersonality({ id: 'second' }, { label: 'second' }), {
    tone: 'second',
  });
  assert.equal(loadCount, 2);
});

test('lazy personality disposal detaches listeners and releases a loaded service', async () => {
  const listener = { onPersonalityStart() {} };
  const service = new LazyPersonalityService({
    loadService: async () => ({ PersonalityService: FakePersonalityService }),
  });
  const removeListener = service.addListener(listener);
  const loaded = await service._getService();
  removeListener();
  service.dispose();

  assert.deepEqual(loaded.listeners, []);
  assert.equal(loaded.disposed, true);
  assert.equal(service.service, null);
});

test('listener removal before runtime loading leaves no deferred subscription', async () => {
  const listener = { onPersonalityStart() {} };
  const service = new LazyPersonalityService({
    loadService: async () => ({ PersonalityService: FakePersonalityService }),
  });
  const removeListener = service.addListener(listener);
  removeListener();

  const loaded = await service._getService();

  assert.deepEqual(loaded.listeners, []);
});

test('loaded personality reset is forwarded to the single runtime owner', async () => {
  const service = new LazyPersonalityService({
    loadService: async () => ({ PersonalityService: FakePersonalityService }),
  });
  const loaded = await service._getService();

  service.resetSubject();

  assert.equal(loaded.resetCount, 1);
});

test('lazy personality rejects a malformed runtime module explicitly', async () => {
  const service = new LazyPersonalityService({ loadService: async () => ({}) });

  await assert.rejects(
    () => service.generatePersonality({ id: 'first' }, { label: 'first' }),
    /Personality runtime must export PersonalityService/,
  );
  assert.equal(service.servicePromise, null);
});

test('lazy personality rejects an invalid runtime loader at construction', () => {
  assert.throws(
    () => new LazyPersonalityService({ loadService: null }),
    /Personality runtime loader must be a function/,
  );
});

test('lazy personality rejects invalid platform collaborators before loading runtime code', () => {
  let loadCount = 0;
  const loadService = async () => {
    loadCount++;
    return { PersonalityService: FakePersonalityService };
  };

  assert.throws(
    () => new LazyPersonalityService({ loadService, createImageBitmap: null }),
    /Personality createImageBitmap must be a function/,
  );
  assert.throws(
    () => new LazyPersonalityService({ loadService, createCanvas: {} }),
    /Personality createCanvas must be a function/,
  );
  assert.equal(loadCount, 0);
});

test('lazy personality requires an unambiguous object config', () => {
  assert.throws(() => new LazyPersonalityService(null), /config must be an object/);
  assert.throws(() => new LazyPersonalityService([]), /config must be an object/);
});
