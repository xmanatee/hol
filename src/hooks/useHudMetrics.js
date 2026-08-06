import { useEffect, useState } from 'react';

const METRIC_DEFINITIONS = {
  'Capture FPS': {
    target: 28,
    isRed: (value) => value < 28,
    unit: 'FPS',
  },
  'Camera frame cost': {
    target: 4,
    isRed: (value) => value > 4,
    unit: 'ms',
  },
  'Anchor processing time': {
    target: 6,
    isRed: (value) => value > 6,
    unit: 'ms',
  },
  'Keypoint count': {
    target: 12,
    isRed: (value) => value < 12,
    unit: '',
  },
  'Tracking success rate': {
    target: 50,
    isRed: (value) => value < 50,
    unit: '%',
  },
  'Homography inliers': {
    target: 15,
    isRed: (value) => value < 8,
    unit: '',
  },
  'Object pose inliers': {
    target: 15,
    isRed: (value) => value < 12,
    unit: '',
  },
  'Pose residual': {
    target: 3,
    isRed: (value) => value > 5,
    unit: 'px',
  },
  'Pose foreshortening': {
    target: 0.9,
    isRed: () => false,
    unit: '',
  },
  'Template quality': {
    target: 25,
    isRed: (value) => value < 12,
    unit: '%',
  },
  'Recovery attempts': {
    target: 0,
    isRed: (value) => value > 0,
    unit: '',
  },
  'Lost frame count': {
    target: 0,
    isRed: (value) => value > 3,
    unit: '',
  },
  'Object Count': {
    target: 1,
    isRed: (value) => value === 0,
    unit: '',
  },
  'Stable Anchors': {
    target: 1,
    isRed: (value) => value === 0,
    unit: '',
  },
  'Stability score': {
    target: 0.75,
    isRed: (value) => value < 0.75,
    unit: '',
  },
  'lock time': {
    target: 1.0,
    isRed: (value) => value < 1.0, // Assuming this is checked when S >= 0.75
    unit: 's',
  },
  'Normal jitter': {
    target: 6,
    isRed: (value) => value > 6,
    unit: '°',
  },
  'Mode confidence': {
    // This is more about display than a numerical target for red/green
    target: null,
    isRed: () => false, // No red condition based on the description
    unit: '',
  },
  'Short-loss survival': {
    target: 85,
    isRed: (value) => value < 85,
    unit: '%',
  },
  'Reattach latency': {
    target: 1000,
    isRed: (value) => value > 1000,
    unit: 'ms',
  },
  'Mask IoU stability': {
    target: 0.85,
    isRed: (value) => value < 0.85,
    unit: '%',
  },
  'Mask cost': {
    target: 6,
    isRed: (value) => value > 6,
    unit: 'ms',
  },
  'Attachment drift': {
    target: 0.05,
    isRed: (value) => value > 0.05,
    unit: '% bbox',
  },
  'Pose solve time': {
    target: 1.5,
    isRed: (value) => value > 1.5,
    unit: 'ms',
  },
  'Seam contrast ratio': {
    target: 0.15,
    isRed: (value) => value > 0.15,
    unit: '',
  },
  'Effect FPS': {
    target: 55,
    isRed: (value) => value < 55,
    unit: 'FPS',
  },
  'Persona RTT': {
    target: 1500,
    isRed: (value) => value > 1500,
    unit: 'ms',
  },
  'Confidence tag': {
    target: 0.6,
    isRed: (value) => value < 0.6,
    unit: '',
  },
  'TTS latency to first audio': {
    target: 700,
    isRed: (value) => value > 700,
    unit: 'ms',
  },
  'Audio underruns': {
    target: 0,
    isRed: (value) => value > 0,
    unit: '#',
  },
  'A/V sync error': {
    target: 80,
    isRed: (value) => Math.abs(value) > 80,
    unit: 'ms',
  },
  'Viseme stability': {
    target: 90,
    isRed: (value) => value < 90,
    unit: '%',
  },
  'Gaze error': {
    target: 8,
    isRed: (value) => value > 8,
    unit: '°',
  },
  'Micro-motion energy': {
    target: [1, 3], // Range target
    isRed: (value) => value < 1 || value > 3,
    unit: '°',
  },
  'Lost time ratio': {
    target: 10,
    isRed: (value) => value > 10,
    unit: '%',
  },
  'Exit recovery path': {
    // This is more about display than a numerical target for red/green
    target: 80, // Re-attach success rate
    isRed: (value) => value < 80, // Assuming value is the re-attach success rate
    unit: '%',
  },
  '95p frame time': {
    target: 22,
    isRed: (value) => value > 22,
    unit: 'ms',
  },
  'Thermal headroom': {
    target: 80,
    isRed: (value) => value > 80, // Assuming sustained for 60s is handled externally
    unit: '%',
  },
  'GC pressure': {
    target: 30,
    isRed: (value) => value > 30,
    unit: 'MB',
  },
};

const DEFAULT_METRIC_DEFINITION = {
  target: null,
  isRed: () => false,
  unit: '',
};

const createMetricEntry = (previousEntry, name, value) => {
  const definition = METRIC_DEFINITIONS[name] || DEFAULT_METRIC_DEFINITION;

  return {
    ...previousEntry,
    value,
    isRed: definition.isRed(value),
    unit: definition.unit,
    target: definition.target,
  };
};

export const createHudMetricStore = (scheduleFlush) => {
  let metrics = {};
  let pendingMetrics = {};
  let cancelScheduledFlush = null;
  const listeners = new Set();

  const promotePendingMetrics = () => {
    const pendingNames = Object.keys(pendingMetrics);
    if (pendingNames.length === 0) {
      return false;
    }

    metrics = {
      ...metrics,
      ...pendingMetrics,
    };
    pendingMetrics = {};
    return true;
  };

  const cancelPendingFlush = () => {
    if (!cancelScheduledFlush) {
      return;
    }
    const cancel = cancelScheduledFlush;
    cancelScheduledFlush = null;
    cancel();
  };

  const flush = () => {
    cancelScheduledFlush = null;
    if (listeners.size === 0 || !promotePendingMetrics()) {
      return;
    }
    listeners.forEach((listener) => {
      listener(metrics);
    });
  };

  return {
    getSnapshot: () => metrics,
    hasSubscribers: () => listeners.size > 0,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        promotePendingMetrics();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          cancelPendingFlush();
        }
      };
    },
    updateMetric: (name, value) => {
      const previousEntry = pendingMetrics[name] || metrics[name];
      if (previousEntry && Object.is(previousEntry.value, value)) {
        return;
      }
      pendingMetrics[name] = createMetricEntry(previousEntry, name, value);
      if (listeners.size > 0 && !cancelScheduledFlush) {
        cancelScheduledFlush = scheduleFlush(flush);
      }
    },
    dispose: () => {
      cancelPendingFlush();
      listeners.clear();
      metrics = {};
      pendingMetrics = {};
    },
  };
};

const scheduleMetricFlush = (callback) => {
  const timeoutId = globalThis.setTimeout(callback, 100);
  return () => globalThis.clearTimeout(timeoutId);
};

export const useHudMetrics = () => {
  const [store] = useState(() => createHudMetricStore(scheduleMetricFlush));
  useEffect(() => () => store.dispose(), [store]);

  return { metricStore: store, updateMetric: store.updateMetric };
};
