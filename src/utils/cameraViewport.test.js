import test from 'node:test';
import assert from 'node:assert/strict';
import * as cameraViewport from './cameraViewport.js';

const round = (value) => Number(value.toFixed(3));

test('maps a pointer at the cropped viewport edge to the visible source edge', () => {
  assert.equal(typeof cameraViewport.viewportPointToSource, 'function');

  const sourceWidth = 1280;
  const sourceHeight = 720;
  const viewportWidth = 390;
  const viewportHeight = 844;
  const transform = cameraViewport.createCameraViewportTransform({
    sourceWidth,
    sourceHeight,
    viewportWidth,
    viewportHeight,
  });
  const sourcePoint = cameraViewport.viewportPointToSource({
    point: { x: 0, y: viewportHeight / 2 },
    transform,
  });
  const expectedVisibleSourceLeft = (sourceWidth - viewportWidth / transform.scale) / 2;

  assert.deepEqual(
    { x: round(sourcePoint.x), y: round(sourcePoint.y) },
    { x: round(expectedVisibleSourceLeft), y: sourceHeight / 2 },
  );
});

test('mirrored presentation and pointer inversion share the same transform', () => {
  const transform = cameraViewport.createCameraViewportTransform({
    sourceWidth: 1280,
    sourceHeight: 720,
    viewportWidth: 1280,
    viewportHeight: 720,
    mirrored: true,
  });
  const sourcePoint = { x: 200, y: 320 };
  const viewportPoint = cameraViewport.sourcePointToViewport({ point: sourcePoint, transform });

  assert.deepEqual(viewportPoint, { x: 1080, y: 320 });
  assert.deepEqual(cameraViewport.viewportPointToSource({ point: viewportPoint, transform }), sourcePoint);
});
