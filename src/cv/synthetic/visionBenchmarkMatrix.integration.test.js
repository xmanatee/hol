import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BENCHMARK_BACKGROUND_VARIANTS,
  BENCHMARK_OCCLUSION_PROFILES,
  BENCHMARK_MOTION_VARIANTS,
  BENCHMARK_OBJECT_CASES,
  createVisionBenchmarkMatrix,
} from './visionBenchmarkMatrix.js';

const countsFor = (scenarios, axisName) =>
  scenarios.reduce((counts, scenario) => {
    counts[scenario.axes[axisName]] = (counts[scenario.axes[axisName]] || 0) + 1;
    return counts;
  }, {});

const motionCountsByOcclusion = (scenarios) =>
  scenarios.reduce((groups, scenario) => {
    const occlusion = scenario.axes.occlusion;
    const motion = scenario.axes.motion;
    const group = groups[occlusion] || {};
    group[motion] = (group[motion] || 0) + 1;
    groups[occlusion] = group;
    return groups;
  }, {});

const scenarioAxisKey = (scenario) =>
  [scenario.axes.object, scenario.axes.background, scenario.axes.motion, scenario.axes.occlusion].join('|');

test('benchmark matrix keeps explicit object, background, motion, and occlusion axes', () => {
  const scenarios = createVisionBenchmarkMatrix({ size: 'quick' });
  const axes = scenarios.map((scenario) => scenario.axes);

  assert.equal(scenarios.length, 21);
  assert.ok(new Set(axes.map((axis) => axis.object)).size >= 4);
  assert.ok(new Set(axes.map((axis) => axis.background)).size >= 3);
  assert.deepEqual([...new Set(axes.map((axis) => axis.motion))].sort(), ['fast', 'slow', 'standard']);
  assert.deepEqual([...new Set(axes.map((axis) => axis.occlusion))].sort(), ['clean', 'early', 'repeated']);
  assert.deepEqual(countsFor(scenarios, 'motion'), {
    fast: 7,
    slow: 7,
    standard: 7,
  });
  assert.deepEqual(countsFor(scenarios, 'occlusion'), {
    clean: 7,
    early: 7,
    repeated: 7,
  });
  assert.ok(axes.every((axis) => Number.isInteger(axis.backgroundSeed)));
  assert.ok(axes.every((axis) => BENCHMARK_BACKGROUND_VARIANTS.includes(axis.background)));
  assert.ok(
    axes.some(
      (axis) => axis.object === 'generic-free-tap-can' && axis.targetClassOverride === 'generic-object',
    ),
  );
  assert.ok(axes.some((axis) => axis.object === 'glossy-can' && axis.geometry === 'cylindrical-specular'));
  assert.ok(axes.some((axis) => axis.object === 'human-silhouette' && axis.targetClass === 'person'));
});

test('representative benchmark covers every object case and motion profile once', () => {
  const scenarios = createVisionBenchmarkMatrix();
  const expectedCount = BENCHMARK_OBJECT_CASES.length * BENCHMARK_OCCLUSION_PROFILES.length;

  assert.equal(scenarios.length, expectedCount);
  assert.deepEqual(
    [...new Set(scenarios.map((scenario) => scenario.axes.object))].sort(),
    BENCHMARK_OBJECT_CASES.map((objectCase) => objectCase.id).sort(),
  );
  assert.deepEqual([...new Set(scenarios.map((scenario) => scenario.axes.motion))].sort(), [
    'fast',
    'slow',
    'standard',
  ]);
  assert.deepEqual(
    [...new Set(scenarios.map((scenario) => scenario.axes.occlusion))].sort(),
    BENCHMARK_OCCLUSION_PROFILES.map((profile) => profile.id).sort(),
  );
});

test('representative benchmark balances motion independently from occlusion', () => {
  const scenarios = createVisionBenchmarkMatrix();
  const expectedMotionCount =
    (BENCHMARK_OBJECT_CASES.length * BENCHMARK_OCCLUSION_PROFILES.length) / BENCHMARK_MOTION_VARIANTS.length;
  const expectedMotionPerOcclusion = BENCHMARK_OBJECT_CASES.length / BENCHMARK_MOTION_VARIANTS.length;

  assert.deepEqual(countsFor(scenarios, 'motion'), {
    fast: expectedMotionCount,
    slow: expectedMotionCount,
    standard: expectedMotionCount,
  });
  assert.deepEqual(
    countsFor(scenarios, 'occlusion'),
    Object.fromEntries(
      BENCHMARK_OCCLUSION_PROFILES.map((profile) => [profile.id, BENCHMARK_OBJECT_CASES.length]),
    ),
  );
  for (const counts of Object.values(motionCountsByOcclusion(scenarios))) {
    assert.deepEqual(counts, {
      fast: expectedMotionPerOcclusion,
      slow: expectedMotionPerOcclusion,
      standard: expectedMotionPerOcclusion,
    });
  }
});

test('representative benchmark ties procedural background seed to selected background', () => {
  const scenarios = createVisionBenchmarkMatrix();

  for (const scenario of scenarios) {
    const objectIndex = BENCHMARK_OBJECT_CASES.findIndex(
      (objectCase) => objectCase.id === scenario.axes.object,
    );
    const occlusionIndex = BENCHMARK_OCCLUSION_PROFILES.findIndex(
      (profile) => profile.id === scenario.axes.occlusion,
    );
    const backgroundIndex = BENCHMARK_BACKGROUND_VARIANTS.indexOf(scenario.axes.background);
    assert.equal(
      scenario.axes.backgroundSeed,
      2000 + objectIndex * 101 + occlusionIndex * 17 + backgroundIndex * 13,
      `${scenario.name} seed should include selected background axis`,
    );
  }
});

test('quick benchmark reuses canonical seeds for every scenario shared with the full matrix', () => {
  const quick = createVisionBenchmarkMatrix({ size: 'quick' });
  const fullByAxes = new Map(
    createVisionBenchmarkMatrix({ size: 'full' }).map((scenario) => [scenarioAxisKey(scenario), scenario]),
  );
  const overlapping = quick.filter((scenario) => fullByAxes.has(scenarioAxisKey(scenario)));

  assert.ok(overlapping.length > 0);
  for (const scenario of overlapping) {
    const fullScenario = fullByAxes.get(scenarioAxisKey(scenario));
    assert.equal(
      scenario.axes.backgroundSeed,
      fullScenario.axes.backgroundSeed,
      `${scenario.name} must keep one seed across matrix sizes`,
    );
  }
});

test('shared quick and full axes create byte-identical replay fixtures', () => {
  const quickScenario = createVisionBenchmarkMatrix({ size: 'quick' }).find(
    (scenario) => scenario.name === 'handled-mug / window / fast / repeated',
  );
  const fullScenario = createVisionBenchmarkMatrix({ size: 'full' }).find(
    (scenario) => scenarioAxisKey(scenario) === scenarioAxisKey(quickScenario),
  );

  assert.ok(quickScenario);
  assert.ok(fullScenario);
  const quickSequence = quickScenario.create();
  const fullSequence = fullScenario.create();
  assert.deepEqual(quickSequence.metadata, fullSequence.metadata);
  assert.equal(quickSequence.frames.length, fullSequence.frames.length);

  for (const frameIndex of [
    0,
    Math.floor(quickSequence.frames.length / 2),
    quickSequence.frames.length - 1,
  ]) {
    const quickFrame = quickSequence.frames[frameIndex];
    const fullFrame = fullSequence.frames[frameIndex];
    assert.deepEqual(quickFrame.groundTruth, fullFrame.groundTruth);
    assert.deepEqual(
      quickFrame.imageData.data,
      fullFrame.imageData.data,
      `frame ${frameIndex} pixels must be identical`,
    );
  }
});

test('benchmark scenarios create real synthetic replay sequences with matching axes', () => {
  const scenarios = createVisionBenchmarkMatrix({ size: 'quick' });
  const cleanScenario = scenarios.find((scenario) => scenario.axes.occlusion === 'clean');
  const occludedScenario = scenarios.find((scenario) => scenario.axes.occlusion === 'repeated');
  const cleanSequence = cleanScenario.create();
  const occludedSequence = occludedScenario.create();

  assert.equal(cleanSequence.kind, cleanScenario.axes.object);
  assert.equal(cleanSequence.frames.length, cleanScenario.axes.frameCount);
  assert.equal(cleanSequence.metadata.backgroundVariant, cleanScenario.axes.background);
  assert.equal(cleanSequence.metadata.hasOcclusion, false);
  assert.equal(occludedSequence.kind, occludedScenario.axes.object);
  assert.equal(occludedSequence.frames.length, occludedScenario.axes.frameCount);
  assert.equal(occludedSequence.metadata.backgroundVariant, occludedScenario.axes.background);
  assert.equal(occludedSequence.metadata.hasOcclusion, true);

  const freeTapCan = scenarios.find((scenario) => scenario.axes.object === 'generic-free-tap-can');
  assert.equal(freeTapCan.create().kind, 'cylindrical-can');
  assert.equal(freeTapCan.targetClassOverride, 'generic-object');

  const glossyCan = scenarios.find((scenario) => scenario.axes.object === 'glossy-can');
  assert.equal(glossyCan.create().kind, 'glossy-can');
  assert.equal(glossyCan.create().metadata.hasSpecularHighlights, true);
});

test('hard benchmark composes capture artifacts with motion and post-occlusion recovery', () => {
  const scenarios = createVisionBenchmarkMatrix({ size: 'hard' });
  const axes = scenarios.map((scenario) => scenario.axes);

  assert.equal(scenarios.length, 7);
  assert.deepEqual([...new Set(axes.map((axis) => axis.capture))].sort(), [
    'handheld-night',
    'low-light-motion',
    'rolling-motion',
  ]);
  assert.ok(axes.every((axis) => axis.capture !== 'nominal'));
  assert.ok(axes.every((axis) => axis.motion === 'fast' || axis.occlusion === 'repeated'));
  assert.ok(axes.some((axis) => axis.geometry === 'handled-tapered-cylinder'));
  assert.ok(axes.some((axis) => axis.geometry === 'planar-glossy'));
  assert.equal(axes.filter((axis) => axis.event === 'full-loss-reentry').length, 1);

  assert.ok(scenarios.every((scenario) => scenario.name.endsWith(scenario.axes.capture)));

  const sequence = scenarios.find((scenario) => scenario.axes.capture === 'handheld-night').create();
  assert.equal(sequence.metadata.captureCondition, 'handheld-night');
  assert.deepEqual(sequence.metadata.captureModel.effects, ['rolling-shutter', 'motion-blur', 'low-light']);

  const targetLoss = scenarios.find((scenario) => scenario.axes.event === 'full-loss-reentry');
  assert.equal(targetLoss.axes.frameCount, 36);
  assert.equal(targetLoss.axes.occlusion, 'full-loss');
  assert.equal(targetLoss.replayOptions.refreshObjectSupportMask, false);
  assert.equal(targetLoss.create().metadata.targetLoss.reentryFrame, 22);
});

test('benchmark matrix rejects unknown protocol sizes', () => {
  assert.throws(
    () => createVisionBenchmarkMatrix({ size: 'nightmare' }),
    /Unknown vision benchmark size: nightmare/,
  );
});
