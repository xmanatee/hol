import test from 'node:test';
import assert from 'node:assert/strict';

import { targetLossRecoveryMetrics } from './trackingRecoveryMetrics.js';

test('target-loss metrics separate false locks from re-entry recovery latency', () => {
  const frames = [
    { index: 1, targetVisible: true, targetPresent: true, success: true, anchorError: 2 },
    { index: 2, targetVisible: true, targetPresent: true, success: true, anchorError: 3 },
    {
      index: 3,
      targetVisible: false,
      targetPresent: true,
      success: true,
      anchorError: 4,
      runtime: { admittedUpdate: true },
    },
    { index: 4, targetVisible: false, targetPresent: false, success: true, anchorError: 18 },
    { index: 5, targetVisible: true, targetPresent: false, success: true, anchorError: 4 },
    { index: 6, targetVisible: true, targetPresent: true, success: true, anchorError: 5 },
  ];

  assert.deepEqual(targetLossRecoveryMetrics(frames), {
    targetLossWindowCount: 1,
    targetAbsentFrameCount: 2,
    targetPresentAbsentDisplayFrames: 1,
    falseTrackedAbsentAdmittedFrames: 1,
    targetLossRecoveredAt8: 1,
    targetLossFailedWindowsAt8: 0,
    targetLossRecoveryRateAt8: 1,
    maxTargetLossRecoveryFramesAt8: 2,
    meanTargetLossRecoveryFramesAt8: 2,
  });
});

test('target-loss metrics do not call a held display frame a confirmed false lock', () => {
  const metrics = targetLossRecoveryMetrics([
    {
      index: 1,
      targetVisible: false,
      targetPresent: true,
      success: true,
      anchorError: 2,
      runtime: { admittedUpdate: false },
    },
    {
      index: 2,
      targetVisible: false,
      targetPresent: false,
      success: true,
      anchorError: 2,
      runtime: { admittedUpdate: true },
    },
    {
      index: 3,
      targetVisible: true,
      targetPresent: true,
      success: true,
      anchorError: 2,
      runtime: { admittedUpdate: true },
    },
  ]);

  assert.equal(metrics.targetAbsentFrameCount, 2);
  assert.equal(metrics.targetPresentAbsentDisplayFrames, 1);
  assert.equal(metrics.falseTrackedAbsentAdmittedFrames, 0);
  assert.equal(metrics.targetLossRecoveredAt8, 1);
});

test('target-loss metrics remain neutral for continuous-visibility replays', () => {
  assert.deepEqual(
    targetLossRecoveryMetrics([
      { index: 1, targetVisible: true, targetPresent: true, success: true, anchorError: 2 },
    ]),
    {
      targetLossWindowCount: 0,
      targetAbsentFrameCount: 0,
      targetPresentAbsentDisplayFrames: 0,
      falseTrackedAbsentAdmittedFrames: 0,
      targetLossRecoveredAt8: 0,
      targetLossFailedWindowsAt8: 0,
      targetLossRecoveryRateAt8: 1,
      maxTargetLossRecoveryFramesAt8: 0,
      meanTargetLossRecoveryFramesAt8: 0,
    },
  );
});
