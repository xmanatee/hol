import { expect, test } from '@playwright/test';
import { productionAssetUrl } from './productionAsset.js';

const DEPTH_INPUT_SIZE = 56;
const SOURCE_WIDTH = 64;
const SOURCE_HEIGHT = 48;

const productionDepthServiceUrl = () =>
  productionAssetUrl({
    label: 'depth service',
    pattern: /^DepthEstimationService-[\w-]+\.js$/,
  });

test('cancelled depth imports cannot start or orphan a superseded runtime', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');

  const serviceUrl = productionDepthServiceUrl();
  let releaseDepthChunk;
  let markDepthChunkRequested;
  const depthChunkReleased = new Promise((resolve) => {
    releaseDepthChunk = resolve;
  });
  const depthChunkRequested = new Promise((resolve) => {
    markDepthChunkRequested = resolve;
  });

  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__depthWorkerLifecycle = { created: 0, terminated: 0 };
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args);
        if (/\/depth\.worker-[\w-]+\.js$/.test(String(args[0]))) {
          window.__depthWorkerLifecycle.created++;
          const nativeTerminate = worker.terminate.bind(worker);
          worker.terminate = () => {
            window.__depthWorkerLifecycle.terminated++;
            return nativeTerminate();
          };
        }
        return worker;
      },
    });
  });
  await page.route(`**${serviceUrl}`, async (route) => {
    markDepthChunkRequested();
    await depthChunkReleased;
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Start Camera' }).click();
  await expect(page.locator('canvas')).toHaveCSS('pointer-events', 'auto', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Debug drawer' }).click();
  await page.getByRole('tab', { name: 'model', exact: true }).click();

  await page.getByRole('button', { name: 'Depth Fusion' }).click();
  await depthChunkRequested;
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await page.getByRole('button', { name: 'Depth Fusion' }).click();
  releaseDepthChunk();

  await expect
    .poll(() => page.evaluate(() => window.__depthWorkerLifecycle.created), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );

  expect(await page.evaluate(() => window.__depthWorkerLifecycle)).toEqual({
    created: 1,
    terminated: 0,
  });

  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__depthWorkerLifecycle.terminated)).toBe(1);
});

test('production depth service runs real worker inference in a mobile browser', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  const capabilityRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (/depth|ort-wasm-simd-threaded\.jsep/i.test(request.url())) {
      capabilityRequests.push(request.url());
    }
  });
  await page.goto('/');

  const result = await page.evaluate(
    async ({ serviceUrl, config }) => {
      const { DepthEstimationService } = await import(new URL(serviceUrl, window.location.href).href);
      const service = new DepthEstimationService({
        inputSize: config.inputSize,
        intervalMs: 0,
      });
      const initialized = await service.initialize();
      const data = new Uint8ClampedArray(config.sourceWidth * config.sourceHeight * 4);
      for (let y = 0; y < config.sourceHeight; y++) {
        for (let x = 0; x < config.sourceWidth; x++) {
          const offset = (y * config.sourceWidth + x) * 4;
          const foreground = x > 14 && x < 50 && y > 8 && y < 40;
          data[offset] = foreground ? 220 - y * 2 : x * 3;
          data[offset + 1] = foreground ? 52 + x * 2 : y * 4;
          data[offset + 2] = ((x >> 2) ^ (y >> 2)) & 1 ? 208 : 28;
          data[offset + 3] = 255;
        }
      }
      const sourceBuffer = data.buffer;
      const depth = await service.estimate(
        {
          width: config.sourceWidth,
          height: config.sourceHeight,
          data,
        },
        {
          force: true,
          timestamp: 1234,
        },
      );
      let min = Infinity;
      let max = -Infinity;
      let finiteCount = 0;
      for (const value of depth.data) {
        if (!Number.isFinite(value)) continue;
        min = Math.min(min, value);
        max = Math.max(max, value);
        finiteCount++;
      }
      const ready = service.getState();
      const latestMatches = service.getLatestFrame() === depth;
      service.dispose();
      return {
        initialized,
        ready,
        latestMatches,
        sourceDetached: sourceBuffer.byteLength === 0,
        disposed: service.getState(),
        latestAfterDispose: service.getLatestFrame(),
        depth: {
          ...depth,
          data: {
            length: depth.data.length,
            finiteCount,
            min,
            max,
          },
        },
      };
    },
    {
      serviceUrl: productionDepthServiceUrl(),
      config: {
        inputSize: DEPTH_INPUT_SIZE,
        sourceWidth: SOURCE_WIDTH,
        sourceHeight: SOURCE_HEIGHT,
      },
    },
  );

  expect(['webgpu', 'wasm']).toContain(result.initialized.provider);
  expect(result.initialized).toMatchObject({
    state: 'ready',
    inputSize: DEPTH_INPUT_SIZE,
    error: null,
  });
  expect(result.initialized.modelUrl).toMatch(/\/assets\/depth-anything-v2-small-q4-[\w-]+\.onnx$/);
  expect(result.depth).toMatchObject({
    timestamp: 1234,
    provider: result.initialized.provider,
    modelUrl: result.initialized.modelUrl,
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT,
    sourceWidth: SOURCE_WIDTH,
    sourceHeight: SOURCE_HEIGHT,
  });
  expect(result.depth.processingTime).toBeGreaterThan(0);
  expect(result.depth.data).toMatchObject({
    length: SOURCE_WIDTH * SOURCE_HEIGHT,
    finiteCount: SOURCE_WIDTH * SOURCE_HEIGHT,
  });
  expect(result.depth.data.min).toBeGreaterThanOrEqual(0);
  expect(result.depth.data.max).toBeLessThanOrEqual(1);
  expect(result.depth.data.max - result.depth.data.min).toBeGreaterThan(0.1);
  expect(result.ready).toMatchObject({
    state: 'ready',
    provider: result.initialized.provider,
    error: null,
  });
  expect(result.ready.processingTime).toBeGreaterThan(0);
  expect(result.latestMatches).toBe(true);
  expect(result.sourceDetached).toBe(true);
  expect(result.disposed.state).toBe('idle');
  expect(result.latestAfterDispose).toBe(null);
  expect(capabilityRequests.some((url) => /DepthEstimationService-[\w-]+\.js$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /depth\.worker-[\w-]+\.js$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /depth-anything-v2-small-q4-[\w-]+\.onnx$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /ort-wasm-simd-threaded\.jsep-[\w-]+\.mjs$/.test(url))).toBe(true);
  expect(capabilityRequests.some((url) => /ort-wasm-simd-threaded\.jsep-[\w-]+\.wasm$/.test(url))).toBe(true);
  expect(pageErrors).toEqual([]);
});
