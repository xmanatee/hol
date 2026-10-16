import { expect, test } from '@playwright/test';

for (const failDepthImport of [false, true]) {
  test(
    failDepthImport
      ? 'a failed reconstruction import retires tracking and shows an actionable error'
      : 'rendered object video reaches green readiness before tap and mounts a surface-attached face',
    async ({ page, context: browserContext, browserName }) => {
      test.skip(browserName !== 'chromium', 'Canvas video capture is a Chromium fixture');
      test.setTimeout(120_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      if (failDepthImport) {
        await browserContext.route('**/anchor.depthFusion-*.js', (route) => route.abort('failed'));
      }
      // A real MediaStream from a rendered scene replaces only the physical camera input.
      // Segmentation, worker tracking, readiness, selection and the GLB renderer are unmodified.
      await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.__holDepthSourcePairs = [];
        window.__holModeSnapshots = [];
        window.__holSelectionCommands = [];
        window.Worker = new Proxy(NativeWorker, {
          construct(target, args) {
            const worker = Reflect.construct(target, args);
            if (/\/anchor\.worker-[\w-]+\.js$/.test(String(args[0]))) {
              const postMessage = worker.postMessage.bind(worker);
              worker.postMessage = (message, transfers) => {
                if (message.command === 'selectCandidate') {
                  window.__holSelectionCommands.push({
                    selection: message.payload,
                    shownId: window.__holLatestAnchorState.candidate?.id ?? null,
                    pageTimeOrigin: performance.timeOrigin,
                  });
                }
                const context = message.payload?.depthContext;
                if (context?.depthRequestTimestamp != null) {
                  window.__holDepthSourcePairs.push([
                    message.payload.capturedAt,
                    context.depthRequestTimestamp,
                  ]);
                }
                const result = postMessage(message, transfers);
                if (context?.depthFrame) {
                  window.__holDepthTransferred = context.depthFrame.data.buffer.byteLength === 0;
                }
                return result;
              };
              worker.addEventListener('message', ({ data }) => {
                window.__holLatestAnchorState = data.state;
                if (data.state?.activeAnchor) {
                  window.__holModeSnapshots.push([
                    data.state.trackingMode,
                    data.state.activeAnchor.trackingMode,
                    data.state.anchorState.metrics.trackingMode,
                  ]);
                }
              });
            }
            return worker;
          },
        });
        const clear = WebGL2RenderingContext.prototype.clear;
        WebGL2RenderingContext.prototype.clear = function (...args) {
          window.__holLastClearAt = performance.now();
          return clear.apply(this, args);
        };
        const drawElements = WebGL2RenderingContext.prototype.drawElements;
        WebGL2RenderingContext.prototype.drawElements = function (...args) {
          window.__holFirstDrawAt ??= performance.now();
          window.__holLastDrawAt = performance.now();
          return drawElements.apply(this, args);
        };
        const physicalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (!constraints.video) return physicalGetUserMedia(constraints);
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          const ctx = canvas.getContext('2d');
          const frame = ctx.createImageData(320, 240);
          const render = () => {
            if (window.__holFreezeObjectVideo) return;
            const shift = window.__holObjectShift || 0;
            for (let y = 0; y < 240; y++) {
              for (let x = 0; x < 320; x++) {
                const localX = x - shift;
                const inside = ((localX - 160) / 96) ** 2 + ((y - 120) / 72) ** 2 <= 1;
                let noise = Math.imul(localX, 374761393) ^ Math.imul(y, 668265263);
                noise = (noise ^ (noise >>> 13)) & 127;
                const offset = (y * 320 + x) * 4;
                frame.data[offset] = inside ? 128 + noise : 30 + Math.round(x * 0.28);
                frame.data[offset + 1] = inside ? 20 + (noise >> 2) : 70 + Math.round(y * 0.35);
                frame.data[offset + 2] = inside ? 15 + (noise >> 3) : 108 + (((x >> 3) ^ (y >> 3)) & 1) * 14;
                frame.data[offset + 3] = 255;
              }
            }
            ctx.putImageData(frame, 0, 0);
            if (canvas.__stream?.active) requestAnimationFrame(render);
          };
          const stream = canvas.captureStream(30);
          canvas.__stream = stream;
          window.__holResumeObjectVideo = () => {
            window.__holFreezeObjectVideo = false;
            render();
          };
          render();
          return stream;
        };
      });
      await page.goto('/');
      await page.getByRole('button', { name: 'Start Camera' }).click();
      const discovery = page.getByTestId('object-discovery');
      await expect(discovery).toHaveAttribute('data-stage', 'ready', { timeout: 90_000 });
      await page.screenshot({ path: 'test-results/object-funnel-discovery.png' });
      await expect(page.locator('.overlay-scene')).toHaveCount(0);
      const selectionCanvas = page.getByRole('button', { name: 'Select the object at the camera center' });
      await selectionCanvas.click();
      await expect(discovery).toHaveCount(0);
      await expect(page.locator('.overlay-scene canvas')).toBeVisible({ timeout: 30_000 });
      const [commit] = await page.evaluate(() => window.__holSelectionCommands);
      expect(commit.selection).toEqual({
        candidateId: commit.shownId,
        timeOrigin: commit.pageTimeOrigin,
        capturedAt: expect.any(Number),
        tapPosition: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      });
      await expect(page.getByRole('button', { name: 'Clear anchor' })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.__holLastDrawAt - window.__holFirstDrawAt))
        .toBeGreaterThan(500);
      await page.screenshot({ path: 'test-results/object-funnel-ready.png' });
      await page.evaluate(() => {
        window.__holObjectShift = 12;
      });
      await expect(page.locator('.overlay-scene canvas')).toBeVisible();
      for (const viewport of [
        { width: 844, height: 390 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await expect
          .poll(() => page.locator('.overlay-scene canvas').evaluate((element) => element.clientWidth))
          .toBe(viewport.width);
        await expect(page.locator('.overlay-scene canvas')).toBeVisible();
      }
      await expect
        .poll(() => page.evaluate(() => window.__holLatestAnchorState.anchorState.position.x))
        .toBeCloseTo(172, 0);
      expect(await page.evaluate(() => window.__holLatestAnchorState.activeAnchor.id)).toBe(1);
      await expect
        .poll(() =>
          page.evaluate(() => window.__holLatestAnchorState.anchorState.metrics.surfaceAttachment?.kind),
        )
        .toBe('planar-pnp');
      await expect
        .poll(() => page.evaluate(() => performance.now() - window.__holLastDrawAt))
        .toBeLessThan(150);
      const overlayCanvas = await page.locator('.overlay-scene canvas').elementHandle();
      const frozenAt = await page.evaluate(() => {
        window.__holFreezeObjectVideo = true;
        return performance.now();
      });
      // The camera track remains live, but no new image arrives. A fresh clear without
      // a draw proves the real GLB disappeared; keeping the canvas mounted is not enough.
      await expect
        .poll(() =>
          page.evaluate(
            (at) => window.__holLastClearAt > at && window.__holLastClearAt > window.__holLastDrawAt,
            frozenAt,
          ),
        )
        .toBe(true);
      await page.evaluate(() => window.__holResumeObjectVideo());
      await expect
        .poll(() => page.evaluate(() => performance.now() - window.__holLastDrawAt))
        .toBeLessThan(150);
      expect(
        await page
          .locator('.overlay-scene canvas')
          .evaluate((canvas, original) => canvas === original, overlayCanvas),
      ).toBe(true);
      await page.getByRole('button', { name: 'Debug drawer' }).click();
      await page.getByRole('tab', { name: 'model', exact: true }).click();
      await page.getByRole('button', { name: 'Depth Fusion', exact: true }).click();
      if (failDepthImport) {
        await expect(discovery).toHaveAttribute('data-stage', 'error');
        await expect(discovery).toHaveText(
          'Object discovery is unavailable. Stop and restart the camera to retry.',
        );
        await expect(page.locator('.overlay-scene')).toHaveCount(0);
        await browserContext.unroute('**/anchor.depthFusion-*.js');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
        await page.getByRole('button', { name: 'Start Camera' }).click();
        await expect(discovery).toHaveAttribute('data-stage', 'ready', { timeout: 90_000 });
        await page.getByRole('button', { name: 'Select the object at the camera center' }).click();
        await expect(page.locator('.overlay-scene canvas')).toBeVisible();
        expect(errors).toEqual([]);
        return;
      }
      await expect
        .poll(
          () =>
            page.evaluate(
              () => window.__holLatestAnchorState.anchorState?.metrics.reconstructionDepthFrameTimestamp || 0,
            ),
          { timeout: 90_000 },
        )
        .toBeGreaterThan(0);
      const depthSources = await page.evaluate(() => window.__holDepthSourcePairs);
      expect(depthSources.length).toBeGreaterThan(0);
      expect(depthSources.every(([capturedAt, requestedAt]) => capturedAt === requestedAt)).toBe(true);
      expect(await page.evaluate(() => window.__holDepthTransferred)).toBe(true);
      for (const [label, mode] of [
        ['Auto', 'sparse-reconstruction'],
        ['Surface Fit', 'parametric-surface'],
        ['Photometric', 'direct-photometric'],
        ['Object pose', 'object-pose'],
        ['Depth Fusion', 'depth-fusion'],
      ]) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.__holLatestAnchorState.trackingMode)).toBe(mode);
      }
      expect(
        await page.evaluate(() => window.__holModeSnapshots.every((modes) => new Set(modes).size === 1)),
      ).toBe(true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Clear anchor' }).click();
      await expect(discovery).toBeVisible();
      expect(errors).toEqual([]);
    },
  );
}
