import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAnchorOverlayTransform } from './anchorProjection.js';

const round = (value) => Number(value.toFixed(3));

test('maps the anchor center to the center of the WebGL plane', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
      sourceDetection: { x1: 560, y1: 280, x2: 720, y2: 440 },
    },
    anchorState: {
      anchored: true,
      state: 'tracking',
      normal: { x: 0, y: 0, z: 1 },
    },
  });

  assert.equal(transform.visible, true);
  assert.deepEqual(transform.position.map(round), [0, 0, 0]);
  assert.equal(round(transform.rotation[0]), 0);
  assert.equal(round(transform.rotation[1]), 0);
  assert.ok(transform.scale > 0.45 && transform.scale < 0.7);
});

test('maps top-left image coordinates to top-left world coordinates', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 0, y: 0 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0, y: 0, z: 1 },
    },
  });

  assert.equal(transform.visible, true);
  assert.ok(transform.position[0] < -3);
  assert.ok(transform.position[1] > 1.7);
});

test('uses render viewport aspect while normalizing source video coordinates', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    renderWidth: 390,
    renderHeight: 844,
    activeAnchor: {
      position: { x: 0, y: 360 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0, y: 0, z: 1 },
    },
  });

  assert.equal(transform.visible, true);
  assert.ok(transform.position[0] > -1);
  assert.ok(transform.position[0] < -0.7);
  assert.equal(round(transform.position[1]), 0);
});

test('tilts the overlay from the tracked surface normal', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0.45, y: -0.25, z: 0.86 },
    },
  });

  assert.equal(transform.visible, true);
  assert.ok(transform.rotation[0] < 0);
  assert.ok(transform.rotation[1] < 0);
});

test('uses angular surface rotation for strong object turns', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0.7, y: 0, z: 0.714 },
    },
  });

  assert.equal(transform.visible, true);
  assert.ok(transform.rotation[1] < -0.72);
  assert.ok(transform.rotation[1] > -0.95);
});

test('uses tracked planar scale and in-plane rotation from the anchor transform', () => {
  const base = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
      sourceDetection: { x1: 560, y1: 280, x2: 720, y2: 440 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0, y: 0, z: 1 },
    },
  });
  const transformed = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
      sourceDetection: { x1: 560, y1: 280, x2: 720, y2: 440 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0, y: 0, z: 1 },
      planarTransform: {
        scale: 1.45,
        rotation: 0.42,
      },
    },
  });

  assert.ok(transformed.scale > base.scale * 1.35);
  assert.equal(round(transformed.rotation[2]), -0.42);
});

test('uses live service position instead of stale active anchor position', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 100, y: 100 },
      sourceDetection: { x1: 560, y1: 280, x2: 720, y2: 440 },
    },
    anchorState: {
      anchored: true,
      state: 'tracking',
      position: { x: 640, y: 360, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
  });

  assert.equal(transform.visible, true);
  assert.deepEqual(transform.position.map(round), [0, 0, 0]);
});

test('uses selected template region as the overlay footprint before whole detection box', () => {
  const fullDetectionScale = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
      sourceDetection: { x1: 420, y1: 120, x2: 860, y2: 680 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      position: { x: 640, y: 360, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
  }).scale;

  const templateScale = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
      sourceDetection: { x1: 420, y1: 120, x2: 860, y2: 680 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      position: { x: 640, y: 360, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      metrics: {
        templateRegion: { x: 588, y: 300, width: 104, height: 120 },
      },
    },
  }).scale;

  assert.ok(templateScale < fullDetectionScale * 0.35);
  assert.ok(templateScale > 0.28);
});

test('hides the overlay when no live anchor is available', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
    },
    anchorState: {
      anchored: true,
      state: 'lost',
      normal: { x: 0, y: 0, z: 1 },
    },
  });

  assert.equal(transform.visible, false);
});
