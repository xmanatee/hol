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
