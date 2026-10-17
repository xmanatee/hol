import { expect, test } from '@playwright/test';

const waitForActiveCamera = async (page) => {
  const canvas = page.locator('canvas');
  const video = page.locator('video');
  await expect(video).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => video.evaluate((element) => Boolean(element.srcObject)), { timeout: 10_000 })
    .toBe(true);
  return { canvas, video };
};

const instrumentCanvasReadbacks = (page) =>
  page.addInitScript(() => {
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    window.__holCanvasReadbacks = [];
    window.__holCameraCaptures = [];
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (args[0] instanceof HTMLVideoElement) {
        window.__holCameraCaptures.push({ at: performance.now() });
      }
      return drawImage.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const imageData = getImageData.apply(this, args);
      window.__holCanvasReadbacks.push({
        at: performance.now(),
        width: imageData.width,
        height: imageData.height,
      });
      return imageData;
    };
  });

test('mobile shell is usable across portrait and landscape without runtime errors', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const startButton = page.getByRole('button', { name: 'Start Camera' });
  await expect(startButton).toBeVisible();
  await expect(startButton).toHaveCSS('cursor', 'pointer');

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(startButton).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(startButton).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('mobile browser natively crops and resizes ImageData for bounded vision input', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const source = new ImageData(new Uint8ClampedArray(100 * 80 * 4), 100, 80);
    const bitmap = await createImageBitmap(source, 88, 68, 12, 12, {
      resizeWidth: 6,
      resizeHeight: 6,
      resizeQuality: 'high',
    });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.82);
    });
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
    return { ...dimensions, blobSize: blob?.size || 0, blobType: blob?.type || '' };
  });

  expect(result).toEqual({ width: 6, height: 6, blobSize: expect.any(Number), blobType: 'image/jpeg' });
  expect(result.blobSize).toBeGreaterThan(0);
});

test('production runtime registers the bounded capability-asset cache', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const serviceWorkerUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL || '';
  });

  expect(serviceWorkerUrl).toMatch(/\/sw\.js$/);
});

test('Chromium starts the camera only from the user gesture', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'Start Camera' }).click();
  const { canvas, video } = await waitForActiveCamera(page);
  await expect(video).toHaveCSS('opacity', '1');
  await expect(canvas).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.getByRole('button', { name: 'Start Camera' })).toBeHidden();
  await page.waitForTimeout(500);

  expect(pageErrors).toEqual([]);
});

test('camera discovery reads compositor-presented frames before any tap, with backpressure', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await instrumentCanvasReadbacks(page);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Start Camera' }).click();
  await waitForActiveCamera(page);
  await expect
    .poll(() => page.evaluate(() => window.__holCanvasReadbacks.length), { timeout: 60_000 })
    .toBeGreaterThan(0);
  const [readback] = await page.evaluate(() => window.__holCanvasReadbacks);
  expect(readback.width).toBeGreaterThan(0);
  expect(readback.height).toBeGreaterThan(0);
  await expect(page.getByTestId('object-discovery')).toBeVisible();
  const captures = await page.evaluate(() => window.__holCameraCaptures.length);
  expect(captures).toBeLessThanOrEqual(3);
});

test('rapid taps cannot trigger capture or segmentation while discovery is still initializing', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await instrumentCanvasReadbacks(page);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Start Camera' }).click();
  const { canvas } = await waitForActiveCamera(page);

  const counts = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const before = window.__holCanvasReadbacks.length;
    for (let tap = 0; tap < 10; tap++) {
      element.dispatchEvent(
        new PointerEvent('pointerup', {
          button: 0,
          isPrimary: true,
          clientX: bounds.x + bounds.width / 2,
          clientY: bounds.y + bounds.height / 2,
        }),
      );
    }
    return { before, after: window.__holCanvasReadbacks.length };
  });
  expect(counts.after).toBe(counts.before);
});

for (const [dependency, runtimeUrl] of [
  ['OpenCV', /\/assets\/opencv-[\w-]+\.js$/],
  ['segmentation model', /\/assets\/magic-touch-f32-[\w-]+\.tflite$/],
  ['segmentation WASM', /\/assets\/vision_wasm_module_internal-[\w-]+\.wasm$/],
]) {
  test(`a failed ${dependency} reports a retryable discovery error`, async ({
    page,
    context,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
    await context.route(runtimeUrl, (route) => route.abort());
    await page.goto('/');
    await page.getByRole('button', { name: 'Start Camera' }).click();
    const discovery = page.getByTestId('object-discovery');
    await expect(discovery).toHaveAttribute('data-stage', 'error', { timeout: 30_000 });
    await expect(discovery).toContainText('Object discovery unavailable');
    await page.evaluate(() => {
      window.__originalCameraStream = document.querySelector('video').srcObject;
    });
    await page.getByRole('button', { name: 'Controls' }).click();
    const drawer = page.getByRole('dialog', { name: 'Camera controls' });
    await expect(drawer.getByRole('alert')).toContainText('Object discovery unavailable');
    await expect(drawer.getByText('Loading on-device vision', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('Keypoints', { exact: true })).toHaveCount(0);
    await drawer.getByText('Technical details', { exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('vision-error.png') });
    await context.unroute(runtimeUrl);
    await drawer.getByRole('button', { name: 'Retry vision', exact: true }).click();
    await expect(discovery).not.toHaveAttribute('data-stage', /initializing|error/, { timeout: 30_000 });
    await expect(drawer.getByRole('status')).toBeFocused();
    expect(
      await page.evaluate(() => document.querySelector('video').srcObject === window.__originalCameraStream),
    ).toBe(true);
    await page.getByRole('button', { name: 'Close controls' }).click();
    await expect(discovery).toBeVisible();
  });
}

test('slow first model download remains loading without capturing stale camera frames', async ({
  page,
  context,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  test.setTimeout(60_000);
  await instrumentCanvasReadbacks(page);
  const download = Promise.withResolvers();
  let requestedAt = null;
  await context.route(/\/assets\/magic-touch-f32-[\w-]+\.tflite$/, async (route) => {
    requestedAt = Date.now();
    await download.promise;
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Camera' }).click();
  await expect.poll(() => requestedAt).not.toBeNull();
  const discovery = page.getByTestId('object-discovery');
  await expect(discovery).toHaveAttribute('data-stage', 'initializing');
  await expect(discovery).toContainText('Loading on-device vision');
  await page.getByRole('button', { name: 'Controls' }).click();
  const drawer = page.getByRole('dialog', { name: 'Camera controls' });
  await expect(drawer.getByText('Loading on-device vision', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Keypoints', { exact: true })).toHaveCount(0);
  await drawer.getByRole('tab', { name: 'Face', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Surface Fit', exact: true })).toHaveCount(0);
  await drawer.getByRole('tab', { name: 'Object', exact: true }).click();
  // Intentionally exceed the former 6 s cold inference deadline; this is a delayed network fault, not a readiness sleep.
  await expect.poll(() => Date.now() - requestedAt, { timeout: 10_000 }).toBeGreaterThan(6500);
  await expect(drawer.getByText('Loading on-device vision', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__holCameraCaptures.length)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('vision-loading.png') });
  for (const viewport of [
    { width: 844, height: 390 },
    { width: 1024, height: 1366 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(drawer.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
    const bounds = await drawer.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`vision-loading-${viewport.width}.png`) });
  }
  download.resolve();
  await expect(discovery).not.toHaveAttribute('data-stage', /initializing|error/, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__holCameraCaptures.length)).toBeGreaterThan(0);
  await drawer.getByRole('tab', { name: 'Face', exact: true }).click();
  await expect(drawer.getByText('Select a highlighted object to enable face controls.')).toBeVisible();
  await expect(drawer.getByRole('tabpanel').getByRole('slider')).toHaveCount(0);
});

test('stopping during model loading retires startup and a new camera session loads cleanly', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  const download = Promise.withResolvers();
  const requested = Promise.withResolvers();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route(/\/assets\/magic-touch-f32-[\w-]+\.tflite$/, async (route) => {
    requested.resolve();
    await download.promise;
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Camera' }).click();
  await requested.promise;
  await expect(page.getByTestId('object-discovery')).toHaveAttribute('data-stage', 'initializing');
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start Camera' })).toBeVisible();
  download.resolve();
  await page.getByRole('button', { name: 'Start Camera' }).click();
  await expect(page.getByTestId('object-discovery')).not.toHaveAttribute('data-stage', /initializing|error/, {
    timeout: 30_000,
  });
  expect(errors).toEqual([]);
});

test('active camera canvas follows portrait and landscape viewport changes', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Start Camera' }).click();
  const { canvas } = await waitForActiveCamera(page);

  for (const viewport of [
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(canvas).toHaveCSS('width', `${viewport.width}px`);
    await expect(canvas).toHaveCSS('height', `${viewport.height}px`);
    await expect(page.getByRole('button', { name: 'Start Camera' })).toBeHidden();
  }

  expect(pageErrors).toEqual([]);
});

test('ended camera track returns to a clean restartable session', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Start Camera' }).click();
  const { video } = await waitForActiveCamera(page);

  await video.evaluate((element) => {
    element.srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended'));
  });

  const restartButton = page.getByRole('button', { name: 'Start Camera' });
  await expect(restartButton).toBeVisible();
  await expect(page.getByText('Camera stream ended unexpectedly.')).toBeVisible();
  await restartButton.click();
  await waitForActiveCamera(page);

  expect(pageErrors).toEqual([]);
});
