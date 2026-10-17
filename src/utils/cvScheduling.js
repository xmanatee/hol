export const ANCHOR_TRACKING_INTERVAL_MS = 1000 / 15;
export const SEGMENTATION_REFRESH_CHECK_INTERVAL_MS = 250;
export const MAX_OBJECT_OBSERVATION_AGE_MS = 300;

export const isObjectObservationFresh = (capturedAt, now) =>
  Number.isFinite(capturedAt) && now >= capturedAt && now - capturedAt <= MAX_OBJECT_OBSERVATION_AGE_MS;

export const isSelectedObjectObservationFresh = (state, now) =>
  state.activeAnchor != null &&
  state.observationExpired !== true &&
  isObjectObservationFresh(state.sampledAt, now);

const SCHEDULING_EPSILON_MS = 1e-6;

export const shouldRunTimedStep = ({ now, lastRunAt, intervalMs }) =>
  lastRunAt === 0 || now - lastRunAt + SCHEDULING_EPSILON_MS >= intervalMs;
