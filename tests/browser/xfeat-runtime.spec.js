import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';
import { createLaminatedCardSequence } from '../../src/cv/synthetic/visionFixtures.js';
import { productionAssetUrl } from './productionAsset.js';

const XFEAT_WIDTH = 256;
const XFEAT_HEIGHT = 192;

const resizeFrame = (frame) => {
  const data = new Uint8ClampedArray(XFEAT_WIDTH * XFEAT_HEIGHT * 4);
  for (let y = 0; y < XFEAT_HEIGHT; y++) {
    const sourceY = Math.min(
      frame.imageData.height - 1,
      Math.floor(((y + 0.5) * frame.imageData.height) / XFEAT_HEIGHT),
    );
    for (let x = 0; x < XFEAT_WIDTH; x++) {
      const sourceX = Math.min(
        frame.imageData.width - 1,
        Math.floor(((x + 0.5) * frame.imageData.width) / XFEAT_WIDTH),
      );
      const source = (sourceY * frame.imageData.width + sourceX) * 4;
      const target = (y * XFEAT_WIDTH + x) * 4;
      data[target] = frame.imageData.data[source];
      data[target + 1] = frame.imageData.data[source + 1];
      data[target + 2] = frame.imageData.data[source + 2];
      data[target + 3] = frame.imageData.data[source + 3];
    }
  }
  return {
    width: XFEAT_WIDTH,
    height: XFEAT_HEIGHT,
    data: Buffer.from(data).toString('base64'),
  };
};

const scalePoint = (point, sourceFrame) => ({
  x: (point.x * XFEAT_WIDTH) / sourceFrame.width,
  y: (point.y * XFEAT_HEIGHT) / sourceFrame.height,
});

const createTrackedPoints = (frame) =>
  Array.from({ length: 96 }, (_, id) => {
    const column = id % 12;
    const row = Math.floor(id / 12);
    const point = scalePoint(
      {
        x: frame.boundingBox.x1 + ((column + 0.5) * (frame.boundingBox.x2 - frame.boundingBox.x1)) / 12,
        y: frame.boundingBox.y1 + ((row + 0.5) * (frame.boundingBox.y2 - frame.boundingBox.y1)) / 8,
      },
      frame.imageData,
    );
    return {
      id,
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 5,
      recentDropout: false,
      original: point,
      current: { ...point },
      totalSuccessfulFrames: 8,
      successfulTrackingStreak: 8,
      landmarkQuality: 0.9,
      response: 1,
    };
  });

const sequence = createLaminatedCardSequence();
const referenceFixture = sequence.frames[0];
const queryFixture = sequence.frames[23];
const recoveryFixture = {
  referenceFrame: resizeFrame(referenceFixture),
  queryFrame: resizeFrame(queryFixture),
  trackedPoints: createTrackedPoints(referenceFixture),
  referenceAnchor: scalePoint(referenceFixture.groundTruth.anchor, referenceFixture.imageData),
  queryAnchor: scalePoint(queryFixture.groundTruth.anchor, queryFixture.imageData),
};

const productionXFeatWorkerUrl = () =>
  productionAssetUrl({
    label: 'XFeat worker',
    pattern: /^xfeat\.worker-[\w-]+\.js$/,
  });

test('production XFeat recovers a transformed fixture through a nested worker', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');

  const result = await page.evaluate(
    async ({ workerUrl, fixture }) => {
      const parentSource = `
      let nestedWorker = null;
      self.onmessage = event => {
        if (event.data.command === 'initialize') {
          nestedWorker = new Worker(event.data.workerUrl, { type: 'module' });
          nestedWorker.onmessage = nestedEvent => self.postMessage({
            type: 'response',
            message: nestedEvent.data,
          });
          nestedWorker.onerror = error => self.postMessage({
            type: 'error',
            message: error.message,
          });
          self.postMessage({ type: 'ready' });
          return;
        }
        if (event.data.command === 'terminate') {
          nestedWorker.terminate();
          self.close();
          return;
        }
        nestedWorker.postMessage(event.data.message, event.data.transferables);
      };
    `;
      const parentUrl = URL.createObjectURL(
        new Blob([parentSource], {
          type: 'text/javascript',
        }),
      );
      const parentWorker = new Worker(parentUrl, { type: 'module' });
      const pending = new Map();
      let nextRequestId = 1;
      const ready = new Promise((resolveReady, rejectReady) => {
        parentWorker.onmessage = (event) => {
          if (event.data.type === 'ready') {
            resolveReady();
            return;
          }
          if (event.data.type === 'error') {
            const error = new Error(event.data.message);
            rejectReady(error);
            for (const queuedRequest of pending.values()) queuedRequest.reject(error);
            pending.clear();
            return;
          }
          const pendingRequest = pending.get(event.data.message.id);
          if (!pendingRequest) return;
          pending.delete(event.data.message.id);
          if (event.data.message.error) {
            pendingRequest.reject(new Error(event.data.message.error));
          } else {
            pendingRequest.resolve(event.data.message.result);
          }
        };
        parentWorker.onerror = (error) => {
          const failure = new Error(error.message);
          rejectReady(failure);
          for (const pendingRequest of pending.values()) pendingRequest.reject(failure);
          pending.clear();
        };
      });
      const request = (command, payload, transferables = []) => {
        const id = nextRequestId++;
        const response = new Promise((resolveRequest, rejectRequest) => {
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        });
        parentWorker.postMessage(
          {
            command: 'request',
            message: { id, command, payload },
            transferables,
          },
          transferables,
        );
        return response;
      };
      const decodeFrame = (frame) => {
        const bytes = Uint8Array.from(atob(frame.data), (character) => character.charCodeAt(0));
        return {
          width: frame.width,
          height: frame.height,
          data: new Uint8ClampedArray(bytes.buffer),
        };
      };

      parentWorker.postMessage({
        command: 'initialize',
        workerUrl: new URL(workerUrl, window.location.href).href,
      });
      await ready;
      const referenceFrame = decodeFrame(fixture.referenceFrame);
      const stored = await request(
        'storeReference',
        {
          imageData: referenceFrame,
          trackedPoints: fixture.trackedPoints,
          anchorPoint: fixture.referenceAnchor,
        },
        [referenceFrame.data.buffer],
      );
      const queryFrame = decodeFrame(fixture.queryFrame);
      const recovered = await request('relocalize', { imageData: queryFrame }, [queryFrame.data.buffer]);
      const cleared = await request('clear', null);
      const clearedQueryFrame = decodeFrame(fixture.queryFrame);
      const afterClear = await request('relocalize', { imageData: clearedQueryFrame }, [
        clearedQueryFrame.data.buffer,
      ]);
      parentWorker.postMessage({ command: 'terminate' });
      URL.revokeObjectURL(parentUrl);
      return { stored, recovered, cleared, afterClear };
    },
    {
      workerUrl: productionXFeatWorkerUrl(),
      fixture: recoveryFixture,
    },
  );

  expect(result.stored.success).toBe(true);
  expect(result.stored.descriptorCount).toBeGreaterThanOrEqual(5);
  expect(result.recovered, result.recovered.reason).toMatchObject({ success: true });
  expect(result.recovered.method).toBe('xfeat-keyframe-relocalization');
  expect(result.recovered.inlierCount).toBeGreaterThanOrEqual(5);
  expect(
    Math.hypot(
      result.recovered.anchorPoint.x - recoveryFixture.queryAnchor.x,
      result.recovered.anchorPoint.y - recoveryFixture.queryAnchor.y,
    ),
  ).toBeLessThan(5);
  expect(result.cleared).toBe(true);
  expect(result.afterClear).toEqual({
    success: false,
    reason: 'No XFeat reference available',
  });
  expect(pageErrors).toEqual([]);
});
