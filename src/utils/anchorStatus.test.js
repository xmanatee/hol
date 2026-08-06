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
      anchorState: { state, metrics },
    },
  });

test('returns a compact status record for the permanent HUD', () => {
  assert.deepEqual(describeAnchorStatus(ACTIVE_SELECTION), {
    status: 'ready',
    severity: 'idle',
    message: 'Tap an object to create an anchor',
    recommendation: 'Tap a sharp, textured area on the object surface.',
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
    severity: 'warn',
    message: 'CV services are initializing',
    recommendation: 'Wait for selection and anchoring services to finish loading.',
  });
});

test('describes stable and tracking states without allocating rich diagnostics', () => {
  assert.deepEqual(describeTrackedState({ state: 'stable' }), {
    status: 'stable',
    severity: 'good',
    message: 'Anchor is stable',
    recommendation: 'The face should stay attached while the object remains visible.',
  });
  assert.deepEqual(describeTrackedState({ state: 'tracking' }), {
    status: 'tracking',
    severity: 'good',
    message: 'Anchor is tracking',
    recommendation: 'Hold the object steady if the face drifts.',
  });
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
      recommendation:
        'Move the object through a small left/right and up/down turn before expecting the face.',
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
    recommendation: 'Bring the original object back into view or tap to reset.',
  });
  assert.deepEqual(describeTrackedState({ state: 'unavailable' }), {
    status: 'unknown',
    severity: 'warn',
    message: 'Anchor state is unavailable',
    recommendation: 'Return to selection mode and create a new anchor.',
  });
});
