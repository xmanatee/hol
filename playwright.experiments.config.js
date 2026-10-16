import { defineConfig } from '@playwright/test';
import runtimeConfig from './playwright.config.js';

export default defineConfig({
  ...runtimeConfig,
  testDir: './tests/experiments',
  outputDir: './artifacts/vision-experiments',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: { ...runtimeConfig.use, trace: 'off', video: 'off' },
});
