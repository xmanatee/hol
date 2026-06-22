import test from 'node:test';
import assert from 'node:assert/strict';

import { DepthEstimationService } from './DepthEstimationService.js';
import { shouldInitializeDepthForTrackingMode } from '../hooks/useCameraSystem.js';

class FakeDepthWorker {
  constructor() {
    this.messages = [];
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
  }

  postMessage(message) {
    this.messages.push(message);
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
    inputName: 'image',
    outputName: 'depth',
    inputSize: 518,
    modelUrl: '/models/depth_anything_v2_small.onnx',
  });

  const state = await retry;
  assert.equal(state.state, 'ready');
  assert.equal(state.provider, 'wasm');
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
    inputName: 'image',
    outputName: 'depth',
    inputSize: 518,
    modelUrl: '/models/depth_anything_v2_small.onnx',
  });
  await initialized;

  const first = service.estimate(createImageData(), { timestamp: now });
  const throttledInFlight = await service.estimate(createImageData(), { timestamp: now + 1 });
  assert.equal(throttledInFlight, null);
  assert.equal(worker.messages.filter(message => message.type === 'estimate').length, 1);

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
    modelUrl: '/models/depth_anything_v2_small.onnx',
  });
  const firstDepth = await first;
  assert.equal(firstDepth.sourceWidth, 8);
  assert.equal(firstDepth.sourceHeight, 6);
  now += 80;
  const throttledRecent = await service.estimate(createImageData(), { timestamp: now });

  assert.equal(throttledRecent, firstDepth);
  assert.equal(worker.messages.filter(message => message.type === 'estimate').length, 1);
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
    inputName: 'image',
    outputName: 'depth',
    inputSize: 518,
    modelUrl: '/models/depth_anything_v2_small.onnx',
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
    inputName: 'image',
    outputName: 'depth',
    inputSize: 518,
    modelUrl: '/models/depth_anything_v2_small.onnx',
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
    inputName: 'image',
    outputName: 'depth',
    inputSize: 518,
    modelUrl: '/models/depth_anything_v2_small.onnx',
  });

  const state = await retry;
  assert.equal(state.state, 'ready');
  assert.equal(state.provider, 'wasm');
});
