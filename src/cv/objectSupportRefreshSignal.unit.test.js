import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isObjectSupportRefreshSignalActive,
  isRecoveryObjectSupportRefreshReason,
  mergeObjectSupportRefreshSignal,
} from './objectSupportRefreshSignal.js';

test('recovery refresh survives weaker signals until the next CV update can consume it', () => {
  assert.deepEqual(
    mergeObjectSupportRefreshSignal({
      currentReason: 'pose-dropout-recovery',
      currentFrame: 7,
      incomingReason: 'periodic-segmentation-refresh',
      incomingFrame: 7,
    }),
    {
      reason: 'pose-dropout-recovery',
      frame: 7,
    },
  );
});

test('expired recovery signal yields to the current refresh', () => {
  assert.deepEqual(
    mergeObjectSupportRefreshSignal({
      currentReason: 'curved-object-recovery',
      currentFrame: 7,
      incomingReason: 'periodic-segmentation-refresh',
      incomingFrame: 10,
    }),
    {
      reason: 'periodic-segmentation-refresh',
      frame: 10,
    },
  );
});

test('recovery refresh preempts routine and support-growth signals', () => {
  for (const currentReason of [
    'periodic-segmentation-refresh',
    'tap-local-support-growth',
    'object-ownership-recovery',
  ]) {
    assert.deepEqual(
      mergeObjectSupportRefreshSignal({
        currentReason,
        currentFrame: 12,
        incomingReason: 'pose-dropout-recovery',
        incomingFrame: 12,
      }),
      {
        reason: 'pose-dropout-recovery',
        frame: 12,
      },
    );
  }
});

test('object-support refresh reasons are exact and frame-monotonic', () => {
  assert.throws(
    () =>
      mergeObjectSupportRefreshSignal({
        currentReason: null,
        currentFrame: null,
        incomingReason: 'best-effort-recovery',
        incomingFrame: 4,
      }),
    /Unknown object-support refresh reason/,
  );
  assert.throws(
    () =>
      mergeObjectSupportRefreshSignal({
        currentReason: 'periodic-segmentation-refresh',
        currentFrame: 5,
        incomingReason: 'periodic-segmentation-refresh',
        incomingFrame: 4,
      }),
    /cannot move backwards/,
  );
});

test('refresh reason categories are explicit', () => {
  assert.equal(isRecoveryObjectSupportRefreshReason('pose-dropout-recovery'), true);
  assert.equal(isRecoveryObjectSupportRefreshReason('periodic-segmentation-refresh'), false);
  assert.equal(
    isObjectSupportRefreshSignalActive({
      reason: 'object-ownership-recovery',
      signalFrame: 4,
      currentFrame: 6,
    }),
    true,
  );
  assert.equal(
    isObjectSupportRefreshSignalActive({
      reason: 'periodic-segmentation-refresh',
      signalFrame: 4,
      currentFrame: 4,
    }),
    false,
  );
});
