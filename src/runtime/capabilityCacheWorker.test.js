import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { listCapabilityPacks } from './capabilityPacks.js';

const WORKER_URL = new URL('../../public/sw.js', import.meta.url);
const ORIGIN = 'https://hol.test';
const CACHE_NAME = 'hol-capability-packs-v2';
const MIB = 1024 * 1024;

const requestUrl = (request) => (typeof request === 'string' ? request : request.url);

class MemoryCache {
  constructor({ failKeys = false, failPut = false } = {}) {
    this.entries = new Map();
    this.failKeys = failKeys;
    this.failPut = failPut;
  }

  async match(request) {
    return this.entries.get(requestUrl(request))?.clone();
  }

  async put(request, response) {
    if (this.failPut) {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    }
    const url = requestUrl(request);
    this.entries.delete(url);
    this.entries.set(url, response.clone());
  }

  async keys() {
    if (this.failKeys) {
      throw new DOMException('Cache unavailable', 'UnknownError');
    }
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async delete(request) {
    return this.entries.delete(requestUrl(request));
  }
}

class MemoryCacheStorage {
  constructor({ failCacheKeys = false, failPut = false, failKeys = false } = {}) {
    this.caches = new Map();
    this.failCacheKeys = failCacheKeys;
    this.failPut = failPut;
    this.failKeys = failKeys;
  }

  async open(name) {
    if (!this.caches.has(name)) {
      this.caches.set(
        name,
        new MemoryCache({
          failKeys: this.failCacheKeys,
          failPut: this.failPut,
        }),
      );
    }
    return this.caches.get(name);
  }

  async keys() {
    if (this.failKeys) {
      throw new DOMException('Cache storage unavailable', 'UnknownError');
    }
    return [...this.caches.keys()];
  }

  async delete(name) {
    return this.caches.delete(name);
  }
}

const createResponse = (label, bytes) =>
  new Response(label, {
    status: 200,
    headers: { 'content-length': String(bytes) },
  });

const loadWorker = async ({ caches = new MemoryCacheStorage(), fetchImpl } = {}) => {
  const source = await readFile(WORKER_URL, 'utf8');
  const listeners = new Map();
  const fetchCalls = [];
  let claimCalls = 0;
  const self = {
    location: { origin: ORIGIN },
    clients: {
      claim: async () => {
        claimCalls++;
      },
    },
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  const fetch = async (request) => {
    fetchCalls.push(requestUrl(request));
    return fetchImpl(request);
  };

  vm.runInNewContext(
    source,
    {
      self,
      caches,
      fetch,
      URL,
      Request,
      Response,
      DOMException,
      Promise,
    },
    { filename: WORKER_URL.pathname },
  );

  const dispatchFetch = async (url) => {
    let responsePromise = null;
    const lifetimePromises = [];
    listeners.get('fetch')({
      request: new Request(url),
      respondWith: (promise) => {
        responsePromise = Promise.resolve(promise);
      },
      waitUntil: (promise) => lifetimePromises.push(Promise.resolve(promise)),
    });
    assert.ok(responsePromise, `service worker did not handle ${url}`);
    const response = await responsePromise;
    await Promise.all(lifetimePromises);
    return response;
  };

  const dispatchActivate = async () => {
    const lifetimePromises = [];
    listeners.get('activate')({
      waitUntil: (promise) => lifetimePromises.push(Promise.resolve(promise)),
    });
    await Promise.all(lifetimePromises);
  };

  return {
    caches,
    dispatchActivate,
    dispatchFetch,
    fetchCalls,
    getClaimCalls: () => claimCalls,
  };
};

test('cache cleanup failure cannot prevent the active worker from claiming clients', async () => {
  const runtime = await loadWorker({
    caches: new MemoryCacheStorage({ failKeys: true }),
    fetchImpl: () => createResponse('unused', 1),
  });

  await runtime.dispatchActivate();

  assert.equal(runtime.getClaimCalls(), 1);
});

test('active-cache inspection failure cannot prevent the worker from claiming clients', async () => {
  const runtime = await loadWorker({
    caches: new MemoryCacheStorage({ failCacheKeys: true }),
    fetchImpl: () => createResponse('unused', 1),
  });

  await runtime.dispatchActivate();

  assert.equal(runtime.getClaimCalls(), 1);
});

test('capability cache admits every asset owned by the runtime manifest', async () => {
  const runtime = await loadWorker({
    fetchImpl: (request) => createResponse(requestUrl(request), 1),
  });
  const manifestAssets = new Map(
    listCapabilityPacks()
      .flatMap((pack) => pack.assets)
      .map((asset) => [asset.id, asset]),
  );
  const paths = [...manifestAssets.values()].map((asset) => {
    const sourceName = new URL(asset.url).pathname.split('/').at(-1);
    return `/assets/${sourceName}`;
  });

  for (const path of paths) {
    await runtime.dispatchFetch(`${ORIGIN}${path}`);
  }

  const cache = await runtime.caches.open(CACHE_NAME);
  assert.deepEqual(
    (await cache.keys()).map((request) => new URL(request.url).pathname),
    paths,
  );
});

test('a cache quota failure never replaces a successful network response', async () => {
  const caches = new MemoryCacheStorage({ failPut: true });
  const runtime = await loadWorker({
    caches,
    fetchImpl: () => createResponse('network-opencv', 10 * MIB),
  });

  const response = await runtime.dispatchFetch(`${ORIGIN}/assets/opencv-runtime.js`);

  assert.equal(await response.text(), 'network-opencv');
  assert.equal(runtime.fetchCalls.length, 1);
});

test('capability cache evicts oldest responses to enforce its byte budget', async () => {
  const caches = new MemoryCacheStorage();
  const cache = await caches.open(CACHE_NAME);
  const first = `${ORIGIN}/assets/opencv-first.js`;
  const second = `${ORIGIN}/assets/magic-touch-second.tflite`;
  const incoming = `${ORIGIN}/assets/depth-anything-third.onnx`;
  await cache.put(first, createResponse('first', 64 * MIB));
  await cache.put(second, createResponse('second', 64 * MIB));

  const runtime = await loadWorker({
    caches,
    fetchImpl: () => createResponse('incoming', 32 * MIB),
  });
  await runtime.dispatchFetch(incoming);

  assert.deepEqual(
    (await cache.keys()).map((request) => request.url),
    [second, incoming],
  );
});

test('parallel capability writes share one mutation owner and finish inside budget', async () => {
  const runtime = await loadWorker({
    fetchImpl: (request) => createResponse(requestUrl(request), 64 * MIB),
  });
  const urls = [
    `${ORIGIN}/assets/opencv-a.js`,
    `${ORIGIN}/assets/magic-touch-b.tflite`,
    `${ORIGIN}/assets/depth-anything-c.onnx`,
  ];

  await Promise.all(urls.map((url) => runtime.dispatchFetch(url)));

  const cache = await runtime.caches.open(CACHE_NAME);
  assert.deepEqual(
    (await cache.keys()).map((request) => request.url),
    urls.slice(1),
  );
});
