import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeAnnotatedVisionRgbDeltaInPlace } from './annotatedVisionFrameCodec.js';

test('annotated RGB temporal deltas reconstruct every frame exactly in place', () => {
  const encoded = new Uint8Array([1, 2, 3, 4, 5, 6, 6, 2, 2, 12, 12, 12, 4, 4, 12, 8, 8, 8]);

  const decoded = decodeAnnotatedVisionRgbDeltaInPlace(encoded, {
    frameByteLength: 6,
    frameCount: 3,
  });

  assert.equal(decoded, encoded);
  assert.deepEqual(decoded, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 0, 1, 8, 9, 10, 3, 4, 13, 0, 1, 2]));
});

test('annotated RGB temporal decoder rejects ambiguous payload shapes before mutation', () => {
  for (const [bytes, options, message] of [
    [new Uint8Array(5), { frameByteLength: 3, frameCount: 2 }, /must contain exactly 6 bytes/],
    [new Uint8Array(6), { frameByteLength: 0, frameCount: 2 }, /frameByteLength must be positive/],
    [new Uint8Array(6), { frameByteLength: 3, frameCount: 1 }, /frameCount must be at least 2/],
    [[1, 2, 3, 4, 5, 6], { frameByteLength: 3, frameCount: 2 }, /bytes must be a Uint8Array/],
  ]) {
    assert.throws(() => decodeAnnotatedVisionRgbDeltaInPlace(bytes, options), message);
  }
});
