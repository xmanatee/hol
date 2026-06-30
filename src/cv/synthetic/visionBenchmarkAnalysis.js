const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const VISION_BENCHMARK_TARGETS = {
  tracking: {
    maxMeanAnchorError: 6,
    maxAnchorError: 18,
    maxFrameJump: 8,
    minAnchorAccuracyAt8: 0.82,
    minAnchorAccuracyAt16: 0.95,
    minPostOcclusionRecoveryRateAt8: 0.85,
    maxPostOcclusionRecoveryFramesAt8: 6,
  },
  reconstruction: {
    minReadyFrameRatio: 0.65,
    minPoseReadyFrameRatio: 0.45,
    maxMeanNormalError: 0.45,
    maxNormalError: 0.9,
    minMapConfidence: 0.5,
  },
  headAttachment: {
    maxWorldPositionError: 0.1,
    maxRotationError: 0.65,
    maxScaleLogError: 0.1,
    maxHeadJumpExcess: 0.04,
  },
};

const finiteMetric = value => Number.isFinite(value) ? value : null;

const cappedRatio = (value, target, cap = 2.5) => {
  const metric = finiteMetric(value);
  if (metric === null) return 1;
  return clamp(metric / target, 0, cap) / cap;
};

const cappedDeficit = (value, target) => {
  const metric = finiteMetric(value);
  if (metric === null) return 1;
  return clamp((target - metric) / target, 0, 1);
};

const hasPostOcclusionWindows = tracking => Number.isFinite(tracking.postOcclusionWindowCount) &&
  tracking.postOcclusionWindowCount > 0;

const postOcclusionRecoveryDeficit = tracking => hasPostOcclusionWindows(tracking)
  ? cappedDeficit(
    tracking.postOcclusionRecoveryRateAt8,
    VISION_BENCHMARK_TARGETS.tracking.minPostOcclusionRecoveryRateAt8
  )
  : 0;

const postOcclusionRecoveryLatency = tracking => hasPostOcclusionWindows(tracking)
  ? cappedRatio(
    tracking.maxPostOcclusionRecoveryFramesAt8,
    VISION_BENCHMARK_TARGETS.tracking.maxPostOcclusionRecoveryFramesAt8
  )
  : 0;

const addWeighted = (components, name, raw, weight) => {
  const score = raw * weight;
  components.push({ name, score, weight });
  return score;
};

export const scoreBenchmarkRisk = report => {
  const tracking = report.stages.tracking.metrics;
  const reconstruction = report.stages.reconstruction.metrics;
  const head = report.stages.headAttachment.metrics;
  const components = [];
  const score = [
    addWeighted(
      components,
      'tracking.meanAnchorError',
      cappedRatio(tracking.meanAnchorError, VISION_BENCHMARK_TARGETS.tracking.maxMeanAnchorError),
      14
    ),
    addWeighted(
      components,
      'tracking.maxAnchorError',
      cappedRatio(tracking.maxAnchorError, VISION_BENCHMARK_TARGETS.tracking.maxAnchorError),
      9
    ),
    addWeighted(
      components,
      'tracking.maxFrameJump',
      cappedRatio(tracking.maxFrameJump, VISION_BENCHMARK_TARGETS.tracking.maxFrameJump),
      6
    ),
    addWeighted(
      components,
      'tracking.anchorAccuracyAt8',
      cappedDeficit(tracking.anchorAccuracyAt8, VISION_BENCHMARK_TARGETS.tracking.minAnchorAccuracyAt8),
      5
    ),
    addWeighted(
      components,
      'tracking.anchorAccuracyAt16',
      cappedDeficit(tracking.anchorAccuracyAt16, VISION_BENCHMARK_TARGETS.tracking.minAnchorAccuracyAt16),
      3
    ),
    addWeighted(
      components,
      'tracking.postOcclusionRecoveryRateAt8',
      postOcclusionRecoveryDeficit(tracking),
      3
    ),
    addWeighted(
      components,
      'tracking.postOcclusionRecoveryFramesAt8',
      postOcclusionRecoveryLatency(tracking),
      4
    ),
    addWeighted(
      components,
      'reconstruction.readyFrameRatio',
      cappedDeficit(reconstruction.readyFrameRatio, VISION_BENCHMARK_TARGETS.reconstruction.minReadyFrameRatio),
      9
    ),
    addWeighted(
      components,
      'reconstruction.poseReadyFrameRatio',
      cappedDeficit(reconstruction.poseReadyFrameRatio, VISION_BENCHMARK_TARGETS.reconstruction.minPoseReadyFrameRatio),
      7
    ),
    addWeighted(
      components,
      'reconstruction.meanReadyNormalError',
      cappedRatio(reconstruction.meanReadyNormalError, VISION_BENCHMARK_TARGETS.reconstruction.maxMeanNormalError),
      10
    ),
    addWeighted(
      components,
      'reconstruction.maxReadyNormalError',
      cappedRatio(reconstruction.maxReadyNormalError, VISION_BENCHMARK_TARGETS.reconstruction.maxNormalError),
      8
    ),
    addWeighted(
      components,
      'reconstruction.maxMapConfidence',
      cappedDeficit(reconstruction.maxMapConfidence, VISION_BENCHMARK_TARGETS.reconstruction.minMapConfidence),
      4
    ),
    addWeighted(
      components,
      'headAttachment.maxWorldPositionError',
      cappedRatio(head.maxWorldPositionError, VISION_BENCHMARK_TARGETS.headAttachment.maxWorldPositionError),
      10
    ),
    addWeighted(
      components,
      'headAttachment.maxRotationError',
      cappedRatio(head.maxRotationError, VISION_BENCHMARK_TARGETS.headAttachment.maxRotationError),
      4
    ),
    addWeighted(
      components,
      'headAttachment.maxScaleLogError',
      cappedRatio(head.maxScaleLogError, VISION_BENCHMARK_TARGETS.headAttachment.maxScaleLogError),
      2
    ),
    addWeighted(
      components,
      'headAttachment.maxHeadJumpExcess',
      cappedRatio(head.maxHeadJumpExcess, VISION_BENCHMARK_TARGETS.headAttachment.maxHeadJumpExcess),
      2
    ),
  ].reduce((sum, value) => sum + value, 0);

  const sortedComponents = components
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  return {
    score,
    band: riskBandForScore(score),
    primaryWeakness: sortedComponents[0]?.name || 'none',
    components: sortedComponents.slice(0, 5),
  };
};

export const riskBandForScore = score => {
  if (score >= 58) return 'severe';
  if (score >= 36) return 'high';
  if (score >= 20) return 'moderate';
  return 'low';
};

const increment = (counts, key) => {
  counts[key] = (counts[key] || 0) + 1;
};

const compactMetricsFor = report => {
  const tracking = report.stages.tracking.metrics;
  const reconstruction = report.stages.reconstruction.metrics;
  const head = report.stages.headAttachment.metrics;
  return {
    maxAnchorError: finiteMetric(tracking.maxAnchorError),
    meanAnchorError: finiteMetric(tracking.meanAnchorError),
    anchorAccuracyAt4: finiteMetric(tracking.anchorAccuracyAt4),
    anchorAccuracyAt8: finiteMetric(tracking.anchorAccuracyAt8),
    anchorAccuracyAt16: finiteMetric(tracking.anchorAccuracyAt16),
    postOcclusionWindowCount: finiteMetric(tracking.postOcclusionWindowCount),
    postOcclusionRecoveryRateAt8: finiteMetric(tracking.postOcclusionRecoveryRateAt8),
    maxPostOcclusionRecoveryFramesAt8: finiteMetric(tracking.maxPostOcclusionRecoveryFramesAt8),
    meanPostOcclusionRecoveryFramesAt8: finiteMetric(tracking.meanPostOcclusionRecoveryFramesAt8),
    maxFrameJump: finiteMetric(tracking.maxFrameJump),
    objectSupportCorrectionFrames: finiteMetric(tracking.objectSupportCorrectionFrames),
    objectSupportRecoveryFrames: finiteMetric(tracking.objectSupportRecoveryFrames),
    maxObjectSupportPositionStep: finiteMetric(tracking.maxObjectSupportPositionStep),
    maxObjectSupportAnchorError: finiteMetric(tracking.maxObjectSupportAnchorError),
    meanObjectSupportAnchorError: finiteMetric(tracking.meanObjectSupportAnchorError),
    readyFrameRatio: finiteMetric(reconstruction.readyFrameRatio),
    poseReadyFrameRatio: finiteMetric(reconstruction.poseReadyFrameRatio),
    meanReadyNormalError: finiteMetric(reconstruction.meanReadyNormalError),
    maxReadyNormalError: finiteMetric(reconstruction.maxReadyNormalError),
    maxWorldPositionError: finiteMetric(head.maxWorldPositionError),
    maxRotationError: finiteMetric(head.maxRotationError),
    maxHeadJumpExcess: finiteMetric(head.maxHeadJumpExcess),
  };
};

const compactReport = report => ({
  name: report.name,
  mode: report.mode,
  axes: report.axes,
  overallStatus: report.overallStatus,
  failedStages: report.failedStages,
  risk: report.risk,
  metrics: compactMetricsFor(report),
});

const createGroupAccumulator = () => ({
  count: 0,
  scoreSum: 0,
  maxRiskScore: 0,
  severe: 0,
  high: 0,
  fail: 0,
  primaryWeaknesses: {},
  failedPrimaryWeaknesses: {},
  highRiskPrimaryWeaknesses: {},
  worst: null,
});

const addToGroup = (groups, key, report) => {
  const group = groups[key] || createGroupAccumulator();
  group.count++;
  group.scoreSum += report.risk.score;
  group.maxRiskScore = Math.max(group.maxRiskScore, report.risk.score);
  if (report.risk.band === 'severe') group.severe++;
  if (report.risk.band === 'high') group.high++;
  if (report.overallStatus === 'fail') group.fail++;
  increment(group.primaryWeaknesses, report.risk.primaryWeakness);
  if (report.overallStatus === 'fail') {
    increment(group.failedPrimaryWeaknesses, report.risk.primaryWeakness);
  }
  if (report.risk.band === 'high' || report.risk.band === 'severe') {
    increment(group.highRiskPrimaryWeaknesses, report.risk.primaryWeakness);
  }
  if (!group.worst || report.risk.score > group.worst.risk.score) {
    group.worst = compactReport(report);
  }
  groups[key] = group;
};

const rankedWeaknesses = weaknesses => Object.entries(weaknesses)
  .map(([weakness, count]) => ({ weakness, count }))
  .sort((left, right) => right.count - left.count || left.weakness.localeCompare(right.weakness))
  .slice(0, 4);

const finalizeGroups = groups => Object.entries(groups)
  .map(([name, group]) => ({
    name,
    count: group.count,
    meanRiskScore: group.scoreSum / group.count,
    maxRiskScore: group.maxRiskScore,
    severe: group.severe,
    high: group.high,
    fail: group.fail,
    topPrimaryWeaknesses: rankedWeaknesses(group.primaryWeaknesses),
    topFailedPrimaryWeaknesses: rankedWeaknesses(group.failedPrimaryWeaknesses),
    topHighRiskPrimaryWeaknesses: rankedWeaknesses(group.highRiskPrimaryWeaknesses),
    worst: group.worst,
  }))
  .sort((left, right) => (
    right.meanRiskScore - left.meanRiskScore ||
    right.maxRiskScore - left.maxRiskScore ||
    left.name.localeCompare(right.name)
  ));

const interactionKey = (...values) => values.join(' / ');

export const createVisionBenchmarkAnalysis = reports => {
  const scoredReports = reports.map(report => ({
    ...report,
    risk: scoreBenchmarkRisk(report),
  }));
  const aggregate = {
    total: scoredReports.length,
    meanRiskScore: scoredReports.reduce((sum, report) => sum + report.risk.score, 0) /
      Math.max(1, scoredReports.length),
    maxRiskScore: Math.max(...scoredReports.map(report => report.risk.score), 0),
    byRiskBand: {},
    byStatus: {},
  };
  const groups = {
    byMode: {},
    byObject: {},
    byGeometry: {},
    byBackground: {},
    byLighting: {},
    byMotion: {},
    byOcclusion: {},
    byModeObject: {},
    byObjectOcclusion: {},
    byObjectBackground: {},
    byModeOcclusion: {},
  };

  scoredReports.forEach(report => {
    increment(aggregate.byRiskBand, report.risk.band);
    increment(aggregate.byStatus, report.overallStatus);
    addToGroup(groups.byMode, report.mode, report);
    addToGroup(groups.byObject, report.axes.object, report);
    addToGroup(groups.byGeometry, report.axes.geometry, report);
    addToGroup(groups.byBackground, report.axes.background, report);
    addToGroup(groups.byLighting, report.axes.lighting, report);
    addToGroup(groups.byMotion, report.axes.motion, report);
    addToGroup(groups.byOcclusion, report.axes.occlusion, report);
    addToGroup(groups.byModeObject, interactionKey(report.mode, report.axes.object), report);
    addToGroup(groups.byObjectOcclusion, interactionKey(report.axes.object, report.axes.occlusion), report);
    addToGroup(groups.byObjectBackground, interactionKey(report.axes.object, report.axes.background), report);
    addToGroup(groups.byModeOcclusion, interactionKey(report.mode, report.axes.occlusion), report);
  });

  return {
    aggregate,
    weakPoints: Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, finalizeGroups(group)])),
    worstReports: scoredReports
      .sort((left, right) => right.risk.score - left.risk.score || left.name.localeCompare(right.name))
      .slice(0, 16)
      .map(compactReport),
    reports: scoredReports,
  };
};
