import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSegmentationInput,
  getSegmentationBackend,
  listSegmentationBackends,
} from './segmentationBackend.js';

const input = () => ({
  imageData: { width: 4, height: 3, data: new Uint8ClampedArray(48) },
  tapPosition: { x: 2, y: 1 },
  createdAtFrame: 0,
});

test('backend selection is explicit, immutable and distinguishes WebGL from WebGPU', () => {
  assert.deepEqual(
    listSegmentationBackends().map(({ id }) => id),
    ['mediapipe-wasm', 'mediapipe-webgl'],
  );
  assert.equal(getSegmentationBackend('mediapipe-wasm').delegate, 'CPU');
  assert.equal(getSegmentationBackend('mediapipe-webgl').execution, 'webgl');
  assert.ok(Object.isFrozen(getSegmentationBackend('mediapipe-webgl')));
  for (const id of [
    'auto',
    'webgpu',
    null,
    undefined,
    '__proto__',
    ['mediapipe-wasm'],
    { toString: () => 'mediapipe-wasm' },
    Symbol('mediapipe-wasm'),
  ])
    assert.throws(() => getSegmentationBackend(id), /Unsupported/);
});

test('all segmentation backends reject malformed frames and fractional out-of-raster points before inference', () => {
  assert.doesNotThrow(() => assertSegmentationInput(input()));
  for (const imageData of [
    { width: 4.5, height: 3, data: new Uint8ClampedArray(48) },
    { width: 4, height: 3, data: new Uint8Array(48) },
    { width: 4, height: 3, data: new Uint8ClampedArray(44) },
    { width: 4096, height: 4096, data: new Uint8ClampedArray(0) },
  ])
    assert.throws(() => assertSegmentationInput({ ...input(), imageData }));
  for (const tapPosition of [
    { x: -0.1, y: 0 },
    { x: 4, y: 1 },
    { x: 1, y: 3 },
    { x: NaN, y: 0 },
  ]) {
    assert.throws(() => assertSegmentationInput({ ...input(), tapPosition }), /point/);
  }
  for (const createdAtFrame of [-1, 0.2, Infinity])
    assert.throws(() => assertSegmentationInput({ ...input(), createdAtFrame }), /frame ID/);
});
