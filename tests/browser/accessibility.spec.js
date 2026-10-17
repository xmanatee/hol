import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { expectReachableButton, expectWithinViewport } from './layoutAssertions.js';

const ACCESSIBILITY_STANDARD_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
  'best-practice',
];

const auditAccessibility = (page) => new AxeBuilder({ page }).withTags(ACCESSIBILITY_STANDARD_TAGS).analyze();

const describeViolations = (violations) =>
  violations
    .map(
      ({ help, id, impact, nodes }) =>
        `${id} (${impact}): ${help}\n${nodes
          .map(({ failureSummary, target }) => `  ${target.join(' ')}: ${failureSummary}`)
          .join('\n')}`,
    )
    .join('\n\n');

const expectNoAccessibilityViolations = async (page) => {
  const { violations } = await auditAccessibility(page);
  expect(violations, describeViolations(violations)).toEqual([]);
};

const startCamera = async (page) => {
  await page.getByRole('button', { name: 'Start Camera' }).click();
  await expect(page.locator('video')).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      () => page.locator('video').evaluate((element) => Boolean(element.srcObject && element.videoWidth > 0)),
      { timeout: 10_000 },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        page.locator('canvas').evaluate((canvas) => {
          const video = document.querySelector('video');
          return canvas.width === video.videoWidth && canvas.height === video.videoHeight;
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
};

for (const viewport of [
  { width: 320, height: 720 },
  { width: 640, height: 256 },
]) {
  test(`start screen reflows at 200% text in ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'High on Life' })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    const title = page.getByRole('heading', { name: 'High on Life' });
    await title.scrollIntoViewIfNeeded();
    await expectWithinViewport(title);
    await expectReachableButton(page.getByRole('button', { name: 'Start Camera', exact: true }));
    const guidance = page.getByRole('status');
    await guidance.scrollIntoViewIfNeeded();
    await expectWithinViewport(guidance);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
  });

  test(`camera actions stay reachable at 200% text in ${viewport.width}x${viewport.height}`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
    await page.setViewportSize(viewport);
    await page.goto('/');
    await startCamera(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    const stop = page.getByRole('button', { name: 'Stop camera', exact: true });
    await expectWithinViewport(stop);
    for (const label of ['Enable microphone mode', 'Controls', 'Stop camera']) {
      await expectReachableButton(page.getByRole('button', { name: label, exact: true }));
    }
    await stop.click();
    await expect(page.getByRole('button', { name: 'Start Camera', exact: true })).toBeVisible();
  });
}

test('start screen meets the supported WCAG A and AA rules', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await expectNoAccessibilityViolations(page);
});

test('active camera controls meet the supported WCAG A and AA rules', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await startCamera(page);

  await expectNoAccessibilityViolations(page);
});

test('field-control drawer code loads once and remains closeable during cold loading', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  const drawerRequests = [];
  const drawerLoad = Promise.withResolvers();
  page.on('request', (request) => {
    if (/\/FieldControlsDrawer-[^/]+\.js$/.test(new URL(request.url()).pathname)) {
      drawerRequests.push(request.url());
    }
  });
  await page.route(/\/FieldControlsDrawer-[^/]+\.js$/, async (route) => {
    await drawerLoad.promise;
    await route.continue();
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(drawerRequests).toEqual([]);

  await startCamera(page);
  expect(drawerRequests).toEqual([]);

  const drawerTrigger = page.getByRole('button', { name: 'Controls', exact: true });
  await drawerTrigger.click();
  await expect.poll(() => drawerRequests.length).toBe(1);
  const loadingDrawer = page.getByRole('dialog', { name: 'Camera controls' });
  await expect(loadingDrawer).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Loading controls…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close controls' })).toBeFocused();
  await drawerTrigger.focus();
  await expect(page.getByRole('button', { name: 'Close controls' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(loadingDrawer).toBeHidden();
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(drawerTrigger).toBeFocused();

  drawerLoad.resolve();

  await drawerTrigger.click();
  await expect(page.getByRole('dialog', { name: 'Camera controls' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Object' })).toBeVisible();
  expect(drawerRequests).toHaveLength(1);
});

for (const fault of ['network', 'evaluation']) {
  test(`a controls ${fault} failure stays local and reloads only at the user request`, async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
    const errors = [];
    let navigations = 0;
    let requests = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    const chunk = /\/FieldControlsDrawer-[^/]+\.js$/;
    await page.route(chunk, (route) => {
      requests++;
      return fault === 'network'
        ? route.abort()
        : route.fulfill({ contentType: 'text/javascript', body: 'throw null;' });
    });
    await page.goto('/');
    await startCamera(page);
    await page.evaluate(() => {
      window.__holOriginalStream = document.querySelector('video').srcObject;
    });
    const trigger = page.getByRole('button', { name: 'Controls', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Camera controls' });
    const failure = dialog.getByRole('alert');
    await expect(failure).toContainText('Camera controls unavailable');
    if (fault === 'evaluation') await expect(failure.getByText('null', { exact: true })).toBeVisible();
    await expect(failure).toContainText('This stops the camera');
    await expect(dialog).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: 'Close controls' })).toBeFocused();
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('controls-error.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(failure).toContainText('Camera controls unavailable');
    expect(requests).toBe(1);
    expect(navigations).toBe(1);
    expect(
      await page.evaluate(() => {
        const stream = document.querySelector('video').srcObject;
        return stream === window.__holOriginalStream && stream.getVideoTracks()[0].readyState === 'live';
      }),
    ).toBe(true);
    await page.unroute(chunk);
    await page.getByRole('button', { name: 'Reload app', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start Camera', exact: true })).toBeVisible();
    expect(navigations).toBe(2);
    await startCamera(page);
    await trigger.click();
    await expect(page.getByRole('tab', { name: 'Object', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const webgl2Available of [true, false]) {
  test(`browser capabilities report WebGL 2 ${webgl2Available ? 'available' : 'unavailable'} and release probes`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
    const localAITransportRequests = [];
    page.on('request', (request) => {
      if (/\/localAIClient-[^/]+\.js$/.test(new URL(request.url()).pathname)) {
        localAITransportRequests.push(request.url());
      }
    });
    await page.addInitScript((available) => {
      window.__holWebGLReadinessProbe = { contexts: 0, releases: 0 };
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        const context = type === 'webgl2' && !available ? null : originalGetContext.call(this, type, ...args);
        if (type === 'webgl' || type === 'webgl2') {
          window.__holWebGLReadinessProbe.contexts += 1;
        }
        return context;
      };

      const wrapLoseContext = (prototype) => {
        const originalGetExtension = prototype.getExtension;
        prototype.getExtension = function (name) {
          const extension = originalGetExtension.call(this, name);
          if (name !== 'WEBGL_lose_context' || !extension) {
            return extension;
          }
          return {
            loseContext() {
              window.__holWebGLReadinessProbe.releases += 1;
              extension.loseContext();
            },
            restoreContext() {
              extension.restoreContext();
            },
          };
        };
      };

      wrapLoseContext(WebGLRenderingContext.prototype);
      if (window.WebGL2RenderingContext) {
        wrapLoseContext(WebGL2RenderingContext.prototype);
      }
    }, webgl2Available);

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start Camera' })).toBeVisible();
    await startCamera(page);
    expect(await page.evaluate(() => window.__holWebGLReadinessProbe)).toEqual({ contexts: 0, releases: 0 });

    await page.getByRole('button', { name: 'Controls' }).click();
    await page.getByRole('tab', { name: 'System' }).click();
    await expect(page.getByRole('heading', { name: 'Browser capabilities' })).toBeVisible();
    await expect(
      page.getByText('API support only; camera, tracking, and face loading report their own status.'),
    ).toBeVisible();
    await expect(
      page.getByText(webgl2Available ? 'Required 3D API is available' : 'The 3D face requires WebGL 2', {
        exact: true,
      }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.__holWebGLReadinessProbe.releases)).toBe(webgl2Available ? 1 : 0);
    expect(await page.evaluate(() => window.__holWebGLReadinessProbe.contexts)).toBe(1);
    expect(localAITransportRequests).toEqual([]);
  });
}

test('every field-control section meets the supported WCAG A and AA rules', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await startCamera(page);
  await page.getByRole('button', { name: 'Controls' }).click();
  await expect(page.getByRole('dialog', { name: 'Camera controls' })).toBeVisible();

  for (const tabName of ['Object', 'Voice', 'Face', 'System']) {
    const tab = page.getByRole('tab', { name: tabName });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expectNoAccessibilityViolations(page);
  }

  await expect(page.getByRole('button', { name: 'Show canvas debug' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('tab', { name: 'Face' }).click();
  await expect(page.getByRole('button', { name: 'Object pose', exact: true })).toHaveCount(0);
  await expect(page.getByText('Select a highlighted object to enable face controls.')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByRole('slider')).toHaveCount(0);
});

test('field controls reflow long bidirectional runtime text at 320 CSS pixels', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  const longRtlToken = `م${'runtimevalue'.repeat(48)}`;
  await context.route(/\/assets\/opencv-[\w-]+\.js$/, (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `throw new Error(${JSON.stringify(longRtlToken)});`,
    }),
  );
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await startCamera(page);
  await expect(page.getByTestId('object-discovery')).toHaveAttribute('data-stage', 'error');
  await page.getByRole('button', { name: 'Controls' }).click();
  await expect(page.getByRole('dialog', { name: 'Camera controls' })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });

  await page.getByRole('dialog').getByText('Technical details', { exact: true }).click();
  const diagnosticValue = page.getByRole('dialog').getByText(longRtlToken, { exact: true });
  await expect(diagnosticValue).toHaveAttribute('dir', 'auto');

  await expect
    .poll(() =>
      diagnosticValue.evaluate((element) => ({
        direction: getComputedStyle(element).direction,
        overflowWrap: getComputedStyle(element).overflowWrap,
        textAlign: getComputedStyle(element).textAlign,
      })),
    )
    .toEqual({ direction: 'rtl', overflowWrap: 'anywhere', textAlign: 'start' });

  await page.getByRole('tab', { name: 'System' }).click();
  const metric = page.getByText('Capture FPS', { exact: true }).locator('..');
  const metricLabel = metric.locator(':scope > :nth-child(1)');
  const metricValue = metric.locator(':scope > :nth-child(2)');
  await expect(metricLabel).toHaveAttribute('dir', 'auto');
  await expect(metricValue).toHaveAttribute('dir', 'auto');
  const metricValueStyle = await metricValue.evaluate((element, value) => {
    element.textContent = value;
    return {
      direction: getComputedStyle(element).direction,
      overflowWrap: getComputedStyle(element).overflowWrap,
    };
  }, longRtlToken);
  const metricLabelStyle = await metricLabel.evaluate((element, value) => {
    element.textContent = value;
    return {
      direction: getComputedStyle(element).direction,
      overflowWrap: getComputedStyle(element).overflowWrap,
    };
  }, longRtlToken);
  expect(metricLabelStyle).toEqual({ direction: 'rtl', overflowWrap: 'anywhere' });
  expect(metricValueStyle).toEqual({ direction: 'rtl', overflowWrap: 'anywhere' });

  const overflow = await page.evaluate(() => {
    const drawer = document.querySelector('#field-controls-drawer');
    const panel = document.querySelector('#field-controls-panel');
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      drawer: drawer.scrollWidth - drawer.clientWidth,
      panel: panel.scrollWidth - panel.clientWidth,
    };
  });
  expect(overflow).toEqual({ document: 0, drawer: 0, panel: 0 });
});

test('camera controls and field drawer support keyboard navigation', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start Camera' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Start Camera' })).toBeFocused();
  await startCamera(page);

  const cameraCanvas = page.getByRole('button', { name: 'Select the object at the camera center' });
  await expect(cameraCanvas).toBeDisabled();
  await expect(cameraCanvas).toHaveAttribute('tabindex', '-1');

  const drawerTrigger = page.getByRole('button', { name: 'Controls', exact: true });
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await drawerTrigger.click();
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Close controls' })).toBeFocused();
  const anchorTab = page.getByRole('tab', { name: 'Object' });
  await anchorTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Voice' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Voice' })).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Camera controls' })).toBeHidden();
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(drawerTrigger).toBeFocused();
});

test('field controls contain mobile focus and retain desktop scene interaction across resizing', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await page.goto('/');
  await startCamera(page);
  const trigger = page.getByRole('button', { name: 'Controls', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Camera controls' });
  const close = dialog.getByRole('button', { name: 'Close controls' });
  await expect(dialog.getByRole('tab', { name: 'Object', exact: true })).toBeVisible();
  await expect(close).toBeFocused();
  await trigger.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).not.toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Select the object at the camera center' }),
  ).not.toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();

  const voice = dialog.getByRole('tab', { name: 'Voice', exact: true });
  await voice.click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(() => dialog.evaluate((element) => element.matches(':modal'))).toBe(false);
  await expect(voice).toBeFocused();
  await trigger.focus();
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
  await expect(close).toBeFocused();
  await expect(voice).toHaveAttribute('aria-selected', 'true');
  await trigger.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole('button', { name: 'Stop camera', exact: true }).click();
  const start = page.getByRole('button', { name: 'Start Camera', exact: true });
  await expect(start).toBeVisible();
  await start.focus();
  await expect(start).toBeFocused();
});

test('field controls preserve one controlled state across close, reopen, and camera restart', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  const expectCameraMeasurements = async () => {
    const fps = page.getByText('Capture FPS', { exact: true }).locator('..');
    const frameCost = page.getByText('Camera frame cost', { exact: true }).locator('..');
    await expect(fps).toContainText(/\d+\.\d FPS/);
    await expect(frameCost).toContainText(/\d+\.\d ms/);
    const value = (await fps.textContent()).replace('Capture FPS', '').trim();
    expect(Number.parseFloat(value)).toBeGreaterThan(0);
  };
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await startCamera(page);

  const microphoneMode = page.getByRole('button', { name: 'Enable microphone mode' });
  await microphoneMode.click();
  await expect(page.getByText('Select a highlighted object before enabling microphone mode.')).toBeVisible();
  await expect(microphoneMode).toHaveAttribute('aria-pressed', 'false');

  const drawerTrigger = page.getByRole('button', { name: 'Controls', exact: true });
  await drawerTrigger.click();
  await page.getByRole('tab', { name: 'System' }).click();
  await expectCameraMeasurements();

  const showCanvasDebug = page.getByRole('button', { name: 'Show canvas debug' });
  await showCanvasDebug.click();
  await expect(page.getByRole('button', { name: 'Hide canvas debug' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('tab', { name: 'Face' }).click();
  await expect(page.getByText('Select a highlighted object to enable face controls.')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByRole('slider')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Voice' }).click();
  const voiceThreshold = page.getByLabel('Voice threshold');
  await voiceThreshold.fill('0.05');
  await expect(voiceThreshold).toHaveValue('0.05');
  const microphoneGain = page.getByLabel(/Mic gain:/);
  await microphoneGain.fill('4.5');
  await expect(microphoneGain).toHaveValue('4.5');
  await page.getByRole('button', { name: 'Debug off' }).click();
  await expect(page.getByRole('button', { name: 'Debug on' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: 'System' }).click();

  await page.getByRole('button', { name: 'Close controls' }).click();
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await drawerTrigger.click();
  await expect(page.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
  await expectCameraMeasurements();
  await expect(page.getByRole('button', { name: 'Hide canvas debug' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Stop camera' }).last().click();
  await expect(page.getByRole('button', { name: 'Start Camera' })).toBeVisible();
  await startCamera(page);
  await expect(page.getByRole('dialog', { name: 'Camera controls' })).toBeHidden();
  const restartedDrawerTrigger = page.getByRole('button', { name: 'Controls', exact: true });
  await expect(restartedDrawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await restartedDrawerTrigger.click();
  await page.getByRole('tab', { name: 'System' }).click();
  await expectCameraMeasurements();
  await page.getByRole('tab', { name: 'Face' }).click();
  await expect(page.getByText('Select a highlighted object to enable face controls.')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByRole('slider')).toHaveCount(0);
});

test('reduced-motion preference removes nonessential UI motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const transitionDuration = await page
    .getByRole('button', { name: 'Start Camera' })
    .evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration) * 1000);
  expect(transitionDuration).toBeLessThanOrEqual(0.01);
});
