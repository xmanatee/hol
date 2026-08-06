import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

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
  await expect(page.locator('canvas')).toHaveCSS('pointer-events', 'auto', { timeout: 10_000 });
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

  const drawerTrigger = page.getByRole('button', { name: 'Debug drawer', exact: true });
  await drawerTrigger.click();
  await expect.poll(() => drawerRequests.length).toBe(1);
  const loadingDrawer = page.getByRole('dialog', { name: 'Field controls' });
  await expect(loadingDrawer).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Loading controls…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close debug drawer' })).toBeFocused();

  await page.getByRole('button', { name: 'Close debug drawer' }).click();
  await expect(loadingDrawer).toBeHidden();
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(drawerTrigger).toBeFocused();

  drawerLoad.resolve();

  await drawerTrigger.click();
  await expect(page.getByRole('dialog', { name: 'Field controls' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Anchor' })).toBeVisible();
  expect(drawerRequests).toHaveLength(1);
});

test('runtime readiness creates and releases its WebGL probe only when System controls open', async ({
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
  await page.addInitScript(() => {
    window.__holWebGLReadinessProbe = { contexts: 0, releases: 0 };
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const context = originalGetContext.call(this, type, ...args);
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
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await startCamera(page);
  expect(await page.evaluate(() => window.__holWebGLReadinessProbe)).toEqual({ contexts: 0, releases: 0 });

  await page.getByRole('button', { name: 'Debug drawer' }).click();
  await page.getByRole('tab', { name: 'System' }).click();
  await expect.poll(() => page.evaluate(() => window.__holWebGLReadinessProbe.releases)).toBe(1);
  expect(await page.evaluate(() => window.__holWebGLReadinessProbe.contexts)).toBe(1);
  expect(localAITransportRequests).toEqual([]);
});

test('every field-control section meets the supported WCAG A and AA rules', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await startCamera(page);
  await page.getByRole('button', { name: 'Debug drawer' }).click();
  await expect(page.getByRole('dialog', { name: 'Field controls' })).toBeVisible();

  for (const tabName of ['Anchor', 'Voice', 'Model', 'System']) {
    const tab = page.getByRole('tab', { name: tabName });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expectNoAccessibilityViolations(page);
  }

  await expect(page.getByRole('button', { name: 'Show canvas debug' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('tab', { name: 'Model' }).click();
  await expect(page.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
});

test('field controls reflow long bidirectional runtime text at 320 CSS pixels', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await startCamera(page);
  await page.getByRole('button', { name: 'Debug drawer' }).click();
  await expect(page.getByRole('dialog', { name: 'Field controls' })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });

  const longRtlToken = `م${'runtimevalue'.repeat(48)}`;
  const diagnosticRow = page.getByText('Pose rejection', { exact: true }).locator('..');
  const diagnosticValue = diagnosticRow.locator(':scope > :nth-child(2)');
  await expect(diagnosticValue).toHaveAttribute('dir', 'auto');
  await diagnosticValue.evaluate((element, value) => {
    element.textContent = value;
  }, longRtlToken);

  await expect
    .poll(() =>
      diagnosticValue.evaluate((element) => ({
        direction: getComputedStyle(element).direction,
        overflowWrap: getComputedStyle(element).overflowWrap,
        textAlign: getComputedStyle(element).textAlign,
      })),
    )
    .toEqual({ direction: 'rtl', overflowWrap: 'anywhere', textAlign: 'end' });

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

test('camera selection and field controls support a complete keyboard path', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await page.addInitScript(() => {
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    window.__holKeyboardCanvasReadbacks = 0;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      window.__holKeyboardCanvasReadbacks++;
      return getImageData.apply(this, args);
    };
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Start Camera' })).toBeFocused();
  await startCamera(page);

  const cameraCanvas = page.getByRole('button', { name: 'Select the object at the camera center' });
  await cameraCanvas.focus();
  expect(await cameraCanvas.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__holKeyboardCanvasReadbacks)).toBe(1);

  const drawerTrigger = page.getByRole('button', { name: 'Debug drawer', exact: true });
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await drawerTrigger.click();
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Close debug drawer' })).toBeFocused();
  const anchorTab = page.getByRole('tab', { name: 'Anchor' });
  await anchorTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Voice' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Voice' })).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Field controls' })).toBeHidden();
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(drawerTrigger).toBeFocused();
});

test('field controls preserve one controlled state across close, reopen, and camera restart', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fake camera capture is a Chromium release gate');
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await startCamera(page);

  const microphoneMode = page.getByRole('button', { name: 'Enable microphone mode' });
  await microphoneMode.click();
  await expect(page.getByText('Anchor an object before enabling microphone mode.')).toBeVisible();
  await expect(microphoneMode).toHaveAttribute('aria-pressed', 'false');

  const drawerTrigger = page.getByRole('button', { name: 'Debug drawer', exact: true });
  await drawerTrigger.click();
  await page.getByRole('tab', { name: 'System' }).click();
  await expect(page.getByText('Capture FPS', { exact: true })).toBeVisible();

  const showCanvasDebug = page.getByRole('button', { name: 'Show canvas debug' });
  await showCanvasDebug.click();
  await expect(page.getByRole('button', { name: 'Hide canvas debug' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('tab', { name: 'Model' }).click();
  await page.getByRole('button', { name: 'Object pose' }).click();
  await expect(page.getByRole('button', { name: 'Object pose' })).toHaveAttribute('aria-pressed', 'true');
  const xRotation = page.locator('#field-controls-panel input[type="range"]').first();
  await xRotation.fill('69');
  await expect(xRotation).toHaveValue('69');

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

  await page.getByRole('button', { name: 'Close debug drawer' }).click();
  await expect(drawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await drawerTrigger.click();
  await expect(page.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Hide canvas debug' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Stop camera' }).last().click();
  await expect(page.getByRole('button', { name: 'Start Camera' })).toBeVisible();
  await startCamera(page);
  await expect(page.getByRole('dialog', { name: 'Field controls' })).toBeHidden();
  const restartedDrawerTrigger = page.getByRole('button', { name: 'Debug drawer', exact: true });
  await expect(restartedDrawerTrigger).toHaveAttribute('aria-expanded', 'false');
  await restartedDrawerTrigger.click();
  await page.getByRole('tab', { name: 'Model' }).click();
  await expect(page.locator('#field-controls-panel input[type="range"]').first()).toHaveValue('69');
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
