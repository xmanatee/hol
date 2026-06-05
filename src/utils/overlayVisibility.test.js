import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRenderAnchorOverlay } from './overlayVisibility.js';

test('renders sparse reconstruction overlay when planar homography is the active pose source', () => {
  assert.equal(shouldRenderAnchorOverlay({
    activeAnchor: { id: 'anchor' },
    anchorState: {
      metrics: {
        poseModel: 'sparse-reconstruction',
        reconstructionReady: false,
        poseSource: 'planar-homography',
      }
    }
  }), true);
});

test('hides sparse reconstruction overlay while no stable pose source is ready', () => {
  assert.equal(shouldRenderAnchorOverlay({
    activeAnchor: { id: 'anchor' },
    anchorState: {
      metrics: {
        poseModel: 'sparse-reconstruction',
        reconstructionReady: false,
        poseSource: 'sparse-reconstruction',
      }
    }
  }), false);
});
