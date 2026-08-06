import { expect, test } from '@playwright/test';

const waitForActiveCamera = async (page) => {
  const canvas = page.locator('canvas');
  const video = page.locator('video');
  await expect(canvas).toHaveCSS('pointer-events', 'auto', { timeout: 10_000 });
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

const dispatchCenterTap = async (page, canvas) => {
  const bounds = await canvas.boundingBox();
  await canvas.dispatchEvent('pointerup', {
    button: 0,
    isPrimary: true,
    clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2,
  });
};

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

test('tap selection captures the compositor-presented video only from the tap gesture', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await instrumentCanvasReadbacks(page);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Start Camera' }).click();
  const { canvas } = await waitForActiveCamera(page);
  await page.waitForTimeout(750);

  expect(await page.evaluate(() => window.__holCanvasReadbacks)).toEqual([]);
  expect(await page.evaluate(() => window.__holCameraCaptures)).toEqual([]);

  const tapAt = await page.evaluate(() => performance.now());
  await dispatchCenterTap(page, canvas);

  await expect.poll(() => page.evaluate(() => window.__holCanvasReadbacks.length)).toBe(1);
  const [readback] = await page.evaluate(() => window.__holCanvasReadbacks);
  expect(await page.evaluate(() => window.__holCameraCaptures.length)).toBe(1);
  expect(readback.at).toBeGreaterThanOrEqual(tapAt);
  expect(readback.width).toBeGreaterThan(0);
  expect(readback.height).toBeGreaterThan(0);
});

test('rapid repeated taps start one selection transaction and copy one frame', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await instrumentCanvasReadbacks(page);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Start Camera' }).click();
  const { canvas } = await waitForActiveCamera(page);

  for (let tap = 0; tap < 10; tap++) {
    await dispatchCenterTap(page, canvas);
  }

  expect(await page.evaluate(() => window.__holCanvasReadbacks.length)).toBe(1);
  expect(await page.evaluate(() => window.__holCameraCaptures.length)).toBe(1);
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
