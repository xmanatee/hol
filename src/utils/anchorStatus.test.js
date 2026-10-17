import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAnchorStatus } from './anchorStatus.js';

const ACTIVE_SELECTION = {
  cameraState: 'active',
  anchorSystemState: {
    mode: 'selection',
    initialized: true,
    activeAnchor: null,
    anchorState: null,
  },
};

const describeTrackedState = ({ state, metrics = {}, initialized = true }) =>
  describeAnchorStatus({
    cameraState: 'active',
    anchorSystemState: {
      mode: 'anchor',
      initialized,
      activeAnchor: { createdAt: 1 },
      anchorState: {
        anchored: true,
        state,
        position: { x: 120, y: 80, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        metrics,
      },
    },
  });

test('returns a compact status record for the permanent HUD', () => {
  assert.deepEqual(describeAnchorStatus(ACTIVE_SELECTION), {
    status: 'searching',
    severity: 'idle',
    message: 'Point the camera at an object',
    recommendation: 'Keep one object near the center until its outline turns green.',
  });
});

test('describes camera and initialization boundaries before anchor state', () => {
  assert.deepEqual(describeAnchorStatus({ ...ACTIVE_SELECTION, cameraState: 'blocked' }), {
    status: 'camera',
    severity: 'idle',
    message: 'Camera is not active',
    recommendation: 'Start the camera before checking anchors.',
  });
  assert.deepEqual(describeTrackedState({ state: null, initialized: false }), {
    status: 'initializing',
    severity: 'idle',
    message: 'Loading on-device vision',
    recommendation: 'First use downloads the tracking engine and object model. Keep this tab open.',
  });
});

test('vision failures take precedence over initialization and previous tracking success', () => {
  for (const initialized of [false, true]) {
    const status = describeAnchorStatus({
      cameraState: 'active',
      anchorSystemState: {
        initialized,
        error: 'Model download failed',
        mode: 'anchor',
        anchorState: { state: 'stable' },
      },
    });
    assert.equal(status.status, 'error');
    assert.equal(status.severity, 'bad');
    assert.equal(status.message, 'Object discovery unavailable');
    assert.match(status.recommendation, /retry vision/i);
  }
});

test('tracking labels alone cannot report a ready face', () => {
  for (const state of ['stable', 'tracking']) {
    assert.deepEqual(describeTrackedState({ state }), {
      status: 'recovering',
      severity: 'warn',
      message: 'Preparing surface attachment',
      recommendation: 'Keep the selected surface visible while pose support is rebuilt.',
    });
  }
});

test('accepted face readiness owns the HUD even while optional reconstruction is still mapping', () => {
  for (const surfaceAttachment of [null, { kind: 'planar-pnp' }]) {
    const status = describeTrackedState({
      state: 'stable',
      metrics: {
        targetPresent: true,
        poseModel: 'sparse-reconstruction',
        poseSource: 'planar-homography',
        reconstructionReady: false,
        readiness: { poseReady: true, attachmentReady: true, faceReady: true },
        surfaceAttachment,
      },
    });
    assert.equal(status.status, surfaceAttachment ? 'attached' : 'tracking');
    assert.equal(status.severity, 'good');
  }
});

test('the HUD never reports success for contradictory attachment permissions', () => {
  for (const field of ['poseReady', 'attachmentReady', 'faceReady']) {
    const readiness = { poseReady: true, attachmentReady: true, faceReady: true, [field]: false };
    const status = describeTrackedState({
      state: 'stable',
      metrics: { targetPresent: true, poseSource: 'planar-homography', readiness },
    });
    assert.equal(status.severity, 'warn');
    assert.equal(status.status, 'recovering');
  }
});

test('keeps reconstruction mapping and pose-recovery states exact', () => {
  assert.deepEqual(
    describeTrackedState({
      state: 'stable',
      metrics: { poseModel: 'depth-fusion', reconstructionReady: false },
    }),
    {
      status: 'mapping',
      severity: 'warn',
      message: 'Building 3D object map',
      recommendation: 'Slowly turn and tilt the object while keeping the clicked area visible.',
    },
  );
  assert.deepEqual(
    describeTrackedState({
      state: 'tracking',
      metrics: { poseModel: 'sparse-reconstruction', reconstructionReady: false },
    }),
    {
      status: 'mapping',
      severity: 'warn',
      message: 'Building 3D object map',
      recommendation: 'Slowly turn and tilt the object while keeping the clicked area visible.',
    },
  );
  assert.deepEqual(
    describeTrackedState({
      state: 'tracking',
      metrics: {
        poseModel: 'sparse-reconstruction',
        reconstructionReady: true,
        readiness: { reason: 'Recovering object pose before showing the face' },
        poseRejectedReason: 'Insufficient pose inliers',
      },
    }),
    {
      status: 'recovering',
      severity: 'warn',
      message: 'Recovering object pose',
      recommendation: 'Insufficient pose inliers',
    },
  );
});

test('keeps candidate, mapping, degraded, lost, and unknown guidance exact', () => {
  assert.deepEqual(
    describeTrackedState({ state: 'candidate', metrics: { readiness: { reason: 'Need 8 landmarks' } } }),
    {
      status: 'candidate',
      severity: 'warn',
      message: 'Object selected; building initial support',
      recommendation: 'Need 8 landmarks',
    },
  );
  assert.deepEqual(
    describeTrackedState({ state: 'mapping', metrics: { readiness: { reason: 'Need wider baseline' } } }),
    {
      status: 'mapping',
      severity: 'warn',
      message: 'Building 3D object map',
      recommendation: 'Need wider baseline',
    },
  );
  assert.deepEqual(describeTrackedState({ state: 'degraded' }), {
    status: 'weak',
    severity: 'warn',
    message: 'Weak lock; template recovery is active',
    recommendation: 'Move closer to a textured label or stronger edge detail.',
  });
  assert.deepEqual(
    describeTrackedState({
      state: 'degraded',
      metrics: {
        poseModel: 'sparse-reconstruction',
        reconstructionReady: false,
        reconstructionFailureReason: 'Map reliability is below threshold',
      },
    }),
    {
      status: 'mapping',
      severity: 'warn',
      message: '3D map needs more stable observations',
      recommendation: 'Map reliability is below threshold',
    },
  );
  assert.deepEqual(describeTrackedState({ state: 'lost', metrics: { recoveryAttempts: 3 } }), {
    status: 'recovering',
    severity: 'bad',
    message: 'Anchor lost; recovery attempt 3',
    recommendation: 'Bring the original object back into view or use Clear anchor to select another.',
  });
  assert.deepEqual(describeTrackedState({ state: 'unavailable' }), {
    status: 'unknown',
    severity: 'warn',
    message: 'Anchor state is unavailable',
    recommendation: 'Return to selection mode and create a new anchor.',
  });
});
