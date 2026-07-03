import test from 'node:test';
import assert from 'node:assert/strict';

import { RECONSTRUCTION_MODES } from '../anchor.reconstructionModes.js';
import {
  BENCHMARK_OBJECT_CASES,
  BENCHMARK_OCCLUSION_PROFILES,
  createVisionBenchmarkMatrix,
} from './visionBenchmarkMatrix.js';
import { summarizeVisionBenchmarkCoverage } from './visionBenchmarkCoverage.js';

test('benchmark coverage summary separates scenario balance from replay mode balance', () => {
  const scenarios = [
    {
      axes: {
        object: 'handled-mug',
        targetClass: 'mug',
        geometry: 'handled-tapered-cylinder',
        background: 'busy',
        lighting: 'moving-high-frequency-clutter',
        motion: 'slow',
        occlusion: 'early',
        condition: 'slow-early',
      },
    },
    {
      axes: {
        object: 'handled-mug',
        targetClass: 'mug',
        geometry: 'handled-tapered-cylinder',
        background: 'window',
        lighting: 'high-contrast-backlight',
        motion: 'fast',
        occlusion: 'repeated',
        condition: 'fast-repeated',
      },
    },
    {
      axes: {
        object: 'glossy-can',
        targetClass: 'can',
        geometry: 'cylindrical-specular',
        background: 'busy',
        lighting: 'moving-high-frequency-clutter',
        motion: 'slow',
        occlusion: 'early',
        condition: 'slow-early',
      },
    },
  ];
  const modes = [
    { id: 'sparse-reconstruction' },
    { id: 'direct-photometric' },
  ];

  const coverage = summarizeVisionBenchmarkCoverage({ scenarios, modes });

  assert.equal(coverage.scenarioCount, 3);
  assert.equal(coverage.modeCount, 2);
  assert.equal(coverage.replayCount, 6);
  assert.deepEqual(coverage.scenarioAxes.object, {
    total: 3,
    uniqueCount: 2,
    minCount: 1,
    maxCount: 2,
    imbalanceRatio: 2,
    values: [
      { name: 'handled-mug', count: 2, share: 2 / 3 },
      { name: 'glossy-can', count: 1, share: 1 / 3 },
    ],
  });
  assert.deepEqual(coverage.replayAxes.mode, {
    total: 6,
    uniqueCount: 2,
    minCount: 3,
    maxCount: 3,
    imbalanceRatio: 1,
    values: [
      { name: 'direct-photometric', count: 3, share: 0.5 },
      { name: 'sparse-reconstruction', count: 3, share: 0.5 },
    ],
  });
  assert.deepEqual(coverage.scenarioInteractions.motionOcclusion.values, [
    { name: 'slow / early', count: 2, share: 2 / 3 },
    { name: 'fast / repeated', count: 1, share: 1 / 3 },
  ]);
  assert.deepEqual(
    coverage.replayAxes.modeObject.values.find(item => item.name === 'direct-photometric / handled-mug'),
    { name: 'direct-photometric / handled-mug', count: 2, share: 2 / 6 }
  );
  assert.deepEqual(coverage.imbalances.scenarioAxes[0], {
    name: 'object',
    total: 3,
    uniqueCount: 2,
    minCount: 1,
    maxCount: 2,
    imbalanceRatio: 2,
  });
});

test('representative benchmark coverage audits the real object and mode protocol', () => {
  const scenarios = createVisionBenchmarkMatrix({ size: 'representative' });
  const coverage = summarizeVisionBenchmarkCoverage({
    scenarios,
    modes: RECONSTRUCTION_MODES,
  });

  assert.equal(coverage.scenarioAxes.object.uniqueCount, BENCHMARK_OBJECT_CASES.length);
  assert.equal(coverage.scenarioAxes.object.minCount, BENCHMARK_OCCLUSION_PROFILES.length);
  assert.equal(coverage.scenarioAxes.object.maxCount, BENCHMARK_OCCLUSION_PROFILES.length);
  assert.equal(coverage.scenarioAxes.occlusion.uniqueCount, BENCHMARK_OCCLUSION_PROFILES.length);
  assert.equal(coverage.replayAxes.mode.uniqueCount, RECONSTRUCTION_MODES.length);
  assert.equal(coverage.replayAxes.mode.minCount, scenarios.length);
  assert.equal(coverage.replayAxes.mode.maxCount, scenarios.length);
  assert.equal(coverage.replayAxes.modeObject.minCount, BENCHMARK_OCCLUSION_PROFILES.length);
  assert.equal(coverage.replayAxes.modeObject.maxCount, BENCHMARK_OCCLUSION_PROFILES.length);
});
