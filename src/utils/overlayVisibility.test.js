import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRenderableAnchorOverlay,
  shouldMountOverlayScene,
  shouldRenderAnchorOverlay,
} from './overlayVisibility.js';

test('renders sparse reconstruction overlay when planar homography is the active pose source', () => {
  assert.equal(
    shouldRenderAnchorOverlay({
      activeAnchor: { id: 'anchor' },
      anchorState: {
        metrics: {
          poseModel: 'sparse-reconstruction',
          reconstructionReady: false,
          poseSource: 'planar-homography',
        },
      },
    }),
    true,
  );
});

test('hides sparse reconstruction overlay while no stable pose source is ready', () => {
  assert.equal(
    shouldRenderAnchorOverlay({
      activeAnchor: { id: 'anchor' },
      anchorState: {
        state: 'mapping',
        metrics: {
          poseModel: 'sparse-reconstruction',
          reconstructionReady: false,
          poseSource: 'sparse-reconstruction',
        },
      },
    }),
    false,
  );
});

test('hides progressive candidate and mapping overlays until readiness is proven', () => {
  for (const state of ['candidate', 'mapping']) {
    assert.equal(
      shouldRenderAnchorOverlay({
        activeAnchor: { id: 'anchor' },
        anchorState: {
          state,
          metrics: {
            poseModel: 'sparse-reconstruction',
            reconstructionReady: false,
            poseSource: null,
          },
        },
      }),
      false,
      state,
    );
  }
});

test('hides progressive overlays when service metrics have not caught up yet', () => {
  assert.equal(
    shouldRenderAnchorOverlay({
      activeAnchor: {
        id: 'anchor',
        state: 'candidate',
        readiness: {
          faceReady: false,
          reason: 'Build more object landmarks before showing the face',
        },
      },
      anchorState: null,
    }),
    false,
  );
});

test('renders any reconstruction overlay once the selected map is ready', () => {
  for (const poseModel of ['parametric-surface', 'direct-photometric']) {
    assert.equal(
      shouldRenderAnchorOverlay({
        activeAnchor: { id: 'anchor' },
        anchorState: {
          metrics: {
            poseModel,
            reconstructionReady: true,
            poseSource: poseModel,
          },
        },
      }),
      true,
      poseModel,
    );
  }
});

test('hides reconstruction overlay when attachment readiness is explicitly blocked', () => {
  assert.equal(
    shouldRenderAnchorOverlay({
      activeAnchor: { id: 'anchor' },
      anchorState: {
        state: 'stable',
        metrics: {
          poseModel: 'parametric-surface',
          reconstructionReady: true,
          poseSource: 'parametric-surface',
          readiness: {
            faceReady: true,
            poseReady: true,
            surfaceReady: true,
            attachmentReady: false,
            reason: 'Recovering object pose before showing the face',
          },
        },
      },
    }),
    false,
  );
});

test('hides every pose model when target presence is explicitly lost', () => {
  for (const poseModel of [
    'homography',
    'sparse-reconstruction',
    'parametric-surface',
    'direct-photometric',
  ]) {
    assert.equal(
      shouldRenderAnchorOverlay({
        activeAnchor: { id: 'anchor' },
        anchorState: {
          state: 'tracking',
          metrics: {
            targetPresent: false,
            poseModel,
            reconstructionReady: true,
            poseSource: poseModel,
            readiness: { faceReady: true, attachmentReady: true },
          },
        },
      }),
      false,
      poseModel,
    );
  }
});

test('hides reconstruction overlay when the map is ready but current pose is unavailable', () => {
  assert.equal(
    shouldRenderAnchorOverlay({
      activeAnchor: { id: 'anchor' },
      anchorState: {
        state: 'tracking',
        metrics: {
          poseModel: 'parametric-surface',
          reconstructionReady: true,
          poseSource: null,
        },
      },
    }),
    false,
  );
});

test('hides any reconstruction overlay while selected map has no stable pose source', () => {
  for (const poseModel of ['parametric-surface', 'direct-photometric']) {
    assert.equal(
      shouldRenderAnchorOverlay({
        activeAnchor: { id: 'anchor' },
        anchorState: {
          metrics: {
            poseModel,
            reconstructionReady: false,
            poseSource: poseModel,
          },
        },
      }),
      false,
      poseModel,
    );
  }
});

test('keeps the overlay scene unmounted until the camera and anchor have proven readiness', () => {
  const activeAnchor = { id: 'anchor', overlaySceneReady: false };
  const anchorState = {
    metrics: {
      poseModel: 'sparse-reconstruction',
      reconstructionReady: false,
      poseSource: 'planar-homography',
    },
  };

  assert.equal(
    shouldMountOverlayScene({
      cameraState: 'idle',
      activeAnchor,
      anchorState,
    }),
    false,
  );
  assert.equal(
    shouldMountOverlayScene({
      cameraState: 'active',
      activeAnchor: null,
      anchorState,
    }),
    false,
  );
  assert.equal(
    shouldMountOverlayScene({
      cameraState: 'active',
      activeAnchor: { ...activeAnchor, overlaySceneReady: true },
      anchorState,
    }),
    true,
  );
  assert.equal(
    getRenderableAnchorOverlay({
      activeAnchor,
      anchorState,
    }),
    activeAnchor,
  );
});

test('keeps one expensive overlay runtime alive across pose dropouts for a proven anchor', () => {
  const readyAnchor = { id: 'anchor', createdAt: 100, overlaySceneReady: true };
  assert.equal(
    shouldMountOverlayScene({
      cameraState: 'active',
      activeAnchor: readyAnchor,
    }),
    true,
  );
  assert.equal(
    shouldMountOverlayScene({
      cameraState: 'active',
      activeAnchor: { id: 'next-anchor', createdAt: 200, overlaySceneReady: false },
    }),
    false,
  );
  assert.equal(
    shouldMountOverlayScene({
      cameraState: 'active',
      activeAnchor: null,
    }),
    false,
  );
});
