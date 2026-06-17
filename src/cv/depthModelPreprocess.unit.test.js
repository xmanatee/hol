import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDepthValues,
  postprocessDepthTensor,
  preprocessDepthImageData,
} from './depthModelPreprocess.js';

test('depth preprocessing letterboxes image data into normalized NCHW tensor', () => {
  const imageData = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
    ]),
  };

  const result = preprocessDepthImageData(imageData, { inputSize: 4 });

  assert.deepEqual(result.dims, [1, 3, 4, 4]);
  assert.equal(result.resizedWidth, 4);
  assert.equal(result.resizedHeight, 2);
  assert.equal(result.padY, 1);
  assert.equal(result.tensor.length, 48);
  assert.equal(result.tensor[0], 0);
  assert.ok(result.tensor[4] > 2.2);
  assert.ok(result.tensor[4 + 16] < -2);
});

test('depth postprocessing normalizes tensor output back to source dimensions', () => {
  const tensor = {
    dims: [1, 1, 2, 2],
    data: new Float32Array([0, 1, 2, 3]),
  };
  const preprocessInfo = {
    inputSize: 2,
    originalWidth: 2,
    originalHeight: 2,
    scale: 1,
    padX: 0,
    padY: 0,
  };

  const result = postprocessDepthTensor(tensor, preprocessInfo);

  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  assert.deepEqual([...result.data].map(value => Number(value.toFixed(3))), [0, 0.333, 0.667, 1]);
});

test('depth normalization ignores non-finite model outputs', () => {
  const result = normalizeDepthValues(new Float32Array([4, Number.NaN, 8, Infinity]));

  assert.deepEqual([...result], [0, 0, 1, 0]);
});
