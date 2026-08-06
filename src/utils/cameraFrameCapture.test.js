import test from 'node:test';
import assert from 'node:assert/strict';

import { captureCameraFrame, shouldCaptureCameraFrame } from './cameraFrameCapture.js';

test('selection-mode presentation never captures a frame without an admitted tap', () => {
  for (let frame = 0; frame < 120; frame++) {
    assert.equal(
      shouldCaptureCameraFrame({
        mode: 'selection',
        shouldUpdateAnchor: true,
        shouldRefreshSegmentation: true,
        canProcess: true,
      }),
      false,
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
