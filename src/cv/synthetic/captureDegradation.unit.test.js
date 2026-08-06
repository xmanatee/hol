import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURE_CONDITIONS,
  applyCaptureCondition,
  applyLinearMotionBlur,
  applyLowLightSensorNoise,
  applyRollingShutterWarp,
  warpRollingShutterPoint,
} from './captureDegradation.js';
import { createPlanarBookSequence } from './visionFixtures.js';
import { captureReplayScenarios, reportReplayScenarios } from './visionReplayScenarios.js';

const createImage = (width, height, pixelFor) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = pixelFor(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = pixel[0];
      data[offset + 1] = pixel[1];
      data[offset + 2] = pixel[2];
      data[offset + 3] = pixel[3] ?? 255;
    }
  }
  return { width, height, data };
};

const channelValues = (imageData, channel = 0) => {
  const values = [];
  for (let offset = channel; offset < imageData.data.length; offset += 4) {
    values.push(imageData.data[offset]);
  }
  return values;
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

test('low-light sensor degradation is deterministic, darker, and noisy without mutating its source', () => {
  const source = createImage(12, 8, () => [156, 156, 156, 255]);
  const sourceSnapshot = [...source.data];

  const first = applyLowLightSensorNoise(source, 47);
  const second = applyLowLightSensorNoise(source, 47);
  const differentSeed = applyLowLightSensorNoise(source, 48);
  const values = channelValues(first);

  assert.deepEqual([...first.data], [...second.data]);
  assert.notDeepEqual([...first.data], [...differentSeed.data]);
  assert.deepEqual([...source.data], sourceSnapshot);
  assert.ok(mean(values) < 120);
  assert.ok(new Set(values).size > 20);
  assert.ok(channelValues(first, 3).every((value) => value === 255));
});

test('linear motion blur uses a line PSF that preserves centered impulse energy', () => {
  const source = createImage(15, 9, (x, y) => (x === 7 && y === 4 ? [255, 0, 0, 255] : [0, 0, 0, 255]));

  const blurred = applyLinearMotionBlur(source, { x: 8, y: 0 });
  const activePixels = [];
  let redEnergy = 0;
  for (let y = 0; y < blurred.height; y++) {
    for (let x = 0; x < blurred.width; x++) {
      const red = blurred.data[(y * blurred.width + x) * 4];
      redEnergy += red;
      if (red > 0) activePixels.push({ x, y });
    }
  }

  assert.ok(activePixels.length >= 7);
  assert.ok(activePixels.every((point) => point.y === 4));
  assert.ok(Math.abs(redEnergy - 255) <= 8);
});

test('rolling shutter applies row-time skew consistently to pixels and points', () => {
  const source = createImage(9, 5, (x) => (x === 4 ? [255, 255, 255, 255] : [0, 0, 0, 255]));

  const warped = applyRollingShutterWarp(source, 4);
  const whiteXAt = (y) => {
    const row = channelValues({
      width: warped.width,
      height: 1,
      data: warped.data.slice(y * warped.width * 4, (y + 1) * warped.width * 4),
    });
    return row.indexOf(Math.max(...row));
  };

  assert.equal(whiteXAt(0), 2);
  assert.equal(whiteXAt(2), 4);
  assert.equal(whiteXAt(4), 6);
  assert.deepEqual(warpRollingShutterPoint({ x: 4, y: 0 }, source.height, 4), { x: 2, y: 0 });
  assert.deepEqual(warpRollingShutterPoint({ x: 4, y: 4 }, source.height, 4), { x: 6, y: 4 });
});

test('capture conditions clone sequences and publish reproducible evidence metadata', () => {
  const source = createPlanarBookSequence({
    frameCount: 6,
    occlusionFrames: [],
    backgroundSeed: 211,
  });
  const originalPixels = [...source.frames[0].imageData.data];
  const degraded = applyCaptureCondition(source, 'low-light');
  const repeated = applyCaptureCondition(source, 'low-light');

  assert.deepEqual(Object.keys(CAPTURE_CONDITIONS).sort(), [
    'handheld-night',
    'low-light',
    'low-light-motion',
    'motion-blur',
    'rolling-motion',
    'rolling-shutter',
  ]);
  assert.notEqual(degraded, source);
  assert.notEqual(degraded.frames[0], source.frames[0]);
  assert.deepEqual([...source.frames[0].imageData.data], originalPixels);
  assert.deepEqual([...degraded.frames[0].imageData.data], [...repeated.frames[0].imageData.data]);
  assert.equal(degraded.metadata.captureCondition, 'low-light');
  assert.deepEqual(
    degraded.frames[0].captureDegradation.effects.map((effect) => effect.condition),
    ['low-light'],
  );
  assert.throws(() => applyCaptureCondition(source, 'unknown'), /Unknown capture condition: unknown/);
});

test('handheld-night composes row readout, exposure blur, and sensor noise with aligned truth', () => {
  const source = createPlanarBookSequence({
    frameCount: 8,
    occlusionFrames: [5, 6],
    backgroundVariant: 'busy',
    backgroundSeed: 223,
  });
  const degraded = applyCaptureCondition(source, 'handheld-night');
  const repeated = applyCaptureCondition(source, 'handheld-night');
  const frame = degraded.frames[3];
  const rollingEvidence = frame.captureDegradation.effects[0];

  assert.deepEqual(degraded.metadata.captureModel.effects, ['rolling-shutter', 'motion-blur', 'low-light']);
  assert.deepEqual(
    frame.captureDegradation.effects.map((effect) => effect.condition),
    degraded.metadata.captureModel.effects,
  );
  assert.deepEqual(
    frame.groundTruth.anchor,
    warpRollingShutterPoint(source.frames[3].groundTruth.anchor, degraded.height, rollingEvidence.skewX),
  );
  assert.deepEqual(frame.imageData.data, repeated.frames[3].imageData.data);
  assert.notDeepEqual(frame.imageData.data, source.frames[3].imageData.data);
});

test('rolling-shutter sequence degradation keeps object masks and anchor truth aligned', () => {
  const imageData = createImage(9, 5, (x) => (x === 4 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const objectMask = {
    data: new Uint8Array(9 * 5).map((_, index) => (index % 9 === 4 ? 255 : 0)),
  };
  const createFrame = (anchorX) => ({
    imageData,
    objectMask,
    corners: [
      { x: 3, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 4 },
      { x: 3, y: 4 },
    ],
    boundingBox: {
      x: 3,
      y: 0,
      width: 2,
      height: 4,
      x1: 3,
      y1: 0,
      x2: 5,
      y2: 4,
    },
    groundTruth: {
      anchor: { x: anchorX, y: 4 },
      normal: { x: 0, y: 0, z: 1 },
      scale: 1,
      roll: 0,
    },
    maskProbePoints: {
      object: { x: anchorX, y: 4 },
    },
  });
  const source = {
    kind: 'rolling-mask-test',
    width: 9,
    height: 5,
    tap: { x: 4, y: 4 },
    boundingBox: createFrame(4).boundingBox,
    camera: { fx: 8, fy: 8, cx: 4, cy: 2 },
    frames: [createFrame(4), createFrame(8)],
    metadata: {},
  };

  const degraded = applyCaptureCondition(source, 'rolling-shutter');
  const frame = degraded.frames[0];
  const probe = frame.maskProbePoints.object;
  const probeIndex = Math.round(probe.y) * source.width + Math.round(probe.x);

  assert.deepEqual(frame.groundTruth.anchor, probe);
  assert.equal(frame.objectMask.data[probeIndex], 255);
  assert.notDeepEqual(frame.boundingBox, source.frames[0].boundingBox);
  assert.equal(source.frames[0].objectMask.data[4 + 4 * source.width], 255);
});

test('strict replay scenarios cover each capture condition exactly once', () => {
  const captureConditions = captureReplayScenarios.map((scenario) => scenario.captureCondition);

  assert.deepEqual(captureConditions.sort(), ['low-light', 'motion-blur', 'rolling-shutter']);
  assert.ok(
    captureReplayScenarios.every(
      (scenario) => scenario.create().metadata.captureCondition === scenario.captureCondition,
    ),
  );
  assert.ok(captureReplayScenarios.every((scenario) => reportReplayScenarios.includes(scenario)));
});
