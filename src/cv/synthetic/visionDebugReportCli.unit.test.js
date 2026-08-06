import test from 'node:test';
import assert from 'node:assert/strict';

import { debugReportUsesBenchmarkMatrix, selectedDebugFrameIndexes } from './visionDebugReportCli.js';

test('debug report uses benchmark matrix when filters or matrix size are explicit', () => {
  assert.equal(debugReportUsesBenchmarkMatrix(), false);
  assert.equal(debugReportUsesBenchmarkMatrix({ size: 'representative', filters: {} }), false);
  assert.equal(debugReportUsesBenchmarkMatrix({ size: 'quick', filters: {} }), true);
  assert.equal(
    debugReportUsesBenchmarkMatrix({ size: 'representative', filters: { object: 'handled-mug' } }),
    true,
  );
});

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
