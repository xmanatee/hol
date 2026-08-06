import { clamp, normalizeVector } from './anchor.reconstruction.math.js';
import { boundsForPoints } from './anchor.reconstructionRobust.js';

export const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

export const maskHasPixel = (objectSupportMask, x, y, width, height) => {
  const maskX = clamp(
    Math.round((x / Math.max(width - 1, 1)) * (objectSupportMask.width - 1)),
    0,
    objectSupportMask.width - 1,
  );
  const maskY = clamp(
    Math.round((y / Math.max(height - 1, 1)) * (objectSupportMask.height - 1)),
    0,
    objectSupportMask.height - 1,
  );
  return objectSupportMask.data[maskY * objectSupportMask.width + maskX] > 0;
};

export const isMaskInterior = (objectSupportMask, x, y, width, height) => {
  const maskX = clamp(
    Math.round((x / Math.max(width - 1, 1)) * (objectSupportMask.width - 1)),
    1,
    objectSupportMask.width - 2,
  );
  const maskY = clamp(
    Math.round((y / Math.max(height - 1, 1)) * (objectSupportMask.height - 1)),
    1,
    objectSupportMask.height - 2,
  );
  const index = maskY * objectSupportMask.width + maskX;
  return (
    objectSupportMask.data[index] > 0 &&
    objectSupportMask.data[index - 1] > 0 &&
    objectSupportMask.data[index + 1] > 0 &&
    objectSupportMask.data[index - objectSupportMask.width] > 0 &&
    objectSupportMask.data[index + objectSupportMask.width] > 0
  );
};

export const invertSimilarityPoint = (point, transform) => {
  const cos = Math.cos(-transform.rotation);
  const sin = Math.sin(-transform.rotation);
  const dx = point.x - transform.tx;
  const dy = point.y - transform.ty;
  const scale = Math.max(transform.scale, 1e-6);
  return {
    x: (cos * dx - sin * dy) / scale,
    y: (sin * dx + cos * dy) / scale,
  };
};

export const depthAt = (depthFrame, x, y) => {
  const px = clamp(Math.round(x), 0, depthFrame.width - 1);
  const py = clamp(Math.round(y), 0, depthFrame.height - 1);
  return depthFrame.data[py * depthFrame.width + px];
};

export const colorAt = (imageData, x, y) => {
  const px = clamp(Math.round(x), 0, imageData.width - 1);
  const py = clamp(Math.round(y), 0, imageData.height - 1);
  const offset = (py * imageData.width + px) * 4;
  return {
    r: imageData.data[offset],
    g: imageData.data[offset + 1],
    b: imageData.data[offset + 2],
  };
};

const calculateDepthNormalFromBounds = (points, bounds) => {
  const width = Math.max(bounds.max.x - bounds.min.x, 1);
  const height = Math.max(bounds.max.y - bounds.min.y, 1);
  const leftZ = median(
    points.filter((point) => point.x < bounds.min.x + width * 0.35).map((point) => point.z),
  );
  const rightZ = median(
    points.filter((point) => point.x > bounds.max.x - width * 0.35).map((point) => point.z),
  );
  const topZ = median(
    points.filter((point) => point.y < bounds.min.y + height * 0.35).map((point) => point.z),
  );
  const bottomZ = median(
    points.filter((point) => point.y > bounds.max.y - height * 0.35).map((point) => point.z),
  );
  const vector = normalizeVector([-(rightZ - leftZ) / width, -(bottomZ - topZ) / height, 1]);

  return vector[2] >= 0
    ? { x: vector[0], y: vector[1], z: vector[2] }
    : { x: -vector[0], y: -vector[1], z: -vector[2] };
};

const calculateDepthQualityFromBounds = (bounds) => {
  const depth = bounds.max.z - bounds.min.z;
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  return clamp(depth / Math.max(width, height, 1), 0, 1);
};

export const calculateDepthNormal = (points) =>
  points.length < 3 ? { x: 0, y: 0, z: 1 } : calculateDepthNormalFromBounds(points, boundsForPoints(points));

export const calculateDepthQuality = (points) =>
  points.length < 3 ? 0 : calculateDepthQualityFromBounds(boundsForPoints(points));

export const calculateDepthGeometry = (geometryPoints) => {
  const points = Array.isArray(geometryPoints) ? geometryPoints : [...geometryPoints];
  if (points.length < 3) {
    return {
      normal: { x: 0, y: 0, z: 1 },
      depthQuality: 0,
    };
  }

  const bounds = boundsForPoints(points);
  return {
    normal: calculateDepthNormalFromBounds(points, bounds),
    depthQuality: calculateDepthQualityFromBounds(bounds),
  };
};
