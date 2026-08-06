import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalityService } from './PersonalityService.js';

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flushPipeline = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const visionResult = (label) => ({
  category: label,
  description: `${label} description`,
  brandOrTitle: label,
  textSnippets: [],
  colors: [],
  materials: [],
});

const personaResult = (label) => ({
  voiceStyle: 'dramatic',
  facialExpression: 'dramatic',
  emotionalDelivery: `${label} delivery`,
  animationIntensity: 0.8,
  tone: label,
  quirks: [label],
  oneLiners: [`Hello from ${label}`],
});

const createService = ({ visionClient, llmClient }) => {
  const service = new PersonalityService();
  service.visionClient = visionClient;
  service.llmClient = llmClient;
  service.extractROI = async () => new Blob(['object'], { type: 'image/jpeg' });
  return service;
};

test('personality disposal aborts vision and prevents the persona stage', async () => {
  const vision = createDeferred();
  let visionSignal = null;
  let personaCalls = 0;
  const service = createService({
    visionClient: {
      identifyObject: async (_blob, { signal } = {}) => {
        visionSignal = signal;
        return await vision.promise;
      },
    },
    llmClient: {
      generatePersona: async () => {
        personaCalls++;
        return personaResult('retired');
      },
    },
  });

  const personality = service.generatePersonality({}, {});
  await flushPipeline();
  service.dispose();

  assert.equal(visionSignal.aborted, true);
  vision.resolve(visionResult('retired'));

  assert.equal(await personality, null);
  assert.equal(personaCalls, 0);
  assert.equal(service.lastPersona, null);
  assert.equal(service.getMetrics().cancelledRequests, 1);
  assert.equal(service.getMetrics().failedRequests, 0);
});

test('personality disposal during crop prevents all network stages', async () => {
  const crop = createDeferred();
  let visionCalls = 0;
  let personaCalls = 0;
  const service = createService({
    visionClient: {
      identifyObject: async () => {
        visionCalls++;
        return visionResult('retired');
      },
    },
    llmClient: {
      generatePersona: async () => {
        personaCalls++;
        return personaResult('retired');
      },
    },
  });
  service.extractROI = () => crop.promise;

  const personality = service.generatePersonality({}, {});
  service.dispose();
  crop.resolve(new Blob(['object'], { type: 'image/jpeg' }));

  assert.equal(await personality, null);
  assert.equal(visionCalls, 0);
  assert.equal(personaCalls, 0);
  assert.equal(service.getMetrics().cancelledRequests, 1);
});

test('only the newest personality request can publish an out-of-order LLM result', async () => {
  const personaRequests = [];
  let visionCount = 0;
  const generated = [];
  const service = createService({
    visionClient: {
      identifyObject: async (_blob, { signal } = {}) => {
        visionCount++;
        return { ...visionResult(visionCount === 1 ? 'first' : 'second'), signal };
      },
    },
    llmClient: {
      generatePersona: (visionData, { signal } = {}) => {
        const response = createDeferred();
        personaRequests.push({ visionData, signal, response });
        return response.promise;
      },
    },
  });
  service.addListener({
    onPersonalityGenerated: (event) => generated.push(event.persona?.tone || event.error),
  });

  const first = service.generatePersonality({}, {});
  await flushPipeline();
  const second = service.generatePersonality({}, {});
  await flushPipeline();

  assert.equal(personaRequests.length, 2);
  assert.equal(personaRequests[0].signal.aborted, true);
  assert.equal(personaRequests[1].signal.aborted, false);

  personaRequests[1].response.resolve(personaResult('second'));
  assert.equal((await second).tone, 'second');
  personaRequests[0].response.resolve(personaResult('first'));
  assert.equal(await first, null);

  assert.equal(service.lastPersona.tone, 'second');
  assert.deepEqual(generated, ['second']);
  assert.equal(service.isProcessing, false);
  assert.equal(service.getMetrics().successfulRequests, 1);
  assert.equal(service.getMetrics().cancelledRequests, 1);
});

test('resetting the personality subject retires active work and clears completed persona state', async () => {
  const vision = createDeferred();
  let visionSignal = null;
  const generated = [];
  const service = createService({
    visionClient: {
      identifyObject: async (_blob, { signal } = {}) => {
        visionSignal = signal;
        return await vision.promise;
      },
    },
    llmClient: { generatePersona: async () => personaResult('retired') },
  });
  service.lastPersona = personaResult('previous');
  service.addListener({
    onPersonalityGenerated: (event) => generated.push(event),
  });

  const personality = service.generatePersonality({}, {});
  await flushPipeline();
  service.resetSubject();

  assert.equal(visionSignal.aborted, true);
  assert.equal(service.lastPersona, null);
  assert.equal(service.isProcessing, false);

  vision.resolve(visionResult('retired'));
  assert.equal(await personality, null);
  assert.deepEqual(generated, []);
});

test('current personality failures remain explicit and observable', async () => {
  const generated = [];
  const service = createService({
    visionClient: {
      identifyObject: async () => {
        throw new Error('vision unavailable');
      },
    },
    llmClient: { generatePersona: async () => personaResult('unused') },
  });
  service.addListener({ onPersonalityGenerated: (event) => generated.push(event) });

  await assert.rejects(() => service.generatePersonality({}, {}), /vision unavailable/);

  assert.equal(service.isProcessing, false);
  assert.equal(service.getMetrics().failedRequests, 1);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].success, false);
  assert.equal(generated[0].error, 'vision unavailable');
});

test('disposed personality service is terminal', async () => {
  let visionCalls = 0;
  const service = createService({
    visionClient: {
      identifyObject: async () => {
        visionCalls++;
        return visionResult('unused');
      },
    },
    llmClient: { generatePersona: async () => personaResult('unused') },
  });
  service.dispose();

  assert.equal(await service.generatePersonality({}, {}), null);
  assert.equal(visionCalls, 0);
  assert.equal(service.getMetrics().totalRequests, 0);
});

test('personality crop uses one clipped resized ImageBitmap and releases native resources', async () => {
  const bitmap = {
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
  };
  const bitmapCalls = [];
  const canvasStates = [];
  const drawCalls = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (...args) => drawCalls.push(args) }),
    toBlob(callback, type, quality) {
      canvasStates.push({ width: this.width, height: this.height, type, quality });
      callback(new Blob(['crop'], { type }));
    },
  };
  const service = new PersonalityService({
    createImageBitmap: async (...args) => {
      bitmapCalls.push(args);
      return bitmap;
    },
    createCanvas: () => canvas,
  });
  const imageData = {
    width: 100,
    height: 80,
    data: new Uint8ClampedArray(100 * 80 * 4),
  };

  const blob = await service.extractROI(
    imageData,
    { x: 90, y: 70, width: 20, height: 20 },
    { signal: new AbortController().signal },
  );

  assert.equal(blob.type, 'image/jpeg');
  assert.deepEqual(bitmapCalls, [
    [imageData, 88, 68, 12, 12, { resizeWidth: 12, resizeHeight: 12, resizeQuality: 'high' }],
  ]);
  assert.deepEqual(drawCalls, [[bitmap, 0, 0, 12, 12]]);
  assert.deepEqual(canvasStates, [{ width: 12, height: 12, type: 'image/jpeg', quality: 0.82 }]);
  assert.equal(bitmap.closeCalls, 1);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
});

test('personality crop cancellation releases a bitmap completed after retirement', async () => {
  const bitmapResult = createDeferred();
  const bitmap = {
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
  };
  let canvasCalls = 0;
  const service = new PersonalityService({
    createImageBitmap: () => bitmapResult.promise,
    createCanvas: () => {
      canvasCalls++;
      return {};
    },
  });
  const controller = new AbortController();
  const crop = service.extractROI(
    { width: 2, height: 2, data: new Uint8ClampedArray(16) },
    { x: 0, y: 0, width: 2, height: 2 },
    { signal: controller.signal },
  );

  controller.abort(new DOMException('crop retired', 'AbortError'));
  bitmapResult.resolve(bitmap);

  await assert.rejects(() => crop, /crop retired/);
  assert.equal(bitmap.closeCalls, 1);
  assert.equal(canvasCalls, 0);
});

test('personality crop cancellation wins native JPEG encoding and clears its canvas', async () => {
  let finishEncoding = null;
  const bitmap = { close() {} };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob(callback) {
      finishEncoding = callback;
    },
  };
  const service = new PersonalityService({
    createImageBitmap: async () => bitmap,
    createCanvas: () => canvas,
  });
  const controller = new AbortController();
  const crop = service.extractROI(
    { width: 2, height: 2, data: new Uint8ClampedArray(16) },
    { x: 0, y: 0, width: 2, height: 2 },
    { signal: controller.signal },
  );
  await flushPipeline();
  assert.equal(typeof finishEncoding, 'function');

  controller.abort(new DOMException('encoding retired', 'AbortError'));
  await assert.rejects(() => crop, /encoding retired/);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);

  finishEncoding(new Blob(['late crop'], { type: 'image/jpeg' }));
});

test('personality crop rejects malformed platform collaborators without leaking resources', async () => {
  assert.throws(
    () => new PersonalityService({ createImageBitmap: null }),
    /createImageBitmap must be a function/,
  );
  assert.throws(() => new PersonalityService({ createCanvas: {} }), /createCanvas must be a function/);

  const bitmap = {
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => null, toBlob() {} };
  const service = new PersonalityService({
    createImageBitmap: async () => bitmap,
    createCanvas: () => canvas,
  });
  await assert.rejects(
    () =>
      service.extractROI(
        { width: 2, height: 2, data: new Uint8ClampedArray(16) },
        { x: 0, y: 0, width: 2, height: 2 },
      ),
    /2D canvas context/,
  );
  assert.equal(bitmap.closeCalls, 1);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
});
