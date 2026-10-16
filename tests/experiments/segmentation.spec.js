import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { arch, cpus, platform, release } from 'node:os';
import { listSegmentationBackends } from '../../src/cv/segmentationBackend.js';
import {
  createSegmentationProbe,
  SEGMENTATION_EXPERIMENT_CASES,
} from '../../src/cv/synthetic/segmentationExperiment.js';
import {
  MAGIC_TOUCH_ASSET,
  MEDIAPIPE_LOADER_ASSET,
  MEDIAPIPE_WASM_ASSET,
} from '../../src/runtime/capabilityPacks.js';
import { productionAssetUrl } from '../browser/productionAsset.js';

for (const backend of listSegmentationBackends()) {
  test(`real ${backend.id} point segmentation on identical pinned probes`, async ({
    page,
    browser,
    browserName,
  }, testInfo) => {
    test.setTimeout(600_000);
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && consoleErrors.length < 30)
        consoleErrors.push(message.text().slice(0, 2000));
    });
    await page.goto('/');
    const protocolSource = await readFile(
      new URL('../../src/cv/synthetic/segmentationExperiment.js', import.meta.url),
      'utf8',
    );
    await page.addScriptTag({
      type: 'module',
      content: `${protocolSource}\nwindow.runHolSegmentationExperiment = runSegmentationExperiment;`,
    });
    await page.waitForFunction(() => typeof window.runHolSegmentationExperiment === 'function');
    const workerUrl = productionAssetUrl({
      label: 'interactive segmenter',
      pattern: /^interactiveSegmenter\.worker-[\w-]+\.js$/,
      minBytes: 100_000,
    });
    const model = {
      id: MAGIC_TOUCH_ASSET.id,
      sha256: MAGIC_TOUCH_ASSET.sha256,
      bytes: MAGIC_TOUCH_ASSET.bytes,
      license: MAGIC_TOUCH_ASSET.license,
      resolution: [512, 512],
      weightPrecision: 'float32',
    };
    const runtime = {
      package: '@mediapipe/tasks-vision',
      version: MEDIAPIPE_WASM_ASSET.revision,
      wasmSha256: MEDIAPIPE_WASM_ASSET.sha256,
      loaderSha256: MEDIAPIPE_LOADER_ASSET.sha256,
      arithmeticPrecision: 'delegate-controlled; not independently established',
    };
    const report = await page.evaluate((args) => window.runHolSegmentationExperiment(args), {
      workerUrl,
      backendId: backend.id,
      model,
      runtime,
    });
    const reports = [{ ...report, backend, browserName, browserVersion: browser.version() }];
    console.log(
      JSON.stringify(
        {
          backend: backend.id,
          status: report.status,
          error: report.error,
          backendInfo: report.backendInfo,
          cases: report.samples.map((sample) => ({
            id: sample.id,
            iou: sample.minimumIou,
            targetMet: sample.targetMet,
            roundTripMedianMs: sample.timing.roundTripMs.medianMs,
            segmentCallMedianMs: sample.timing.segmentCallMs.medianMs,
            maskReadbackAndSyncMedianMs: sample.timing.maskReadbackAndSyncMs.medianMs,
            maskPostprocessMedianMs: sample.timing.maskPostprocessMs.medianMs,
            falseForegroundFraction: sample.maximumFalseForegroundFraction,
          })),
        },
        null,
        2,
      ),
    );
    const reportPath = testInfo.outputPath('segmentation-report.json');
    await writeFile(
      reportPath,
      `${JSON.stringify({ createdAt: new Date().toISOString(), host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0].model }, workerUrl, consoleErrors, reports }, null, 2)}\n`,
    );
    await testInfo.attach('segmentation-report', { path: reportPath, contentType: 'application/json' });
    if (backend.id === 'mediapipe-wasm') expect(report.status, report.error).toBe('completed');
    const expectedProbes = SEGMENTATION_EXPERIMENT_CASES.map(({ id }) => {
      const probe = createSegmentationProbe(id);
      return {
        id,
        inputSha256: createHash('sha256').update(probe.imageData.data).digest('hex'),
        truthSha256: createHash('sha256').update(probe.truth).digest('hex'),
      };
    });
    expect(['completed', 'unavailable'], report.error).toContain(report.status);
    if (report.status !== 'completed') return;
    expect(report.coldStart.cold).toBe(true);
    expect(
      report.samples.map(({ id, inputSha256, truthSha256 }) => ({ id, inputSha256, truthSha256 })),
    ).toEqual(expectedProbes);
    expect(report.backendInfo.execution).toBe(backend.execution);
    if (backend.execution === 'webgl') expect(report.backendInfo.webgl.version).toContain('WebGL');
    expect(report.samples.every(({ observations }) => observations.length === 20)).toBe(true);
  });
}
