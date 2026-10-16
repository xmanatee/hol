import { useEffect, useState } from 'react';

const EMPTY_METRICS = Object.freeze({ captureFps: null, frameWorkMs: null });
const scheduleMetricFlush = (callback) => {
  const timeoutId = globalThis.setTimeout(callback, 100);
  return () => globalThis.clearTimeout(timeoutId);
};

export const createCameraMetricsStore = (scheduleFlush = scheduleMetricFlush) => {
  let snapshot = EMPTY_METRICS;
  let captureFps = null;
  let frameWorkMs = null;
  let cancelScheduledFlush = null;
  const listeners = new Set();

  const promoteLatest = () => {
    if (snapshot.captureFps === captureFps && snapshot.frameWorkMs === frameWorkMs) return false;
    snapshot = Object.freeze({ captureFps, frameWorkMs });
    return true;
  };
  const cancelPendingFlush = () => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;
  };
  const notify = () => {
    listeners.forEach((listener) => {
      listener();
    });
  };
  const flush = () => {
    cancelScheduledFlush = null;
    if (promoteLatest()) notify();
  };
  const reset = () => {
    cancelPendingFlush();
    captureFps = null;
    frameWorkMs = null;
    if (promoteLatest()) notify();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (listeners.size === 0) promoteLatest();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) cancelPendingFlush();
      };
    },
    recordFrame: (fps, workMs) => {
      if (fps !== null && (!Number.isFinite(fps) || fps <= 0)) {
        throw new RangeError('Camera capture FPS must be null or finite and positive');
      }
      if (!Number.isFinite(workMs) || workMs < 0) {
        throw new RangeError('Camera frame work must be finite and non-negative');
      }
      if (captureFps === fps && frameWorkMs === workMs) return;
      captureFps = fps;
      frameWorkMs = workMs;
      if (listeners.size > 0 && !cancelScheduledFlush) {
        cancelScheduledFlush = scheduleFlush(flush);
      }
    },
    reset,
    dispose: () => {
      listeners.clear();
      reset();
    },
  };
};

export const useCameraMetrics = () => {
  const [store] = useState(createCameraMetricsStore);
  useEffect(() => () => store.dispose(), [store]);
  return store;
};
