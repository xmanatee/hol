import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISION_CROP_MAX_EDGE,
  VISION_IMAGE_MAX_BYTES,
  assertVisionImageBlob,
  assertVisionImageData,
  resolveVisionCrop,
} from './visionImage.js';

test('vision crop clips padded edge regions without changing their aspect ratio', () => {
  assert.deepEqual(resolveVisionCrop({ x: 90, y: 70, width: 20, height: 20 }, 100, 80), {
    sourceX: 88,
    sourceY: 68,
    sourceWidth: 12,
    sourceHeight: 12,
    outputWidth: 12,
    outputHeight: 12,
  });
});

test('vision crop downsizes large regions once while preserving aspect ratio', () => {
  assert.deepEqual(resolveVisionCrop({ x: 0, y: 0, width: 2000, height: 1000 }, 2000, 1000), {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: 2000,
    sourceHeight: 1000,
    outputWidth: VISION_CROP_MAX_EDGE,
    outputHeight: VISION_CROP_MAX_EDGE / 2,
  });
});

test('vision crop rejects ambiguous, malformed, and off-frame regions', () => {
  assert.throws(() => resolveVisionCrop({ x1: 0, y1: 0, x2: 20, y2: 20 }, 100, 80), /unsupported field: x1/);
  assert.throws(
    () => resolveVisionCrop({ x: 0, y: 0, width: 20, height: 20, x1: 0 }, 100, 80),
    /unsupported field: x1/,
  );
  assert.throws(
    () => resolveVisionCrop({ x: 0, y: 0, width: 0, height: 20 }, 100, 80),
    /width must be a positive finite number/,
  );
  assert.throws(
    () => resolveVisionCrop({ x: Number.NaN, y: 0, width: 20, height: 20 }, 100, 80),
    /x must be a finite number/,
  );
  assert.throws(
    () => resolveVisionCrop({ x: 120, y: 90, width: 20, height: 20 }, 100, 80),
    /must intersect the image/,
  );
  assert.throws(
    () => resolveVisionCrop({ x: 0, y: 0, width: 20, height: 20 }, 0, 80),
    /image width must be a positive safe integer/,
  );
});

test('vision image blobs have one explicit JPEG and byte-budget contract', () => {
  const valid = new Blob(['jpeg'], { type: 'image/jpeg' });
  assert.equal(assertVisionImageBlob(valid), valid);
  assert.throws(() => assertVisionImageBlob({}), /must be a Blob/);
  assert.throws(() => assertVisionImageBlob(new Blob([], { type: 'image/jpeg' })), /must not be empty/);
  assert.throws(
    () => assertVisionImageBlob(new Blob(['png'], { type: 'image/png' })),
    /must use image\/jpeg/,
  );
  assert.throws(
    () =>
      assertVisionImageBlob(new Blob([new Uint8Array(VISION_IMAGE_MAX_BYTES + 1)], { type: 'image/jpeg' })),
    /exceeds the 2097152-byte limit/,
  );
});

test('vision source pixels require one exact 8-bit RGBA ImageData layout', () => {
  const valid = { width: 2, height: 3, data: new Uint8ClampedArray(24) };
  assert.equal(assertVisionImageData(valid), valid);
  assert.throws(() => assertVisionImageData(null), /must be an ImageData object/);
  assert.throws(
    () => assertVisionImageData({ width: 2, height: 3, data: new Uint8Array(24) }),
    /must be a Uint8ClampedArray/,
  );
  assert.throws(
    () => assertVisionImageData({ width: 2, height: 3, data: new Uint8ClampedArray(23) }),
    /exactly 24 bytes/,
  );
});
