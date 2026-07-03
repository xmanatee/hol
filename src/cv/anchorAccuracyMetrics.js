export const ANCHOR_ACCURACY_THRESHOLDS = [4, 8, 16];

const sortedSuccessfulAnchorErrors = frames => frames
  .filter(frame => frame.success && Number.isFinite(frame.anchorError))
  .map(frame => frame.anchorError)
  .sort((left, right) => left - right);

const interpolatedPercentile = (sortedValues, percentile) => {
  if (!sortedValues.length) return 0;

  const position = (sortedValues.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];
  return lower + (upper - lower) * (position - lowerIndex);
};

export const anchorAccuracyAt = (frames, threshold) => {
  if (!frames.length) return 0;

  return frames.filter(frame => (
    frame.success &&
    Number.isFinite(frame.anchorError) &&
    frame.anchorError <= threshold
  )).length / frames.length;
};

export const anchorAccuracyMetrics = frames => Object.fromEntries(ANCHOR_ACCURACY_THRESHOLDS.map(threshold => [
  `anchorAccuracyAt${threshold}`,
  anchorAccuracyAt(frames, threshold),
]));

export const anchorErrorPercentileMetrics = frames => {
  const sortedErrors = sortedSuccessfulAnchorErrors(frames);
  return {
    p50AnchorError: interpolatedPercentile(sortedErrors, 0.5),
    p95AnchorError: interpolatedPercentile(sortedErrors, 0.95),
  };
};
