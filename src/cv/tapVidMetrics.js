import { findTapVidEligibleReappearances } from './tapVidReappearanceEvents.js';
export { assertTapVidAggregateQualityFloor, assertTapVidQueryQualityFloor } from './tapVidQualityFloor.js';
import {
  computeTapVidTemporalMetrics,
  TAP_VID_STABLE_REDETECTION_DURATION_MS,
} from './tapVidTemporalMetrics.js';

export const TAP_VID_DISTANCE_THRESHOLDS = Object.freeze([1, 2, 4, 8, 16]);
export const TAP_VID_REDETECTION_DURATIONS = Object.freeze([1, 4, 16, 64, 256]);
export { TAP_VID_STABLE_REDETECTION_DURATION_MS };

const requireDimension = (value, name) => {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
};

const requireFramesPerSecond = (value) => {
  if (!Number.isFinite(value) || value <= 0 || value > 120) {
    throw new TypeError('framesPerSecond must be greater than 0 and at most 120');
  }
  return value;
};

const requirePoint = (point, name) => {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
    throw new TypeError(`${name} must be a finite [x, y] pair`);
  }
  return point;
};

const requireBooleanFrames = (values, frameCount, name) => {
  if (
    !Array.isArray(values) ||
    values.length !== frameCount ||
    !values.every((value) => typeof value === 'boolean')
  ) {
    throw new TypeError(`${name} must match the ground-truth frame count and contain booleans`);
  }
  return values;
};

const validateMetricTrack = (track, index) => {
  if (!track || typeof track !== 'object' || Array.isArray(track)) {
    throw new TypeError(`tracks[${index}] must be an object`);
  }
  const frameCount = track.groundTruthPoints?.length;
  if (!Number.isInteger(frameCount) || frameCount < 2) {
    throw new TypeError(`tracks[${index}].groundTruthPoints must contain at least two frames`);
  }
  if (!Number.isInteger(track.queryFrame) || track.queryFrame < 0 || track.queryFrame >= frameCount - 1) {
    throw new TypeError(`tracks[${index}].queryFrame must precede an evaluation frame`);
  }
  const groundTruthPoints = track.groundTruthPoints.map((point, frameIndex) =>
    requirePoint(point, `tracks[${index}].groundTruthPoints[${frameIndex}]`),
  );
  if (!Array.isArray(track.predictedPoints) || track.predictedPoints.length !== frameCount) {
    throw new TypeError(`tracks[${index}].predictedPoints must match the ground-truth frame count`);
  }
  const predictedPoints = track.predictedPoints.map((point, frameIndex) =>
    requirePoint(point, `tracks[${index}].predictedPoints[${frameIndex}]`),
  );
  const groundTruthOccluded = requireBooleanFrames(
    track.groundTruthOccluded,
    frameCount,
    `tracks[${index}].groundTruthOccluded`,
  );
  if (groundTruthOccluded[track.queryFrame]) {
    throw new TypeError(`tracks[${index}] query frame must be visible`);
  }
  const predictedOccluded = requireBooleanFrames(
    track.predictedOccluded,
    frameCount,
    `tracks[${index}].predictedOccluded`,
  );
  if (!groundTruthOccluded.slice(track.queryFrame + 1).some((occluded) => !occluded)) {
    throw new TypeError(`tracks[${index}] must contain a visible evaluation point`);
  }
  return {
    queryFrame: track.queryFrame,
    groundTruthPoints,
    groundTruthOccluded,
    predictedPoints,
    predictedOccluded,
  };
};

const metricName = (prefix, threshold) => `${prefix}${threshold}`;

const interpolatedPercentile = (sortedValues, percentile) => {
  const position = (sortedValues.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];
  return lower + (upper - lower) * (position - lowerIndex);
};

const computeSegmentAverageJaccard = ({ events, minimumUndetectableFrames, scaleX, scaleY }) => {
  const eligibleEvents = events.filter((event) => event.undetectableFrames >= minimumUndetectableFrames);
  if (eligibleEvents.length === 0) return null;

  const counters = new Map(
    TAP_VID_DISTANCE_THRESHOLDS.map((threshold) => [
      threshold,
      { visibleGroundTruth: 0, truePositive: 0, falsePositive: 0 },
    ]),
  );
  for (const { track, frameIndex: segmentStart } of eligibleEvents) {
    for (let frameIndex = segmentStart; frameIndex < track.groundTruthPoints.length; frameIndex++) {
      const groundTruthVisible = !track.groundTruthOccluded[frameIndex];
      const predictedVisible = !track.predictedOccluded[frameIndex];
      const deltaX = (track.predictedPoints[frameIndex][0] - track.groundTruthPoints[frameIndex][0]) * scaleX;
      const deltaY = (track.predictedPoints[frameIndex][1] - track.groundTruthPoints[frameIndex][1]) * scaleY;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;

      for (const threshold of TAP_VID_DISTANCE_THRESHOLDS) {
        const counter = counters.get(threshold);
        const withinThreshold = distanceSquared < threshold * threshold;
        const correct = groundTruthVisible && withinThreshold;
        if (groundTruthVisible) counter.visibleGroundTruth++;
        if (correct && predictedVisible) counter.truePositive++;
        if (predictedVisible && (!groundTruthVisible || !withinThreshold)) counter.falsePositive++;
      }
    }
  }

  return (
    [...counters.values()].reduce(
      (sum, counter) => sum + counter.truePositive / (counter.visibleGroundTruth + counter.falsePositive),
      0,
    ) / TAP_VID_DISTANCE_THRESHOLDS.length
  );
};

const computeReDetectionMetrics = ({ tracks, scaleX, scaleY }) => {
  const events = tracks.flatMap(findTapVidEligibleReappearances);
  const byMinimumUndetectableFrames = Object.fromEntries(
    TAP_VID_REDETECTION_DURATIONS.map((minimumUndetectableFrames) => [
      minimumUndetectableFrames,
      computeSegmentAverageJaccard({ events, minimumUndetectableFrames, scaleX, scaleY }),
    ]),
  );
  const scores = Object.values(byMinimumUndetectableFrames).filter(Number.isFinite);
  return {
    eligibleReappearanceCount: events.length,
    maximumEligibleUndetectableFrames:
      events.length === 0 ? 0 : Math.max(...events.map((event) => event.undetectableFrames)),
    reDetectionAverageJaccardByMinimumUndetectableFrames: byMinimumUndetectableFrames,
    reDetectionAverageJaccard:
      scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
  };
};

export const computeTapVidMetrics = ({ width, height, framesPerSecond, tracks }) => {
  const sourceWidth = requireDimension(width, 'width');
  const sourceHeight = requireDimension(height, 'height');
  const sourceFramesPerSecond = requireFramesPerSecond(framesPerSecond);
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new TypeError('tracks must be a non-empty array');
  }
  const validatedTracks = tracks.map(validateMetricTrack);
  const counters = new Map(
    TAP_VID_DISTANCE_THRESHOLDS.map((threshold) => [
      threshold,
      { correct: 0, truePositive: 0, falsePositive: 0 },
    ]),
  );
  const scaleX = 256 / sourceWidth;
  const scaleY = 256 / sourceHeight;
  let evaluationPointCount = 0;
  let visibleGroundTruthPointCount = 0;
  let predictedVisiblePointCount = 0;
  let visibilityTruePositiveCount = 0;
  let visibilityTrueNegativeCount = 0;
  let visibilityFalsePositiveCount = 0;
  let visibilityFalseNegativeCount = 0;
  let correctOcclusionCount = 0;
  const visiblePointErrors = [];

  for (const track of validatedTracks) {
    for (let frameIndex = track.queryFrame + 1; frameIndex < track.groundTruthPoints.length; frameIndex++) {
      evaluationPointCount++;
      const groundTruthVisible = !track.groundTruthOccluded[frameIndex];
      const predictedVisible = !track.predictedOccluded[frameIndex];
      if (groundTruthVisible) visibleGroundTruthPointCount++;
      if (predictedVisible) predictedVisiblePointCount++;
      if (groundTruthVisible && predictedVisible) visibilityTruePositiveCount++;
      if (!groundTruthVisible && !predictedVisible) visibilityTrueNegativeCount++;
      if (!groundTruthVisible && predictedVisible) visibilityFalsePositiveCount++;
      if (groundTruthVisible && !predictedVisible) visibilityFalseNegativeCount++;
      if (groundTruthVisible === predictedVisible) correctOcclusionCount++;
      const deltaX = (track.predictedPoints[frameIndex][0] - track.groundTruthPoints[frameIndex][0]) * scaleX;
      const deltaY = (track.predictedPoints[frameIndex][1] - track.groundTruthPoints[frameIndex][1]) * scaleY;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (groundTruthVisible) visiblePointErrors.push(Math.sqrt(distanceSquared));

      for (const threshold of TAP_VID_DISTANCE_THRESHOLDS) {
        const counter = counters.get(threshold);
        const withinThreshold = distanceSquared < threshold * threshold;
        const correct = groundTruthVisible && withinThreshold;
        if (correct) counter.correct++;
        if (correct && predictedVisible) counter.truePositive++;
        if (predictedVisible && (!groundTruthVisible || !withinThreshold)) counter.falsePositive++;
      }
    }
  }

  const metrics = {
    queryCount: validatedTracks.length,
    evaluationPointCount,
    visibleGroundTruthPointCount,
    predictedVisiblePointCount,
    visibilityTruePositiveCount,
    visibilityTrueNegativeCount,
    visibilityFalsePositiveCount,
    visibilityFalseNegativeCount,
    occlusionAccuracy: correctOcclusionCount / evaluationPointCount,
    meanVisiblePointError:
      visiblePointErrors.reduce((sum, error) => sum + error, 0) / visiblePointErrors.length,
  };
  visiblePointErrors.sort((left, right) => left - right);
  metrics.p50VisiblePointError = interpolatedPercentile(visiblePointErrors, 0.5);
  metrics.p95VisiblePointError = interpolatedPercentile(visiblePointErrors, 0.95);
  let pointsWithinSum = 0;
  let jaccardSum = 0;
  for (const threshold of TAP_VID_DISTANCE_THRESHOLDS) {
    const counter = counters.get(threshold);
    const pointsWithin = counter.correct / visibleGroundTruthPointCount;
    const jaccard = counter.truePositive / (visibleGroundTruthPointCount + counter.falsePositive);
    metrics[metricName('ptsWithin', threshold)] = pointsWithin;
    metrics[metricName('jaccard', threshold)] = jaccard;
    pointsWithinSum += pointsWithin;
    jaccardSum += jaccard;
  }
  metrics.averagePointsWithinThreshold = pointsWithinSum / TAP_VID_DISTANCE_THRESHOLDS.length;
  metrics.averageJaccard = jaccardSum / TAP_VID_DISTANCE_THRESHOLDS.length;
  return Object.assign(
    metrics,
    computeReDetectionMetrics({ tracks: validatedTracks, scaleX, scaleY }),
    computeTapVidTemporalMetrics({
      tracks: validatedTracks,
      framesPerSecond: sourceFramesPerSecond,
      scaleX,
      scaleY,
    }),
  );
};
