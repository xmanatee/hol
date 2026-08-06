const maxContractFields = [
  ['strictFailures', 'maxStrictFailures'],
  ['severeRiskCases', 'maxSevereRiskCases'],
  ['highOrSevereRiskCases', 'maxHighOrSevereRiskCases'],
  ['meanRiskScore', 'maxMeanRiskScore'],
  ['targetPresentAbsentDisplayFrames', 'maxTargetPresentAbsentDisplayFrames'],
  ['falseTrackedAbsentAdmittedFrames', 'maxFalseTrackedAbsentAdmittedFrames'],
  ['maxTargetLossRecoveryFramesAt8', 'maxTargetLossRecoveryFramesAt8'],
];

export const HARD_VISION_BENCHMARK_CONTRACT = Object.freeze({
  maxStrictFailures: 26,
  maxSevereRiskCases: 3,
  maxHighOrSevereRiskCases: 19,
  maxMeanRiskScore: 42.85,
  minPostOcclusionRecoveryRateAt8: 27 / 40,
  maxTargetPresentAbsentDisplayFrames: 4,
  maxFalseTrackedAbsentAdmittedFrames: 0,
  maxTargetLossRecoveryFramesAt8: 2,
  minTargetLossRecoveryRateAt8: 1,
});

export const projectHardVisionBenchmarkContract = ({ qualitySummary, benchmark }) => {
  const severeRiskCases = benchmark.aggregate.byRiskBand.severe || 0;
  const highRiskCases = benchmark.aggregate.byRiskBand.high || 0;
  return {
    strictFailures: qualitySummary.aggregate.byStatus.fail || 0,
    severeRiskCases,
    highOrSevereRiskCases: highRiskCases + severeRiskCases,
    meanRiskScore: benchmark.aggregate.meanRiskScore,
    postOcclusionRecoveryRateAt8: benchmark.postOcclusionRecovery.aggregate.recoveryRateAt8,
    targetPresentAbsentDisplayFrames: benchmark.targetLossRecovery.targetPresentAbsentDisplayFrames,
    falseTrackedAbsentAdmittedFrames: benchmark.targetLossRecovery.falseTrackedAbsentAdmittedFrames,
    maxTargetLossRecoveryFramesAt8: benchmark.targetLossRecovery.maxRecoveryFramesAt8,
    targetLossRecoveryRateAt8: benchmark.targetLossRecovery.recoveryRateAt8,
  };
};

export const compareHardVisionBenchmarkContract = (actual, expected) => {
  const mismatches = maxContractFields.flatMap(([actualField, expectedField]) =>
    actual[actualField] <= expected[expectedField]
      ? []
      : [
          {
            field: actualField,
            expected: `<= ${expected[expectedField]}`,
            actual: actual[actualField],
          },
        ],
  );

  if (actual.postOcclusionRecoveryRateAt8 < expected.minPostOcclusionRecoveryRateAt8) {
    mismatches.push({
      field: 'postOcclusionRecoveryRateAt8',
      expected: `>= ${expected.minPostOcclusionRecoveryRateAt8}`,
      actual: actual.postOcclusionRecoveryRateAt8,
    });
  }
  if (actual.targetLossRecoveryRateAt8 < expected.minTargetLossRecoveryRateAt8) {
    mismatches.push({
      field: 'targetLossRecoveryRateAt8',
      expected: `>= ${expected.minTargetLossRecoveryRateAt8}`,
      actual: actual.targetLossRecoveryRateAt8,
    });
  }
  return mismatches;
};
