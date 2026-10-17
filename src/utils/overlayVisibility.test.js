import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRenderableAnchorOverlay,
  isFaceObservationReady,
  shouldMountOverlayScene,
  shouldRenderAnchorOverlay,
} from './overlayVisibility.js';
import { OBJECT_POSE_MODEL, RECONSTRUCTION_MODE_IDS } from '../cv/anchor.reconstructionModes.js';

const readyState = () => ({
  anchored: true,
  state: 'tracking',
  position: { x: 120, y: 80, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  metrics: {
    targetPresent: true,
    poseSource: 'planar-homography',
    readiness: { poseReady: true, attachmentReady: true, faceReady: true },
  },
});

test('selection and rendering require the same positive observation for every tracking mode', () => {
  for (const poseModel of [OBJECT_POSE_MODEL, ...RECONSTRUCTION_MODE_IDS]) {
    for (const state of ['tracking', 'stable']) {
      const anchorState = readyState();
      anchorState.state = state;
      anchorState.metrics.poseModel = poseModel;
      assert.equal(isFaceObservationReady(anchorState), true, poseModel);
      assert.equal(shouldRenderAnchorOverlay({ activeAnchor: {}, anchorState }), true);
      assert.equal(shouldRenderAnchorOverlay({ activeAnchor: null, anchorState }), false);
    }
  }
});

test('no absent, false, or truthy non-boolean permission authorizes a face', () => {
  for (const value of [undefined, null, false, 1, 'true']) {
    const observations = [
      { ...readyState(), anchored: value },
      { ...readyState(), metrics: null },
      ...['targetPresent', 'readiness'].map((field) => {
        const state = readyState();
        state.metrics[field] = value;
        return state;
      }),
      ...['poseReady', 'attachmentReady', 'faceReady'].map((field) => {
        const state = readyState();
        state.metrics.readiness[field] = value;
        return state;
      }),
    ];
    for (const anchorState of observations) {
      assert.equal(isFaceObservationReady(anchorState), false);
    }
  }
  for (const poseSource of [undefined, null, false, 1, '']) {
    const state = readyState();
    state.metrics.poseSource = poseSource;
    assert.equal(isFaceObservationReady(state), false);
  }
});

test('historical readiness, a reconstructed map, and pose names cannot replace current authorization', () => {
  const activeAnchor = {
    position: { x: 120, y: 80 },
    state: 'stable',
    trackingMode: 'object-pose',
    readiness: readyState().metrics.readiness,
    diagnostics: readyState().metrics,
  };
  for (const anchorState of [null, {}, { ...readyState(), metrics: {} }]) {
    assert.equal(shouldRenderAnchorOverlay({ activeAnchor, anchorState }), false);
  }
  for (const poseModel of [OBJECT_POSE_MODEL, ...RECONSTRUCTION_MODE_IDS]) {
    const anchorState = readyState();
    Object.assign(anchorState.metrics, { poseModel, poseSource: poseModel, reconstructionReady: true });
    delete anchorState.metrics.readiness;
    assert.equal(shouldRenderAnchorOverlay({ activeAnchor, anchorState }), false);
  }
});

test('incomplete geometry and non-tracking states hide every rendering path', () => {
  for (const state of [null, 'candidate', 'mapping', 'degraded', 'lost', 'inactive', 'unknown']) {
    assert.equal(isFaceObservationReady({ ...readyState(), state }), false);
  }
  for (const field of ['position', 'normal']) {
    for (const value of [null, {}, { x: NaN, y: 80, z: 1 }, { x: 120, y: Infinity, z: 1 }]) {
      assert.equal(isFaceObservationReady({ ...readyState(), [field]: value }), false);
    }
  }
  assert.equal(isFaceObservationReady({ ...readyState(), normal: { x: 0, y: 0 } }), false);
  assert.equal(isFaceObservationReady({ ...readyState(), normal: { x: 0, y: 0, z: 0 } }), false);
});

test('a ready face expires with its source observation, not its last successful render', () => {
  const state = { sampledAt: 100, activeAnchor: { id: 'subject' }, anchorState: readyState() };
  assert.equal(getRenderableAnchorOverlay(state, 100), state.activeAnchor);
  assert.equal(getRenderableAnchorOverlay(state, 400), state.activeAnchor);
  assert.equal(getRenderableAnchorOverlay(state, 401), null);
  assert.equal(getRenderableAnchorOverlay(state, 99), null);
  for (const sampledAt of [null, undefined, NaN, Infinity]) {
    assert.equal(getRenderableAnchorOverlay({ ...state, sampledAt }, 200), null);
  }
});

test('the expensive scene mounts only for a proven anchor and survives temporary pose loss', () => {
  for (const cameraState of ['idle', 'active']) {
    for (const overlaySceneReady of [false, true]) {
      const activeAnchor = { id: 'subject', overlaySceneReady };
      assert.equal(
        shouldMountOverlayScene({ cameraState, activeAnchor }),
        cameraState === 'active' && overlaySceneReady,
      );
    }
  }
  assert.equal(shouldMountOverlayScene({ cameraState: 'active', activeAnchor: null }), false);
  const readyAnchor = { id: 'subject', overlaySceneReady: true };
  const anchorState = { ...readyState(), state: 'lost' };
  assert.equal(
    shouldMountOverlayScene({ cameraState: 'active', activeAnchor: readyAnchor, anchorState }),
    true,
  );
  assert.equal(
    getRenderableAnchorOverlay({ activeAnchor: readyAnchor, anchorState, sampledAt: 100 }, 200),
    null,
  );
});
