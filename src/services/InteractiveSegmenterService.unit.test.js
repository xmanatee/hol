import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractiveSegmenterService } from './InteractiveSegmenterService.js';

class FakeWorker {
  static instances = [];

  constructor() {
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
    this.onmessage({
      data: {
        type: 'segment-result',
        requestId: message.requestId,
        objectSupportMask: {
          width: 4,
          height: 3,
          data: new Uint8Array([
            0, 0, 0, 0,
            0, 255, 255, 0,
            0, 0, 0, 0,
          ]),
          source: 'interactive-segmenter',
          confidence: 0.91,
          referencePoint: message.tapPosition,
          createdAtFrame: message.createdAtFrame,
          updatedAtFrame: message.createdAtFrame,
          bbox: { x: 1, y: 1, width: 2, height: 1 },
        },
      },
    });
  }

  terminate() {
    this.terminated = true;
  }
}

class DeferredWorker {
  static instances = [];

  constructor() {
    this.messages = [];
    this.terminated = false;
    DeferredWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }
}

class SlowWorkerCreationService extends InteractiveSegmenterService {
  async _createWorker(workerGeneration) {
    await Promise.resolve();
    return super._createWorker(workerGeneration);
  }
}

test('interactive segmenter service resolves worker masks with copied frame data', async () => {
  FakeWorker.instances = [];
  const service = new InteractiveSegmenterService({ WorkerClass: FakeWorker });
  const imageData = {
    width: 4,
    height: 3,
    data: new Uint8ClampedArray(4 * 3 * 4).fill(12),
  };

  const mask = await service.segmentTap({
    imageData,
    tapPosition: { x: 2, y: 1 },
    createdAtFrame: 5,
  });

  assert.equal(FakeWorker.instances.length, 1);
  assert.notEqual(FakeWorker.instances[0].messages[0].imageData.data.buffer, imageData.data.buffer);
  assert.equal(mask.source, 'interactive-segmenter');
  assert.deepEqual(mask.bbox, { x: 1, y: 1, width: 2, height: 1 });
  assert.equal(mask.confidence, 0.91);

  service.dispose();
  assert.equal(FakeWorker.instances[0].terminated, true);
});

test('interactive segmenter service rejects pending requests and ignores stale replies on dispose', async () => {
  DeferredWorker.instances = [];
  const service = new InteractiveSegmenterService({ WorkerClass: DeferredWorker });
  const imageData = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray(2 * 2 * 4),
  };

  const pending = service.segmentTap({
    imageData,
    tapPosition: { x: 1, y: 1 },
    createdAtFrame: 3,
  });

  service.dispose();

  await assert.rejects(pending, /Interactive segmenter disposed/);
  assert.equal(DeferredWorker.instances[0].terminated, true);
  assert.doesNotThrow(() => service._handleMessage({
    type: 'segment-result',
    requestId: 1,
    objectSupportMask: null,
  }));
});

test('interactive segmenter service does not create a worker after dispose wins lazy creation', async () => {
  DeferredWorker.instances = [];
  const service = new SlowWorkerCreationService({ WorkerClass: DeferredWorker });
  const imageData = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray(2 * 2 * 4),
  };

  const pending = service.segmentTap({
    imageData,
    tapPosition: { x: 1, y: 1 },
    createdAtFrame: 4,
  });

  service.dispose();

  await assert.rejects(pending, /Interactive segmenter disposed/);
  assert.equal(DeferredWorker.instances.length, 0);
});

test('interactive segmenter service clears failed workers before retrying', async () => {
  DeferredWorker.instances = [];
  const service = new InteractiveSegmenterService({ WorkerClass: DeferredWorker });
  const imageData = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray(2 * 2 * 4),
  };

  const failed = service.segmentTap({
    imageData,
    tapPosition: { x: 1, y: 1 },
    createdAtFrame: 6,
  });

  await Promise.resolve();
  DeferredWorker.instances[0].onerror({ message: 'worker crashed' });

  await assert.rejects(failed, /worker crashed/);
  assert.equal(DeferredWorker.instances[0].terminated, true);

  const retry = service.segmentTap({
    imageData,
    tapPosition: { x: 1, y: 1 },
    createdAtFrame: 7,
  });

  await Promise.resolve();
  assert.equal(DeferredWorker.instances.length, 2);

  DeferredWorker.instances[1].onmessage({
    data: {
      type: 'segment-result',
      requestId: 2,
      objectSupportMask: { source: 'interactive-segmenter', data: new Uint8Array([255]) },
    },
  });

  const result = await retry;
  assert.equal(result.source, 'interactive-segmenter');
});

test('interactive segmenter service times out stalled workers and retries with a fresh worker', async () => {
  DeferredWorker.instances = [];
  const service = new InteractiveSegmenterService({
    WorkerClass: DeferredWorker,
    requestTimeoutMs: 5,
  });
  const imageData = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray(2 * 2 * 4),
  };

  const stalled = service.segmentTap({
    imageData,
    tapPosition: { x: 1, y: 1 },
    createdAtFrame: 8,
  });

  await assert.rejects(stalled, /timed out/);
  assert.equal(DeferredWorker.instances[0].terminated, true);
  assert.equal(service.pendingRequests.size, 0);

  const retry = service.segmentTap({
    imageData,
    tapPosition: { x: 1, y: 1 },
    createdAtFrame: 9,
    timeoutMs: 50,
  });

  await Promise.resolve();
  assert.equal(DeferredWorker.instances.length, 2);
  DeferredWorker.instances[1].onmessage({
    data: {
      type: 'segment-result',
      requestId: 2,
      objectSupportMask: { source: 'interactive-segmenter', data: new Uint8Array([255]) },
    },
  });

  const result = await retry;
  assert.equal(result.source, 'interactive-segmenter');
});
