export const ANCHOR_TRACKING_INTERVAL_MS = 1000 / 15;
export const SEGMENTATION_REFRESH_CHECK_INTERVAL_MS = 250;

const SCHEDULING_EPSILON_MS = 1e-6;

export const shouldRunTimedStep = ({ now, lastRunAt, intervalMs }) =>
  lastRunAt === 0 || now - lastRunAt + SCHEDULING_EPSILON_MS >= intervalMs;
