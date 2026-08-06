import { createFullLossReentrySequence } from './targetLossSequence.js';

export const HARD_BENCHMARK_CASES = Object.freeze([
  {
    object: 'planar-book',
    background: 'shelf',
    motion: 'fast',
    occlusion: 'repeated',
    capture: 'handheld-night',
  },
  {
    object: 'glossy-phone',
    background: 'window',
    motion: 'fast',
    occlusion: 'early',
    capture: 'rolling-motion',
  },
  {
    object: 'handled-mug',
    background: 'kitchen',
    motion: 'fast',
    occlusion: 'repeated',
    capture: 'handheld-night',
  },
  {
    object: 'glossy-can',
    background: 'busy',
    motion: 'fast',
    occlusion: 'late',
    capture: 'low-light-motion',
  },
  {
    object: 'rigid-box',
    background: 'shelf',
    motion: 'standard',
    occlusion: 'repeated',
    capture: 'handheld-night',
  },
  {
    object: 'textured-ball',
    background: 'busy',
    motion: 'fast',
    occlusion: 'mid',
    capture: 'low-light-motion',
  },
  {
    object: 'laminated-card',
    background: 'window',
    motion: 'fast',
    occlusion: 'full-loss',
    frameCount: 36,
    capture: 'rolling-motion',
    event: 'full-loss-reentry',
    create: createFullLossReentrySequence,
    replayOptions: {
      refreshObjectSupportMask: false,
      suppressDepthWhenTargetAbsent: true,
    },
  },
]);
