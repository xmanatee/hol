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
