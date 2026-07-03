import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BENCHMARK_BACKGROUND_VARIANTS,
  BENCHMARK_OCCLUSION_PROFILES,
  BENCHMARK_MOTION_VARIANTS,
  BENCHMARK_OBJECT_CASES,
  createVisionBenchmarkMatrix,
} from './visionBenchmarkMatrix.js';

const countsFor = (scenarios, axisName) => scenarios.reduce((counts, scenario) => {
  counts[scenario.axes[axisName]] = (counts[scenario.axes[axisName]] || 0) + 1;
  return counts;
}, {});

const motionCountsByOcclusion = scenarios => scenarios.reduce((groups, scenario) => {
  const occlusion = scenario.axes.occlusion;
  const motion = scenario.axes.motion;
  const group = groups[occlusion] || {};
  group[motion] = (group[motion] || 0) + 1;
  groups[occlusion] = group;
  return groups;
}, {});

test('benchmark matrix keeps explicit object, background, motion, and occlusion axes', () => {
  const scenarios = createVisionBenchmarkMatrix({ size: 'quick' });
  const axes = scenarios.map(scenario => scenario.axes);

  assert.equal(scenarios.length, 21);
  assert.ok(new Set(axes.map(axis => axis.object)).size >= 4);
  assert.ok(new Set(axes.map(axis => axis.background)).size >= 3);
  assert.deepEqual(
    [...new Set(axes.map(axis => axis.motion))].sort(),
    ['fast', 'slow', 'standard']
  );
  assert.deepEqual(
    [...new Set(axes.map(axis => axis.occlusion))].sort(),
    ['clean', 'early', 'repeated']
  );
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
  assert.ok(axes.every(axis => Number.isInteger(axis.backgroundSeed)));
  assert.ok(axes.every(axis => BENCHMARK_BACKGROUND_VARIANTS.includes(axis.background)));
  assert.ok(axes.some(axis => (
    axis.object === 'generic-free-tap-can' &&
    axis.targetClassOverride === 'segmented-object'
  )));
  assert.ok(axes.some(axis => (
    axis.object === 'glossy-can' &&
    axis.geometry === 'cylindrical-specular'
  )));
  assert.ok(axes.some(axis => (
    axis.object === 'human-silhouette' &&
    axis.targetClass === 'person'
  )));
});

test('representative benchmark covers every object case and motion profile once', () => {
  const scenarios = createVisionBenchmarkMatrix();
  const expectedCount = BENCHMARK_OBJECT_CASES.length * BENCHMARK_OCCLUSION_PROFILES.length;

  assert.equal(scenarios.length, expectedCount);
  assert.deepEqual(
    [...new Set(scenarios.map(scenario => scenario.axes.object))].sort(),
    BENCHMARK_OBJECT_CASES.map(objectCase => objectCase.id).sort()
  );
  assert.deepEqual(
    [...new Set(scenarios.map(scenario => scenario.axes.motion))].sort(),
    ['fast', 'slow', 'standard']
  );
  assert.deepEqual(
    [...new Set(scenarios.map(scenario => scenario.axes.occlusion))].sort(),
    BENCHMARK_OCCLUSION_PROFILES.map(profile => profile.id).sort()
  );
});

test('representative benchmark balances motion independently from occlusion', () => {
  const scenarios = createVisionBenchmarkMatrix();
  const expectedMotionCount = BENCHMARK_OBJECT_CASES.length *
    BENCHMARK_OCCLUSION_PROFILES.length / BENCHMARK_MOTION_VARIANTS.length;
  const expectedMotionPerOcclusion = BENCHMARK_OBJECT_CASES.length / BENCHMARK_MOTION_VARIANTS.length;

  assert.deepEqual(countsFor(scenarios, 'motion'), {
    fast: expectedMotionCount,
    slow: expectedMotionCount,
    standard: expectedMotionCount,
  });
  assert.deepEqual(countsFor(scenarios, 'occlusion'), Object.fromEntries(
    BENCHMARK_OCCLUSION_PROFILES.map(profile => [profile.id, BENCHMARK_OBJECT_CASES.length])
  ));
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
    const objectIndex = BENCHMARK_OBJECT_CASES.findIndex(objectCase => objectCase.id === scenario.axes.object);
    const occlusionIndex = BENCHMARK_OCCLUSION_PROFILES.findIndex(profile => profile.id === scenario.axes.occlusion);
    const backgroundIndex = BENCHMARK_BACKGROUND_VARIANTS.indexOf(scenario.axes.background);
    assert.equal(
      scenario.axes.backgroundSeed,
      2000 + objectIndex * 101 + occlusionIndex * 17 + backgroundIndex * 13,
      `${scenario.name} seed should include selected background axis`
    );
  }
});

test('benchmark scenarios create real synthetic replay sequences with matching axes', () => {
  const scenarios = createVisionBenchmarkMatrix({ size: 'quick' });
  const cleanScenario = scenarios.find(scenario => scenario.axes.occlusion === 'clean');
  const occludedScenario = scenarios.find(scenario => scenario.axes.occlusion === 'repeated');
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

  const freeTapCan = scenarios.find(scenario => scenario.axes.object === 'generic-free-tap-can');
  assert.equal(freeTapCan.create().kind, 'cylindrical-can');
  assert.equal(freeTapCan.targetClassOverride, 'segmented-object');

  const glossyCan = scenarios.find(scenario => scenario.axes.object === 'glossy-can');
  assert.equal(glossyCan.create().kind, 'glossy-can');
  assert.equal(glossyCan.create().metadata.hasSpecularHighlights, true);
});
