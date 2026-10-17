import assert from 'node:assert/strict';
import test from 'node:test';
import { AnchorWorkerService } from './AnchorWorkerService.js';
import { DepthEstimationService } from './DepthEstimationService.js';
import { XFeatWorkerRelocalizer } from '../cv/xfeatWorkerClient.js';

class FailedWorker {
  postMessage({ id }) {
    queueMicrotask(() => this.onmessage({ data: { id, error: '' } }));
  }
  terminate() {}
}

const requests = {
  depth: () => new DepthEstimationService({ workerFactory: () => new FailedWorker() }).initialize(),
  anchor: () =>
    new AnchorWorkerService({ loadWorkerClass: async () => FailedWorker }).initialize(null, 320, 240),
  XFeat: () =>
    new XFeatWorkerRelocalizer({ createWorker: () => new FailedWorker() }).storeReference({
      objectSupportMask: null,
      imageData: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
      trackedPoints: [],
      anchorPoint: { x: 0, y: 0 },
    }),
};

for (const [name, request] of Object.entries(requests)) {
  test(`${name} rejects an explicit worker error even when its message is empty`, async (t) => {
    t.mock.method(console, 'error', () => {});
    await assert.rejects(request(), { name: 'Error', message: '' });
  });
}
