import { expect, test } from '@playwright/test';
import { expectReachableButton, expectWithinViewport } from './layoutAssertions.js';
import { productionAssetUrl } from './productionAsset.js';

const countGreenPixels = (canvas) => {
  const pixels = window.__holInspectCanvasPixels(canvas);
  let green = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < 150 && pixels[index + 1] > 200 && pixels[index + 2] < 180) green++;
  }
  return green;
};

for (const [scenario, failedUrl, title] of [
  [null, null, 'rendered object video reaches green readiness before tap and mounts a surface-attached face'],
  ['stale', null, 'frozen discovery removes its green outline and resumes the same selectable object'],
  ['static', null, 'camera-to-face flow works under static hosting CSP without isolation headers'],
  ['slow-head', null, 'face loading stays visible until the actual head asset is ready'],
  ['resize', null, 'intrinsic camera resize rebuilds object coordinates without replacing the video stream'],
  ['refresh-fault', null, 'segmentation refresh failure stops tracking until explicit vision recovery'],
  [
    'worker',
    '**/anchor.worker-*.js',
    'a failed tracking module offers an explicit reload instead of a cached import retry loop',
  ],
  [
    'overlay',
    '**/OverlayScene-*.js',
    'a failed overlay chunk preserves the camera and selection until explicit reload',
  ],
  ['head', '**/head-*.glb', 'a failed face asset preserves the camera and selection until explicit reload'],
]) {
  test(title, async ({ page, context: browserContext, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Canvas video capture is a Chromium fixture');
    test.setTimeout(120_000);
    const errors = [];
    const faceDownload = Promise.withResolvers();
    const optionalAIRequests = [];
    page.on('request', (request) => {
      if (
        /\/assets\/(?:PersonalityService|localAIClient|ttsClient)-|\/chat\/completions$|\/audio\/speech$/.test(
          request.url(),
        )
      ) {
        optionalAIRequests.push(request.url());
      }
    });
    let navigations = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    if (failedUrl) {
      await browserContext.route(failedUrl, (route) => route.abort('failed'));
    }
    if (scenario === 'slow-head') {
      await browserContext.route('**/head-*.glb', async (route) => {
        await faceDownload.promise;
        await route.continue();
      });
    }
    if (scenario === 'refresh-fault') {
      const runtime = productionAssetUrl({
        label: 'anchor runtime',
        pattern: /^anchor\.worker-[\w-]+\.js$/,
        minBytes: 1000,
      });
      await browserContext.route(`**${runtime}`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: `
            let failNextSegment = false;
            self.addEventListener('message', (event) => {
              if (event.data.type === 'fail-next-segment') {
                failNextSegment = true;
                event.stopImmediatePropagation();
              }
            });
            self.Worker = new Proxy(self.Worker, {
              construct(target, args) {
                const worker = Reflect.construct(target, args);
                const postMessage = worker.postMessage.bind(worker);
                worker.postMessage = (message, transfers) => {
                  if (failNextSegment && message.type === 'segment') {
                    failNextSegment = false;
                    throw new Error('Segmentation refresh transport failed');
                  }
                  return postMessage(message, transfers);
                };
                return worker;
              }
            });
            ${await response.text()}
          `,
        });
      });
    }
    if (scenario === 'static') {
      await browserContext.route('**/', async (route) => {
        const response = await route.fetch();
        const headers = response.headers();
        delete headers['cross-origin-embedder-policy'];
        delete headers['cross-origin-opener-policy'];
        headers['content-security-policy'] =
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' https: wss: data:; worker-src 'self' blob:; base-uri 'self'";
        await route.fulfill({ response, headers });
      });
    }
    // A real MediaStream from a rendered scene replaces only the physical camera input.
    // Segmentation, worker tracking, readiness, selection and the GLB renderer are unmodified.
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.__holSelectionCommands = [];
      window.__holCameraReadbacks = 0;
      window.__holAnchorFrameCommands = 0;
      window.__holInitializations = [];
      window.__holWrongRasterFrames = 0;
      const getImageData = CanvasRenderingContext2D.prototype.getImageData;
      window.__holInspectCanvasPixels = (canvas) =>
        getImageData.call(canvas.getContext('2d'), 0, 0, canvas.width, canvas.height).data;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        window.__holCameraReadbacks++;
        return getImageData.apply(this, args);
      };
      window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          const worker = Reflect.construct(target, args);
          if (/\/anchor\.worker-[\w-]+\.js$/.test(String(args[0]))) {
            window.__holAnchorWorker = worker;
            let raster;
            const postMessage = worker.postMessage.bind(worker);
            worker.postMessage = (message, transfers) => {
              if (message.command === 'initialize') {
                raster = {
                  width: message.payload.viewportWidth,
                  height: message.payload.viewportHeight,
                };
                window.__holInitializations.push(raster);
              }
              if (message.command === 'processFrame') {
                window.__holAnchorFrameCommands++;
                if (
                  message.payload.imageData.width !== raster.width ||
                  message.payload.imageData.height !== raster.height
                ) {
                  window.__holWrongRasterFrames++;
                }
              }
              if (message.command === 'selectCandidate') {
                window.__holSelectionCommands.push({
                  selection: message.payload,
                  shownId: window.__holLatestAnchorState.candidate?.id ?? null,
                  pageTimeOrigin: performance.timeOrigin,
                });
              }
              return postMessage(message, transfers);
            };
            worker.addEventListener('message', ({ data }) => {
              window.__holLatestAnchorState = data.state;
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
      const facePixels = new Uint8Array(16 * 16 * 4);
      WebGL2RenderingContext.prototype.drawElements = function (...args) {
        window.__holFirstDrawAt ??= performance.now();
        window.__holLastDrawAt = performance.now();
        const result = drawElements.apply(this, args);
        if (window.__holObserveFaceVisibility && this.canvas.closest('.overlay-scene')) {
          this.readPixels(
            Math.floor(this.drawingBufferWidth / 2) - 8,
            Math.floor(this.drawingBufferHeight / 2) - 8,
            16,
            16,
            this.RGBA,
            this.UNSIGNED_BYTE,
            facePixels,
          );
          if (facePixels.some((value, index) => index % 4 === 3 && value > 0)) {
            window.__holFirstVisibleFaceAt ??= performance.now();
            window.__holLastVisibleFaceAt = performance.now();
          }
        }
        return result;
      };
      const uniformNames = new WeakMap();
      window.__holMicrophoneAnalysisReads = 0;
      const getByteTimeDomainData = AnalyserNode.prototype.getByteTimeDomainData;
      AnalyserNode.prototype.getByteTimeDomainData = function (data) {
        window.__holMicrophoneAnalysisReads++;
        return getByteTimeDomainData.call(this, data);
      };
      const getUniformLocation = WebGL2RenderingContext.prototype.getUniformLocation;
      WebGL2RenderingContext.prototype.getUniformLocation = function (program, name) {
        const location = getUniformLocation.call(this, program, name);
        if (location) uniformNames.set(location, name);
        return location;
      };
      const uniform1fv = WebGL2RenderingContext.prototype.uniform1fv;
      let referenceMorphs = null;
      window.__holSpeechMorphChange = 0;
      WebGL2RenderingContext.prototype.uniform1fv = function (location, values, ...rest) {
        if (
          window.__holObserveSpeechMorphs &&
          uniformNames.get(location)?.startsWith('morphTargetInfluences')
        ) {
          referenceMorphs ??= Array.from(values);
          for (let index = 0; index < values.length; index++) {
            window.__holSpeechMorphChange = Math.max(
              window.__holSpeechMorphChange,
              Math.abs(values[index] - referenceMorphs[index]),
            );
          }
        }
        return uniform1fv.call(this, location, values, ...rest);
      };
      const physicalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (!constraints.video && constraints.audio) {
          const audio = new AudioContext();
          await audio.resume();
          const source = audio.createOscillator();
          const gain = audio.createGain();
          const destination = audio.createMediaStreamDestination();
          source.frequency.value = 330;
          gain.gain.value = 0.15;
          source.connect(gain).connect(destination);
          source.start();
          window.__holMicrophoneTrack = destination.stream.getAudioTracks()[0];
          window.__holCloseAudioFixture = async () => {
            source.stop();
            await audio.close();
          };
          return destination.stream;
        }
        if (!constraints.video) return physicalGetUserMedia(constraints);
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d');
        let frame = ctx.createImageData(canvas.width, canvas.height);
        window.__holResizeObjectVideo = ({ width, height }) => {
          canvas.width = width;
          canvas.height = height;
          frame = ctx.createImageData(width, height);
        };
        const render = () => {
          if (window.__holFreezeObjectVideo) return;
          const shift = window.__holObjectShift || 0;
          for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
              const sourceX = Math.floor((x * 320) / canvas.width);
              const localX = sourceX - shift;
              const localY = Math.floor((y * 240) / canvas.height);
              const inside =
                !window.__holBlankScene && ((localX - 160) / 96) ** 2 + ((localY - 120) / 72) ** 2 <= 1;
              let noise = Math.imul(localX, 374761393) ^ Math.imul(localY, 668265263);
              noise = (noise ^ (noise >>> 13)) & 127;
              const offset = (y * canvas.width + x) * 4;
              frame.data[offset] = inside ? 128 + noise : 30 + Math.round(sourceX * 0.28);
              frame.data[offset + 1] = inside ? 20 + (noise >> 2) : 70 + Math.round(localY * 0.35);
              frame.data[offset + 2] = inside
                ? 15 + (noise >> 3)
                : 108 + (((sourceX >> 3) ^ (localY >> 3)) & 1) * 14;
              frame.data[offset + 3] = 255;
              if (window.__holBlankScene) {
                frame.data[offset] = 128;
                frame.data[offset + 1] = 128;
                frame.data[offset + 2] = 128;
              }
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
    if (scenario === null)
      await page.addInitScript(() => {
        window.__holBlankScene = true;
      });
    await page.goto('/');
    if (scenario === 'static') expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
    await page.getByRole('button', { name: 'Start Camera' }).click();
    const discovery = page.getByTestId('object-discovery');
    const selectionCanvas = page.getByRole('button', { name: 'Select the object at the camera center' });
    if (scenario === 'worker') {
      await expect(discovery).toHaveAttribute('data-stage', 'error');
      await expect(discovery).toContainText('Object discovery unavailable');
      await expect(selectionCanvas).toBeDisabled();
      await page.evaluate(() => {
        window.__holOriginalStream = document.querySelector('video').srcObject;
      });
      await browserContext.unroute(failedUrl);
      await expect(page.getByRole('button', { name: 'Retry vision', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Reload app', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Start Camera' })).toBeVisible();
      expect(navigations).toBe(2);
      await page.getByRole('button', { name: 'Start Camera' }).click();
    }
    if (scenario === null) {
      await expect
        .poll(() => page.evaluate(() => window.__holAnchorFrameCommands), { timeout: 90_000 })
        .toBeGreaterThanOrEqual(3);
      await expect(selectionCanvas).toBeDisabled();
      expect(await selectionCanvas.evaluate(countGreenPixels)).toBe(0);
      await selectionCanvas.dispatchEvent('click', { detail: 0 });
      expect(await page.evaluate(() => window.__holSelectionCommands)).toEqual([]);
      await expect(page.locator('.overlay-scene')).toHaveCount(0);
      await page.evaluate(() => {
        window.__holBlankScene = false;
      });
    }
    await expect(discovery).toHaveAttribute('data-stage', 'ready', { timeout: 90_000 });
    await page.evaluate(() => {
      window.__holOriginalStream = document.querySelector('video').srcObject;
    });
    await expect(page.locator('.overlay-scene')).toHaveCount(0);
    if (scenario === null) {
      await selectionCanvas.evaluate((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const point = {
          bubbles: true,
          button: 0,
          isPrimary: true,
          pointerId: 1,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        };
        const send = (type, overrides = {}) =>
          canvas.dispatchEvent(new PointerEvent(type, { ...point, ...overrides }));
        send('pointerup');
        for (const cancellation of ['pointercancel', 'pointerout', 'lostpointercapture']) {
          send('pointerdown');
          send(cancellation);
          send('pointerup');
        }
        send('pointerdown');
        send('pointermove', { clientX: point.clientX + 50 });
        send('pointermove');
        send('pointerup');
        send('pointerdown');
        send('pointerup', { pointerId: 2 });
        send('pointerdown');
        send('pointerdown', { pointerId: 2, isPrimary: false });
        send('pointerup');
        send('pointerdown', { button: 2 });
        send('pointerup', { button: 2 });
        send('pointerdown', { clientX: rect.left + 3 });
        send('pointerup', { clientX: rect.left - 3 });
      });
      expect(await page.evaluate(() => window.__holSelectionCommands)).toEqual([]);
      await expect(discovery).toBeVisible();
    }
    if (scenario === 'stale') {
      await page.evaluate(() => {
        window.__holFreezeObjectVideo = true;
        window.__holFrozenCandidateId = window.__holLatestAnchorState.candidate.id;
      });
      expect(await selectionCanvas.evaluate(countGreenPixels)).toBeGreaterThan(100);
      await expect(discovery).toHaveAttribute('data-stage', 'stale');
      await expect(discovery).toContainText('Waiting for fresh tracking');
      expect(await selectionCanvas.evaluate(countGreenPixels)).toBe(0);
      const workBeforeTap = await page.evaluate(() => [
        window.__holAnchorFrameCommands,
        window.__holCameraReadbacks,
      ]);
      await expect(selectionCanvas).toBeDisabled();
      await selectionCanvas.dispatchEvent('click', { detail: 0 });
      await expect(discovery).toHaveAttribute('data-stage', 'stale');
      await expect(page.locator('.overlay-scene')).toHaveCount(0);
      expect(await page.evaluate(() => window.__holSelectionCommands)).toEqual([]);
      expect(
        await page.evaluate(() => [window.__holAnchorFrameCommands, window.__holCameraReadbacks]),
      ).toEqual(workBeforeTap);
      await page.screenshot({ path: testInfo.outputPath('stale-discovery.png') });
      await page.evaluate(() => {
        window.__holObserveFaceVisibility = true;
        window.__holResumeObjectVideo();
      });
      await expect(discovery).toHaveAttribute('data-stage', 'ready', { timeout: 90_000 });
    }
    if (scenario === null) await selectionCanvas.tap();
    else await selectionCanvas.click();
    await expect(discovery).toHaveCount(0);
    if (scenario === 'slow-head') {
      const loading = page.getByRole('status').filter({ hasText: 'Loading face…' });
      await expect(loading).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('face-loading.png') });
      faceDownload.resolve();
      await expect(loading).toBeHidden();
    }
    if (scenario === 'overlay' || scenario === 'head') {
      await expect(page.getByRole('alert')).toContainText('3D overlay unavailable');
      await page.screenshot({ path: testInfo.outputPath('overlay-error.png') });
      await expect(page.getByRole('button', { name: 'Choose another object', exact: true })).toBeVisible();
      expect(navigations).toBe(1);
      expect(
        await page.evaluate(() => {
          const stream = document.querySelector('video').srcObject;
          return stream === window.__holOriginalStream && stream.getVideoTracks()[0].readyState === 'live';
        }),
      ).toBe(true);
      await browserContext.unroute(failedUrl);
      await page.getByRole('button', { name: 'Reload app', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Start Camera', exact: true })).toBeVisible();
      expect(navigations).toBe(2);
      await page.getByRole('button', { name: 'Start Camera' }).click();
      await expect(discovery).toHaveAttribute('data-stage', 'ready', { timeout: 90_000 });
      await selectionCanvas.click();
      await expect(page.locator('.overlay-scene canvas')).toBeVisible();
      // R3F deliberately reports caught scene errors through the native reportError API.
      expect(errors).toEqual(
        scenario === 'head'
          ? [
              expect.stringMatching(
                /^Could not load https?:\/\/[^/]+\/assets\/head-[\w-]+\.glb: Failed to fetch$/,
              ),
            ]
          : [],
      );
      return;
    }
    await expect(page.locator('.overlay-scene canvas')).toBeVisible({ timeout: 30_000 });
    const [commit] = await page.evaluate(() => window.__holSelectionCommands);
    expect(commit.selection).toEqual({
      candidateId: commit.shownId,
      timeOrigin: commit.pageTimeOrigin,
      capturedAt: expect.any(Number),
      tapPosition: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    });
    await expect(page.getByRole('button', { name: 'Choose another object' })).toBeVisible();
    if (scenario === null) {
      const selectedId = await page.evaluate(() => window.__holLatestAnchorState.activeAnchor.id);
      await expect(selectionCanvas).toBeDisabled();
      await expect(selectionCanvas).toHaveAttribute('tabindex', '-1');
      await page.touchscreen.tap(120, 240);
      await page.touchscreen.tap(120, 240);
      await selectionCanvas.dispatchEvent('keydown', { key: 'Enter' });
      await selectionCanvas.dispatchEvent('click', { detail: 0 });
      expect(await page.evaluate(() => window.__holLatestAnchorState.activeAnchor.id)).toBe(selectedId);
      expect(await page.evaluate(() => window.__holSelectionCommands)).toHaveLength(1);
      await expect(discovery).toHaveCount(0);
    }
    await expect
      .poll(() => page.evaluate(() => window.__holLastDrawAt - window.__holFirstDrawAt))
      .toBeGreaterThan(500);
    await page.screenshot({ path: testInfo.outputPath('ready.png') });
    if (scenario === 'refresh-fault') {
      await page.evaluate(() => {
        window.__holAnchorWorker.postMessage({ type: 'fail-next-segment' });
      });
      await expect(discovery).toHaveAttribute('data-stage', 'error');
      await expect(selectionCanvas).toBeDisabled();
      await expect(page.locator('.overlay-scene')).toHaveCount(0);
      await discovery.getByText('Technical details', { exact: true }).click();
      await expect(discovery).toContainText('Segmentation refresh transport failed');
      await page.screenshot({ path: testInfo.outputPath('refresh-error.png') });
      await discovery.getByRole('button', { name: 'Retry vision', exact: true }).click();
      await expect(discovery).toHaveAttribute('data-stage', 'ready', { timeout: 90_000 });
      await page.evaluate(() => {
        window.__holObserveFaceVisibility = true;
        window.__holFirstVisibleFaceAt = null;
        window.__holLastVisibleFaceAt = null;
      });
      await selectionCanvas.click();
      await expect
        .poll(() => page.evaluate(() => window.__holLastVisibleFaceAt - window.__holFirstVisibleFaceAt))
        .toBeGreaterThan(500);
      expect(
        await page.evaluate(() => {
          const stream = document.querySelector('video').srcObject;
          return stream === window.__holOriginalStream && stream.getVideoTracks()[0].readyState === 'live';
        }),
      ).toBe(true);
      expect(navigations).toBe(1);
      expect(errors).toEqual([]);
      return;
    }
    if (scenario === 'slow-head') {
      expect(errors).toEqual([]);
      expect(optionalAIRequests).toEqual([]);
      return;
    }
    if (scenario === 'stale') {
      await expect
        .poll(() => page.evaluate(() => window.__holLastVisibleFaceAt - window.__holFirstVisibleFaceAt))
        .toBeGreaterThan(500);
      expect(commit.shownId).toBe(await page.evaluate(() => window.__holFrozenCandidateId));
      expect(await page.evaluate(() => window.__holLatestAnchorState.activeAnchor.id)).toBe(commit.shownId);
      expect(errors).toEqual([]);
      expect(optionalAIRequests).toEqual([]);
      return;
    }
    if (scenario === 'resize') {
      let initializations = await page.evaluate(() => window.__holInitializations.length);
      for (const dimensions of [
        { width: 240, height: 320 },
        { width: 320, height: 240 },
      ]) {
        await page.evaluate((size) => window.__holResizeObjectVideo(size), dimensions);
        await expect
          .poll(() =>
            page.locator('video').evaluate((video) => ({
              width: video.videoWidth,
              height: video.videoHeight,
            })),
          )
          .toEqual(dimensions);
        await expect(page.locator('.overlay-scene')).toHaveCount(0);
        await page.evaluate(() => {
          window.__holObserveFaceVisibility = true;
          window.__holFirstVisibleFaceAt = null;
          window.__holLastVisibleFaceAt = null;
        });
        await expect(discovery).toHaveAttribute('data-stage', 'ready', { timeout: 90_000 });
        await selectionCanvas.click();
        await expect(page.locator('.overlay-scene canvas')).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => window.__holLastVisibleFaceAt - window.__holFirstVisibleFaceAt))
          .toBeGreaterThan(500);
        expect(await page.evaluate(() => window.__holInitializations)).toHaveLength(++initializations);
        expect(await page.evaluate(() => window.__holInitializations.at(-1))).toEqual(dimensions);
        expect(
          await page.evaluate(() => {
            const stream = document.querySelector('video').srcObject;
            return stream === window.__holOriginalStream && stream.getVideoTracks()[0].readyState === 'live';
          }),
        ).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`resized-${dimensions.width}.png`) });
      }
      expect(await page.evaluate(() => window.__holWrongRasterFrames)).toBe(0);
      expect(navigations).toBe(1);
      expect(errors).toEqual([]);
      return;
    }
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
    const recoveryGuidance = page.getByTestId('object-recovery');
    const trackingStatus = recoveryGuidance.getByRole('status');
    await expect(trackingStatus).toContainText('Face is tracking the object');
    await expect(trackingStatus).toHaveAttribute('aria-atomic', 'true');
    const beforeQuietFrames = await trackingStatus.evaluate((element) => {
      let previousText = element.textContent;
      window.__holTrackingAnnouncements = [];
      window.__holTrackingStatusObserver = new MutationObserver(() => {
        if (element.textContent !== previousText) {
          previousText = element.textContent;
          window.__holTrackingAnnouncements.push(previousText);
        }
      });
      window.__holTrackingStatusObserver.observe(element, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      return window.__holAnchorFrameCommands;
    });
    await expect
      .poll(() => page.evaluate(() => window.__holAnchorFrameCommands))
      .toBeGreaterThan(beforeQuietFrames + 3);
    expect(
      await page.evaluate(() => {
        window.__holTrackingStatusObserver.disconnect();
        return window.__holTrackingAnnouncements;
      }),
    ).toEqual([]);
    const overlayCanvas = await page.locator('.overlay-scene canvas').elementHandle();
    if (scenario === 'static') {
      const paused = await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        return window.__holAnchorFrameCommands;
      });
      await expect(recoveryGuidance).toContainText('Waiting for fresh tracking');
      // The input still delivers video, but both CV submissions and GPU clears must stop.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              new Promise((resolve) => {
                const video = document.querySelector('video');
                video.requestVideoFrameCallback(() => {
                  const lastClearAt = window.__holLastClearAt;
                  video.requestVideoFrameCallback(() => {
                    resolve({
                      frames: window.__holAnchorFrameCommands,
                      renderingStopped: lastClearAt === window.__holLastClearAt,
                    });
                  });
                });
              }),
          ),
        )
        .toEqual({ frames: paused, renderingStopped: true });
      await page.evaluate(() => {
        window.__holFreezeObjectVideo = true;
        delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(recoveryGuidance).toContainText('Waiting for fresh tracking');
      await expect
        .poll(() => page.evaluate(() => window.__holLastClearAt > window.__holLastDrawAt))
        .toBe(true);
      await page.evaluate(() => window.__holResumeObjectVideo());
      await expect(trackingStatus).toContainText('Face is tracking the object');
      expect(
        await page
          .locator('.overlay-scene canvas')
          .evaluate((canvas, original) => canvas === original, overlayCanvas),
      ).toBe(true);
    }
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
    await expect(page.getByText('stale', { exact: true })).toBeVisible();
    await expect(recoveryGuidance).toContainText('Waiting for fresh tracking');
    await expect(
      page.getByText('Object selected. Use the microphone button to animate its face.', { exact: true }),
    ).toBeHidden();
    await expectWithinViewport(recoveryGuidance.getByRole('status'));
    await page.screenshot({ path: testInfo.outputPath('selected-tracking-expired.png') });
    await page.getByRole('button', { name: 'Controls', exact: true }).click();
    await expect(recoveryGuidance).toBeHidden();
    await expect(
      page.getByRole('dialog').getByText('Waiting for fresh tracking', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Last tracking diagnostics (expired)', { exact: true })).toBeVisible();
    for (const tab of ['Voice', 'Face', 'System']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const guidance = page.getByRole('dialog').getByText('Waiting for fresh tracking', { exact: true });
      await expect(guidance).toHaveCount(1);
      await expect(guidance).toBeVisible();
    }
    await page.getByRole('tab', { name: 'Object', exact: true }).click();
    await page.getByRole('button', { name: 'Close controls', exact: true }).click();
    await page.evaluate(() => window.__holResumeObjectVideo());
    await expect
      .poll(() => page.evaluate(() => performance.now() - window.__holLastDrawAt))
      .toBeLessThan(150);
    await expect(recoveryGuidance.getByRole('status')).toContainText('Face is tracking the object');
    expect(
      await page
        .locator('.overlay-scene canvas')
        .evaluate((canvas, original) => canvas === original, overlayCanvas),
    ).toBe(true);
    if (scenario === null) {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await expectWithinViewport(page.getByRole('button', { name: 'Stop camera', exact: true }));
      for (const label of ['Enable microphone mode', 'Choose another object', 'Controls', 'Stop camera']) {
        await expectReachableButton(page.getByRole('button', { name: label, exact: true }));
      }
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
      });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByRole('button', { name: 'Controls' }).click();
    if (scenario === null) {
      await page.getByRole('tab', { name: 'Voice', exact: true }).click();
      await expect(page.getByText('AI personality is not configured.', { exact: false })).toBeVisible();
      await expect(page.getByText('Microphone mode animates the face', { exact: false })).toBeVisible();
      await page.evaluate(() => {
        window.__holObserveSpeechMorphs = true;
      });
      await page.getByRole('button', { name: 'Microphone mode off', exact: true }).click();
      const mic = page.getByText('Mic', { exact: true }).locator('..');
      const energy = page.getByText('Energy', { exact: true }).locator('..');
      await expect(mic).toContainText('active');
      await expect
        .poll(() => page.evaluate(() => window.__holMicrophoneAnalysisReads), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(90);
      await expect
        .poll(() => page.evaluate(() => window.__holSpeechMorphChange), { timeout: 15_000 })
        .toBeGreaterThan(0.01);
      await expect
        .poll(async () => Number.parseInt((await energy.textContent()).replace('Energy', ''), 10), {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(() => window.__holSpeechMorphChange), { timeout: 15_000 })
        .toBeGreaterThan(0.01);
      await page.screenshot({ path: testInfo.outputPath('microphone-lip-sync.png') });
      await page.getByRole('button', { name: 'Microphone mode on', exact: true }).click();
      await expect(mic).toContainText('idle');
      await expect(energy).toContainText('0%');
      expect(await page.evaluate(() => window.__holMicrophoneTrack.readyState)).toBe('ended');
      await page.evaluate(() => window.__holCloseAudioFixture());
      expect(await page.evaluate(() => window.__holCameraReadbacks - window.__holAnchorFrameCommands)).toBe(
        0,
      );
      expect(optionalAIRequests).toEqual([]);
    }
    await page.getByRole('tab', { name: 'Face', exact: true }).click();
    for (const label of ['Object pose', 'Sparse SfM', 'Surface Fit', 'Photometric', 'Depth Fusion']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    }
    expect(await page.evaluate(() => window.__holLatestAnchorState.trackingMode)).toBe('object-pose');
    if (scenario === null) {
      await page.getByText('Rig adjustments', { exact: true }).click();
      await page.getByLabel(/X rotation:/).fill('69');
      const meshes = page.getByRole('tabpanel').getByRole('checkbox');
      expect(await meshes.count()).toBeGreaterThan(0);
      for (const mesh of await meshes.all()) await mesh.uncheck();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Controls', exact: true }).click();
      await expect(page.getByLabel(/X rotation:/)).toHaveValue('69');
      for (const mesh of await meshes.all()) await expect(mesh).not.toBeChecked();
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Choose another object' }).click();
    await expect(discovery).toBeVisible();
    if (scenario === null) {
      await page.getByRole('button', { name: 'Controls', exact: true }).click();
      await expect(page.getByText('Select a highlighted object to enable face controls.')).toBeVisible();
      await expect(page.getByRole('tabpanel').getByRole('slider')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(discovery).toHaveAttribute('data-stage', 'ready', { timeout: 90_000 });
      await expect(selectionCanvas).toBeEnabled();
      await page.evaluate(() => {
        window.__holObserveFaceVisibility = true;
        window.__holFirstVisibleFaceAt = null;
        window.__holLastVisibleFaceAt = null;
      });
      await selectionCanvas.focus();
      await page.keyboard.press('Enter');
      await expect(discovery).toHaveCount(0);
      await expect(page.locator('.overlay-scene canvas')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose another object' })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.__holLastVisibleFaceAt - window.__holFirstVisibleFaceAt))
        .toBeGreaterThan(500);
      await page.getByRole('button', { name: 'Controls', exact: true }).click();
      await page.getByText('Rig adjustments', { exact: true }).click();
      await expect(page.getByLabel(/X rotation:/)).toHaveValue('0');
      const meshes = page.getByRole('tabpanel').getByRole('checkbox');
      expect(await meshes.count()).toBeGreaterThan(0);
      for (const mesh of await meshes.all()) await expect(mesh).toBeChecked();
    }
    expect(errors).toEqual([]);
  });
}
