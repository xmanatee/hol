import { expect, test } from '@playwright/test';

test('a stale app shell identifies its build and offers an explicit reload without navigating automatically', async ({
  page,
}, testInfo) => {
  let newerRelease = true;
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.route('**/', async (route) => {
    const response = await route.fetch();
    if (route.request().isNavigationRequest() || !newerRelease) {
      await route.fulfill({ response });
      return;
    }
    const body = (await response.text()).replace(
      /src="\/assets\/index-[^"]+\.js"/,
      'src="/assets/index-new-release.js"',
    );
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  const build = page.getByText(/^Build index-/);
  await expect(build).toBeVisible();
  await expect(page.getByText('A newer version is available.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Camera', exact: true })).toBeVisible();
  expect(navigations).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('update-available.png') });
  newerRelease = false;
  const currentReleaseCheck = page.waitForResponse(
    (response) => !response.request().isNavigationRequest() && new URL(response.url()).pathname === '/',
  );
  await page.getByRole('button', { name: 'Reload app', exact: true }).click();
  await (await currentReleaseCheck).finished();
  await expect(page.getByRole('button', { name: 'Start Camera', exact: true })).toBeVisible();
  await expect(page.getByText('A newer version is available.', { exact: false })).toHaveCount(0);
  expect(navigations).toBe(2);
  await page.unrouteAll({ behavior: 'wait' });
});
