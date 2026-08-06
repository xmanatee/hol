import test from 'node:test';
import assert from 'node:assert/strict';

import { loadOpenCvForNode } from './opencvNodeLoader.js';

test('Node OpenCV loading does not mutate process-level error ownership', async () => {
  const uncaughtBefore = process.listeners('uncaughtException');
  const rejectionBefore = process.listeners('unhandledRejection');

  const cv = await loadOpenCvForNode();

  assert.equal(typeof cv.calcOpticalFlowPyrLK, 'function');
  assert.deepEqual(process.listeners('uncaughtException'), uncaughtBefore);
  assert.deepEqual(process.listeners('unhandledRejection'), rejectionBefore);
});
