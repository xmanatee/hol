import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnchorWorkerSnapshot } from './anchorWorkerSnapshot.js';

const createWorkerState = () => {
  const objectSupportMask = {
    width: 1280,
    height: 720,
    data: new Uint8Array(1280 * 720),
    source: 'interactive-segmenter',
    confidence: 0.91,
    referencePoint: { x: 640, y: 360 },
    bbox: { x: 400, y: 220, width: 480, height: 310 },
  };

  return {
    mode: 'anchor',
    activeAnchor: {
      createdAt: 12,
      position: { x: 640, y: 360, z: 0 },
      selectionRegion: {
        surfaceHint: 'cup',
        confidence: 0.88,
        x1: 400,
        y1: 220,
        x2: 880,
        y2: 530,
        objectSupportMask,
      },
    },
    anchorState: {
      anchored: true,
      state: 'tracking',
      metrics: {
        currentObjectSupportMaskPreview: {
          bbox: objectSupportMask.bbox,
          points: [{ x: 400, y: 220 }],
        },
      },
    },
    trackingMode: 'sparse-reconstruction',
    initialized: true,
  };
};

test('anchor worker snapshots keep UI mask evidence without cloning worker-owned mask pixels', () => {
  const state = createWorkerState();
  const sourceMask = state.activeAnchor.selectionRegion.objectSupportMask;
  const snapshot = createAnchorWorkerSnapshot(state);
  const snapshotMask = snapshot.activeAnchor.selectionRegion.objectSupportMask;

  assert.equal(sourceMask.data.byteLength, 1280 * 720);
  assert.equal('data' in snapshotMask, false);
  assert.deepEqual(snapshotMask.bbox, sourceMask.bbox);
  assert.equal(snapshotMask.source, 'interactive-segmenter');
  assert.equal(snapshot.activeAnchor.selectionRegion.surfaceHint, 'cup');
  assert.deepEqual(snapshot.anchorState.metrics.currentObjectSupportMaskPreview.points, [{ x: 400, y: 220 }]);
});
