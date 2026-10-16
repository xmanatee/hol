import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

import { AnchorWorkerService } from './AnchorWorkerService.js';

class FakeAnchorWorker {
  static instances = [];

  constructor() {
    this.messages = [];
    this.transferLists = [];
    this.terminated = false;
    FakeAnchorWorker.instances.push(this);
  }

  postMessage(message, transferList = []) {
    this.messages.push(message);
    this.transferLists.push(transferList);
  }

  reply(message) {
    this.onmessage?.({ data: message });
  }

  terminate() {
    this.terminated = true;
  }
}

class ThrowingAnchorWorker extends FakeAnchorWorker {
  postMessage() {
    throw new Error('DataCloneError: payload is not structured-cloneable');
  }
}

class TestAnchorWorkerService extends AnchorWorkerService {
  constructor(WorkerClass = FakeAnchorWorker, options = {}) {
    super({ ...options, loadWorkerClass: async () => WorkerClass });
  }
}

class DeferredWorkerClassService extends AnchorWorkerService {
  constructor() {
    let resolveWorkerClass;
    const workerClass = new Promise((resolve) => {
      resolveWorkerClass = resolve;
    });
    super({ loadWorkerClass: () => workerClass });
    this.resolveWorkerClass = resolveWorkerClass;
  }
}

const createImageData = () => ({
  width: 2,
  height: 1,
  data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]),
});

const createState = (overrides = {}) => ({
  mode: 'selection',
  activeAnchor: null,
  candidate: null,
  nextObservationAt: 0,
  anchorState: null,
  segmentationRefresh: null,
  trackingMode: 'sparse-reconstruction',
  initialized: false,
  error: null,
  sampledAt: null,
  ...overrides,
});

const waitForWorkerPost = () => setImmediate();

const waitForRequestHandlers = () => setImmediate();

const createManualTimeoutScheduler = () => {
  let callback = null;
  return {
    schedule: (nextCallback) => {
      assert.equal(callback, null, 'anchor worker scheduled more than one request deadline');
      callback = nextCallback;
      return () => {
        callback = null;
      };
    },
    run: () => {
      assert.notEqual(callback, null, 'anchor worker did not schedule a request deadline');
      const scheduledCallback = callback;
      callback = null;
      scheduledCallback();
    },
  };
};

const outcomeAfterAsyncTurn = async (promise) => {
  const outcome = promise.then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  await setImmediate();
  return Promise.race([outcome, Promise.resolve({ status: 'pending' })]);
};

test('anchor worker rejects invalid request deadlines before loading its runtime', () => {
  assert.throws(
    () => new AnchorWorkerService({ requestTimeoutMs: 0 }),
    /Anchor worker request timeout must be a positive finite number/,
  );
  assert.throws(
    () => new AnchorWorkerService({ initializationTimeoutMs: Number.POSITIVE_INFINITY }),
    /Anchor worker initialization timeout must be a positive finite number/,
  );
});

test('anchor worker client does not publish or allocate for a duplicate tracking mode', () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  let publications = 0;
  service.addListener(() => {
    publications++;
  });

  service.setTrackingMode('sparse-reconstruction');

  assert.equal(publications, 0);
  assert.equal(FakeAnchorWorker.instances.length, 0);
});

test('anchor worker initialization sends the active tracking mode and applies state before resolving', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  service.setTrackingMode('depth-fusion');
  let publicationCount = 0;
  service.addListener(() => {
    publicationCount++;
  });

  let resolvedState = null;
  const initialized = service.initialize(null, 320, 240, 70).then(() => {
    resolvedState = service.getState();
  });

  await waitForWorkerPost();
  const worker = FakeAnchorWorker.instances[0];
  assert.deepEqual(worker.messages[0], {
    id: 1,
    command: 'initialize',
    payload: {
      viewportWidth: 320,
      viewportHeight: 240,
      fov: 70,
      trackingMode: 'depth-fusion',
    },
  });

  worker.reply({
    id: 1,
    result: true,
    state: createState({
      mode: 'anchor',
      activeAnchor: { id: 'anchor-1' },
      anchorState: 'tracking',
      trackingMode: 'depth-fusion',
      initialized: true,
    }),
  });

  await initialized;
  assert.equal(resolvedState.mode, 'anchor');
  assert.equal(resolvedState.anchorState, 'tracking');
  assert.equal(resolvedState.trackingMode, 'depth-fusion');
  assert.equal(publicationCount, 1);
});

test('anchor worker initialization is single-flight across concurrent callers', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();

  const first = service.initialize(null, 320, 240, 63);
  const second = service.initialize(null, 320, 240, 63);

  await waitForWorkerPost();
  for (const worker of FakeAnchorWorker.instances) {
    worker.reply({
      id: worker.messages[0].id,
      result: true,
      state: createState({ initialized: true }),
    });
  }

  await Promise.all([first, second]);
  assert.equal(first, second);
  assert.equal(FakeAnchorWorker.instances.length, 1);
  assert.equal(FakeAnchorWorker.instances[0].messages.length, 1);
});

test('anchor initialization shares runtime loading and permits retry after a load failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  let loadAttempts = 0;
  let rejectFirstLoad;
  const firstLoad = new Promise((_, reject) => {
    rejectFirstLoad = reject;
  });
  const service = new AnchorWorkerService({
    loadWorkerClass: () => {
      loadAttempts++;
      return loadAttempts === 1 ? firstLoad : Promise.resolve(FakeAnchorWorker);
    },
  });

  const first = service.initialize(null, 320, 240, 63);
  const concurrent = service.initialize(null, 320, 240, 63);
  assert.equal(first, concurrent);
  assert.equal(loadAttempts, 1);

  rejectFirstLoad(new Error('Anchor worker chunk unavailable'));
  await assert.rejects(first, /chunk unavailable/);
  await assert.rejects(concurrent, /chunk unavailable/);

  const retry = service.initialize(null, 320, 240, 63);
  await waitForWorkerPost();
  const worker = FakeAnchorWorker.instances.at(-1);
  worker.reply({ id: worker.messages[0].id, result: true, state: createState({ initialized: true }) });
  await retry;
  assert.equal(loadAttempts, 2);
  service.dispose();
});

test('anchor reset cancels lazy worker creation and starts only the latest calibration', async () => {
  FakeAnchorWorker.instances = [];
  const service = new DeferredWorkerClassService();
  const staleInitialization = service.initialize(null, 320, 240, 63);
  const staleOutcome = staleInitialization.then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );

  await Promise.resolve();
  service.reset();
  const currentInitialization = service.initialize(null, 640, 360, 70);
  service.resolveWorkerClass(FakeAnchorWorker);

  await waitForWorkerPost();
  const outcome = await staleOutcome;
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /Anchor worker reset/);
  assert.equal(FakeAnchorWorker.instances.length, 1);
  assert.deepEqual(FakeAnchorWorker.instances[0].messages[0].payload, {
    viewportWidth: 640,
    viewportHeight: 360,
    fov: 70,
    trackingMode: 'sparse-reconstruction',
  });

  FakeAnchorWorker.instances[0].reply({
    id: FakeAnchorWorker.instances[0].messages[0].id,
    result: true,
    state: createState({ initialized: true }),
  });
  await currentInitialization;

  assert.equal(service.pendingRequests.size, 0);
  assert.equal(service.initialized, true);
});

test('anchor initialization failures terminate the invalid runtime before retry', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  const failed = service.initialize(null, 320, 240, 63);

  await waitForWorkerPost();
  const failedWorker = FakeAnchorWorker.instances[0];
  failedWorker.reply({
    id: failedWorker.messages[0].id,
    error: 'OpenCV initialization failed',
    state: createState(),
  });

  await assert.rejects(failed, /OpenCV initialization failed/);
  assert.equal(failedWorker.terminated, true);

  const retry = service.initialize(null, 320, 240, 63);
  await waitForWorkerPost();
  const readyWorker = FakeAnchorWorker.instances[1];
  readyWorker.reply({
    id: readyWorker.messages[0].id,
    result: true,
    state: createState({ initialized: true }),
  });

  await retry;
  assert.equal(FakeAnchorWorker.instances.length, 2);
  assert.equal(service.initialized, true);
});

test('selection commits a candidate without copying or transferring another camera frame', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  service.initialized = true;
  let publicationCount = 0;
  service.addListener(() => {
    publicationCount++;
  });

  const created = service.selectCandidate({ candidateId: 7, tapPosition: { x: 1, y: 0 }, capturedAt: 100 });

  await waitForWorkerPost();
  const worker = FakeAnchorWorker.instances[0];
  const message = worker.messages[0];
  assert.equal(message.command, 'selectCandidate');
  assert.deepEqual(message.payload.tapPosition, { x: 1, y: 0 });
  assert.deepEqual(message.payload, {
    candidateId: 7,
    tapPosition: { x: 1, y: 0 },
    capturedAt: 100,
    timeOrigin: performance.timeOrigin,
  });
  assert.deepEqual(worker.transferLists[0], []);

  worker.reply({
    id: message.id,
    result: { success: true, id: 7 },
    state: createState({ mode: 'anchor', initialized: true }),
  });

  assert.deepEqual(await created, { success: true, id: 7 });
  assert.equal(publicationCount, 1);
});

test('anchor tap requests reject locally before selection is initialized without creating a worker', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();

  const outcome = await outcomeAfterAsyncTurn(
    service.selectCandidate({ candidateId: 7, tapPosition: { x: 1, y: 0 }, capturedAt: 100 }),
  );

  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /initialized selection mode/);
  assert.equal(FakeAnchorWorker.instances.length, 0);
});

test('anchor frames require an explicit video capture timestamp', () => {
  const service = new TestAnchorWorkerService();
  service.initialized = true;
  service.mode = 'anchor';

  assert.throws(
    () =>
      service.processFrame(createImageData(), {
        update: true,
        refreshSegmentation: false,
        depthContext: null,
      }),
    /capture timestamp/,
  );
});

test('anchor frames combine tracking and segmentation in one zero-copy worker request', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  service.initialized = true;
  service.mode = 'anchor';
  const imageData = createImageData();

  const first = service.processFrame(imageData, {
    update: true,
    refreshSegmentation: true,
    depthContext: { depthFrame: { timestamp: 12, data: new Float32Array(16) } },
    capturedAt: 100,
  });
  await waitForWorkerPost();

  const worker = FakeAnchorWorker.instances[0];
  assert.deepEqual(first, { success: true, method: 'worker-anchor-frame', pending: true });
  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].command, 'processFrame');
  assert.equal(worker.messages[0].payload.imageData.data, imageData.data);
  assert.equal(worker.messages[0].payload.update, true);
  assert.equal(worker.messages[0].payload.refreshSegmentation, true);
  assert.deepEqual(worker.transferLists[0], [
    imageData.data.buffer,
    worker.messages[0].payload.depthContext.depthFrame.data.buffer,
  ]);
  assert.equal(service.canProcessFrame(), false);

  const blocked = service.processFrame(createImageData(), {
    update: true,
    refreshSegmentation: false,
    depthContext: { timestamp: 13 },
    capturedAt: 101,
  });
  assert.equal(blocked.success, false);
  assert.equal(blocked.reason, 'Observation frame in progress');
  assert.equal(worker.messages.length, 1);

  worker.reply({
    id: worker.messages[0].id,
    result: { success: true },
    state: createState({ mode: 'anchor', initialized: true }),
  });
  await waitForRequestHandlers();
  assert.equal(service.canProcessFrame(), true);
  assert.equal(service.getState().sampledAt, 100);

  const next = service.processFrame(createImageData(), {
    update: false,
    refreshSegmentation: true,
    depthContext: { timestamp: 14 },
    capturedAt: 102,
  });
  await waitForWorkerPost();
  assert.equal(next.success, true);
  assert.equal(worker.messages.length, 2);
  worker.reply({
    id: worker.messages[1].id,
    result: { success: true },
    state: createState({ mode: 'anchor', initialized: true }),
  });
  await waitForRequestHandlers();
  assert.equal(service.getState().sampledAt, 100);
  service.dispose();
});

test('anchor worker deadline retires a stalled frame and releases the frame gate', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  FakeAnchorWorker.instances = [];
  const scheduler = createManualTimeoutScheduler();
  const service = new TestAnchorWorkerService(FakeAnchorWorker, {
    requestTimeoutMs: 1000,
    scheduleRequestTimeout: scheduler.schedule,
  });
  service.initialized = true;
  service.mode = 'anchor';

  service.processFrame(createImageData(), {
    update: true,
    refreshSegmentation: false,
    depthContext: null,
    capturedAt: 200,
  });
  await waitForWorkerPost();
  const stalledWorker = FakeAnchorWorker.instances[0];
  assert.equal(service.canProcessFrame(), false);

  scheduler.run();
  await waitForRequestHandlers();

  assert.equal(stalledWorker.terminated, true);
  assert.equal(service.canProcessFrame(), false);
  assert.equal(service.pendingRequests.size, 0);
  assert.deepEqual(
    service.getState(),
    createState({ error: 'Anchor worker processFrame timed out after 1000ms' }),
  );
});

test('anchor clear in selection mode does not create a worker request', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();

  service.clearAnchor();
  await waitForWorkerPost();

  assert.equal(FakeAnchorWorker.instances.length, 0);
  assert.deepEqual(service.getState(), createState());
});

test('anchor dispose clears the in-flight frame gate immediately', async (t) => {
  const originalError = console.error;
  let errorCount = 0;
  console.error = () => {
    errorCount++;
  };
  t.after(() => {
    console.error = originalError;
  });

  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  service.initialized = true;
  service.mode = 'anchor';

  service.processFrame(createImageData(), {
    update: true,
    refreshSegmentation: true,
    depthContext: { timestamp: 12 },
    capturedAt: 300,
  });
  await waitForWorkerPost();

  assert.equal(service.canProcessFrame(), false);

  service.dispose();

  assert.equal(service.canProcessFrame(), false);

  await waitForRequestHandlers();
  assert.equal(errorCount, 0);
});

test('anchor reset restarts camera calibration and ignores every stale worker callback', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  const states = [];
  service.setTrackingMode('direct-photometric');
  service.addListener((state) => states.push(state));
  service.initialized = true;
  service.mode = 'anchor';
  service.activeAnchor = { id: 'anchor-1' };
  service.anchorState = 'tracking';

  const pending = service._request('processFrame', { imageData: createImageData() });
  await waitForWorkerPost();
  const firstWorker = FakeAnchorWorker.instances[0];

  service.reset();

  await assert.rejects(pending, /Anchor worker reset/);
  assert.equal(firstWorker.terminated, true);
  assert.deepEqual(
    service.getState(),
    createState({
      trackingMode: 'direct-photometric',
    }),
  );
  assert.deepEqual(states.at(-1), service.getState());

  const initialized = service.initialize(null, 360, 640, 63);
  await waitForWorkerPost();
  const secondWorker = FakeAnchorWorker.instances[1];
  assert.notEqual(secondWorker, firstWorker);
  assert.deepEqual(secondWorker.messages[0].payload, {
    viewportWidth: 360,
    viewportHeight: 640,
    fov: 63,
    trackingMode: 'direct-photometric',
  });
  secondWorker.reply({
    id: secondWorker.messages[0].id,
    result: true,
    state: createState({
      trackingMode: 'direct-photometric',
      initialized: true,
    }),
  });

  await initialized;
  assert.equal(states.length, 2);
  assert.equal(service.getState().initialized, true);

  const currentState = service.getState();
  const publicationCount = states.length;
  firstWorker.reply({
    id: firstWorker.messages[0].id,
    result: { success: true },
    state: createState({
      mode: 'anchor',
      activeAnchor: { id: 'stale-anchor' },
      initialized: true,
    }),
  });
  firstWorker.onerror({ message: 'stale worker crash' });
  firstWorker.onmessageerror({ message: 'stale worker response could not be cloned' });

  assert.deepEqual(service.getState(), currentState);
  assert.equal(states.length, publicationCount);
  assert.equal(secondWorker.terminated, false);
});

test('anchor worker failures reject pending work and reset runtime state', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  service.initialized = true;
  service.mode = 'anchor';
  service.activeAnchor = { id: 'anchor-1' };
  service.anchorState = 'tracking';

  const pending = service._request('processFrame', { imageData: createImageData() });
  await waitForWorkerPost();

  const worker = FakeAnchorWorker.instances[0];
  worker.onerror({ message: 'worker crashed' });

  await assert.rejects(pending, /worker crashed/);
  assert.equal(worker.terminated, true);
  assert.equal(service.pendingRequests.size, 0);
  assert.deepEqual(service.getState(), createState({ error: 'worker crashed' }));
});

test('anchor worker message errors reject pending work and reset runtime state', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  service.initialized = true;
  service.mode = 'anchor';

  const pending = service._request('processFrame', { imageData: createImageData() });
  await waitForWorkerPost();

  const worker = FakeAnchorWorker.instances[0];
  assert.equal(typeof worker.onmessageerror, 'function');
  worker.onmessageerror({ message: 'worker message could not be cloned' });

  await assert.rejects(pending, /worker message could not be cloned/);
  assert.equal(worker.terminated, true);
  assert.equal(service.pendingRequests.size, 0);
  assert.deepEqual(service.getState(), createState({ error: 'worker message could not be cloned' }));
});

test('anchor worker requests do not leak pending entries when postMessage rejects', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService(ThrowingAnchorWorker);

  await assert.rejects(service._request('processFrame', { imageData: createImageData() }), /DataCloneError/);

  assert.equal(service.pendingRequests.size, 0);
});

test('anchor replies publish refresh diagnostics once and release only their own frame', async () => {
  const service = new TestAnchorWorkerService();
  const initialized = service.initialize(null, 320, 240, 63);
  await waitForWorkerPost();
  const worker = FakeAnchorWorker.instances.at(-1);
  const ready = createState({ initialized: true });
  worker.reply({ id: worker.messages[0].id, result: true, state: ready });
  await initialized;
  const states = [];
  service.addListener((state) => states.push(state));
  const frame = { update: true, refreshSegmentation: true, depthContext: null, capturedAt: 100 };
  service.processFrame(createImageData(), frame);
  await waitForWorkerPost();
  const reply = {
    id: worker.messages.at(-1).id,
    result: { success: true },
    state: { ...ready, segmentationRefresh: { status: 'rejected', errorMessage: 'Model unavailable' } },
  };
  worker.reply(reply);
  assert.equal(service.canProcessFrame(), true);
  assert.deepEqual(service.getState().segmentationRefresh, reply.state.segmentationRefresh);
  assert.equal(states.length, 1);

  service.processFrame(createImageData(), { ...frame, capturedAt: 200 });
  worker.reply({ ...reply, state: createState({ initialized: false }) });
  worker.reply({ ...reply, id: -1, error: 'unowned error' });
  await waitForRequestHandlers();
  assert.equal(service.canProcessFrame(), false);
  assert.equal(service.getState().initialized, true);
  assert.equal(states.length, 1);
  worker.reply({ ...reply, id: worker.messages.at(-1).id });
  await waitForRequestHandlers();
  assert.equal(service.canProcessFrame(), true);
  assert.equal(service.getState().sampledAt, 200);
  service.dispose();
});
