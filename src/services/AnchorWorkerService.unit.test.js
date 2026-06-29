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
  constructor(WorkerClass = FakeAnchorWorker) {
    super();
    this.WorkerClass = WorkerClass;
  }

  async _getWorkerClass() {
    return this.WorkerClass;
  }
}

const createImageData = () => ({
  width: 2,
  height: 1,
  data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]),
});

const createState = (overrides = {}) => ({
  mode: 'detection',
  detections: [],
  activeAnchor: null,
  anchorState: null,
  trackingMode: 'sparse-reconstruction',
  initialized: false,
  ...overrides,
});

const waitForWorkerPost = async () => {
  await Promise.resolve();
};

const waitForRequestHandlers = () => setImmediate();

test('anchor worker initialization sends the active tracking mode and applies state before resolving', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  service.setTrackingMode('depth-fusion');

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
});

test('anchor tap requests copy frame data and transfer the copied buffer', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  const imageData = createImageData();

  const created = service.createAnchorFromTap({ x: 1, y: 0 }, imageData);

  await waitForWorkerPost();
  const worker = FakeAnchorWorker.instances[0];
  const message = worker.messages[0];
  assert.equal(message.command, 'createAnchorFromTap');
  assert.deepEqual(message.payload.tapPosition, { x: 1, y: 0 });
  assert.notEqual(message.payload.imageData.data.buffer, imageData.data.buffer);
  assert.deepEqual(Array.from(message.payload.imageData.data), Array.from(imageData.data));
  assert.deepEqual(worker.transferLists[0], [message.payload.imageData.data.buffer]);

  worker.reply({
    id: message.id,
    result: { success: true, id: 'anchor-1' },
    state: createState({ mode: 'anchor', initialized: true }),
  });

  assert.deepEqual(await created, { success: true, id: 'anchor-1' });
});

test('anchor updates keep one in-flight request and release the gate after the response', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  service.initialized = true;
  service.mode = 'anchor';

  const first = service.updateAnchor(createImageData(), { timestamp: 12 });
  await waitForWorkerPost();

  const worker = FakeAnchorWorker.instances[0];
  assert.deepEqual(first, { success: true, method: 'worker-anchor-update', pending: true });
  assert.equal(worker.messages.length, 1);
  assert.equal(service.updateInFlight, true);

  const blocked = service.updateAnchor(createImageData(), { timestamp: 13 });
  assert.equal(blocked.success, false);
  assert.equal(blocked.reason, 'Anchor update in progress');
  assert.equal(worker.messages.length, 1);

  worker.reply({
    id: worker.messages[0].id,
    result: { success: true },
    state: createState({ mode: 'anchor', initialized: true }),
  });
  await waitForRequestHandlers();
  assert.equal(service.updateInFlight, false);

  const next = service.updateAnchor(createImageData(), { timestamp: 14 });
  await waitForWorkerPost();
  assert.equal(next.success, true);
  assert.equal(worker.messages.length, 2);
});

test('anchor worker failures reject pending work and reset runtime state', async t => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService();
  service.initialized = true;
  service.mode = 'anchor';
  service.detections = [{ id: 'cup-1' }];
  service.activeAnchor = { id: 'anchor-1' };
  service.anchorState = 'tracking';

  const pending = service._request('updateAnchor', { imageData: createImageData() });
  await waitForWorkerPost();

  const worker = FakeAnchorWorker.instances[0];
  worker.onerror({ message: 'worker crashed' });

  await assert.rejects(pending, /worker crashed/);
  assert.equal(worker.terminated, true);
  assert.equal(service.pendingRequests.size, 0);
  assert.deepEqual(service.getState(), createState());
});

test('anchor worker requests do not leak pending entries when postMessage rejects', async () => {
  FakeAnchorWorker.instances = [];
  const service = new TestAnchorWorkerService(ThrowingAnchorWorker);

  await assert.rejects(
    service._request('updateAnchor', { imageData: createImageData() }),
    /DataCloneError/
  );

  assert.equal(service.pendingRequests.size, 0);
});
