import { clamp } from './anchor.reconstruction.math.js';
import { isPointInsideObjectSupport } from './objectSupportMask.js';

const hasMaskPixel = (objectSupportMask, x, y) =>
  x >= 0 &&
  y >= 0 &&
  x < objectSupportMask.width &&
  y < objectSupportMask.height &&
  objectSupportMask.data[y * objectSupportMask.width + x] > 0;

const isBoundaryPixel = (objectSupportMask, x, y) =>
  hasMaskPixel(objectSupportMask, x, y) &&
  (!hasMaskPixel(objectSupportMask, x - 1, y) ||
    !hasMaskPixel(objectSupportMask, x + 1, y) ||
    !hasMaskPixel(objectSupportMask, x, y - 1) ||
    !hasMaskPixel(objectSupportMask, x, y + 1));

const scanStrideForMask = (objectSupportMask, maxScanSamples) => {
  const area = objectSupportMask.bbox.width * objectSupportMask.bbox.height;
  return Math.max(1, Math.floor(Math.sqrt(area / maxScanSamples)));
};

const scanMask = (objectSupportMask, scanStride) => {
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  const boundary = [];
  const { bbox } = objectSupportMask;
  for (let y = bbox.y; y < bbox.y + bbox.height; y += scanStride) {
    const rowOffset = y * objectSupportMask.width;
    for (let x = bbox.x; x < bbox.x + bbox.width; x += scanStride) {
      if (objectSupportMask.data[rowOffset + x] > 0) {
        area += scanStride * scanStride;
        sumX += x;
        sumY += y;
        if (isBoundaryPixel(objectSupportMask, x, y)) {
          boundary.push({ x, y });
        }
      }
    }
  }

  return {
    area,
    center: {
      x: sumX / Math.max(1, area / (scanStride * scanStride)),
      y: sumY / Math.max(1, area / (scanStride * scanStride)),
    },
    boundary,
  };
};

const sampleEvenly = (items, maxItems) => {
  if (items.length <= maxItems) {
    return items;
  }

  const sampled = [];
  const step = items.length / maxItems;
  for (let index = 0; index < maxItems; index++) {
    sampled.push(items[Math.floor(index * step)]);
  }
  return sampled;
};

const nearestBoundaryDistance = (point, boundary) => {
  let best = Infinity;
  for (const boundaryPoint of boundary) {
    best = Math.min(best, Math.hypot(point.x - boundaryPoint.x, point.y - boundaryPoint.y));
  }
  return best;
};

export const extractObjectSilhouette = (
  objectSupportMask,
  { maxBoundaryPoints = 192, maxSegments = 32, maxScanSamples = 6000 } = {},
) => {
  const scanStride = scanStrideForMask(objectSupportMask, maxScanSamples);
  const scan = scanMask(objectSupportMask, scanStride);
  const orderedBoundary = scan.boundary.sort(
    (left, right) =>
      Math.atan2(left.y - scan.center.y, left.x - scan.center.x) -
      Math.atan2(right.y - scan.center.y, right.x - scan.center.x),
  );
  const sampledBoundary = sampleEvenly(orderedBoundary, maxBoundaryPoints);
  const segmentPoints = sampleEvenly(sampledBoundary, Math.min(maxSegments, sampledBoundary.length));
  const contourSegments = segmentPoints.map((point, index) => ({
    from: point,
    to: segmentPoints[(index + 1) % segmentPoints.length],
    role: 'mask-silhouette',
  }));
  const fillRatio = scan.area / Math.max(1, objectSupportMask.bbox.width * objectSupportMask.bbox.height);

  return {
    source: 'mask-boundary',
    area: scan.area,
    center: scan.center,
    fillRatio,
    scanStride,
    boundaryPointCount: orderedBoundary.length,
    boundaryPoints: sampledBoundary,
    contourSegments,
  };
};

export const scoreSilhouetteLandmarks = ({ objectSupportMask, landmarks, silhouette }) => {
  const inside = [];
  const outside = [];
  const boundary = silhouette.boundaryPoints;

  for (const landmark of landmarks) {
    const point = landmark.current || landmark.reference || landmark.original;
    if (!point) {
      continue;
    }

    if (isPointInsideObjectSupport(objectSupportMask, point)) {
      inside.push(point);
    } else {
      outside.push(point);
    }
  }

  const outsideResidual = outside.length
    ? outside.reduce((sum, point) => sum + nearestBoundaryDistance(point, boundary), 0) / outside.length
    : 0;
  const coverageBins = new Set();
  const center = silhouette.center;
  for (const point of inside) {
    const angle = Math.atan2(point.y - center.y, point.x - center.x);
    const bin = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 12);
    coverageBins.add(clamp(bin, 0, 11));
  }

  return {
    landmarksInsideMask: inside.length,
    landmarksOutsideMask: outside.length,
    contourFitResidual: outsideResidual,
    silhouetteCoverage: coverageBins.size / 12,
  };
};
