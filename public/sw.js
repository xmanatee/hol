const CAPABILITY_CACHE_PREFIX = 'hol-capability-packs-';
const CAPABILITY_CACHE = 'hol-capability-packs-v2';
const MAX_CAPABILITY_ENTRIES = 16;
const MAX_CAPABILITY_BYTES = 144 * 1024 * 1024;
const CAPABILITY_ASSET =
  /\/assets\/.*(?:opencv|magic-touch|depth-anything|xfeat_backbone|head|ort-wasm|vision_wasm).*/;
let cacheMutationTail = Promise.resolve();

const enqueueCacheMutation = (operation) => {
  const result = cacheMutationTail.then(operation);
  cacheMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const responseByteLength = (response) => {
  const header = response.headers.get('content-length');
  if (!header || !/^\d+$/.test(header)) {
    return null;
  }

  const bytes = Number(header);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
};

const readCacheEntries = async (cache) => {
  const keys = await cache.keys();
  const entries = [];

  for (const request of keys) {
    const response = await cache.match(request);
    if (!response) {
      continue;
    }

    const bytes = responseByteLength(response);
    if (bytes === null) {
      await cache.delete(request);
      continue;
    }

    entries.push({ request, bytes });
  }

  return entries;
};

const makeCacheRoom = async (cache, incomingBytes, incomingEntries) => {
  const entries = await readCacheEntries(cache);
  let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  let totalEntries = entries.length;

  while (
    entries.length > 0 &&
    (totalBytes + incomingBytes > MAX_CAPABILITY_BYTES ||
      totalEntries + incomingEntries > MAX_CAPABILITY_ENTRIES)
  ) {
    const oldest = entries.shift();
    if (await cache.delete(oldest.request)) {
      totalBytes -= oldest.bytes;
      totalEntries--;
    }
  }

  return (
    totalBytes + incomingBytes <= MAX_CAPABILITY_BYTES &&
    totalEntries + incomingEntries <= MAX_CAPABILITY_ENTRIES
  );
};

const storeCapabilityResponse = (cache, request, response) => {
  const bytes = responseByteLength(response);
  if (bytes === null || bytes > MAX_CAPABILITY_BYTES) {
    return Promise.resolve(false);
  }

  return enqueueCacheMutation(async () => {
    const cached = await cache.match(request);
    if (cached) {
      return true;
    }

    if (!(await makeCacheRoom(cache, bytes, 1))) {
      return false;
    }

    return cache.put(request, response).then(
      () => true,
      () => false,
    );
  }).then(
    (result) => result,
    () => false,
  );
};

const createCapabilityResponse = async (request) => {
  const cache = await caches.open(CAPABILITY_CACHE).then(
    (openedCache) => openedCache,
    () => null,
  );

  if (!cache) {
    return {
      response: await fetch(request),
      cacheCompletion: Promise.resolve(false),
    };
  }

  const cached = await cache.match(request).then(
    (cachedResponse) => cachedResponse,
    () => null,
  );
  if (cached) {
    return {
      response: cached,
      cacheCompletion: Promise.resolve(true),
    };
  }

  const response = await fetch(request);
  const cacheResponse = response.ok ? response.clone() : null;
  return {
    response,
    cacheCompletion: response.ok
      ? storeCapabilityResponse(cache, request, cacheResponse)
      : Promise.resolve(false),
  };
};

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then(
        (names) => names,
        () => [],
      )
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CAPABILITY_CACHE_PREFIX) && name !== CAPABILITY_CACHE)
            .map((name) =>
              caches.delete(name).then(
                (deleted) => deleted,
                () => false,
              ),
            ),
        ),
      )
      .then(() =>
        caches.open(CAPABILITY_CACHE).then(
          (cache) =>
            enqueueCacheMutation(() => makeCacheRoom(cache, 0, 0)).then(
              (trimmed) => trimmed,
              () => false,
            ),
          () => false,
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !CAPABILITY_ASSET.test(url.pathname)
  ) {
    return;
  }

  const outcome = createCapabilityResponse(request);
  event.respondWith(outcome.then((result) => result.response));
  event.waitUntil(
    outcome.then(
      (result) => result.cacheCompletion,
      () => undefined,
    ),
  );
});
