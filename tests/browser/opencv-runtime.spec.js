import { expect, test } from '@playwright/test';
import { productionAssetUrl } from './productionAsset.js';

const productionOpenCvUrl = () =>
  productionAssetUrl({
    label: 'OpenCV runtime',
    pattern: /^opencv-[\w-]+\.js$/,
    minBytes: 10_000_000,
  });

test('production OpenCV worker runtime computes translated Lucas-Kanade flow', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');

  const result = await page.evaluate(async (openCvUrl) => {
    const workerSource = `
      self.onmessage = async event => {
        const response = await fetch(event.data.openCvUrl);
        const source = await response.text();
        const cv = Function(source + '\\nreturn this.cv;').call(globalThis);
        while (typeof cv.calcOpticalFlowPyrLK !== 'function') {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        if (typeof cv.then === 'function') {
          Object.defineProperty(cv, 'then', { value: undefined });
        }

        const width = 320;
        const height = 240;
        const shift = { x: 3, y: 2 };
        const previous = new cv.Mat(height, width, cv.CV_8UC1);
        const current = new cv.Mat(height, width, cv.CV_8UC1);
        let randomState = 0x5f3759df;
        for (let index = 0; index < previous.data.length; index++) {
          randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
          previous.data[index] = randomState >>> 24;
        }
        for (let y = shift.y; y < height; y++) {
          for (let x = shift.x; x < width; x++) {
            current.data[y * width + x] = previous.data[(y - shift.y) * width + x - shift.x];
          }
        }

        const pointCount = 24;
        const previousPoints = new cv.Mat(pointCount, 1, cv.CV_32FC2);
        const nextPoints = new cv.Mat(pointCount, 1, cv.CV_32FC2);
        const status = new cv.Mat(pointCount, 1, cv.CV_8UC1);
        const error = new cv.Mat(pointCount, 1, cv.CV_32FC1);
        for (let index = 0; index < pointCount; index++) {
          previousPoints.data32F[index * 2] = 55 + (index % 6) * 38;
          previousPoints.data32F[index * 2 + 1] = 55 + Math.floor(index / 6) * 38;
        }
        cv.calcOpticalFlowPyrLK(
          previous,
          current,
          previousPoints,
          nextPoints,
          status,
          error,
          new cv.Size(15, 15),
          3,
          new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01)
        );

        const observations = Array.from({ length: pointCount }, (_, index) => ({
          status: status.data[index],
          dx: nextPoints.data32F[index * 2] - previousPoints.data32F[index * 2],
          dy: nextPoints.data32F[index * 2 + 1] - previousPoints.data32F[index * 2 + 1],
          error: error.data32F[index],
        }));
        previous.delete();
        current.delete();
        previousPoints.delete();
        nextPoints.delete();
        status.delete();
        error.delete();
        self.postMessage(observations);
      };
    `;
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const worker = new Worker(workerUrl, { type: 'module' });
    const observations = await new Promise((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (error) => reject(new Error(error.message));
      worker.postMessage({ openCvUrl: new URL(openCvUrl, window.location.href).href });
    });
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    return observations;
  }, productionOpenCvUrl());

  expect(result.filter((observation) => observation.status === 1).length).toBeGreaterThanOrEqual(23);
  expect(
    result
      .filter((observation) => observation.error < 40)
      .every((observation) => Math.hypot(observation.dx - 3, observation.dy - 2) < 0.5),
    JSON.stringify(result),
  ).toBe(true);
  expect(result.every((observation) => Number.isFinite(observation.error))).toBe(true);
});
