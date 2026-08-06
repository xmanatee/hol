import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareHardVisionBenchmarkContract,
  projectHardVisionBenchmarkContract,
} from './visionBenchmarkContract.js';

test('hard benchmark contract permits improvements and rejects regressions by direction', () => {
  const baseline = {
    maxStrictFailures: 14,
    maxSevereRiskCases: 4,
    maxHighOrSevereRiskCases: 9,
    maxMeanRiskScore: 31.5,
    minPostOcclusionRecoveryRateAt8: 0.7,
    maxTargetPresentAbsentDisplayFrames: 24,
    maxFalseTrackedAbsentAdmittedFrames: 20,
    maxTargetLossRecoveryFramesAt8: 8,
    minTargetLossRecoveryRateAt8: 0.5,
  };
  const improved = {
    strictFailures: 12,
    severeRiskCases: 3,
    highOrSevereRiskCases: 8,
    meanRiskScore: 30,
    postOcclusionRecoveryRateAt8: 0.8,
    targetPresentAbsentDisplayFrames: 16,
    falseTrackedAbsentAdmittedFrames: 12,
    maxTargetLossRecoveryFramesAt8: 5,
    targetLossRecoveryRateAt8: 0.75,
  };

  assert.deepEqual(compareHardVisionBenchmarkContract(improved, baseline), []);
  assert.deepEqual(
    compareHardVisionBenchmarkContract(
      {
        ...improved,
        severeRiskCases: 5,
        postOcclusionRecoveryRateAt8: 0.6,
      },
      baseline,
    ),
    [
      { field: 'severeRiskCases', expected: '<= 4', actual: 5 },
      { field: 'postOcclusionRecoveryRateAt8', expected: '>= 0.7', actual: 0.6 },
    ],
  );
});

test('hard benchmark contract projection owns quality risk and recovery evidence', () => {
  const projection = projectHardVisionBenchmarkContract({
    qualitySummary: { aggregate: { byStatus: { fail: 7 } } },
    benchmark: {
      aggregate: {
        byRiskBand: { high: 3, severe: 2 },
        meanRiskScore: 27.25,
      },
      postOcclusionRecovery: {
        aggregate: { recoveryRateAt8: 0.75 },
      },
      targetLossRecovery: {
        targetPresentAbsentDisplayFrames: 20,
        falseTrackedAbsentAdmittedFrames: 16,
        maxRecoveryFramesAt8: 9,
        recoveryRateAt8: 0.25,
      },
    },
  });

  assert.deepEqual(projection, {
    strictFailures: 7,
    severeRiskCases: 2,
    highOrSevereRiskCases: 5,
    meanRiskScore: 27.25,
    postOcclusionRecoveryRateAt8: 0.75,
    targetPresentAbsentDisplayFrames: 20,
    falseTrackedAbsentAdmittedFrames: 16,
    maxTargetLossRecoveryFramesAt8: 9,
    targetLossRecoveryRateAt8: 0.25,
  });
});
