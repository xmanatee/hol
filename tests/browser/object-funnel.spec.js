import { expect, test } from '@playwright/test';

for (const [scenario, failedUrl, title] of [
  [null, null, 'rendered object video reaches green readiness before tap and mounts a surface-attached face'],
  ['resize', null, 'intrinsic camera resize rebuilds object coordinates without replacing the video stream'],
  [
    'depth',
    '**/anchor.depthFusion-*.js',
    'a failed reconstruction import retires tracking and shows an actionable error',
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
    // A real MediaStream from a rendered scene replaces only the physical camera input.
    // Segmentation, worker tracking, readiness, selection and the GLB renderer are unmodified.
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.__holDepthSourcePairs = [];
      window.__holModeSnapshots = [];
      window.__holSelectionCommands = [];
      window.__holCameraReadbacks = 0;
      window.__holAnchorFrameCommands = 0;
      window.__holInitializations = [];
      window.__holWrongRasterFrames = 0;
      const getImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        window.__holCameraReadbacks++;
        return getImageData.apply(this, args);
      };
      window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          const worker = Reflect.construct(target, args);
          if (/\/anchor\.worker-[\w-]+\.js$/.test(String(args[0]))) {
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
              const inside = ((localX - 160) / 96) ** 2 + ((localY - 120) / 72) ** 2 <= 1;
              let noise = Math.imul(localX, 374761393) ^ Math.imul(localY, 668265263);
              noise = (noise ^ (noise >>> 13)) & 127;
              const offset = (y * canvas.width + x) * 4;
              frame.data[offset] = inside ? 128 + noise : 30 + Math.round(sourceX * 0.28);
              frame.data[offset + 1] = inside ? 20 + (noise >> 2) : 70 + Math.round(localY * 0.35);
              frame.data[offset + 2] = inside
                ? 15 + (noise >> 3)
                : 108 + (((sourceX >> 3) ^ (localY >> 3)) & 1) * 14;
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
    await page.evaluate(() => {
      window.__holOriginalStream = document.querySelector('video').srcObject;
    });
    await expect(page.locator('.overlay-scene')).toHaveCount(0);
    const selectionCanvas = page.getByRole('button', { name: 'Select the object at the camera center' });
    await selectionCanvas.click();
    await expect(discovery).toHaveCount(0);
    if (scenario === 'overlay' || scenario === 'head') {
      await expect(page.getByRole('alert')).toContainText('3D overlay unavailable');
      await page.screenshot({ path: testInfo.outputPath('overlay-error.png') });
      await expect(page.getByRole('button', { name: 'Clear anchor', exact: true })).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Clear anchor' })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.__holLastDrawAt - window.__holFirstDrawAt))
      .toBeGreaterThan(500);
    await page.screenshot({ path: testInfo.outputPath('ready.png') });
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
    if (scenario === null) {
      await page.getByRole('tab', { name: 'voice', exact: true }).click();
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
    await page.getByRole('tab', { name: 'model', exact: true }).click();
    await page.getByRole('button', { name: 'Depth Fusion', exact: true }).click();
    if (scenario === 'depth') {
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
      ['Sparse SfM', 'sparse-reconstruction'],
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
  });
}
