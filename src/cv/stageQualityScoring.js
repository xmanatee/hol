export const VISION_QUALITY_THRESHOLDS = {
  selection: {
    minTemplateKeypoints: 8,
    minActiveLandmarks: 8,
    minObjectOwnedLandmarks: 8,
    minMaskCoverage: 0.02,
  },
  tracking: {
    maxFailedFrames: 0,
    maxMeanAnchorError: 8,
    maxAnchorError: 24,
    maxFrameJump: 12,
  },
  reconstruction: {
    minReadyFrameRatio: 0.1,
    minPoseInliers: 8,
    maxMeanNormalError: 0.75,
    maxNormalError: 1.2,
    minMapConfidence: 0.42,
  },
  headAttachment: {
    maxVisibleMismatches: 0,
    maxWorldPositionError: 0.16,
    maxRotationError: 0.9,
    maxScaleLogError: 0.16,
    maxHeadJumpExcess: 0.06,
  },
};

const COMPARISON_EPSILON = 1e-6;

const finiteValues = values => values.filter(Number.isFinite);

const maxValue = values => {
  const finite = finiteValues(values);
  return finite.length ? Math.max(...finite) : 0;
};

const minValue = values => {
  const finite = finiteValues(values);
  return finite.length ? Math.min(...finite) : 0;
};

const meanValue = values => {
  const finite = finiteValues(values);
  return finite.reduce((sum, value) => sum + value, 0) / Math.max(1, finite.length);
};

const metricValue = (value, defaultValue = 0) => Number.isFinite(value) ? value : defaultValue;

const statusForFailures = failures => failures.length ? 'fail' : 'pass';

const stageScore = (failures, checkCount) => Math.max(0, 1 - failures.length / Math.max(1, checkCount));

const failWhen = (failures, condition, message) => {
  if (condition) {
    failures.push(message);
  }
};

const exceeds = (value, threshold) => value - threshold > COMPARISON_EPSILON;
const below = (value, threshold) => threshold - value > COMPARISON_EPSILON;

const createStage = ({ metrics, failures, checkCount }) => ({
  status: statusForFailures(failures),
  score: stageScore(failures, checkCount),
  failures,
  metrics,
});

const evidenceFromReplay = replay => replay.createResult?.evidence || {};

const scoreSelection = ({ replay, thresholds }) => {
  const failures = [];
  const evidence = evidenceFromReplay(replay);
  const metrics = {
    anchorCreated: replay.anchorCreated === true,
    createFailure: replay.createFailure || null,
    maskCoverage: metricValue(evidence.maskCoverage, null),
    maskConfidence: metricValue(evidence.maskConfidence, null),
    templateKeypoints: metricValue(evidence.templateKeypoints),
    activeLandmarks: metricValue(evidence.activeLandmarks),
    objectOwnedLandmarks: metricValue(evidence.objectOwnedLandmarks),
    backgroundRejected: metricValue(evidence.backgroundRejected),
  };

  failWhen(failures, !metrics.anchorCreated, `Anchor was not created: ${metrics.createFailure || 'unknown reason'}`);
  failWhen(
    failures,
    metrics.anchorCreated && below(metrics.templateKeypoints, thresholds.minTemplateKeypoints),
    `Template has ${metrics.templateKeypoints} keypoints; expected at least ${thresholds.minTemplateKeypoints}`
  );
  failWhen(
    failures,
    metrics.anchorCreated && below(metrics.activeLandmarks, thresholds.minActiveLandmarks),
    `Anchor has ${metrics.activeLandmarks} active landmarks; expected at least ${thresholds.minActiveLandmarks}`
  );
  failWhen(
    failures,
    metrics.anchorCreated && below(metrics.objectOwnedLandmarks, thresholds.minObjectOwnedLandmarks),
    `Anchor has ${metrics.objectOwnedLandmarks} object-owned landmarks; expected at least ${thresholds.minObjectOwnedLandmarks}`
  );
  if (metrics.maskCoverage !== null && below(metrics.maskCoverage, thresholds.minMaskCoverage)) {
    failures.push(`Mask coverage ${metrics.maskCoverage.toFixed(3)} is below ${thresholds.minMaskCoverage}`);
  }

  return createStage({ metrics, failures, checkCount: 5 });
};

const scoreTracking = ({ replay, summary, thresholds }) => {
  const failedFrames = metricValue(summary.failedFrames);
  const metrics = {
    frameCount: replay.frames.length,
    failedFrames,
    maxAnchorError: metricValue(summary.maxAnchorError),
    meanAnchorError: metricValue(summary.meanAnchorError),
    maxFrameJump: metricValue(summary.maxFrameJump),
    trackingSuccessRate: meanValue(replay.frames.map(frame => frame.metrics?.trackingSuccessRate)),
    maxBackgroundRejected: maxValue(replay.frames.map(frame => frame.metrics?.backgroundRejected)),
  };
  const failures = [];

  failWhen(
    failures,
    exceeds(failedFrames, thresholds.maxFailedFrames),
    `${failedFrames} tracking frames failed; expected ${thresholds.maxFailedFrames}`
  );
  failWhen(
    failures,
    exceeds(metrics.meanAnchorError, thresholds.maxMeanAnchorError),
    `Mean anchor error ${metrics.meanAnchorError.toFixed(2)}px exceeds ${thresholds.maxMeanAnchorError}px`
  );
  failWhen(
    failures,
    exceeds(metrics.maxAnchorError, thresholds.maxAnchorError),
    `Max anchor error ${metrics.maxAnchorError.toFixed(2)}px exceeds ${thresholds.maxAnchorError}px`
  );
  failWhen(
    failures,
    exceeds(metrics.maxFrameJump, thresholds.maxFrameJump),
    `Max frame jump ${metrics.maxFrameJump.toFixed(2)}px exceeds ${thresholds.maxFrameJump}px`
  );

  return createStage({ metrics, failures, checkCount: 4 });
};

const scoreReconstruction = ({ replay, summary, thresholds }) => {
  const frames = replay.frames;
  const readyFrames = frames.filter(frame => frame.metrics?.reconstructionReady === true);
  const poseReadyFrames = readyFrames.filter(frame => {
    const metrics = frame.metrics || {};
    const poseSource = metrics.poseSource || null;
    const selectedReconstructionPose = poseSource && poseSource === metrics.poseModel;
    const planarPose = poseSource === 'planar-homography';
    return (selectedReconstructionPose || planarPose) && metricValue(metrics.poseInliers) > 0;
  });
  const scoringFrames = readyFrames.length ? readyFrames : frames;
  const mapConfidences = scoringFrames.map(frame => frame.metrics?.reconstructionMapConfidence);
  const poseInliers = frames.map(frame => frame.metrics?.poseInliers);
  const poseScoringFrames = poseReadyFrames.length ? poseReadyFrames : readyFrames;
  const readyPoseInliers = poseScoringFrames.map(frame => frame.metrics?.poseInliers);
  const readyNormalErrors = poseScoringFrames.map(frame => frame.normalError);
  const metrics = {
    readyFrames: readyFrames.length,
    poseReadyFrames: poseReadyFrames.length,
    readyFrameRatio: frames.length ? readyFrames.length / frames.length : 0,
    poseReadyFrameRatio: frames.length ? poseReadyFrames.length / frames.length : 0,
    minPoseInliers: metricValue(summary.minPoseInliers, minValue(poseInliers)),
    minReadyPoseInliers: minValue(readyPoseInliers),
    meanNormalError: metricValue(summary.meanNormalError),
    maxNormalError: metricValue(summary.maxNormalError),
    meanReadyNormalError: poseScoringFrames.length ? meanValue(readyNormalErrors) : metricValue(summary.meanNormalError),
    maxReadyNormalError: poseScoringFrames.length ? maxValue(readyNormalErrors) : metricValue(summary.maxNormalError),
    maxMapConfidence: maxValue(mapConfidences),
    maxDepthQuality: maxValue(scoringFrames.map(frame => frame.metrics?.reconstructionDepthQuality)),
  };
  const failures = [];

  failWhen(
    failures,
    below(metrics.readyFrameRatio, thresholds.minReadyFrameRatio),
    `Reconstruction ready ratio ${metrics.readyFrameRatio.toFixed(3)} is below ${thresholds.minReadyFrameRatio}`
  );
  failWhen(
    failures,
    below(metrics.minReadyPoseInliers, thresholds.minPoseInliers),
    `Minimum ready pose inliers ${metrics.minReadyPoseInliers} is below ${thresholds.minPoseInliers}`
  );
  failWhen(
    failures,
    exceeds(metrics.meanReadyNormalError, thresholds.maxMeanNormalError),
    `Mean ready normal error ${metrics.meanReadyNormalError.toFixed(3)}rad exceeds ${thresholds.maxMeanNormalError}rad`
  );
  failWhen(
    failures,
    exceeds(metrics.maxReadyNormalError, thresholds.maxNormalError),
    `Max ready normal error ${metrics.maxReadyNormalError.toFixed(3)}rad exceeds ${thresholds.maxNormalError}rad`
  );
  failWhen(
    failures,
    below(metrics.maxMapConfidence, thresholds.minMapConfidence),
    `Max map confidence ${metrics.maxMapConfidence.toFixed(3)} is below ${thresholds.minMapConfidence}`
  );

  return createStage({ metrics, failures, checkCount: 5 });
};

const scoreHeadAttachment = ({ headPose, thresholds }) => {
  const summary = headPose.summary || headPose;
  const metrics = {
    visibleMismatches: metricValue(summary.visibleMismatches),
    maxWorldPositionError: metricValue(summary.maxWorldPositionError),
    maxRotationError: metricValue(summary.maxRotationError),
    maxScaleLogError: metricValue(summary.maxScaleLogError),
    maxHeadJumpExcess: metricValue(summary.maxHeadJumpExcess),
    hiddenByPolicyFrames: metricValue(summary.hiddenByPolicyFrames),
  };
  const failures = [];

  failWhen(
    failures,
    exceeds(metrics.visibleMismatches, thresholds.maxVisibleMismatches),
    `${metrics.visibleMismatches} visibility mismatches; expected ${thresholds.maxVisibleMismatches}`
  );
  failWhen(
    failures,
    exceeds(metrics.maxWorldPositionError, thresholds.maxWorldPositionError),
    `Head world error ${metrics.maxWorldPositionError.toFixed(3)} exceeds ${thresholds.maxWorldPositionError}`
  );
  failWhen(
    failures,
    exceeds(metrics.maxRotationError, thresholds.maxRotationError),
    `Head rotation error ${metrics.maxRotationError.toFixed(3)}rad exceeds ${thresholds.maxRotationError}rad`
  );
  failWhen(
    failures,
    exceeds(metrics.maxScaleLogError, thresholds.maxScaleLogError),
    `Head scale log error ${metrics.maxScaleLogError.toFixed(3)} exceeds ${thresholds.maxScaleLogError}`
  );
  failWhen(
    failures,
    exceeds(metrics.maxHeadJumpExcess, thresholds.maxHeadJumpExcess),
    `Head jump excess ${metrics.maxHeadJumpExcess.toFixed(3)} exceeds ${thresholds.maxHeadJumpExcess}`
  );

  return createStage({ metrics, failures, checkCount: 5 });
};

export const scoreVisionPipelineQuality = ({
  name,
  replay,
  summary,
  headPose,
  thresholds = VISION_QUALITY_THRESHOLDS,
}) => {
  const stages = {
    selection: scoreSelection({ replay, thresholds: thresholds.selection }),
    tracking: scoreTracking({ replay, summary, thresholds: thresholds.tracking }),
    reconstruction: scoreReconstruction({ replay, summary, thresholds: thresholds.reconstruction }),
    headAttachment: scoreHeadAttachment({ headPose, thresholds: thresholds.headAttachment }),
  };
  const failedStages = Object.entries(stages)
    .filter(([, stage]) => stage.status === 'fail')
    .map(([stageName]) => stageName);

  return {
    name,
    overallStatus: failedStages.length ? 'fail' : 'pass',
    failedStages,
    stages,
  };
};
