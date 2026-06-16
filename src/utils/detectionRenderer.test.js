import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDetectionOverlay } from './detectionRenderer.js';

const createContext = () => {
  const calls = [];
  const record = (method) => (...args) => calls.push({ method, args });

  return {
    canvas: { width: 640, height: 480 },
    calls,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    arc: record('arc'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    fillText: record('fillText'),
    setLineDash: record('setLineDash'),
    set fillStyle(value) { calls.push({ method: 'fillStyle', args: [value] }); },
    set strokeStyle(value) { calls.push({ method: 'strokeStyle', args: [value] }); },
    set lineWidth(value) { calls.push({ method: 'lineWidth', args: [value] }); },
    set globalAlpha(value) { calls.push({ method: 'globalAlpha', args: [value] }); },
    set font(value) { calls.push({ method: 'font', args: [value] }); },
  };
};

test('anchor overlay draws object bounds live reconstruction and landmarks', () => {
  const ctx = createContext();
  const anchor = {
    position: { x: 170, y: 155 },
    sourceDetection: {
      x1: 96,
      y1: 80,
      x2: 260,
      y2: 250,
      objectSupportMask: {
        bbox: { x: 104, y: 92, width: 138, height: 140 },
      },
    },
  };
  const anchorState = {
    state: 'mapping',
    normal: { x: 0.32, y: 0.18, z: 0.93 },
    metrics: {
      activeLandmarkCount: 3,
      landmarkCount: 4,
      objectOwnedLandmarks: 3,
      reconstructionFrames: 4,
      reconstructionLandmarks: 3,
      reconstructionMapConfidence: 0.46,
      readiness: { faceReady: false },
      currentObjectSupportMaskBounds: { x: 104, y: 92, width: 138, height: 140 },
      reconstructionPreview: {
        current: {
          points: [
            { id: 1, x: 130, y: 120, reliability: 0.9 },
            { id: 2, x: 214, y: 134, reliability: 0.8 },
            { id: 3, x: 188, y: 218, reliability: 0.7 },
          ],
          surface: {
            hull: [1, 2, 3],
            edges: [{ from: 1, to: 2, reliability: 0.8 }],
            faces: [{ points: [1, 2, 3], reliability: 0.85 }],
          },
        },
      },
    },
  };

  renderDetectionOverlay(ctx, {
    mode: 'anchor',
    anchor,
    anchorState,
    showObjectSupport: true,
    trackedPoints: [
      { id: 1, status: 'active', current: { x: 130, y: 120 }, stabilityScore: 0.9, objectOwned: true },
      { id: 2, status: 'active', current: { x: 214, y: 134 }, stabilityScore: 0.8, objectOwned: true },
      { id: 3, status: 'active', current: { x: 188, y: 218 }, stabilityScore: 0.7, objectOwned: true },
    ],
  });

  assert.ok(ctx.calls.some(call => call.method === 'strokeRect'), 'draws selected-object support bounds');
  assert.ok(ctx.calls.filter(call => call.method === 'arc').length >= 5, 'draws anchor, progress ring, and landmark points');
  assert.ok(ctx.calls.filter(call => call.method === 'lineTo').length >= 6, 'draws reconstruction geometry and normal/crosshair lines');
  assert.ok(ctx.calls.some(call => call.method === 'fillText' && /Map: 4f 3p 46%/.test(call.args[0])), 'summarizes reconstruction progress');
});

test('candidate anchor still visualizes sparse bootstrap landmarks without reconstruction preview', () => {
  const ctx = createContext();

  renderDetectionOverlay(ctx, {
    mode: 'anchor',
    anchor: {
      position: { x: 80, y: 90 },
      sourceDetection: { x1: 30, y1: 40, x2: 140, y2: 160 },
    },
    anchorState: {
      state: 'candidate',
      metrics: {
        keypointCount: 3,
        activeLandmarkCount: 3,
        landmarkCount: 3,
        objectOwnedLandmarks: 2,
        readiness: { faceReady: false },
      },
    },
    showObjectSupport: true,
    trackedPoints: [
      { id: 1, status: 'active', current: { x: 50, y: 60 }, stabilityScore: 0.4 },
      { id: 2, status: 'active', current: { x: 78, y: 98 }, stabilityScore: 0.5 },
      { id: 3, status: 'active', current: { x: 118, y: 132 }, stabilityScore: 0.6 },
    ],
  });

  assert.ok(ctx.calls.some(call => call.method === 'strokeRect'), 'draws detection support bounds');
  assert.ok(ctx.calls.filter(call => call.method === 'arc').length >= 5, 'draws sparse landmarks plus anchor and progress');
  assert.ok(ctx.calls.some(call => call.method === 'fillText' && /Face: building/.test(call.args[0])), 'keeps face readiness visible');
});

test('anchor overlay draws object mask preview points instead of filling the whole mask bbox', () => {
  const ctx = createContext();

  renderDetectionOverlay(ctx, {
    mode: 'anchor',
    anchor: {
      position: { x: 170, y: 155 },
      sourceDetection: { x1: 90, y1: 80, x2: 280, y2: 260 },
    },
    anchorState: {
      state: 'mapping',
      metrics: {
        activeLandmarkCount: 8,
        landmarkCount: 12,
        objectOwnedLandmarks: 8,
        currentObjectSupportMaskPreview: {
          source: 'interactive-segmenter',
          bbox: { x: 104, y: 92, width: 138, height: 140 },
          sampleStride: 6,
          points: [
            { x: 104, y: 92 },
            { x: 126, y: 104 },
            { x: 196, y: 198 },
          ],
        },
        readiness: { faceReady: false },
      },
    },
    showObjectSupport: true,
    trackedPoints: [],
  });

  assert.ok(
    ctx.calls.some(call => call.method === 'strokeRect' && call.args[0] === 104 && call.args[1] === 92),
    'keeps a faint mask bbox for scale'
  );
  assert.equal(
    ctx.calls.some(call => call.method === 'fillRect' && call.args[0] === 104 && call.args[1] === 92 && call.args[2] === 138),
    false,
    'does not fill the entire rectangular bbox as the selected object'
  );
  assert.ok(
    ctx.calls.some(call => call.method === 'fillRect' && call.args[0] === 101 && call.args[1] === 89 && call.args[2] === 6 && call.args[3] === 6),
    'draws sampled mask support pixels'
  );
});

test('normal anchor overlay hides object support bounds outside canvas debug mode', () => {
  const ctx = createContext();

  renderDetectionOverlay(ctx, {
    mode: 'anchor',
    anchor: {
      position: { x: 170, y: 155 },
      sourceDetection: { x1: 90, y1: 80, x2: 280, y2: 260 },
    },
    anchorState: {
      state: 'mapping',
      metrics: {
        currentObjectSupportMaskBounds: { x: 104, y: 92, width: 138, height: 140 },
        readiness: { faceReady: false },
      },
    },
    trackedPoints: [],
  });

  assert.equal(ctx.calls.some(call => call.method === 'strokeRect'), false);
  assert.ok(ctx.calls.some(call => call.method === 'arc'), 'still draws the anchor marker');
});

test('active landmarks demoted from object ownership are not drawn as object anchors', () => {
  const ctx = createContext();

  renderDetectionOverlay(ctx, {
    mode: 'anchor',
    anchor: {
      position: { x: 80, y: 90 },
      sourceDetection: { x1: 30, y1: 40, x2: 140, y2: 160 },
    },
    anchorState: {
      state: 'tracking',
      metrics: {
        keypointCount: 3,
        activeLandmarkCount: 3,
        landmarkCount: 3,
        objectOwnedLandmarks: 2,
        readiness: { faceReady: false },
      },
    },
    trackedPoints: [
      { id: 1, status: 'active', current: { x: 50, y: 60 }, stabilityScore: 0.8, objectOwned: true },
      { id: 2, status: 'active', current: { x: 220, y: 170 }, stabilityScore: 0.9, objectOwned: false },
      { id: 3, status: 'active', current: { x: 78, y: 98 }, stabilityScore: 0.7, objectOwned: true },
    ],
  });

  assert.equal(
    ctx.calls.some(call => call.method === 'arc' && call.args[0] === 220 && call.args[1] === 170),
    false
  );
  assert.equal(
    ctx.calls.some(call => call.method === 'arc' && call.args[0] === 50 && call.args[1] === 60),
    true
  );
});

test('detection overlay still draws selectable detection boxes and labels', () => {
  const ctx = createContext();

  renderDetectionOverlay(ctx, {
    mode: 'detection',
    detections: [
      { x1: 10, y1: 20, x2: 110, y2: 140, className: 'bottle', confidence: 0.91 },
    ],
  });

  assert.ok(ctx.calls.some(call => call.method === 'strokeRect' && call.args[0] === 10));
  assert.ok(ctx.calls.some(call => call.method === 'fillText' && /bottle \(91%\)/.test(call.args[0])));
});
