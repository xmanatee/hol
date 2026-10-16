import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthEstimationService } from './DepthEstimationService.js';
import { shouldInitializeDepthForTrackingMode } from '../hooks/useCameraSystem.js';

class WorkerTransport {
  requests = [];
  terminated = false;
  postError = null;

  postMessage(message, transfers = []) {
    if (this.postError) throw this.postError;
    this.requests.push({ ...message, transfers });
  }

  reply(request, result) {
    this.onmessage({ data: { id: request.id, result } });
  }

  terminate() {
    this.terminated = true;
  }
}

const createImageData = () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64) });
const modelConfig = { inputSize: 56, modelUrl: '/depth.onnx' };
const initializedState = { provider: 'wasm', ...modelConfig };
const createDepth = (timestamp) => ({
  width: 4,
  height: 4,
  sourceWidth: 8,
  sourceHeight: 6,
  data: new Float32Array(16),
  timestamp,
  processingTime: 6.5,
  provider: 'wasm',
  modelUrl: '/depth.onnx',
});

const createRuntime = (options = {}) => {
  const workers = [];
  const service = new DepthEstimationService({
    ...modelConfig,
    workerFactory: () => {
      const worker = new WorkerTransport();
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  const initialize = async () => {
    const pending = service.initialize();
    workers.at(-1).reply(workers.at(-1).requests.at(-1), initializedState);
    return await pending;
  };
  return { service, workers, initialize };
};

test('depth service validates deadlines before constructing its runtime', () => {
  for (const [option, value] of [
    ['requestTimeoutMs', 0],
    ['initializeTimeoutMs', NaN],
  ]) {
    assert.throws(() => new DepthEstimationService({ [option]: value }), /positive finite number/);
  }
});

test('only depth-fusion requests the optional depth runtime', () => {
  for (const mode of ['sparse-reconstruction', 'parametric-surface', 'direct-photometric', 'object-pose']) {
    assert.equal(shouldInitializeDepthForTrackingMode(mode), false);
  }
  assert.equal(shouldInitializeDepthForTrackingMode('depth-fusion'), true);
});

test('worker construction errors are visible and allow explicit initialization retry', async () => {
  const worker = new WorkerTransport();
  let attempts = 0;
  const service = new DepthEstimationService({
    ...modelConfig,
    workerFactory: () => {
      if (++attempts === 1) throw new Error('Worker construction blocked');
      return worker;
    },
  });
  await assert.rejects(service.initialize(), /Worker construction blocked/);
  assert.equal(service.getState().state, 'error');
  assert.equal(service.getState().error, 'Worker construction blocked');
  const retry = service.initialize();
  worker.reply(worker.requests.at(-1), initializedState);
  assert.equal((await retry).state, 'ready');
  service.dispose();
});

for (const stage of ['initialize', 'estimate']) {
  for (const failure of ['post', 'error', 'messageerror', 'reply', 'timeout']) {
    test(`${stage} ${failure} failure retires depth until explicit reinitialization`, async () => {
      let deadline;
      const { service, workers, initialize } = createRuntime({
        scheduleRequestTimeout: (callback) => {
          deadline = callback;
          return () => {
            deadline = null;
          };
        },
      });
      if (stage === 'estimate') await initialize();
      if (stage === 'initialize' && failure === 'post') {
        service.workerFactory = () => {
          const failingWorker = new WorkerTransport();
          failingWorker.postError = new Error('post failed');
          workers.push(failingWorker);
          return failingWorker;
        };
      } else if (failure === 'post') {
        workers.at(-1).postError = new Error('post failed');
      }
      const pending =
        stage === 'initialize' ? service.initialize() : service.estimate(createImageData(), { force: true });
      const worker = workers.at(-1);
      if (failure === 'timeout') deadline();
      if (failure === 'error') worker.onerror({ message: 'runtime crashed' });
      if (failure === 'messageerror') worker.onmessageerror({ message: 'response not cloneable' });
      if (failure === 'reply')
        worker.onmessage({ data: { id: worker.requests.at(-1).id, error: 'model failed' } });
      await assert.rejects(pending, /failed|crashed|cloneable|timed out/);
      assert.equal(service.getState().state, 'error');
      assert.equal(service.getState().provider, null);
      assert.ok(service.getState().error);
      assert.equal(worker.terminated, true);
      assert.equal(service.shouldEstimate({ force: true }), false);
      assert.equal(await service.estimate(createImageData()), null);
      assert.equal(deadline, null);

      service.workerFactory = () => {
        const replacement = new WorkerTransport();
        workers.push(replacement);
        return replacement;
      };
      assert.equal((await initialize()).state, 'ready');
      assert.equal(service.getState().error, null);
      service.dispose();
    });
  }

  test(`disposing during ${stage} rejects work and isolates every old worker callback`, async () => {
    const { service, workers, initialize } = createRuntime();
    if (stage === 'estimate') await initialize();
    const pending =
      stage === 'initialize' ? service.initialize() : service.estimate(createImageData(), { force: true });
    const oldWorker = workers.at(-1);
    const oldRequest = oldWorker.requests.at(-1);
    service.dispose();
    await assert.rejects(pending, /disposed/);
    assert.equal(service.getState().state, 'idle');
    assert.equal(oldWorker.terminated, true);

    await initialize();
    const state = service.getState();
    oldWorker.reply(
      oldRequest,
      stage === 'initialize' ? { ...initializedState, provider: 'stale' } : createDepth(0),
    );
    oldWorker.onerror({ message: 'old crash' });
    oldWorker.onmessageerror({ message: 'old message error' });
    assert.deepEqual(service.getState(), state);
    assert.equal(workers.at(-1).terminated, false);
    service.dispose();
  });

  test(`an already delivered ${stage} response cannot revive disposed depth`, async () => {
    const { service, workers, initialize } = createRuntime();
    if (stage === 'estimate') await initialize();
    const pending =
      stage === 'initialize' ? service.initialize() : service.estimate(createImageData(), { force: true });
    const worker = workers.at(-1);
    worker.reply(worker.requests.at(-1), stage === 'initialize' ? initializedState : createDepth(100));
    service.dispose();
    await assert.rejects(pending, /superseded/);
    assert.equal(service.getState().state, 'idle');
    assert.equal(service.getState().provider, null);
    assert.equal(service.getState().lastFrameAt, 0);
  });
}

test('depth initialization is single-flight before and after readiness', async () => {
  const { service, workers } = createRuntime();
  const pending = service.initialize();
  assert.equal(service.initialize(), pending);
  workers[0].reply(workers[0].requests[0], initializedState);
  assert.equal((await pending).state, 'ready');
  assert.equal((await service.initialize()).provider, 'wasm');
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests.length, 1);
  service.dispose();
});

for (const phase of ['loading', 'ready', 'estimate']) {
  test(`disposal by a ${phase} subscriber cancels the public operation`, async () => {
    const { service, workers, initialize } = createRuntime();
    if (phase === 'estimate') await initialize();
    const unsubscribe = service.addListener((state) => {
      if (phase === 'estimate' ? state.processingTime > 0 : state.state === phase) {
        unsubscribe();
        service.dispose();
      }
    });
    const pending =
      phase === 'estimate' ? service.estimate(createImageData(), { force: true }) : service.initialize();
    if (phase !== 'loading') {
      const worker = workers.at(-1);
      worker.reply(worker.requests.at(-1), phase === 'estimate' ? createDepth(100) : initializedState);
    }
    await assert.rejects(pending, /disposed|superseded/);
    assert.equal(service.getState().state, 'idle');
  });
}

test('initialization subscribers can join the same in-progress operation', async () => {
  const { service, workers } = createRuntime();
  let joined;
  service.addListener((state) => {
    if (state.state === 'loading') joined = service.initialize();
  });
  const pending = service.initialize();
  assert.equal(joined, pending);
  workers[0].reply(workers[0].requests[0], initializedState);
  await pending;
  assert.equal(workers.length, 1);
  service.dispose();
});

test('busy and cadence-skipped depth calls return no result and never consume their input', async () => {
  let now = 0;
  const { service, workers, initialize } = createRuntime({ now: () => now });
  assert.equal(await service.estimate(createImageData()), null);
  await initialize();
  assert.equal(service.shouldEstimate(), true);
  const source = createImageData();
  const pending = service.estimate(source, { timestamp: now });
  const request = workers[0].requests.at(-1);
  assert.equal(request.payload.imageData.data, source.data);
  assert.deepEqual(request.transfers, [source.data.buffer]);
  const skipped = createImageData();
  assert.equal(await service.estimate(skipped, { force: true }), null);
  assert.equal(skipped.data.byteLength, 64);
  workers[0].reply(request, createDepth(now));
  assert.equal((await pending).sourceWidth, 8);
  now = 80;
  assert.equal(await service.estimate(skipped), null);
  assert.equal(skipped.data.byteLength, 64);
  assert.equal(workers[0].requests.length, 2);
  now = 260;
  assert.equal(service.shouldEstimate(), true);
  service.dispose();
});

test('unowned and duplicate replies cannot publish state or release the current estimate', async () => {
  const { service, workers, initialize } = createRuntime();
  await initialize();
  const worker = workers[0];
  const publications = [];
  const unsubscribe = service.addListener((state) => publications.push(state));
  worker.reply({ id: 1000 }, createDepth(0));
  worker.reply(worker.requests[0], { ...initializedState, provider: 'duplicate' });
  assert.equal(publications.length, 0);
  const first = service.estimate(createImageData(), { force: true });
  const firstRequest = worker.requests.at(-1);
  worker.reply(firstRequest, createDepth(100));
  assert.equal((await first).timestamp, 100);
  const second = service.estimate(createImageData(), { force: true });
  worker.reply(firstRequest, createDepth(0));
  worker.onmessage({ data: { id: firstRequest.id, error: 'duplicate error' } });
  assert.equal(service.shouldEstimate({ force: true }), false);
  assert.equal(service.getState().error, null);
  assert.equal(publications.length, 1);
  worker.reply(worker.requests.at(-1), createDepth(200));
  assert.equal((await second).timestamp, 200);
  assert.equal(service.shouldEstimate({ force: true }), true);
  unsubscribe();
  service.dispose();
  assert.equal(publications.length, 2);
});
