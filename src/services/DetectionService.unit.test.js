import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionService } from './DetectionService.js';

test('detection frames are packaged as transferable typed arrays', () => {
  const service = new DetectionService();
  const imageData = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])
  };

  const { message, transferList } = service._createDetectionMessage(imageData);

  assert.equal(message.type, 'detect');
  assert.equal(message.imageData.width, 2);
  assert.equal(message.imageData.height, 1);
  assert.ok(message.imageData.data instanceof Uint8ClampedArray);
  assert.deepEqual(Array.from(message.imageData.data), Array.from(imageData.data));
  assert.deepEqual(transferList, [message.imageData.data.buffer]);
});
