import assert from 'node:assert/strict';
import test from 'node:test';
import { XFeatWorkerRelocalizer } from './xfeatWorkerClient.js';

class FakeWorker {
  constructor() {
    this.requests = [];
    this.terminated = false;
  }

  postMessage(message, transferables = []) {
    this.requests.push({ message, transferables });
    if (message.id === null) return;
    const result =
      message.command === 'storeReference'
        ? { success: true, descriptorCount: 24 }
        : { success: true, method: 'xfeat-keyframe-relocalization', inlierCount: 8 };
    queueMicrotask(() => this.onmessage({ data: { id: message.id, result } }));
  }

  terminate() {
    this.terminated = true;
  }
}

class ControlledWorker {
  constructor() {
    this.requests = [];
    this.terminated = false;
  }

  postMessage(message, transferables = []) {
    this.requests.push({ message, transferables });
  }

  terminate() {
    this.terminated = true;
  }

  respond(result) {
    const request = this.requests.find(({ message }) => message.id !== null);
    this.onmessage({ data: { id: request.message.id, result } });
  }
}

const imageData = () => ({
  width: 8,
  height: 8,
  data: new Uint8ClampedArray(8 * 8 * 4),
});

const createManualTimeoutScheduler = () => {
  let callback = null;
  return {
    schedule: (nextCallback) => {
      assert.equal(callback, null, 'XFeat worker scheduled more than one request deadline');
      callback = nextCallback;
      return () => {
        callback = null;
      };
    },
    run: () => {
      assert.notEqual(callback, null, 'XFeat worker did not schedule a request deadline');
      const scheduledCallback = callback;
      callback = null;
      scheduledCallback();
    },
  };
};

test('XFeat client rejects incomplete worker ownership and invalid deadlines', () => {
  assert.throws(() => new XFeatWorkerRelocalizer({ createWorker: null }), /createWorker required/);
  assert.throws(
    () => new XFeatWorkerRelocalizer({ createWorker: () => new FakeWorker(), referenceTimeoutMs: 0 }),
    /XFeat timeout must be a positive finite number/,
  );
});

test('XFeat worker client transfers reference ownership and preserves the live query frame', async () => {
  const worker = new FakeWorker();
  const relocalizer = new XFeatWorkerRelocalizer({ createWorker: () => worker });
  const referenceImage = imageData();
  const queryImage = imageData();

  const stored = await relocalizer.storeReference({
    imageData: referenceImage,
    trackedPoints: [],
    anchorPoint: { x: 4, y: 4 },
  });
  const recovered = await relocalizer.relocalize(queryImage);

  assert.equal(stored.descriptorCount, 24);
  assert.equal(relocalizer.hasReference(), true);
  assert.equal(recovered.inlierCount, 8);
  assert.deepEqual(
    worker.requests.map((request) => request.message.command),
    ['storeReference', 'relocalize'],
  );
  assert.equal(worker.requests[0].transferables[0], referenceImage.data.buffer);
  assert.notEqual(worker.requests[1].transferables[0], queryImage.data.buffer);
  assert.equal(worker.requests[1].message.payload.imageData.width, queryImage.width);
  assert.deepEqual(worker.requests[1].message.payload.imageData.data, queryImage.data);
  assert.equal(queryImage.data.byteLength, 8 * 8 * 4);
});

test('a rejected memory extension preserves an already published XFeat reference', async () => {
  let storageCount = 0;
  const worker = new FakeWorker();
  worker.postMessage = function postMessage(message, transferables = []) {
    this.requests.push({ message, transferables });
    const result =
      storageCount++ === 0
        ? { success: true, descriptorCount: 24, keyframeCount: 1 }
        : {
            success: false,
            descriptorCount: 3,
            keyframeCount: 1,
            reason: 'Insufficient second-view support',
          };
    queueMicrotask(() => this.onmessage({ data: { id: message.id, result } }));
  };
  const relocalizer = new XFeatWorkerRelocalizer({ createWorker: () => worker });

  const first = await relocalizer.storeReference({
    imageData: imageData(),
    trackedPoints: [],
    anchorPoint: { x: 4, y: 4 },
  });
  const extension = await relocalizer.storeReference({
    imageData: imageData(),
    trackedPoints: [],
    anchorPoint: { x: 5, y: 4 },
  });

  assert.equal(first.success, true);
  assert.equal(extension.success, false);
  assert.equal(relocalizer.hasReference(), true);
});

test('XFeat worker client clears runtime state and terminates the worker on disposal', async () => {
  const worker = new FakeWorker();
  const relocalizer = new XFeatWorkerRelocalizer({ createWorker: () => worker });
  await relocalizer.storeReference({
    imageData: imageData(),
    trackedPoints: [],
    anchorPoint: { x: 4, y: 4 },
  });

  relocalizer.clear();
  relocalizer.dispose();

  assert.equal(relocalizer.hasReference(), false);
  assert.equal(worker.requests.at(-1).message.command, 'clear');
  assert.equal(worker.terminated, true);
  await assert.rejects(relocalizer.relocalize(imageData()), /XFeat worker disposed/);
});

test('XFeat clear supersedes in-flight reference publication while preserving the loaded runtime', async () => {
  const worker = new ControlledWorker();
  const relocalizer = new XFeatWorkerRelocalizer({ createWorker: () => worker });
  const storing = relocalizer.storeReference({
    imageData: imageData(),
    trackedPoints: [],
    anchorPoint: { x: 4, y: 4 },
  });

  relocalizer.clear();

  assert.equal(worker.terminated, false);
  assert.deepEqual(
    worker.requests.map((request) => request.message.command),
    ['storeReference', 'clear'],
  );
  worker.respond({ success: true, descriptorCount: 24 });
  assert.deepEqual(await storing, {
    success: false,
    descriptorCount: 0,
    reason: 'Learned reference storage superseded',
  });
  assert.equal(relocalizer.hasReference(), false);
});

test('late failures from a retired XFeat worker cannot terminate its successor', async () => {
  const workers = [];
  const relocalizer = new XFeatWorkerRelocalizer({
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const firstStore = relocalizer.storeReference({
    imageData: imageData(),
    trackedPoints: [],
    anchorPoint: { x: 4, y: 4 },
  });
  workers[0].onerror({ message: 'first worker failed' });
  await assert.rejects(firstStore, /first worker failed/);

  const secondStore = relocalizer.storeReference({
    imageData: imageData(),
    trackedPoints: [],
    anchorPoint: { x: 4, y: 4 },
  });
  const successor = workers[1];
  workers[0].onerror({ message: 'late retired-worker failure' });

  assert.equal(successor.terminated, false);
  successor.respond({ success: true, descriptorCount: 31 });
  assert.deepEqual(await secondStore, { success: true, descriptorCount: 31 });
  assert.equal(relocalizer.hasReference(), true);
});

test('XFeat request deadline retires a stalled worker and starts retries in a clean runtime', async () => {
  const scheduler = createManualTimeoutScheduler();
  const workers = [];
  const relocalizer = new XFeatWorkerRelocalizer({
    referenceTimeoutMs: 1000,
    scheduleRequestTimeout: scheduler.schedule,
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });

  const stalled = relocalizer.storeReference({
    imageData: imageData(),
    trackedPoints: [],
    anchorPoint: { x: 4, y: 4 },
  });
  scheduler.run();

  await assert.rejects(stalled, /XFeat storeReference timed out after 1000ms/);
  assert.equal(workers[0].terminated, true);
  assert.equal(relocalizer.pendingRequests.size, 0);
  assert.equal(relocalizer.hasReference(), false);

  const retry = relocalizer.storeReference({
    imageData: imageData(),
    trackedPoints: [],
    anchorPoint: { x: 4, y: 4 },
  });
  workers[1].respond({ success: true, descriptorCount: 32 });

  assert.deepEqual(await retry, { success: true, descriptorCount: 32 });
  assert.equal(relocalizer.hasReference(), true);
});
