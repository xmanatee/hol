import test from 'node:test';
import assert from 'node:assert/strict';

import { DepthEstimationService } from './DepthEstimationService.js';
import { shouldInitializeDepthForTrackingMode } from '../hooks/useCameraSystem.js';

class FakeDepthWorker {
  constructor() {
    this.messages = [];
    this.transferLists = [];
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    this.postError = null;
  }

  postMessage(message, transferList = []) {
    if (this.postError) {
      throw this.postError;
    }
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

const createImageData = () => ({
  width: 4,
  height: 4,
  data: new Uint8ClampedArray(4 * 4 * 4),
});

const createManualTimeoutScheduler = () => {
  let callback = null;
  return {
    schedule: (nextCallback) => {
      assert.equal(callback, null, 'depth worker scheduled more than one request deadline');
      callback = nextCallback;
      return () => {
        callback = null;
      };
    },
    run: () => {
      assert.notEqual(callback, null, 'depth worker did not schedule a request deadline');
      const scheduledCallback = callback;
      callback = null;
      scheduledCallback();
    },
  };
};

test('depth service rejects invalid request deadlines before creating a worker', () => {
  assert.throws(
    () => new DepthEstimationService({ requestTimeoutMs: 0 }),
    /Depth worker request timeout must be a positive finite number/,
  );
  assert.throws(
    () => new DepthEstimationService({ initializeTimeoutMs: Number.NaN }),
    /Depth worker initialization timeout must be a positive finite number/,
  );
});

test('depth initialization is reserved for the depth fusion tracking mode', () => {
  assert.equal(shouldInitializeDepthForTrackingMode('sparse-reconstruction'), false);
  assert.equal(shouldInitializeDepthForTrackingMode('parametric-surface'), false);
  assert.equal(shouldInitializeDepthForTrackingMode('direct-photometric'), false);
  assert.equal(shouldInitializeDepthForTrackingMode('object-pose'), false);
  assert.equal(shouldInitializeDepthForTrackingMode('depth-fusion'), true);
});

test('depth estimation service retries initialization after worker model errors', async () => {
  const workers = [];
  const service = new DepthEstimationService({
    workerFactory: () => {
      const worker = new FakeDepthWorker();
      workers.push(worker);
      return worker;
    },
  });

  const failed = service.initialize();
  workers[0].reply({ type: 'error', stage: 'initialize', message: 'model missing' });
  await assert.rejects(failed, /model missing/);
  assert.equal(service.getState().state, 'error');
  assert.equal(workers[0].terminated, true);

  const retry = service.initialize();
  workers[1].reply({
    type: 'initialized',
    provider: 'wasm',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });

  const state = await retry;
  assert.equal(state.state, 'ready');
  assert.equal(state.provider, 'wasm');
});

test('depth initialization deadline retires a stalled worker and permits a clean retry', async () => {
  const scheduler = createManualTimeoutScheduler();
  const workers = [];
  const service = new DepthEstimationService({
    initializeTimeoutMs: 1000,
    scheduleRequestTimeout: scheduler.schedule,
    workerFactory: () => {
      const worker = new FakeDepthWorker();
      workers.push(worker);
      return worker;
    },
  });

  const stalled = service.initialize();
  scheduler.run();

  await assert.rejects(stalled, /Depth worker initialize timed out after 1000ms/);
  assert.equal(workers[0].terminated, true);
  assert.equal(service.pending.size, 0);
  assert.equal(service.getState().state, 'error');

  const retry = service.initialize();
  workers[1].reply({
    type: 'initialized',
    provider: 'wasm',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });

  assert.equal((await retry).state, 'ready');
});

test('depth estimation restart ignores every callback from the disposed worker', async () => {
  const workers = [];
  const service = new DepthEstimationService({
    workerFactory: () => {
      const worker = new FakeDepthWorker();
      workers.push(worker);
      return worker;
    },
  });

  const disposedInitialization = service.initialize();
  service.dispose();
  await assert.rejects(disposedInitialization, /disposed/);

  let restartedSettled = false;
  const restarted = service.initialize();
  restarted.then(
    () => {
      restartedSettled = true;
    },
    () => {
      restartedSettled = true;
    },
  );

  workers[0].reply({
    type: 'initialized',
    provider: 'stale-webgpu',
    inputSize: 518,
    modelUrl: '/models/stale.onnx',
  });
  workers[0].onerror({ message: 'stale worker crash' });
  workers[0].onmessageerror({ message: 'stale worker response' });
  await Promise.resolve();

  assert.equal(restartedSettled, false);
  assert.equal(workers[1].terminated, false);
  assert.equal(service.getState().state, 'loading');
  assert.equal(service.getState().provider, null);

  workers[1].reply({
    type: 'initialized',
    provider: 'wasm',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  await restarted;

  workers[0].reply({
    type: 'depth',
    requestId: 1,
    width: 1,
    height: 1,
    sourceWidth: 1,
    sourceHeight: 1,
    data: new Float32Array([1]),
    timestamp: 10,
    processingTime: 99,
    provider: 'stale-webgpu',
    modelUrl: '/models/stale.onnx',
  });

  assert.equal(service.getLatestFrame(), null);
  assert.equal(service.getState().provider, 'wasm');
  assert.equal(service.getState().processingTime, 0);
});

test('depth initialization post failures release the runtime for a fresh retry', async () => {
  const failingWorker = new FakeDepthWorker();
  failingWorker.postError = new Error('initialize could not be cloned');
  const recoveredWorker = new FakeDepthWorker();
  const workers = [failingWorker, recoveredWorker];
  const service = new DepthEstimationService({
    workerFactory: () => workers.shift(),
  });
  const failed = service.initialize();

  await assert.rejects(failed, /initialize could not be cloned/);
  assert.equal(service.pending.size, 0);
  assert.equal(service.initializePromise, null);
  assert.equal(failingWorker.terminated, true);
  assert.equal(service.getState().state, 'error');

  const recovered = service.initialize();
  recoveredWorker.reply({
    type: 'initialized',
    provider: 'wasm',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });

  assert.equal((await recovered).state, 'ready');
});

test('depth estimate post failures clear the in-flight request gate', async () => {
  const worker = new FakeDepthWorker();
  const service = new DepthEstimationService({ workerFactory: () => worker });
  const initialized = service.initialize();
  worker.reply({
    type: 'initialized',
    provider: 'wasm',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  await initialized;

  worker.postError = new Error('depth frame could not be cloned');
  await assert.rejects(
    service.estimate(createImageData(), { force: true }),
    /depth frame could not be cloned/,
  );

  assert.equal(service.pending.size, 0);
  assert.equal(service.inFlight, false);
  assert.equal(service.lastRequestAt, 0);
  assert.equal(service.shouldEstimate({ force: true }), true);
});

test('depth disposal resets the complete public runtime snapshot', async () => {
  const worker = new FakeDepthWorker();
  const service = new DepthEstimationService({ workerFactory: () => worker });
  const initialized = service.initialize();
  worker.reply({
    type: 'initialized',
    provider: 'webgpu',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  await initialized;

  const estimate = service.estimate(createImageData(), { force: true });
  worker.reply({
    type: 'depth',
    requestId: 1,
    width: 4,
    height: 4,
    sourceWidth: 4,
    sourceHeight: 4,
    data: new Float32Array(16),
    timestamp: 10,
    processingTime: 6.5,
    provider: 'webgpu',
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  await estimate;

  service.dispose();

  assert.equal(service.getState().state, 'idle');
  assert.equal(service.getState().provider, null);
  assert.equal(service.getState().error, null);
  assert.equal(service.getState().processingTime, 0);
  assert.equal(service.getState().lastFrameAt, 0);
  assert.equal(service.getLatestFrame(), null);
});

test('depth estimation service throttles in-flight and recent estimates', async () => {
  let now = 1000;
  const worker = new FakeDepthWorker();
  const service = new DepthEstimationService({
    intervalMs: 260,
    now: () => now,
    workerFactory: () => worker,
  });
  const initialized = service.initialize();
  worker.reply({
    type: 'initialized',
    provider: 'webgpu',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  await initialized;

  const first = service.estimate(createImageData(), { timestamp: now });
  const throttledInFlight = await service.estimate(createImageData(), { timestamp: now + 1 });
  assert.equal(throttledInFlight, null);
  assert.equal(worker.messages.filter((message) => message.type === 'estimate').length, 1);

  worker.reply({
    type: 'depth',
    requestId: 1,
    width: 4,
    height: 4,
    sourceWidth: 8,
    sourceHeight: 6,
    data: new Float32Array(16),
    timestamp: now,
    processingTime: 6.5,
    provider: 'webgpu',
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  const firstDepth = await first;
  assert.equal(firstDepth.sourceWidth, 8);
  assert.equal(firstDepth.sourceHeight, 6);
  now += 80;
  const throttledRecent = await service.estimate(createImageData(), { timestamp: now });

  assert.equal(throttledRecent, firstDepth);
  assert.equal(worker.messages.filter((message) => message.type === 'estimate').length, 1);
});

test('depth estimation takes ownership only when its cadence accepts the frame', async () => {
  const now = 1000;
  const worker = new FakeDepthWorker();
  const service = new DepthEstimationService({
    intervalMs: 260,
    now: () => now,
    workerFactory: () => worker,
  });
  const initialized = service.initialize();
  worker.reply({
    type: 'initialized',
    provider: 'wasm',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  await initialized;

  const acceptedFrame = createImageData();
  const accepted = service.estimate(acceptedFrame, { timestamp: now });
  const estimateMessageIndex = worker.messages.findIndex((message) => message.type === 'estimate');

  assert.equal(service.shouldEstimate(), false);
  assert.equal(worker.messages[estimateMessageIndex].imageData.data, acceptedFrame.data);
  assert.deepEqual(worker.transferLists[estimateMessageIndex], [acceptedFrame.data.buffer]);

  const rejectedFrame = createImageData();
  const rejectedBuffer = rejectedFrame.data.buffer;
  assert.equal(await service.estimate(rejectedFrame, { timestamp: now + 1 }), null);
  assert.equal(rejectedBuffer.byteLength, 64);

  service.dispose();
  await assert.rejects(accepted, /disposed/);
});

test('depth estimation never exposes a stale frame while the runtime is unavailable', async () => {
  const service = new DepthEstimationService();
  service.latestFrame = { timestamp: 12, data: new Float32Array([1]) };

  assert.equal(await service.estimate(createImageData()), null);

  service.dispose();
  assert.equal(service.getLatestFrame(), null);
});

test('depth estimation service rejects pending work on dispose', async () => {
  const worker = new FakeDepthWorker();
  const service = new DepthEstimationService({
    workerFactory: () => worker,
  });
  const initialized = service.initialize();
  worker.reply({
    type: 'initialized',
    provider: 'webgpu',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  await initialized;

  const estimate = service.estimate(createImageData(), { force: true });
  service.dispose();

  await assert.rejects(estimate, /disposed/);
  assert.equal(worker.terminated, true);
  assert.equal(service.getState().state, 'idle');
});

test('depth estimation service rejects in-flight estimates after fatal worker errors', async () => {
  const workers = [];
  const service = new DepthEstimationService({
    workerFactory: () => {
      const worker = new FakeDepthWorker();
      workers.push(worker);
      return worker;
    },
  });

  const initialized = service.initialize();
  workers[0].reply({
    type: 'initialized',
    provider: 'webgpu',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  await initialized;

  const estimate = service.estimate(createImageData(), { force: true });
  workers[0].onerror({ message: 'worker crashed' });

  await assert.rejects(estimate, /worker crashed/);
  assert.equal(workers[0].terminated, true);
  assert.equal(service.getState().state, 'error');
  assert.equal(service.getState().error, 'worker crashed');

  const retry = service.initialize();
  workers[1].reply({
    type: 'initialized',
    provider: 'wasm',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });

  const state = await retry;
  assert.equal(state.state, 'ready');
  assert.equal(state.provider, 'wasm');
});

test('depth estimation service rejects in-flight estimates after worker message errors', async () => {
  const worker = new FakeDepthWorker();
  const service = new DepthEstimationService({
    workerFactory: () => worker,
  });

  const initialized = service.initialize();
  worker.reply({
    type: 'initialized',
    provider: 'wasm',
    inputSize: 518,
    modelUrl: '/models/depth-anything-v2-small-q4.onnx',
  });
  await initialized;

  const estimate = service.estimate(createImageData(), { force: true });
  worker.onmessageerror({ message: 'depth result could not be cloned' });

  await assert.rejects(estimate, /could not be cloned/);
  assert.equal(worker.terminated, true);
  assert.equal(service.getState().state, 'error');
  assert.equal(service.getState().error, 'depth result could not be cloned');
});
