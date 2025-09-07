import { useState, useCallback } from 'react';

const METRIC_DEFINITIONS = {
  // Phase 1
  'Capture FPS': {
    target: 28,
    isRed: (value) => value < 28,
    unit: 'FPS',
  },
  // Phase 2
  'Render frame time': {
    target: 2.5,
    isRed: (value) => value > 2.5,
    unit: 'ms',
  },
  // Phase 3
  'Detection amortized cost': {
    target: 4,
    isRed: (value) => value > 4,
    unit: 'ms/frame',
  },
  'Track ID persistence': {
    target: 90,
    isRed: (value) => value < 90,
    unit: '%',
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
  // Phase 4
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
  // Phase 5
  'Normal jitter': {
    target: 6,
    isRed: (value) => value > 6,
    unit: '°',
  },
  'Mode confidence': { // This is more about display than a numerical target for red/green
    target: null,
    isRed: () => false, // No red condition based on the description
    unit: '',
  },
  // Phase 6
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
  // Phase 7
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
  // Phase 8
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
  // Phase 9
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
  // Phase 10
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
  // Phase 11
  'Agent start latency': {
    target: 700,
    isRed: (value) => value > 700,
    unit: 'ms',
  },
  'Audio underruns': {
    target: 0,
    isRed: (value) => value > 0,
    unit: '#',
  },
  // Phase 12
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
  // Phase 13
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
  // Phase 14
  'Lost time ratio': {
    target: 10,
    isRed: (value) => value > 10,
    unit: '%',
  },
  'Exit recovery path': { // This is more about display than a numerical target for red/green
    target: 80, // Re-attach success rate
    isRed: (value) => value < 80, // Assuming value is the re-attach success rate
    unit: '%',
  },
  // Phase 15
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

export const useHudMetrics = () => {
  const [metrics, setMetrics] = useState(() => {
    const initialMetrics = {};
    for (const key in METRIC_DEFINITIONS) {
      initialMetrics[key] = {
        value: null,
        isRed: false,
        unit: METRIC_DEFINITIONS[key].unit,
        target: METRIC_DEFINITIONS[key].target,
      };
    }
    return initialMetrics;
  });

  const updateMetric = useCallback((name, value) => {
    if (!METRIC_DEFINITIONS[name]) {
      console.warn('[HudMetrics] Unknown metric:', name);
      return;
    }

    // Debug: console.log('[HudMetrics] Updating metric:', name, '=', value);
    setMetrics((prevMetrics) => {
      const definition = METRIC_DEFINITIONS[name];
      const isRed = definition.isRed(value);

      return {
        ...prevMetrics,
        [name]: {
          ...prevMetrics[name],
          value,
          isRed,
        },
      };
    });
  }, []);

  return { metrics, updateMetric };
};
