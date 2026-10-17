import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureCameraFrame,
  getCurrentObjectCaptureRegion,
  shouldCaptureCameraFrame,
} from './cameraFrameCapture.js';

const createCaptureState = () => ({
  sampledAt: 100,
  activeAnchor: { selectionRegion: { x1: 10, y1: 20, x2: 50, y2: 70 } },
  anchorState: {
    anchored: true,
    state: 'tracking',
    position: { x: 200, y: 180 },
    normal: { x: 0, y: 0, z: 1 },
    metrics: {
      targetPresent: true,
      poseSource: 'planar-homography',
      readiness: { poseReady: true, attachmentReady: true, faceReady: true },
      currentObjectSupportMaskBounds: { x: 100, y: 80, width: 200, height: 240 },
    },
  },
});

test('object capture follows the current outline rather than the original selection rectangle', () => {
  const state = createCaptureState();
  assert.deepEqual(getCurrentObjectCaptureRegion(state, 200), { x: 100, y: 80, width: 200, height: 240 });
  state.anchorState.metrics.currentObjectSupportMaskBounds.x = 200;
  assert.equal(getCurrentObjectCaptureRegion(state, 250).x, 200);
  state.anchorState.metrics.readiness.faceReady = false;
  assert.equal(
    getCurrentObjectCaptureRegion(state, 250).x,
    200,
    'object capture does not require a renderable face',
  );
});

test('object capture rejects stale, lost and missing outline evidence instead of inventing a crop', () => {
  const state = createCaptureState();
  assert.throws(() => getCurrentObjectCaptureRegion(state, 401), /fresh tracking/);
  assert.throws(() => getCurrentObjectCaptureRegion(state, 99), /fresh tracking/);
  state.observationExpired = true;
  assert.throws(() => getCurrentObjectCaptureRegion(state, 200), /fresh tracking/);
  state.observationExpired = false;
  state.anchorState.metrics.targetPresent = false;
  assert.throws(() => getCurrentObjectCaptureRegion(state, 200), /fresh tracking/);
  state.anchorState.metrics.targetPresent = true;
  for (const bounds of [
    null,
    {},
    { x: 0, y: 0, width: 0, height: 20 },
    { x: -1, y: 0, width: 20, height: 20 },
    { x: 0, y: NaN, width: 20, height: 20 },
  ]) {
    state.anchorState.metrics.currentObjectSupportMaskBounds = bounds;
    assert.throws(() => getCurrentObjectCaptureRegion(state, 200), /outline is unavailable/);
  }
});

test('discovery captures only admitted scheduled frames before the tap', () => {
  for (let frame = 0; frame < 120; frame++) {
    assert.equal(
      shouldCaptureCameraFrame({
        mode: 'selection',
        shouldUpdateAnchor: true,
        shouldRefreshSegmentation: true,
        canProcess: frame % 15 === 0,
      }),
      frame % 15 === 0,
    );
  }
});

test('camera capture stays in sensor coordinates when presentation is mirrored', () => {
  const calls = [];
  const imageData = { width: 1280, height: 720 };
  const context = {
    setTransform: (...args) => calls.push(['setTransform', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
    getImageData: (...args) => {
      calls.push(['getImageData', ...args]);
      return imageData;
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  };
  const video = { videoWidth: 1280, videoHeight: 720 };

  const captured = captureCameraFrame({ video, canvas, context: null, mirrored: true });

  assert.equal(captured.context, context);
  assert.equal(captured.imageData, imageData);
  assert.deepEqual(calls, [
    ['setTransform', 1, 0, 0, 1, 0, 0],
    ['drawImage', video, 0, 0, 1280, 720],
    ['getImageData', 0, 0, 1280, 720],
  ]);
});

test('tracking captures only when scheduled work owns the frame gate', () => {
  assert.equal(
    shouldCaptureCameraFrame({
      mode: 'anchor',
      shouldUpdateAnchor: false,
      shouldRefreshSegmentation: false,
      canProcess: true,
    }),
    false,
  );
  assert.equal(
    shouldCaptureCameraFrame({
      mode: 'anchor',
      shouldUpdateAnchor: true,
      shouldRefreshSegmentation: false,
      canProcess: false,
    }),
    false,
  );
  assert.equal(
    shouldCaptureCameraFrame({
      mode: 'anchor',
      shouldUpdateAnchor: true,
      shouldRefreshSegmentation: false,
      canProcess: true,
    }),
    true,
  );
});
