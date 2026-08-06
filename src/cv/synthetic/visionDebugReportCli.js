export const debugReportUsesBenchmarkMatrix = ({ size = 'representative', filters = {} } = {}) =>
  size !== 'representative' || Object.keys(filters).length > 0;

export const selectedDebugFrameIndexes = ({ frameCount, trackingWorstFrames = [], headWorstFrames = [] }) =>
  [
    ...new Set([
      1,
      Math.max(1, Math.floor(frameCount * 0.25)),
      Math.max(1, Math.floor(frameCount * 0.5)),
      Math.max(1, Math.floor(frameCount * 0.75)),
      frameCount,
      ...trackingWorstFrames.map((frame) => frame.index),
      ...headWorstFrames.map((frame) => frame.index),
    ]),
  ].sort((left, right) => left - right);
