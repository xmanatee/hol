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
      state: 'mapping',
      metrics: {
        poseModel: 'sparse-reconstruction',
        reconstructionReady: false,
        poseSource: 'sparse-reconstruction',
      }
    }
  }), false);
});

test('hides progressive candidate and mapping overlays until readiness is proven', () => {
  for (const state of ['candidate', 'mapping']) {
    assert.equal(shouldRenderAnchorOverlay({
      activeAnchor: { id: 'anchor' },
      anchorState: {
        state,
        metrics: {
          poseModel: 'sparse-reconstruction',
          reconstructionReady: false,
          poseSource: null,
        }
      }
    }), false, state);
  }
});

test('hides progressive overlays when service metrics have not caught up yet', () => {
  assert.equal(shouldRenderAnchorOverlay({
    activeAnchor: {
      id: 'anchor',
      state: 'candidate',
      readiness: {
        faceReady: false,
        reason: 'Build more object landmarks before showing the face',
      },
    },
    anchorState: null,
  }), false);
});

test('renders any reconstruction overlay once the selected map is ready', () => {
  for (const poseModel of ['parametric-surface', 'direct-photometric']) {
    assert.equal(shouldRenderAnchorOverlay({
      activeAnchor: { id: 'anchor' },
      anchorState: {
        metrics: {
          poseModel,
          reconstructionReady: true,
          poseSource: poseModel,
        }
      }
    }), true, poseModel);
  }
});

test('hides any reconstruction overlay while selected map has no stable pose source', () => {
  for (const poseModel of ['parametric-surface', 'direct-photometric']) {
    assert.equal(shouldRenderAnchorOverlay({
      activeAnchor: { id: 'anchor' },
      anchorState: {
        metrics: {
          poseModel,
          reconstructionReady: false,
          poseSource: poseModel,
        }
      }
    }), false, poseModel);
  }
});
