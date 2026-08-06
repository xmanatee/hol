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
      selectionRegion: { x1: 560, y1: 280, x2: 720, y2: 440 },
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

test('mirrors anchor position and orientation with the camera presentation', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    mirrored: true,
    activeAnchor: {
      position: { x: 200, y: 360 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0.3, y: 0, z: 0.95 },
      planarTransform: { rotation: 0.25 },
    },
  });

  assert.ok(transform.position[0] > 0);
  assert.ok(transform.rotation[1] > 0);
  assert.equal(round(transform.rotation[2]), 0.25);
});

test('keeps source coordinates outside the WebGL viewport when object-cover crops them', () => {
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
  assert.ok(transform.position[0] < -3);
  assert.equal(round(transform.position[1]), 0);
});

test('maps the visible source edge to the WebGL edge when object-cover crops a landscape frame', () => {
  const sourceWidth = 1280;
  const sourceHeight = 720;
  const viewportWidth = 390;
  const viewportHeight = 844;
  const coverScale = Math.max(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
  const visibleSourceLeft = (sourceWidth - viewportWidth / coverScale) / 2;
  const fov = 63;
  const cameraDistance = 3;
  const viewHeight = 2 * Math.tan((fov * Math.PI) / 180 / 2) * cameraDistance;
  const viewWidth = (viewHeight * viewportWidth) / viewportHeight;

  const transform = computeAnchorOverlayTransform({
    width: sourceWidth,
    height: sourceHeight,
    renderWidth: viewportWidth,
    renderHeight: viewportHeight,
    activeAnchor: {
      position: { x: visibleSourceLeft, y: sourceHeight / 2 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0, y: 0, z: 1 },
    },
    fov,
    cameraDistance,
  });

  assert.equal(transform.visible, true);
  assert.equal(round(transform.position[0]), round(-viewWidth / 2));
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

test('hides the overlay when the attachment surface is nearly edge-on', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0.99, y: 0, z: 0.05 },
    },
  });

  assert.equal(transform.visible, false);
});

test('hides the overlay when the attachment surface is back-facing', () => {
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      normal: { x: 0.2, y: 0, z: -0.98 },
    },
  });

  assert.equal(transform.visible, false);
});

test('uses tracked planar scale and in-plane rotation from the anchor transform', () => {
  const base = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
      selectionRegion: { x1: 560, y1: 280, x2: 720, y2: 440 },
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
      selectionRegion: { x1: 560, y1: 280, x2: 720, y2: 440 },
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
      selectionRegion: { x1: 560, y1: 280, x2: 720, y2: 440 },
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

test('uses a display-rate presentation position without mutating service state', () => {
  const anchorState = {
    anchored: true,
    state: 'tracking',
    position: { x: 500, y: 360, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  };
  const transform = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 100, y: 100 },
      selectionRegion: { x1: 560, y1: 280, x2: 720, y2: 440 },
    },
    anchorState,
    presentationPosition: { x: 640, y: 360, z: 0 },
  });

  assert.deepEqual(transform.position.map(round), [0, 0, 0]);
  assert.equal(anchorState.position.x, 500);
});

test('uses object support region as the overlay footprint before local template box', () => {
  const fullSelectionScale = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
      selectionRegion: { x1: 420, y1: 120, x2: 860, y2: 680 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      position: { x: 640, y: 360, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
  }).scale;

  const objectSupportScale = computeAnchorOverlayTransform({
    width: 1280,
    height: 720,
    activeAnchor: {
      position: { x: 640, y: 360 },
      selectionRegion: { x1: 420, y1: 120, x2: 860, y2: 680 },
    },
    anchorState: {
      anchored: true,
      state: 'stable',
      position: { x: 640, y: 360, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      metrics: {
        currentObjectSupportMaskBounds: { x: 420, y: 120, width: 440, height: 560 },
        templateRegion: { x: 588, y: 300, width: 104, height: 120 },
      },
    },
  }).scale;

  assert.equal(objectSupportScale, fullSelectionScale);
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
