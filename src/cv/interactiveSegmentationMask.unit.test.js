import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractiveObjectSupportMask } from './interactiveSegmentationMask.js';
import { isPointInsideObjectSupport } from './objectSupportMask.js';

test('interactive segmentation confidence mask is resized and thresholded into frame support', () => {
  const mask = createInteractiveObjectSupportMask({
    confidenceData: new Float32Array([0.1, 0.9, 0.2, 0.8]),
    maskWidth: 2,
    maskHeight: 2,
    frameWidth: 4,
    frameHeight: 4,
    threshold: 0.5,
    referencePoint: { x: 3, y: 1 },
    createdAtFrame: 6,
  });

  assert.equal(mask.source, 'interactive-segmenter');
  assert.equal(Number(mask.confidence.toFixed(2)), 0.85);
  assert.deepEqual(mask.bbox, { x: 2, y: 0, width: 2, height: 4 });
  assert.equal(isPointInsideObjectSupport(mask, { x: 3, y: 1 }), true);
  assert.equal(isPointInsideObjectSupport(mask, { x: 1, y: 1 }), false);
});

test('confidence belongs only to the selected component, not a disconnected confident distractor', () => {
  const mask = createInteractiveObjectSupportMask({
    confidenceData: new Float32Array([0.51, 0.1, 0.99, 0.99, 0.99]),
    maskWidth: 5,
    maskHeight: 1,
    frameWidth: 10,
    frameHeight: 2,
    threshold: 0.5,
    referencePoint: { x: 0, y: 0 },
    createdAtFrame: 1,
  });
  assert.ok(Math.abs(mask.confidence - 0.51) < 1e-6);
  assert.deepEqual(mask.bbox, { x: 0, y: 0, width: 2, height: 2 });
});

test('an empty selected component cannot borrow confidence from foreground elsewhere', () => {
  const mask = createInteractiveObjectSupportMask({
    confidenceData: new Float32Array([0.1, 0.1, 0.99]),
    maskWidth: 3,
    maskHeight: 1,
    frameWidth: 3,
    frameHeight: 1,
    threshold: 0.5,
    referencePoint: { x: 0, y: 0 },
    createdAtFrame: 1,
  });
  assert.equal(mask.confidence, 0);
  assert.equal(
    mask.data.some((value) => value > 0),
    false,
  );
});

test('segmentation preserves the entire connected object, not a circle around the prompt', () => {
  const mask = createInteractiveObjectSupportMask({
    confidenceData: new Float32Array([0.51, 0.51, 0.99, 0.99, 0.99]),
    maskWidth: 5,
    maskHeight: 1,
    frameWidth: 5,
    frameHeight: 1,
    threshold: 0.5,
    referencePoint: { x: 0, y: 0 },
    createdAtFrame: 1,
  });
  assert.ok(Math.abs(mask.confidence - 0.798) < 1e-6);
  assert.equal(mask.pixelCount, 5);
});
