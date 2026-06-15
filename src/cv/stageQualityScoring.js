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

const sourceName = source => source || 'none';

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

  return Object.fromEntries([...groups.entries()].map(([source, group]) => {
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
  }));
};

const pointDistance = (left, right) => {
  if (!left || !right) return 0;
  if (!Number.isFinite(left.x) || !Number.isFinite(left.y) ||
      !Number.isFinite(right.x) || !Number.isFinite(right.y)) {
    return 0;
  }
  return Math.hypot(left.x - right.x, left.y - right.y);
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

  const transitionMetrics = Object.fromEntries([...byTransition.entries()].map(([key, group]) => {
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
  }));

  return {
    transitionCount: transitions.length,
    maxAnchorJump: maxValue(transitions.map(transition => transition.anchorJump)),
    maxAnchorError: maxValue(transitions.map(transition => transition.anchorError)),
    maxHeadJumpExcess: maxValue(transitions.map(transition => transition.headJumpExcess)),
    maxWorldPositionError: maxValue(transitions.map(transition => transition.worldPositionError)),
    maxRotationError: maxValue(transitions.map(transition => transition.rotationError)),
    byTransition: transitionMetrics,
    worstTransitions: [...transitions]
      .sort((left, right) => (
        (right.anchorJump || right.headJumpExcess || right.worldPositionError || 0) -
        (left.anchorJump || left.headJumpExcess || left.worldPositionError || 0)
      ))
      .slice(0, 6),
  };
};

const worstTrackingFrames = frames => [...frames]
  .filter(frame => Number.isFinite(frame.anchorError))
  .sort((left, right) => right.anchorError - left.anchorError)
  .slice(0, 6)
  .map(frame => ({
    index: frame.index,
    positionSource: frame.positionSource || frame.method || null,
    poseSource: frame.poseSource || frame.metrics?.poseSource || null,
    anchorError: frame.anchorError,
  }));

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
  const successfulFrames = replay.frames.filter(frame => frame.success);
  const metrics = {
    frameCount: replay.frames.length,
    failedFrames,
    maxAnchorError: metricValue(summary.maxAnchorError),
    meanAnchorError: metricValue(summary.meanAnchorError),
    maxFrameJump: metricValue(summary.maxFrameJump),
    trackingSuccessRate: meanValue(replay.frames.map(frame => frame.metrics?.trackingSuccessRate)),
    maxBackgroundRejected: maxValue(replay.frames.map(frame => frame.metrics?.backgroundRejected)),
    byPositionSource: sourceFrameStats({
      frames: successfulFrames,
      sourceForFrame: frame => frame.positionSource || frame.method,
      metricsForFrame: frame => ({
        anchorError: frame.anchorError,
        normalError: frame.normalError,
        poseInliers: frame.metrics?.poseInliers,
      }),
    }),
    positionSourceTransitions: transitionFrameStats({
      frames: successfulFrames,
      sourceForFrame: frame => frame.positionSource || frame.method,
      metricsForTransition: (frame, previous) => ({
        anchorJump: pointDistance(frame.predicted, previous.predicted),
        anchorError: frame.anchorError,
        normalError: frame.normalError,
      }),
    }),
    worstFrames: worstTrackingFrames(successfulFrames),
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
      sourceForFrame: frame => frame.poseSource,
      metricsForFrame: frame => ({
        worldPositionError: frame.worldPositionError,
        rotationError: frame.rotationError,
        scaleLogError: frame.scaleLogError,
        headJumpExcess: frame.headJumpExcess,
      }),
    }),
    poseSourceTransitions: transitionFrameStats({
      frames,
      sourceForFrame: frame => frame.poseSource,
      metricsForTransition: frame => ({
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

const incrementCount = (counts, key, amount = 1) => {
  counts[key] = (counts[key] || 0) + amount;
};

const sortCountEntries = counts => Object.entries(counts)
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
  bucket.maxWorldPositionError = Math.max(bucket.maxWorldPositionError, metricValue(metrics.maxWorldPositionError));
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
  bucket.maxWorldPositionError = Math.max(bucket.maxWorldPositionError, metricValue(metrics.maxWorldPositionError));
  bucket.maxRotationError = Math.max(bucket.maxRotationError, metricValue(metrics.maxRotationError));
  transitions[transitionName] = bucket;
};

const finalizeTrackingSources = trackingSources => {
  for (const bucket of Object.values(trackingSources)) {
    bucket.meanAnchorError = bucket.frames
      ? bucket.weightedMeanAnchorErrorSum / bucket.frames
      : 0;
    delete bucket.weightedMeanAnchorErrorSum;
  }
};

export const summarizeVisionQualityReports = reports => {
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

  for (const report of reports) {
    aggregate.total++;
    incrementCount(aggregate.byStatus, report.overallStatus);
    for (const stageName of report.failedStages || []) {
      incrementCount(aggregate.failedByStage, stageName);
    }

    if (report.overallStatus === 'fail') {
      incrementCount(failedByMode, report.mode);
      incrementCount(failedByScenario, report.name);
    }

    for (const [source, metrics] of Object.entries(report.stages?.tracking?.metrics?.byPositionSource || {})) {
      addTrackingSourceMetrics(trackingSources, source, metrics);
    }

    for (const [source, metrics] of Object.entries(report.stages?.headAttachment?.metrics?.byPoseSource || {})) {
      addHeadPoseSourceMetrics(headPoseSources, source, metrics);
    }

    for (const [transition, metrics] of Object.entries(report.stages?.tracking?.metrics?.positionSourceTransitions?.byTransition || {})) {
      addTransitionMetrics(trackingTransitions, transition, metrics);
    }

    for (const [transition, metrics] of Object.entries(report.stages?.headAttachment?.metrics?.poseSourceTransitions?.byTransition || {})) {
      addTransitionMetrics(headPoseTransitions, transition, metrics);
    }
  }

  finalizeTrackingSources(trackingSources);

  const topTrackingSources = Object.entries(trackingSources)
    .map(([source, metrics]) => ({ source, ...metrics }))
    .sort((left, right) => (
      right.meanAnchorError - left.meanAnchorError ||
      right.maxAnchorError - left.maxAnchorError ||
      left.source.localeCompare(right.source)
    ));
  const topHeadPoseSources = Object.entries(headPoseSources)
    .map(([source, metrics]) => ({ source, ...metrics }))
    .sort((left, right) => (
      right.maxWorldPositionError - left.maxWorldPositionError ||
      right.maxRotationError - left.maxRotationError ||
      left.source.localeCompare(right.source)
    ));
  const topTrackingTransitions = Object.entries(trackingTransitions)
    .map(([transition, metrics]) => ({ transition, ...metrics }))
    .sort((left, right) => (
      right.maxAnchorJump - left.maxAnchorJump ||
      right.maxAnchorError - left.maxAnchorError ||
      left.transition.localeCompare(right.transition)
    ));
  const topHeadPoseTransitions = Object.entries(headPoseTransitions)
    .map(([transition, metrics]) => ({ transition, ...metrics }))
    .sort((left, right) => (
      right.maxHeadJumpExcess - left.maxHeadJumpExcess ||
      right.maxWorldPositionError - left.maxWorldPositionError ||
      right.maxRotationError - left.maxRotationError ||
      left.transition.localeCompare(right.transition)
    ));

  return {
    aggregate,
    failedByMode,
    failedByScenario,
    trackingSources,
    headPoseSources,
    trackingTransitions,
    headPoseTransitions,
    topFailingScenarios: sortCountEntries(failedByScenario),
    topTrackingSources,
    topHeadPoseSources,
    topTrackingTransitions,
    topHeadPoseTransitions,
  };
};
