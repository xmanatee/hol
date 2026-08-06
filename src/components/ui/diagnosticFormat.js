export const formatPercent = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(0)}%` : 'N/A');

export const formatNumber = (value, digits = 0) =>
  typeof value === 'number' ? value.toFixed(digits) : 'N/A';

export const formatRegion = (region) =>
  region ? `${region.width}x${region.height} @ ${region.x},${region.y}` : 'N/A';

export const formatDegrees = (value) =>
  typeof value === 'number' ? `${((value * 180) / Math.PI).toFixed(1)} deg` : 'N/A';

export const formatPoint2 = (point) =>
  point ? `${formatNumber(point.x, 0)}, ${formatNumber(point.y, 0)}` : 'N/A';

export const formatVector3 = (vector) =>
  vector ? `${formatNumber(vector.x, 2)}, ${formatNumber(vector.y, 2)}, ${formatNumber(vector.z, 2)}` : 'N/A';
