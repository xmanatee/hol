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

const describeTrackedState = ({ state, metrics = {}, initialized = true, observationExpired = false }) =>
  describeAnchorStatus({
    cameraState: 'active',
    anchorSystemState: {
      mode: 'anchor',
      initialized,
      observationExpired,
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

test('loss guidance is stable across recovery attempts and takes precedence over map preparation', () => {
  const expected = describeTrackedState({ state: 'lost', metrics: { recoveryAttempts: 1 } });
  assert.equal(expected.message, 'Looking for your object');
  assert.equal(expected.severity, 'warn');
  for (const state of ['tracking', 'stable', 'mapping', 'degraded', 'lost']) {
    for (const recoveryAttempts of [0, 1, 27]) {
      assert.deepEqual(
        describeTrackedState({
          state,
          metrics: {
            targetPresent: false,
            poseModel: 'depth-fusion',
            reconstructionReady: false,
            recoveryAttempts,
            readiness: { reason: `Diagnostic ${recoveryAttempts}` },
          },
        }),
        expected,
      );
    }
  }
});

test('changing pose diagnostics cannot repeatedly change recovery announcements', () => {
  for (const state of ['tracking', 'mapping', 'candidate', 'degraded']) {
    const metrics = { poseModel: 'depth-fusion', reconstructionReady: false };
    const expected = describeTrackedState({ state, metrics });
    for (const reason of [
      'Need 8 landmarks',
      'Need 12 landmarks',
      'Recovering object pose before showing the face',
    ]) {
      assert.deepEqual(
        describeTrackedState({
          state,
          metrics: {
            ...metrics,
            readiness: { reason },
            poseRejectedReason: reason,
            reconstructionFailureReason: reason,
          },
        }),
        expected,
      );
    }
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
    assert.equal(status.message, 'Face is tracking the object');
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
      recommendation: 'Slowly turn and tilt the object while keeping the selected surface visible.',
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
      recommendation: 'Slowly turn and tilt the object while keeping the selected surface visible.',
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
      message: 'Preparing surface attachment',
      recommendation: 'Keep the selected surface visible while pose support is rebuilt.',
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
      recommendation: 'Hold the object in view while support landmarks are collected.',
    },
  );
  assert.deepEqual(
    describeTrackedState({ state: 'mapping', metrics: { readiness: { reason: 'Need wider baseline' } } }),
    {
      status: 'mapping',
      severity: 'warn',
      message: 'Building 3D object map',
      recommendation: 'Slowly turn and tilt the object while keeping the selected surface visible.',
    },
  );
  assert.deepEqual(describeTrackedState({ state: 'degraded' }), {
    status: 'weak',
    severity: 'warn',
    message: 'Tracking is uncertain',
    recommendation: 'Keep the selected surface visible and move slowly.',
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
      message: 'Building 3D object map',
      recommendation: 'Slowly turn and tilt the object while keeping the selected surface visible.',
    },
  );
  assert.deepEqual(describeTrackedState({ state: 'lost', metrics: { recoveryAttempts: 3 } }), {
    status: 'recovering',
    severity: 'warn',
    message: 'Looking for your object',
    recommendation: 'Bring the original object back into view or use Clear anchor to select another.',
  });
  assert.deepEqual(describeTrackedState({ state: 'unavailable' }), {
    status: 'unknown',
    severity: 'warn',
    message: 'Anchor state is unavailable',
    recommendation: 'Return to selection mode and create a new anchor.',
  });
});

test('expired observations cannot announce a recovered face or mislabel a frozen camera as object loss', () => {
  for (const state of ['stable', 'lost']) {
    const status = describeTrackedState({
      state,
      observationExpired: true,
      metrics: {
        targetPresent: state === 'stable',
        poseSource: 'planar-homography',
        readiness: { poseReady: true, attachmentReady: true, faceReady: true },
      },
    });
    assert.equal(status.status, 'stale');
    assert.equal(status.message, 'Waiting for fresh tracking');
    assert.match(status.recommendation, /face is hidden/i);
  }
});
