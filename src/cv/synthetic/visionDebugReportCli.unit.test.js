import test from 'node:test';
import assert from 'node:assert/strict';

import { selectedDebugFrameIndexes } from './visionDebugReportCli.js';

test('debug report samples stable checkpoints and worst diagnostic frames once', () => {
  assert.deepEqual(
    selectedDebugFrameIndexes({
      frameCount: 44,
      trackingWorstFrames: [{ index: 13 }, { index: 22 }],
      headWorstFrames: [{ index: 22 }, { index: 40 }],
    }),
    [1, 11, 13, 22, 33, 40, 44],
  );
});
