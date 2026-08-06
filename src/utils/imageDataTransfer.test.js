import test from 'node:test';
import assert from 'node:assert/strict';

import { copyImageData, prepareImageDataTransfer } from './imageDataTransfer.js';

const createImageData = () => ({
  width: 2,
  height: 1,
  data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]),
});

test('image-data copy owns an independent pixel buffer', () => {
  const source = createImageData();
  const copy = copyImageData(source);

  assert.notEqual(copy.data.buffer, source.data.buffer);
  assert.deepEqual(Array.from(copy.data), Array.from(source.data));
});

test('image-data transfer moves the existing pixel buffer without copying', () => {
  const source = createImageData();
  const sourceBuffer = source.data.buffer;
  const transfer = prepareImageDataTransfer(source);

  assert.equal(transfer.imageData.data, source.data);
  assert.deepEqual(transfer.transferList, [sourceBuffer]);

  const received = structuredClone(transfer.imageData, { transfer: transfer.transferList });
  assert.equal(sourceBuffer.byteLength, 0);
  assert.deepEqual(Array.from(received.data), [1, 2, 3, 255, 4, 5, 6, 255]);
});
