export const ANCHOR_TRACKING_INTERVAL_MS = 1000 / 15;
export const SEGMENTATION_REFRESH_CHECK_INTERVAL_MS = 250;
export const TAP_FRAME_SNAPSHOT_INTERVAL_MS = 500;

export const shouldRunTimedStep = ({ now, lastRunAt, intervalMs }) => (
  lastRunAt === 0 || now - lastRunAt >= intervalMs
);
