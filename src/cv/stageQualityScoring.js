import { anchorAccuracyAt, anchorErrorPercentileMetrics } from './anchorAccuracyMetrics.js';
import { summarizeLandmarkRefreshCoverage } from './landmarkSpatialCoverage.js';
import { postOcclusionRecoveryMetrics, targetLossRecoveryMetrics } from './trackingRecoveryMetrics.js';

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

const finiteValues = (values) => values.filter(Number.isFinite);

const maxValue = (values) => {
  const finite = finiteValues(values);
  return finite.length ? Math.max(...finite) : 0;
};

const minValue = (values) => {
  const finite = finiteValues(values);
  return finite.length ? Math.min(...finite) : 0;
};

const meanValue = (values) => {
  const finite = finiteValues(values);
  return finite.reduce((sum, value) => sum + value, 0) / Math.max(1, finite.length);
};

const sumValue = (values) => finiteValues(values).reduce((sum, value) => sum + value, 0);

const metricValue = (value, defaultValue = 0) => (Number.isFinite(value) ? value : defaultValue);

const statusForFailures = (failures) => (failures.length ? 'fail' : 'pass');

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

const evidenceFromReplay = (replay) => replay.createResult?.evidence || {};

const sourceName = (source) => source || 'none';

const sourceFrameStats = ({ frames, sourceForFrame, metricsForFrame }) => {
  const groups = new Map();
  for (const frame of frames) {
    const source = sourceName(sourceForFrame(frame));
    const group = groups.get(source) || { frameCount: 0 };
    group.frameCount++;
    for (const [name, value] of Object.entries(metricsForFrame(frame))) {
      if (!Number.isFinite(value)) {
        continue;
      }
      const valuesKey = `${name}Values`;
      group[valuesKey] = group[valuesKey] || [];
      group[valuesKey].push(value);
    }
    groups.set(source, group);
  }

  return Object.fromEntries(
    [...groups.entries()].map(([source, group]) => {
      const metrics = { frameCount: group.frameCount };
      for (const [key, values] of Object.entries(group)) {
        if (!key.endsWith('Values')) {
          continue;
        }
        const name = key.slice(0, -'Values'.length);
        const metricName = `${name[0].toUpperCase()}${name.slice(1)}`;
        metrics[`mean${metricName}`] = meanValue(values);
        metrics[`max${metricName}`] = maxValue(values);
      }
      return [source, metrics];
    }),
  );
};

const pointDistance = (left, right) => {
  if (!left || !right) return 0;
  if (
    !Number.isFinite(left.x) ||
    !Number.isFinite(left.y) ||
    !Number.isFinite(right.x) ||
    !Number.isFinite(right.y)
  ) {
    return 0;
  }
  return Math.hypot(left.x - right.x, left.y - right.y);
};

const objectSupportAnchorFromMetrics = (metrics) => {
  const uv = metrics?.objectSupportAnchorUv;
  const bounds = metrics?.currentObjectSupportMaskBounds || metrics?.objectSupportMaskBounds;
  if (
    !uv ||
    !bounds ||
    !Number.isFinite(uv.u) ||
    !Number.isFinite(uv.v) ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    return null;
  }

  return {
    x: bounds.x + bounds.width * uv.u,
    y: bounds.y + bounds.height * uv.v,
  };
};

const objectSupportAnchorError = (frame) => {
  const supportAnchor = objectSupportAnchorFromMetrics(frame.metrics);
  const groundTruthAnchor = frame.groundTruth?.anchor;
  if (!supportAnchor || !groundTruthAnchor) {
    return null;
  }

  return Math.hypot(supportAnchor.x - groundTruthAnchor.x, supportAnchor.y - groundTruthAnchor.y);
};

const transitionFrameStats = ({ frames, sourceForFrame, metricsForTransition }) => {
  const transitions = [];
  let previous = null;
  for (const frame of frames) {
    const source = sourceName(sourceForFrame(frame));
    if (previous && source !== previous.source) {
      transitions.push({
        index: frame.index,
        from: previous.source,
        to: source,
        ...metricsForTransition(frame, previous.frame),
      });
    }
    previous = { source, frame };
  }

  const byTransition = new Map();
  for (const transition of transitions) {
    const key = `${transition.from}->${transition.to}`;
    const group = byTransition.get(key) || { frameCount: 0 };
    group.frameCount++;
    for (const [name, value] of Object.entries(transition)) {
      if (name === 'index' || name === 'from' || name === 'to' || !Number.isFinite(value)) {
        continue;
      }
      const valuesKey = `${name}Values`;
      group[valuesKey] = group[valuesKey] || [];
      group[valuesKey].push(value);
    }
    byTransition.set(key, group);
  }

  const transitionMetrics = Object.fromEntries(
    [...byTransition.entries()].map(([key, group]) => {
      const metrics = { frameCount: group.frameCount };
      for (const [name, values] of Object.entries(group)) {
        if (!name.endsWith('Values')) {
          continue;
        }
        const metricName = name.slice(0, -'Values'.length);
        const outputName = `${metricName[0].toUpperCase()}${metricName.slice(1)}`;
        metrics[`max${outputName}`] = maxValue(values);
        metrics[`mean${outputName}`] = meanValue(values);
      }
      return [key, metrics];
    }),
  );

  return {
    transitionCount: transitions.length,
    maxAnchorJump: maxValue(transitions.map((transition) => transition.anchorJump)),
    maxAnchorError: maxValue(transitions.map((transition) => transition.anchorError)),
    maxHeadJumpExcess: maxValue(transitions.map((transition) => transition.headJumpExcess)),
    maxWorldPositionError: maxValue(transitions.map((transition) => transition.worldPositionError)),
    maxRotationError: maxValue(transitions.map((transition) => transition.rotationError)),
    byTransition: transitionMetrics,
    worstTransitions: [...transitions]
      .sort(
        (left, right) =>
          (right.anchorJump || right.headJumpExcess || right.worldPositionError || 0) -
          (left.anchorJump || left.headJumpExcess || left.worldPositionError || 0),
      )
      .slice(0, 6),
  };
};

const worstTrackingFrames = (frames) =>
  [...frames]
    .filter((frame) => Number.isFinite(frame.anchorError))
    .sort((left, right) => right.anchorError - left.anchorError)
    .slice(0, 6)
    .map((frame) => ({
      index: frame.index,
      positionSource: frame.positionSource || frame.method || null,
      poseSource: frame.poseSource || frame.metrics?.poseSource || null,
      anchorError: frame.anchorError,
    }));

const worstObjectSupportAnchorFrames = (frames) =>
  frames
    .map((frame) => ({
      index: frame.index,
      positionSource: frame.positionSource || frame.method || null,
      poseSource: frame.poseSource || frame.metrics?.poseSource || null,
      objectSupportAnchorError: objectSupportAnchorError(frame),
      anchorError: frame.anchorError,
      objectSupportPositionCorrection: frame.metrics?.objectSupportPositionCorrection || null,
    }))
    .filter((frame) => Number.isFinite(frame.objectSupportAnchorError))
    .sort((left, right) => right.objectSupportAnchorError - left.objectSupportAnchorError)
    .slice(0, 6);

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

  failWhen(
    failures,
    !metrics.anchorCreated,
    `Anchor was not created: ${metrics.createFailure || 'unknown reason'}`,
  );
  failWhen(
    failures,
    metrics.anchorCreated && below(metrics.templateKeypoints, thresholds.minTemplateKeypoints),
    `Template has ${metrics.templateKeypoints} keypoints; expected at least ${thresholds.minTemplateKeypoints}`,
  );
  failWhen(
    failures,
    metrics.anchorCreated && below(metrics.activeLandmarks, thresholds.minActiveLandmarks),
    `Anchor has ${metrics.activeLandmarks} active landmarks; expected at least ${thresholds.minActiveLandmarks}`,
  );
  failWhen(
    failures,
    metrics.anchorCreated && below(metrics.objectOwnedLandmarks, thresholds.minObjectOwnedLandmarks),
    `Anchor has ${metrics.objectOwnedLandmarks} object-owned landmarks; expected at least ${thresholds.minObjectOwnedLandmarks}`,
  );
  if (metrics.maskCoverage !== null && below(metrics.maskCoverage, thresholds.minMaskCoverage)) {
    failures.push(`Mask coverage ${metrics.maskCoverage.toFixed(3)} is below ${thresholds.minMaskCoverage}`);
  }

  return createStage({ metrics, failures, checkCount: 5 });
};

const scoreTracking = ({ replay, summary, thresholds }) => {
  const failedFrames = metricValue(summary.failedFrames);
  const visibleFrames = replay.frames.filter((frame) => frame.targetVisible !== false);
  const successfulFrames = visibleFrames.filter((frame) => frame.success && frame.targetPresent !== false);
  const landmarkRefreshCoverage = summarizeLandmarkRefreshCoverage(replay.frames);
  const postOcclusionRecovery = postOcclusionRecoveryMetrics(replay.frames);
  const targetLossRecovery = targetLossRecoveryMetrics(replay.frames);
  const anchorErrorPercentiles = anchorErrorPercentileMetrics(visibleFrames);
  const metrics = {
    frameCount: replay.frames.length,
    visibleFrameCount: visibleFrames.length,
    failedFrames,
    maxAnchorError: metricValue(summary.maxAnchorError),
    meanAnchorError: metricValue(summary.meanAnchorError),
    p50AnchorError: metricValue(summary.p50AnchorError, anchorErrorPercentiles.p50AnchorError),
    p95AnchorError: metricValue(summary.p95AnchorError, anchorErrorPercentiles.p95AnchorError),
    anchorAccuracyAt4: metricValue(summary.anchorAccuracyAt4, anchorAccuracyAt(visibleFrames, 4)),
    anchorAccuracyAt8: metricValue(summary.anchorAccuracyAt8, anchorAccuracyAt(visibleFrames, 8)),
    anchorAccuracyAt16: metricValue(summary.anchorAccuracyAt16, anchorAccuracyAt(visibleFrames, 16)),
    postOcclusionWindowCount: metricValue(
      summary.postOcclusionWindowCount,
      postOcclusionRecovery.postOcclusionWindowCount,
    ),
    postOcclusionRecoveredAt8: metricValue(
      summary.postOcclusionRecoveredAt8,
      postOcclusionRecovery.postOcclusionRecoveredAt8,
    ),
    postOcclusionFailedWindowsAt8: metricValue(
      summary.postOcclusionFailedWindowsAt8,
      postOcclusionRecovery.postOcclusionFailedWindowsAt8,
    ),
    postOcclusionRecoveryRateAt8: metricValue(
      summary.postOcclusionRecoveryRateAt8,
      postOcclusionRecovery.postOcclusionRecoveryRateAt8,
    ),
    maxPostOcclusionRecoveryFramesAt8: metricValue(
      summary.maxPostOcclusionRecoveryFramesAt8,
      postOcclusionRecovery.maxPostOcclusionRecoveryFramesAt8,
    ),
    meanPostOcclusionRecoveryFramesAt8: metricValue(
      summary.meanPostOcclusionRecoveryFramesAt8,
      postOcclusionRecovery.meanPostOcclusionRecoveryFramesAt8,
    ),
    targetLossWindowCount: metricValue(
      summary.targetLossWindowCount,
      targetLossRecovery.targetLossWindowCount,
    ),
    targetAbsentFrameCount: metricValue(
      summary.targetAbsentFrameCount,
      targetLossRecovery.targetAbsentFrameCount,
    ),
    targetPresentAbsentDisplayFrames: metricValue(
      summary.targetPresentAbsentDisplayFrames,
      targetLossRecovery.targetPresentAbsentDisplayFrames,
    ),
    falseTrackedAbsentAdmittedFrames: metricValue(
      summary.falseTrackedAbsentAdmittedFrames,
      targetLossRecovery.falseTrackedAbsentAdmittedFrames,
    ),
    targetLossRecoveredAt8: metricValue(
      summary.targetLossRecoveredAt8,
      targetLossRecovery.targetLossRecoveredAt8,
    ),
    targetLossFailedWindowsAt8: metricValue(
      summary.targetLossFailedWindowsAt8,
      targetLossRecovery.targetLossFailedWindowsAt8,
    ),
    targetLossRecoveryRateAt8: metricValue(
      summary.targetLossRecoveryRateAt8,
      targetLossRecovery.targetLossRecoveryRateAt8,
    ),
    maxTargetLossRecoveryFramesAt8: metricValue(
      summary.maxTargetLossRecoveryFramesAt8,
      targetLossRecovery.maxTargetLossRecoveryFramesAt8,
    ),
    meanTargetLossRecoveryFramesAt8: metricValue(
      summary.meanTargetLossRecoveryFramesAt8,
      targetLossRecovery.meanTargetLossRecoveryFramesAt8,
    ),
    maxFrameJump: metricValue(summary.maxFrameJump),
    objectSupportCorrectionFrames: metricValue(summary.objectSupportCorrectionFrames),
    objectSupportFrameStepLimitedFrames: metricValue(summary.objectSupportFrameStepLimitedFrames),
    objectSupportRecoveryFrames: metricValue(summary.objectSupportRecoveryFrames),
    maxOwnershipProbationLandmarks: metricValue(
      summary.maxOwnershipProbationLandmarks,
      maxValue(replay.frames.map((frame) => frame.metrics?.ownershipProbationLandmarks)),
    ),
    landmarkRefreshProbationaryLandmarks: metricValue(
      summary.landmarkRefreshProbationaryLandmarks,
      sumValue(replay.frames.map((frame) => frame.metrics?.landmarkRefreshProbationary)),
    ),
    landmarkOwnershipPromotions: metricValue(
      summary.landmarkOwnershipPromotions,
      sumValue(replay.frames.map((frame) => frame.metrics?.landmarkOwnershipPromoted)),
    ),
    landmarkRefreshCoverageFrames: metricValue(
      summary.landmarkRefreshCoverageFrames,
      landmarkRefreshCoverage.landmarkRefreshCoverageFrames,
    ),
    landmarkRefreshCoverageGain: metricValue(
      summary.landmarkRefreshCoverageGain,
      landmarkRefreshCoverage.landmarkRefreshCoverageGain,
    ),
    landmarkRefreshNewOccupiedCells: metricValue(
      summary.landmarkRefreshNewOccupiedCells,
      landmarkRefreshCoverage.landmarkRefreshNewOccupiedCells,
    ),
    maxObjectSupportPositionStep: metricValue(summary.maxObjectSupportPositionStep),
    maxObjectSupportAnchorError: metricValue(
      summary.maxObjectSupportAnchorError,
      maxValue(successfulFrames.map(objectSupportAnchorError)),
    ),
    meanObjectSupportAnchorError: metricValue(
      summary.meanObjectSupportAnchorError,
      meanValue(successfulFrames.map(objectSupportAnchorError)),
    ),
    objectSupportCorrectionCounts: summary.objectSupportCorrectionCounts || {},
    trackingSuccessRate: meanValue(visibleFrames.map((frame) => frame.metrics?.trackingSuccessRate)),
    maxBackgroundRejected: maxValue(visibleFrames.map((frame) => frame.metrics?.backgroundRejected)),
    byPositionSource: sourceFrameStats({
      frames: successfulFrames,
      sourceForFrame: (frame) => frame.positionSource || frame.method,
      metricsForFrame: (frame) => ({
        anchorError: frame.anchorError,
        normalError: frame.normalError,
        poseInliers: frame.metrics?.poseInliers,
      }),
    }),
    positionSourceTransitions: transitionFrameStats({
      frames: successfulFrames,
      sourceForFrame: (frame) => frame.positionSource || frame.method,
      metricsForTransition: (frame, previous) => ({
        anchorJump: pointDistance(frame.predicted, previous.predicted),
        anchorError: frame.anchorError,
        normalError: frame.normalError,
      }),
    }),
    worstFrames: worstTrackingFrames(successfulFrames),
    worstObjectSupportAnchorFrames: worstObjectSupportAnchorFrames(successfulFrames),
    worstPostOcclusionWindows:
      summary.worstPostOcclusionWindows || postOcclusionRecovery.worstPostOcclusionWindows,
  };
  const failures = [];

  failWhen(
    failures,
    exceeds(failedFrames, thresholds.maxFailedFrames),
    `${failedFrames} tracking frames failed; expected ${thresholds.maxFailedFrames}`,
  );
  failWhen(
    failures,
    exceeds(metrics.meanAnchorError, thresholds.maxMeanAnchorError),
    `Mean anchor error ${metrics.meanAnchorError.toFixed(2)}px exceeds ${thresholds.maxMeanAnchorError}px`,
  );
  failWhen(
    failures,
    exceeds(metrics.maxAnchorError, thresholds.maxAnchorError),
    `Max anchor error ${metrics.maxAnchorError.toFixed(2)}px exceeds ${thresholds.maxAnchorError}px`,
  );
  failWhen(
    failures,
    exceeds(metrics.maxFrameJump, thresholds.maxFrameJump),
    `Max frame jump ${metrics.maxFrameJump.toFixed(2)}px exceeds ${thresholds.maxFrameJump}px`,
  );

  return createStage({ metrics, failures, checkCount: 4 });
};

const scoreReconstruction = ({ replay, summary, thresholds }) => {
  const frames = replay.frames;
  const readyFrames = frames.filter((frame) => frame.metrics?.reconstructionReady === true);
  const poseEvidence = readyFrames
    .map((frame) => {
      const frameMetrics = frame.metrics || {};
      const poseSource = frameMetrics.poseSource || null;
      const selectedReconstructionPose = poseSource && poseSource === frameMetrics.poseModel;
      const planarPose = poseSource === 'planar-homography';
      const reconstructionPoseInliers = frameMetrics.reconstructionPoseInliers;
      if (Number.isFinite(reconstructionPoseInliers) && reconstructionPoseInliers > 0) {
        return { frame, inliers: reconstructionPoseInliers };
      }
      if ((selectedReconstructionPose || planarPose) && metricValue(frameMetrics.poseInliers) > 0) {
        return { frame, inliers: frameMetrics.poseInliers };
      }
      return null;
    })
    .filter(Boolean);
  const poseReadyFrames = poseEvidence.map((evidence) => evidence.frame);
  const scoringFrames = readyFrames.length ? readyFrames : frames;
  const mapConfidences = scoringFrames.map((frame) => frame.metrics?.reconstructionMapConfidence);
  const poseInliers = frames.map((frame) => frame.metrics?.poseInliers);
  const poseScoringFrames = poseReadyFrames.length ? poseReadyFrames : readyFrames;
  const readyPoseInliers = poseEvidence.length
    ? poseEvidence.map((evidence) => evidence.inliers)
    : poseScoringFrames.map((frame) => frame.metrics?.poseInliers);
  const normalEvidence = poseReadyFrames
    .map((frame) => {
      const frameMetrics = frame.metrics || {};
      const selectedNormalSource = frameMetrics.poseNormalCandidateSource;
      const selectedReconstructionNormal =
        selectedNormalSource === frameMetrics.poseModel || selectedNormalSource === 'planar-homography';
      if (selectedReconstructionNormal) {
        return { frame, error: frame.normalError };
      }
      if (
        frameMetrics.reconstructionPoseNormalDetached === true &&
        Number.isFinite(frame.reconstructionNormalError)
      ) {
        return { frame, error: frame.reconstructionNormalError };
      }
      return null;
    })
    .filter(Boolean);
  const readyNormalErrors = normalEvidence.length
    ? normalEvidence.map((evidence) => evidence.error)
    : poseScoringFrames.map((frame) => frame.normalError);
  const metrics = {
    readyFrames: readyFrames.length,
    poseReadyFrames: poseReadyFrames.length,
    normalReadyFrames: normalEvidence.length || poseScoringFrames.length,
    readyFrameRatio: frames.length ? readyFrames.length / frames.length : 0,
    poseReadyFrameRatio: frames.length ? poseReadyFrames.length / frames.length : 0,
    normalReadyFrameRatio: frames.length
      ? (normalEvidence.length || poseScoringFrames.length) / frames.length
      : 0,
    minPoseInliers: metricValue(summary.minPoseInliers, minValue(poseInliers)),
    minReadyPoseInliers: minValue(readyPoseInliers),
    meanNormalError: metricValue(summary.meanNormalError),
    maxNormalError: metricValue(summary.maxNormalError),
    meanReadyNormalError: poseScoringFrames.length
      ? meanValue(readyNormalErrors)
      : metricValue(summary.meanNormalError),
    maxReadyNormalError: poseScoringFrames.length
      ? maxValue(readyNormalErrors)
      : metricValue(summary.maxNormalError),
    maxMapConfidence: maxValue(mapConfidences),
    maxDepthQuality: maxValue(scoringFrames.map((frame) => frame.metrics?.reconstructionDepthQuality)),
  };
  const failures = [];

  failWhen(
    failures,
    below(metrics.readyFrameRatio, thresholds.minReadyFrameRatio),
    `Reconstruction ready ratio ${metrics.readyFrameRatio.toFixed(3)} is below ${thresholds.minReadyFrameRatio}`,
  );
  failWhen(
    failures,
    below(metrics.minReadyPoseInliers, thresholds.minPoseInliers),
    `Minimum ready pose inliers ${metrics.minReadyPoseInliers} is below ${thresholds.minPoseInliers}`,
  );
  failWhen(
    failures,
    exceeds(metrics.meanReadyNormalError, thresholds.maxMeanNormalError),
    `Mean ready normal error ${metrics.meanReadyNormalError.toFixed(3)}rad exceeds ${thresholds.maxMeanNormalError}rad`,
  );
  failWhen(
    failures,
    exceeds(metrics.maxReadyNormalError, thresholds.maxNormalError),
    `Max ready normal error ${metrics.maxReadyNormalError.toFixed(3)}rad exceeds ${thresholds.maxNormalError}rad`,
  );
  failWhen(
    failures,
    below(metrics.maxMapConfidence, thresholds.minMapConfidence),
    `Max map confidence ${metrics.maxMapConfidence.toFixed(3)} is below ${thresholds.minMapConfidence}`,
  );

  return createStage({ metrics, failures, checkCount: 5 });
};

const scoreHeadAttachment = ({ headPose, thresholds }) => {
  const summary = headPose.summary || headPose;
  const frames = headPose.frames || [];
  const metrics = {
    visibleMismatches: metricValue(summary.visibleMismatches),
    maxWorldPositionError: metricValue(summary.maxWorldPositionError),
    maxRotationError: metricValue(summary.maxRotationError),
    maxScaleLogError: metricValue(summary.maxScaleLogError),
    maxHeadJumpExcess: metricValue(summary.maxHeadJumpExcess),
    hiddenByPolicyFrames: metricValue(summary.hiddenByPolicyFrames),
    byPoseSource: sourceFrameStats({
      frames,
      sourceForFrame: (frame) => frame.poseSource,
      metricsForFrame: (frame) => ({
        worldPositionError: frame.worldPositionError,
        rotationError: frame.rotationError,
        scaleLogError: frame.scaleLogError,
        headJumpExcess: frame.headJumpExcess,
      }),
    }),
    poseSourceTransitions: transitionFrameStats({
      frames,
      sourceForFrame: (frame) => frame.poseSource,
      metricsForTransition: (frame) => ({
        headJumpExcess: frame.headJumpExcess,
        worldPositionError: frame.worldPositionError,
        rotationError: frame.rotationError,
        scaleLogError: frame.scaleLogError,
      }),
    }),
    worstFrames: summary.worstFrames || [],
  };
  const failures = [];

  failWhen(
    failures,
    exceeds(metrics.visibleMismatches, thresholds.maxVisibleMismatches),
    `${metrics.visibleMismatches} visibility mismatches; expected ${thresholds.maxVisibleMismatches}`,
  );
  failWhen(
    failures,
    exceeds(metrics.maxWorldPositionError, thresholds.maxWorldPositionError),
    `Head world error ${metrics.maxWorldPositionError.toFixed(3)} exceeds ${thresholds.maxWorldPositionError}`,
  );
  failWhen(
    failures,
    exceeds(metrics.maxRotationError, thresholds.maxRotationError),
    `Head rotation error ${metrics.maxRotationError.toFixed(3)}rad exceeds ${thresholds.maxRotationError}rad`,
  );
  failWhen(
    failures,
    exceeds(metrics.maxScaleLogError, thresholds.maxScaleLogError),
    `Head scale log error ${metrics.maxScaleLogError.toFixed(3)} exceeds ${thresholds.maxScaleLogError}`,
  );
  failWhen(
    failures,
    exceeds(metrics.maxHeadJumpExcess, thresholds.maxHeadJumpExcess),
    `Head jump excess ${metrics.maxHeadJumpExcess.toFixed(3)} exceeds ${thresholds.maxHeadJumpExcess}`,
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

const incrementCount = (counts, key, amount = 1) => {
  counts[key] = (counts[key] || 0) + amount;
};

const sortCountEntries = (counts) =>
  Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

const addTrackingSourceMetrics = (trackingSources, source, metrics) => {
  const bucket = trackingSources[source] || {
    frames: 0,
    maxAnchorError: 0,
    weightedMeanAnchorErrorSum: 0,
  };
  const frames = metricValue(metrics.frameCount);
  bucket.frames += frames;
  bucket.maxAnchorError = Math.max(bucket.maxAnchorError, metricValue(metrics.maxAnchorError));
  bucket.weightedMeanAnchorErrorSum += metricValue(metrics.meanAnchorError) * frames;
  trackingSources[source] = bucket;
};

const addHeadPoseSourceMetrics = (headPoseSources, source, metrics) => {
  const bucket = headPoseSources[source] || {
    frames: 0,
    maxWorldPositionError: 0,
    maxRotationError: 0,
    maxHeadJumpExcess: 0,
  };
  const frames = metricValue(metrics.frameCount);
  bucket.frames += frames;
  bucket.maxWorldPositionError = Math.max(
    bucket.maxWorldPositionError,
    metricValue(metrics.maxWorldPositionError),
  );
  bucket.maxRotationError = Math.max(bucket.maxRotationError, metricValue(metrics.maxRotationError));
  bucket.maxHeadJumpExcess = Math.max(bucket.maxHeadJumpExcess, metricValue(metrics.maxHeadJumpExcess));
  headPoseSources[source] = bucket;
};

const addTransitionMetrics = (transitions, transitionName, metrics) => {
  const bucket = transitions[transitionName] || {
    frameCount: 0,
    maxAnchorJump: 0,
    maxAnchorError: 0,
    maxHeadJumpExcess: 0,
    maxWorldPositionError: 0,
    maxRotationError: 0,
  };
  bucket.frameCount += metricValue(metrics.frameCount);
  bucket.maxAnchorJump = Math.max(bucket.maxAnchorJump, metricValue(metrics.maxAnchorJump));
  bucket.maxAnchorError = Math.max(bucket.maxAnchorError, metricValue(metrics.maxAnchorError));
  bucket.maxHeadJumpExcess = Math.max(bucket.maxHeadJumpExcess, metricValue(metrics.maxHeadJumpExcess));
  bucket.maxWorldPositionError = Math.max(
    bucket.maxWorldPositionError,
    metricValue(metrics.maxWorldPositionError),
  );
  bucket.maxRotationError = Math.max(bucket.maxRotationError, metricValue(metrics.maxRotationError));
  transitions[transitionName] = bucket;
};

const finalizeTrackingSources = (trackingSources) => {
  for (const bucket of Object.values(trackingSources)) {
    bucket.meanAnchorError = bucket.frames ? bucket.weightedMeanAnchorErrorSum / bucket.frames : 0;
    delete bucket.weightedMeanAnchorErrorSum;
  }
};

export const summarizeVisionQualityReports = (reports) => {
  const aggregate = {
    total: 0,
    byStatus: {},
    failedByStage: {},
  };
  const failedByMode = {};
  const failedByScenario = {};
  const trackingSources = {};
  const headPoseSources = {};
  const trackingTransitions = {};
  const headPoseTransitions = {};
  const captureConditions = {};

  for (const report of reports) {
    aggregate.total++;
    incrementCount(aggregate.byStatus, report.overallStatus);
    for (const stageName of report.failedStages || []) {
      incrementCount(aggregate.failedByStage, stageName);
    }
    const captureCondition = report.axes?.capture || report.captureCondition || 'nominal';
    const conditionSummary = captureConditions[captureCondition] || {
      total: 0,
      byStatus: {},
      failedByStage: {},
    };
    conditionSummary.total++;
    incrementCount(conditionSummary.byStatus, report.overallStatus);
    for (const stageName of report.failedStages || []) {
      incrementCount(conditionSummary.failedByStage, stageName);
    }
    captureConditions[captureCondition] = conditionSummary;

    if (report.overallStatus === 'fail') {
      incrementCount(failedByMode, report.mode);
      incrementCount(failedByScenario, report.name);
    }

    for (const [source, metrics] of Object.entries(
      report.stages?.tracking?.metrics?.byPositionSource || {},
    )) {
      addTrackingSourceMetrics(trackingSources, source, metrics);
    }

    for (const [source, metrics] of Object.entries(
      report.stages?.headAttachment?.metrics?.byPoseSource || {},
    )) {
      addHeadPoseSourceMetrics(headPoseSources, source, metrics);
    }

    for (const [transition, metrics] of Object.entries(
      report.stages?.tracking?.metrics?.positionSourceTransitions?.byTransition || {},
    )) {
      addTransitionMetrics(trackingTransitions, transition, metrics);
    }

    for (const [transition, metrics] of Object.entries(
      report.stages?.headAttachment?.metrics?.poseSourceTransitions?.byTransition || {},
    )) {
      addTransitionMetrics(headPoseTransitions, transition, metrics);
    }
  }

  finalizeTrackingSources(trackingSources);

  const topTrackingSources = Object.entries(trackingSources)
    .map(([source, metrics]) => ({ source, ...metrics }))
    .sort(
      (left, right) =>
        right.meanAnchorError - left.meanAnchorError ||
        right.maxAnchorError - left.maxAnchorError ||
        left.source.localeCompare(right.source),
    );
  const topHeadPoseSources = Object.entries(headPoseSources)
    .map(([source, metrics]) => ({ source, ...metrics }))
    .sort(
      (left, right) =>
        right.maxWorldPositionError - left.maxWorldPositionError ||
        right.maxRotationError - left.maxRotationError ||
        left.source.localeCompare(right.source),
    );
  const topTrackingTransitions = Object.entries(trackingTransitions)
    .map(([transition, metrics]) => ({ transition, ...metrics }))
    .sort(
      (left, right) =>
        right.maxAnchorJump - left.maxAnchorJump ||
        right.maxAnchorError - left.maxAnchorError ||
        left.transition.localeCompare(right.transition),
    );
  const topHeadPoseTransitions = Object.entries(headPoseTransitions)
    .map(([transition, metrics]) => ({ transition, ...metrics }))
    .sort(
      (left, right) =>
        right.maxHeadJumpExcess - left.maxHeadJumpExcess ||
        right.maxWorldPositionError - left.maxWorldPositionError ||
        right.maxRotationError - left.maxRotationError ||
        left.transition.localeCompare(right.transition),
    );

  return {
    aggregate,
    failedByMode,
    failedByScenario,
    trackingSources,
    headPoseSources,
    trackingTransitions,
    headPoseTransitions,
    captureConditions,
    topFailingScenarios: sortCountEntries(failedByScenario),
    topTrackingSources,
    topHeadPoseSources,
    topTrackingTransitions,
    topHeadPoseTransitions,
  };
};
