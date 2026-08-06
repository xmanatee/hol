import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const assetNames = readdirSync(new URL('../../dist/assets', import.meta.url));
const xfeatModel = assetNames.find((name) => /^xfeat_backbone-[^.]+\.onnx$/.test(name));
const xfeatData = assetNames.find((name) => /^xfeat_backbone\.onnx-[^.]+\.data$/.test(name));
const capabilityUrls = [xfeatModel, xfeatData].map((name) => `/assets/${name}`);

test('production capability cache stores complete XFeat assets and serves them offline', async ({
  page,
  context,
  browserName,
}) => {
  expect(xfeatModel).toBeTruthy();
  expect(xfeatData).toBeTruthy();

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const networkLengths = await page.evaluate(
    async (urls) =>
      Promise.all(
        urls.map(async (url) => (await fetch(url)).arrayBuffer().then((buffer) => buffer.byteLength)),
      ),
    capabilityUrls,
  );
  expect(networkLengths.every((length) => length > 0)).toBe(true);

  await expect
    .poll(() =>
      page.evaluate(async (urls) => {
        const cache = await caches.open('hol-capability-packs-v2');
        return Promise.all(urls.map((url) => cache.match(url).then(Boolean)));
      }, capabilityUrls),
    )
    .toEqual([true, true]);

  const cachedStorageLengths = await page.evaluate(async (urls) => {
    const cache = await caches.open('hol-capability-packs-v2');
    return Promise.all(
      urls.map(async (url) => {
        const response = await cache.match(url);
        return (await response.arrayBuffer()).byteLength;
      }),
    );
  }, capabilityUrls);
  expect(cachedStorageLengths).toEqual(networkLengths);

  if (browserName !== 'chromium') {
    return;
  }

  await context.setOffline(true);
  const cachedLengths = await page.evaluate(
    async (urls) =>
      Promise.all(
        urls.map(async (url) => (await fetch(url)).arrayBuffer().then((buffer) => buffer.byteLength)),
      ),
    capabilityUrls,
  );

  expect(cachedLengths).toEqual(networkLengths);
});
