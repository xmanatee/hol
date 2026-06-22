import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionService } from './DetectionService.js';

class FakeWorker {
  constructor() {
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
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

FakeWorker.instances = [];

const rejectedBeforeNextTimer = async promise => {
  const outcome = await Promise.race([
    promise.then(
      value => ({ status: 'resolved', value }),
      error => ({ status: 'rejected', error })
    ),
    new Promise(resolve => setTimeout(() => resolve({ status: 'pending' }), 0)),
  ]);
  return outcome;
};

test('detection frames are packaged as transferable typed arrays', () => {
  const service = new DetectionService();
  const imageData = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])
  };

  const { message, transferList } = service._createDetectionMessage(imageData);

  assert.equal(message.type, 'detect');
  assert.equal(message.imageData.width, 2);
  assert.equal(message.imageData.height, 1);
  assert.ok(message.imageData.data instanceof Uint8ClampedArray);
  assert.deepEqual(Array.from(message.imageData.data), Array.from(imageData.data));
  assert.deepEqual(transferList, [message.imageData.data.buffer]);
});

test('detection initialization resolves from the worker protocol without public listeners', async t => {
  const OriginalWorker = globalThis.Worker;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  const service = new DetectionService();
  t.after(() => {
    globalThis.Worker = OriginalWorker;
    service.dispose();
  });

  const initialized = service.initialize();
  assert.equal(service.listeners.size, 0);
  FakeWorker.instances[0].reply({ type: 'initialized' });

  await initialized;

  assert.equal(service.isInitialized, true);
  assert.equal(service.listeners.size, 0);
  assert.deepEqual(FakeWorker.instances[0].messages.map(message => message.type), ['test', 'initialize']);
});

test('detection model loading resolves from the worker protocol without public listeners', async () => {
  const service = new DetectionService();
  const worker = new FakeWorker();
  service.worker = worker;
  service.isInitialized = true;

  const loaded = service.loadModel('/models/yolo11n_480.onnx');
  assert.equal(service.listeners.size, 0);
  service._handleWorkerMessage({ type: 'modelLoaded', inputNames: ['images'], outputNames: ['output0'] });

  await loaded;

  assert.equal(service.isModelLoaded, true);
  assert.equal(service.listeners.size, 0);
});

test('detection model loading rejects from the worker protocol without public listeners', async () => {
  const service = new DetectionService();
  const worker = new FakeWorker();
  service.worker = worker;
  service.isInitialized = true;

  const loaded = service.loadModel('/models/yolo11n_480.onnx');
  assert.equal(service.listeners.size, 0);
  service._handleWorkerMessage({ type: 'error', message: 'model missing' });

  await assert.rejects(loaded, /model missing/);
  assert.equal(service.listeners.size, 0);
});

test('detection model loading coalesces concurrent requests into one worker command', async () => {
  const service = new DetectionService();
  const worker = new FakeWorker();
  service.worker = worker;
  service.isInitialized = true;

  const first = service.loadModel('/models/yolo11n_480.onnx');
  const second = service.loadModel('/models/yolo11n_480.onnx');

  assert.equal(worker.messages.filter(message => message.type === 'loadModel').length, 1);

  service._handleWorkerMessage({ type: 'modelLoaded', inputNames: ['images'], outputNames: ['output0'] });

  assert.equal(await first, true);
  assert.equal(await second, true);
});

test('detection model loading rejects conflicting concurrent model paths', async () => {
  const service = new DetectionService();
  const worker = new FakeWorker();
  service.worker = worker;
  service.isInitialized = true;

  const first = service.loadModel('/models/yolo11n_480.onnx');
  const second = service.loadModel('/models/other.onnx');
  const outcome = await rejectedBeforeNextTimer(second);

  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /already loading/);
  assert.equal(worker.messages.filter(message => message.type === 'loadModel').length, 1);

  service._handleWorkerMessage({ type: 'modelLoaded', inputNames: ['images'], outputNames: ['output0'] });
  assert.equal(await first, true);
});

test('detection dispose rejects pending initialization immediately', async t => {
  const OriginalWorker = globalThis.Worker;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  const service = new DetectionService();
  t.after(() => {
    globalThis.Worker = OriginalWorker;
    service.dispose();
  });

  const initialized = service.initialize();
  service.dispose();
  const outcome = await rejectedBeforeNextTimer(initialized);

  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /disposed/);
});

test('detection dispose rejects pending model loading immediately', async () => {
  const service = new DetectionService();
  const worker = new FakeWorker();
  service.worker = worker;
  service.isInitialized = true;

  const loaded = service.loadModel('/models/yolo11n_480.onnx');
  service.dispose();
  const outcome = await rejectedBeforeNextTimer(loaded);

  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /disposed/);
});

test('detection fatal worker errors reset the service for retry', async t => {
  const OriginalWorker = globalThis.Worker;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  const service = new DetectionService();
  t.after(() => {
    globalThis.Worker = OriginalWorker;
    service.dispose();
  });

  const initialized = service.initialize();
  FakeWorker.instances[0].reply({ type: 'initialized' });
  await initialized;
  service.isModelLoaded = true;

  FakeWorker.instances[0].onerror({ message: 'worker crashed' });

  assert.equal(FakeWorker.instances[0].terminated, true);
  assert.equal(service.isInitialized, false);
  assert.equal(service.isModelLoaded, false);

  const retry = service.initialize();
  assert.equal(FakeWorker.instances.length, 2);
  FakeWorker.instances[1].reply({ type: 'initialized' });

  await retry;
  assert.equal(service.isInitialized, true);
});

test('detection initialization protocol errors reset the worker for retry', async t => {
  const OriginalWorker = globalThis.Worker;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  const service = new DetectionService();
  t.after(() => {
    globalThis.Worker = OriginalWorker;
    service.dispose();
  });

  const failed = service.initialize();
  FakeWorker.instances[0].reply({ type: 'error', message: 'ONNX initialization failed' });

  await assert.rejects(failed, /ONNX initialization failed/);
  assert.equal(FakeWorker.instances[0].terminated, true);
  assert.equal(service.isInitialized, false);

  const retry = service.initialize();
  assert.equal(FakeWorker.instances.length, 2);
  FakeWorker.instances[1].reply({ type: 'initialized' });

  await retry;
  assert.equal(service.isInitialized, true);
});
