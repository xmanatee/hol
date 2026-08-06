import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4274',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: process.env.HOL_BASE_URL || 'http://127.0.0.1:4274',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 7'],
        permissions: ['camera', 'microphone'],
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
    {
      name: 'mobile-webkit',
      use: {
        ...devices['iPhone 15'],
      },
    },
  ],
});
