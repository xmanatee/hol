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

test('production worker discovers, prepares, commits and tracks one object without rebuilding it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  const runtimeWarnings = [];
  const capabilityRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type()) && runtimeWarnings.length < 20)
      runtimeWarnings.push(message.text());
  });
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
      const discovered = await request(
        'processFrame',
        {
          imageData: initialFrame,
          capturedAt: performance.now(),
          update: true,
          refreshSegmentation: false,
          depthContext: {},
        },
        [initialBuffer],
      );
      let warmedUp;
      let warmupDetached = true;
      const observeStaticObject = async () => {
        const capturedAt = performance.now();
        const warmupFrame = createFrame({ offsetX: 0, offsetY: 0 });
        const warmupBuffer = warmupFrame.data.buffer;
        const response = await request(
          'processFrame',
          {
            imageData: warmupFrame,
            capturedAt,
            update: true,
            refreshSegmentation: false,
            depthContext: {},
          },
          [warmupBuffer],
        );
        warmupDetached &&= warmupBuffer.byteLength === 0;
        return response;
      };
      for (let observation = 0; observation < 3; observation++) {
        // Exercise filters on a real video cadence, not three same-tick worker requests.
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        warmedUp = await observeStaticObject();
      }
      const candidateId = warmedUp.state.candidate.id;
      const replaced = await request('selectCandidate', {
        candidateId: candidateId + 1,
        timeOrigin: performance.timeOrigin,
        tapPosition,
        capturedAt: performance.now(),
      });
      const neighbor = await request('selectCandidate', {
        candidateId,
        timeOrigin: performance.timeOrigin,
        tapPosition: { x: 5, y: 5 },
        capturedAt: performance.now(),
      });
      const selectedAt = performance.now();
      // Wait for this exact observation to expire; this tests a deadline, not model readiness.
      await new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, 301 - (performance.now() - warmedUp.state.candidate.capturedAt)));
      });
      const expired = await request('selectCandidate', {
        candidateId,
        timeOrigin: performance.timeOrigin,
        tapPosition,
        capturedAt: selectedAt,
      });
      const modeChanged = await request('setTrackingMode', { mode: 'object-pose' });
      await request('setTrackingMode', { mode: 'sparse-reconstruction' });
      for (let observation = 0; observation < 3; observation++) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        await observeStaticObject();
      }
      const created = await request('selectCandidate', {
        candidateId,
        timeOrigin: performance.timeOrigin,
        tapPosition,
        capturedAt: performance.now(),
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

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
          capturedAt: performance.now(),
          update: true,
          refreshSegmentation: false,
          depthContext: {},
        },
        [movedBuffer],
      );

      const refreshed = [];
      for (let refresh = 0; refresh < 2; refresh++) {
        // Controlled source cadence crosses the production 500 ms refresh deadline.
        await new Promise((resolve) => {
          setTimeout(resolve, 550);
        });
        const frame = createFrame({ offsetX: translation.x, offsetY: translation.y });
        const response = await request(
          'processFrame',
          {
            imageData: frame,
            capturedAt: performance.now(),
            update: true,
            refreshSegmentation: true,
            depthContext: {},
          },
          [frame.data.buffer],
        );
        refreshed.push({
          objectId: response.state.activeAnchor.id,
          segmentation: response.state.segmentationRefresh,
          targetPresent: response.result.updateResult.targetPresent,
        });
      }

      const disposed = await request('dispose');
      worker.terminate();

      return {
        initialDetached: initialBuffer.byteLength === 0,
        warmupDetached,
        movedDetached: movedBuffer.byteLength === 0,
        translationMismatchCount,
        refreshed,
        initialized: initialized.state,
        discovered,
        neighbor,
        replaced,
        expired,
        modeChanged,
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
  expect(result.discovered.state.mode).toBe('selection');
  expect(result.discovered.state.activeAnchor).toBeNull();
  expect(result.warmedUp.state.candidate.status, JSON.stringify(result.warmedUp)).toBe('ready');
  expect(result.neighbor.result.success).toBe(false);
  expect(result.replaced.result.success).toBe(false);
  expect(result.replaced.state.candidate.id).toBe(result.discovered.state.candidate.id);
  expect(result.expired.result.success).toBe(false);
  expect(result.expired.state.mode).toBe('selection');
  expect(result.modeChanged.state.candidate.id).toBe(result.discovered.state.candidate.id);
  expect(result.modeChanged.state.candidate.status).not.toBe('ready');
  expect(result.created.state.activeAnchor.id).toBe(result.discovered.state.candidate.id);
  expect(result.refreshed, JSON.stringify({ refreshed: result.refreshed, runtimeWarnings })).toEqual([
    {
      objectId: result.created.state.activeAnchor.id,
      segmentation: expect.objectContaining({ status: 'accepted', maskSource: 'interactive-segmenter' }),
      targetPresent: true,
    },
    {
      objectId: result.created.state.activeAnchor.id,
      segmentation: expect.objectContaining({ status: 'accepted', maskSource: 'interactive-segmenter' }),
      targetPresent: true,
    },
  ]);
  expect(result.created.result.method).toBe('prepared-object-selected');
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
  expect(result.tracked.state.anchorState.metrics.surfaceAttachment).toMatchObject({
    kind: 'planar-pnp',
    units: 'reference-pixels',
    rotation: expect.any(Array),
    translation: expect.any(Array),
  });
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
