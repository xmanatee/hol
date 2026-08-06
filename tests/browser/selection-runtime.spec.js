import { expect, test } from '@playwright/test';
import { productionAssetUrl } from './productionAsset.js';

const SOURCE_WIDTH = 160;
const SOURCE_HEIGHT = 120;
const TAP_POSITION = Object.freeze({ x: 80, y: 60 });

const productionSegmenterWorkerUrl = () =>
  productionAssetUrl({
    label: 'interactive segmenter worker',
    pattern: /^interactiveSegmenter\.worker-[\w-]+\.js$/,
    minBytes: 100_000,
  });

test('production interactive segmenter runs real tap inference in a mobile browser', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  const capabilityRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (/interactiveSegmenter|magic-touch|vision_wasm/i.test(request.url())) {
      capabilityRequests.push(request.url());
    }
  });
  await page.goto('/');

  const result = await page.evaluate(
    async ({ workerUrl, width, height, tapPosition }) => {
      const worker = new Worker(new URL(workerUrl, window.location.href), { type: 'module' });
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          const objectDx = (x - tapPosition.x) / 48;
          const objectDy = (y - tapPosition.y) / 36;
          const foreground = objectDx * objectDx + objectDy * objectDy <= 1;
          const checker = ((x >> 3) ^ (y >> 3)) & 1;
          data[offset] = foreground ? 212 + checker * 32 : 30 + Math.round(x * 0.28);
          data[offset + 1] = foreground ? 48 + Math.round(y * 0.45) : 70 + Math.round(y * 0.35);
          data[offset + 2] = foreground ? 34 + checker * 18 : 108 + checker * 14;
          data[offset + 3] = 255;
        }
      }

      const sourceBuffer = data.buffer;
      const objectSupportMask = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          worker.terminate();
          reject(new Error('Interactive segmenter browser contract timed out'));
        }, 120_000);
        worker.onmessage = (event) => {
          clearTimeout(timeoutId);
          if (event.data.type === 'segment-result') {
            resolve(event.data.objectSupportMask);
          } else {
            reject(new Error(event.data.reason));
          }
        };
        worker.onerror = (error) => {
          clearTimeout(timeoutId);
          reject(new Error(error.message));
        };
        worker.onmessageerror = () => {
          clearTimeout(timeoutId);
          reject(new Error('Interactive segmenter response could not be deserialized'));
        };
        worker.postMessage(
          {
            type: 'segment',
            requestId: 1,
            imageData: { width, height, data },
            tapPosition,
            createdAtFrame: 17,
            maxRadius: null,
          },
          [sourceBuffer],
        );
      });

      let positivePixels = 0;
      for (const value of objectSupportMask.data) {
        if (value > 0) positivePixels++;
      }
      const tapIncluded =
        objectSupportMask.data[
          Math.trunc(tapPosition.y) * objectSupportMask.width + Math.trunc(tapPosition.x)
        ] > 0;
      worker.terminate();
      return {
        sourceDetached: sourceBuffer.byteLength === 0,
        tapIncluded,
        mask: {
          ...objectSupportMask,
          data: {
            length: objectSupportMask.data.length,
            positivePixels,
          },
        },
      };
    },
    {
      workerUrl: productionSegmenterWorkerUrl(),
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      tapPosition: TAP_POSITION,
    },
  );

  expect(result.sourceDetached).toBe(true);
  expect(result.tapIncluded, JSON.stringify(result.mask)).toBe(true);
  expect(result.mask).toMatchObject({
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT,
    source: 'interactive-segmenter',
    referencePoint: TAP_POSITION,
    createdAtFrame: 17,
    updatedAtFrame: 17,
    data: {
      length: SOURCE_WIDTH * SOURCE_HEIGHT,
    },
  });
  expect(result.mask.confidence).toBeGreaterThanOrEqual(0.5);
  expect(result.mask.confidence).toBeLessThanOrEqual(1);
  expect(result.mask.data.positivePixels).toBeGreaterThan(0);
  expect(result.mask.data.positivePixels).toBeLessThan((SOURCE_WIDTH * SOURCE_HEIGHT) / 2);
  expect(result.mask.bbox.width).toBeGreaterThan(0);
  expect(result.mask.bbox.width).toBeLessThan(SOURCE_WIDTH);
  expect(result.mask.bbox.height).toBeGreaterThan(0);
  expect(result.mask.bbox.height).toBeLessThan(SOURCE_HEIGHT);
  expect(capabilityRequests.some((url) => /interactiveSegmenter\.worker-[\w-]+\.js$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /magic-touch-f32-[\w-]+\.tflite$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /vision_wasm_module_internal-[\w-]+\.js$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /vision_wasm_module_internal-[\w-]+\.wasm$/.test(url))).toBe(true);
  expect(pageErrors).toEqual([]);
});
