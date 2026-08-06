import { expect, test } from '@playwright/test';
import { productionAssetUrl } from './productionAsset.js';

const SOURCE_WIDTH = 320;
const SOURCE_HEIGHT = 240;
const TAP_POSITION = Object.freeze({ x: 160, y: 120 });
const TRANSLATION = Object.freeze({ x: 3, y: 2 });

const productionAnchorWorkerFactoryUrl = () =>
  productionAssetUrl({
    label: 'anchor worker factory',
    pattern: /^anchor\.worker-[\w-]+\.js$/,
    maxBytes: 1_000,
  });

test('production anchor worker initializes OpenCV and tracks a translated tapped object', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  const capabilityRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (/anchor\.worker|opencv|interactiveSegmenter|magic-touch|vision_wasm/i.test(request.url())) {
      capabilityRequests.push(request.url());
    }
  });
  await page.goto('/');

  const result = await page.evaluate(
    async ({ workerFactoryUrl, width, height, tapPosition, translation }) => {
      const { default: AnchorWorker } = await import(new URL(workerFactoryUrl, window.location.href).href);
      const worker = new AnchorWorker();
      let nextRequestId = 1;

      const request = (command, payload = {}, transferList = []) =>
        new Promise((resolve, reject) => {
          const id = nextRequestId++;
          const timeoutId = setTimeout(() => {
            worker.terminate();
            reject(new Error(`Anchor worker ${command} request timed out`));
          }, 120_000);
          worker.onmessage = (event) => {
            if (event.data.id !== id) return;
            clearTimeout(timeoutId);
            if (event.data.error) {
              reject(new Error(event.data.error));
            } else {
              resolve(event.data);
            }
          };
          worker.onerror = (error) => {
            clearTimeout(timeoutId);
            reject(new Error(error.message));
          };
          worker.onmessageerror = () => {
            clearTimeout(timeoutId);
            reject(new Error('Anchor worker response could not be deserialized'));
          };
          worker.postMessage({ id, command, payload }, transferList);
        });

      const createFrame = ({ offsetX, offsetY }) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const localX = x - offsetX;
            const localY = y - offsetY;
            const objectDx = (localX - tapPosition.x) / (width * 0.3);
            const objectDy = (localY - tapPosition.y) / (height * 0.3);
            const foreground = objectDx * objectDx + objectDy * objectDy <= 1;
            let objectNoise = Math.imul(localX, 374761393) ^ Math.imul(localY, 668265263);
            objectNoise = (objectNoise ^ (objectNoise >>> 13)) & 127;
            const backgroundChecker = ((localX >> 3) ^ (localY >> 3)) & 1;
            data[offset] = foreground ? 128 + objectNoise : 30 + Math.round(Math.max(0, localX) * 0.28);
            data[offset + 1] = foreground
              ? 20 + (objectNoise >> 2)
              : 70 + Math.round(Math.max(0, localY) * 0.35);
            data[offset + 2] = foreground ? 15 + (objectNoise >> 3) : 108 + backgroundChecker * 14;
            data[offset + 3] = 255;
          }
        }
        return { width, height, data };
      };

      const initialized = await request('initialize', {
        viewportWidth: width,
        viewportHeight: height,
        fov: 63,
        trackingMode: 'sparse-reconstruction',
      });

      const initialFrame = createFrame({ offsetX: 0, offsetY: 0 });
      const translatedReference = initialFrame.data.slice();
      const initialBuffer = initialFrame.data.buffer;
      const created = await request(
        'createAnchorFromTap',
        {
          tapPosition,
          imageData: initialFrame,
        },
        [initialBuffer],
      );

      const warmupFrame = createFrame({ offsetX: 0, offsetY: 0 });
      const warmupBuffer = warmupFrame.data.buffer;
      const warmedUp = await request(
        'processFrame',
        {
          imageData: warmupFrame,
          update: true,
          refreshSegmentation: false,
          depthContext: {},
        },
        [warmupBuffer],
      );

      const movedFrame = createFrame({
        offsetX: translation.x,
        offsetY: translation.y,
      });
      let translationMismatchCount = 0;
      for (let y = translation.y; y < height; y++) {
        for (let x = translation.x; x < width; x++) {
          const movedOffset = (y * width + x) * 4;
          const referenceOffset = ((y - translation.y) * width + x - translation.x) * 4;
          for (let channel = 0; channel < 4; channel++) {
            if (movedFrame.data[movedOffset + channel] !== translatedReference[referenceOffset + channel]) {
              translationMismatchCount++;
            }
          }
        }
      }
      const movedBuffer = movedFrame.data.buffer;
      const tracked = await request(
        'processFrame',
        {
          imageData: movedFrame,
          update: true,
          refreshSegmentation: false,
          depthContext: {},
        },
        [movedBuffer],
      );

      const disposed = await request('dispose');
      worker.terminate();

      return {
        initialDetached: initialBuffer.byteLength === 0,
        warmupDetached: warmupBuffer.byteLength === 0,
        movedDetached: movedBuffer.byteLength === 0,
        translationMismatchCount,
        initialized: initialized.state,
        created: {
          result: created.result,
          state: created.state,
        },
        warmedUp: {
          result: warmedUp.result,
          state: warmedUp.state,
        },
        tracked: {
          result: tracked.result,
          state: tracked.state,
        },
        disposedState: disposed.state,
      };
    },
    {
      workerFactoryUrl: productionAnchorWorkerFactoryUrl(),
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      tapPosition: TAP_POSITION,
      translation: TRANSLATION,
    },
  );

  expect(result.initialized).toMatchObject({
    initialized: true,
    mode: 'selection',
    trackingMode: 'sparse-reconstruction',
  });
  expect(
    result.created.result,
    JSON.stringify({ capabilityRequests, creationResult: result.created.result }),
  ).toMatchObject({
    success: true,
    objectSupportMaskSource: 'interactive-segmenter',
    trackingMode: 'sparse-reconstruction',
  });
  expect(result.created.result.keypoints).toBeGreaterThanOrEqual(8);
  expect(result.created.state).toMatchObject({
    initialized: true,
    mode: 'anchor',
    activeAnchor: {
      objectSupportMaskSource: 'interactive-segmenter',
    },
  });
  expect(result.created.state.activeAnchor.selectionRegion.objectSupportMask.data).toBeUndefined();
  expect(result.warmedUp.result.updateResult.success).toBe(true);
  expect(result.tracked.result.updateResult.success).toBe(true);
  expect(result.tracked.result.updateResult.method).toBe('planar-homography');
  expect(result.tracked.state.anchorState.anchored).toBe(true);
  expect(result.tracked.state.anchorState.metrics.activeLandmarks).toBeGreaterThanOrEqual(8);
  expect(result.tracked.state.anchorState.metrics.trackingSuccessRate).toBeGreaterThan(0.5);
  expect(result.translationMismatchCount).toBe(0);
  expect(result.tracked.state.activeAnchor.position.x, JSON.stringify(result.tracked)).toBeGreaterThan(
    TAP_POSITION.x + 0.5,
  );
  expect(result.tracked.state.activeAnchor.position.y, JSON.stringify(result.tracked)).toBeGreaterThan(
    TAP_POSITION.y + 0.5,
  );
  expect(result.initialDetached).toBe(true);
  expect(result.warmupDetached).toBe(true);
  expect(result.movedDetached).toBe(true);
  expect(result.disposedState).toBeNull();

  const anchorWorkerRequests = capabilityRequests.filter((url) => /anchor\.worker-[\w-]+\.js$/.test(url));
  expect(new Set(anchorWorkerRequests).size).toBe(2);
  expect(capabilityRequests.some((url) => /opencv-[\w-]+\.js$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /interactiveSegmenter\.worker-[\w-]+\.js$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /magic-touch-f32-[\w-]+\.tflite$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /vision_wasm_module_internal-[\w-]+\.wasm$/.test(url))).toBe(true);
  expect(pageErrors).toEqual([]);
});
