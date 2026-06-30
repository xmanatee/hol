export const ANCHOR_ACCURACY_THRESHOLDS = [4, 8, 16];

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
