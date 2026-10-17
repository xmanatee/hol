import { createRegionOpenCvMask, isPointInsideObjectSupport } from './objectSupportMask.js';
import { LK_WINDOW_SIZE } from './anchor.lkWorkspace.js';

const GFTT_GRADIENT_RADIUS = 1;
const GFTT_NON_MAXIMUM_SUPPRESSION_RADIUS = 1;
const PATCH_RADIUS = Math.floor(LK_WINDOW_SIZE / 2);
const MIN_PATCH_EIGENVALUE = 1e-4;
const MAX_PATCH_CONDITION_NUMBER = 100;

// Mean structure tensor of normalized central gradients over the LK window.
const patchResponse = (image, data, x, y) => {
  const radius = PATCH_RADIUS;
  if (x <= radius || y <= radius || x + radius + 1 >= image.cols || y + radius + 1 >= image.rows) return 0;
  const stride = image.step[0];
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (let row = y - radius; row <= y + radius; row++) {
    for (let column = x - radius; column <= x + radius; column++) {
      const index = row * stride + column;
      const dx = (data[index + 1] - data[index - 1]) / 510;
      const dy = (data[index + stride] - data[index - stride]) / 510;
      xx += dx * dx;
      xy += dx * dy;
      yy += dy * dy;
    }
  }
  const area = (radius * 2 + 1) ** 2;
  const discriminant = Math.hypot(xx - yy, 2 * xy);
  const minimum = (xx + yy - discriminant) / (2 * area);
  const maximum = (xx + yy + discriminant) / (2 * area);
  return minimum >= MIN_PATCH_EIGENVALUE && minimum * MAX_PATCH_CONDITION_NUMBER >= maximum ? minimum : 0;
};

const constrainRegionToObjectSupport = (region, objectSupportMask, blockSize) => {
  const contextRadius =
    Math.floor(blockSize / 2) + GFTT_GRADIENT_RADIUS + GFTT_NON_MAXIMUM_SUPPRESSION_RADIUS;
  const { bbox } = objectSupportMask;
  const left = Math.max(region.x, bbox.x - contextRadius);
  const top = Math.max(region.y, bbox.y - contextRadius);
  const right = Math.min(region.x + region.width, bbox.x + bbox.width + contextRadius);
  const bottom = Math.min(region.y + region.height, bbox.y + bbox.height + contextRadius);

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
};

class GfttExtractionSession {
  constructor({ cv, image, region, objectSupportMask, roi, mask, corners }) {
    this.cv = cv;
    this.region = region;
    this.objectSupportMask = objectSupportMask;
    this.roi = roi;
    this.mask = mask;
    this.corners = corners;
    this.pixelCount = roi.cols * roi.rows;
    this.image = image;
    this.patchResponses = new Map();
    this.maskSource = objectSupportMask?.source || null;
  }

  detect({ maxCorners, qualityLevel, minDistance, blockSize, useHarrisDetector, k }) {
    this.cv.goodFeaturesToTrack(
      this.roi,
      this.corners,
      maxCorners,
      qualityLevel,
      minDistance,
      this.mask,
      blockSize,
      useHarrisDetector,
      k,
    );

    const keypoints = [];
    let rejectedByMask = 0;
    const offsetX = this.region?.x || 0;
    const offsetY = this.region?.y || 0;
    const data = this.image.data;
    const pixels = new Uint8Array(
      data.buffer,
      data.byteOffset,
      (this.image.rows - 1) * this.image.step[0] + this.image.cols,
    );
    for (let index = 0; index < this.corners.rows; index++) {
      const keypoint = {
        pt: {
          x: this.corners.data32F[index * 2] + offsetX,
          y: this.corners.data32F[index * 2 + 1] + offsetY,
        },
        size: blockSize,
        angle: 0,
        octave: 0,
        class_id: -1,
      };
      if (this.objectSupportMask && !isPointInsideObjectSupport(this.objectSupportMask, keypoint.pt)) {
        rejectedByMask++;
        continue;
      }
      const x = Math.round(keypoint.pt.x);
      const y = Math.round(keypoint.pt.y);
      const pixel = y * this.image.cols + x;
      if (!this.patchResponses.has(pixel))
        this.patchResponses.set(pixel, patchResponse(this.image, pixels, x, y));
      keypoint.response = this.patchResponses.get(pixel);
      if (keypoint.response === 0) continue;
      keypoints.push(keypoint);
    }

    return {
      keypoints,
      descriptors: null,
      method: 'GFTT',
      maskSource: this.maskSource,
      count: keypoints.length,
      gfttCallCount: 1,
      gfttPixelCount: this.pixelCount,
      rejectedByMask,
    };
  }

  detectAdaptive(attempts, minKeypoints) {
    let best = {
      keypoints: [],
      descriptors: null,
      method: 'GFTT_ADAPTIVE',
      count: 0,
      gfttCallCount: 0,
      gfttPixelCount: 0,
    };
    let gfttCallCount = 0;
    let gfttPixelCount = 0;

    for (const attempt of attempts) {
      const result = this.detect(attempt);
      gfttCallCount += result.gfttCallCount;
      gfttPixelCount += result.gfttPixelCount;
      if (result.keypoints.length > best.keypoints.length) {
        best = {
          ...result,
          method: 'GFTT_ADAPTIVE',
        };
      }
      if (best.keypoints.length >= minKeypoints) {
        break;
      }
    }

    return { ...best, gfttCallCount, gfttPixelCount };
  }

  detectWithAdaptiveFallback(primaryParameters, adaptiveAttempts, minKeypoints) {
    const primary = this.detect(primaryParameters);
    if (primary.keypoints.length >= minKeypoints) {
      return primary;
    }

    const adaptive = this.detectAdaptive(adaptiveAttempts, minKeypoints);
    const selected = adaptive.keypoints.length > primary.keypoints.length ? adaptive : primary;
    return {
      ...selected,
      gfttCallCount: primary.gfttCallCount + adaptive.gfttCallCount,
      gfttPixelCount: primary.gfttPixelCount + adaptive.gfttPixelCount,
    };
  }
}

export const withGfttExtractionSession = (
  cv,
  image,
  region,
  objectSupportMask,
  parameterProfiles,
  operation,
) => {
  const supportBlockSize = Math.max(...parameterProfiles.map((profile) => profile.blockSize));
  const requestedRegion =
    region || (objectSupportMask ? { x: 0, y: 0, width: image.cols, height: image.rows } : null);
  const extractionRegion =
    requestedRegion && objectSupportMask
      ? constrainRegionToObjectSupport(requestedRegion, objectSupportMask, supportBlockSize)
      : requestedRegion;
  if (extractionRegion && (extractionRegion.width <= 0 || extractionRegion.height <= 0)) {
    throw new Error('GFTT extraction region does not intersect object support');
  }
  const roi = extractionRegion
    ? image.roi(
        new cv.Rect(extractionRegion.x, extractionRegion.y, extractionRegion.width, extractionRegion.height),
      )
    : image;

  try {
    const mask =
      objectSupportMask && extractionRegion
        ? createRegionOpenCvMask(cv, objectSupportMask, extractionRegion)
        : new cv.Mat();
    try {
      const corners = new cv.Mat();
      try {
        return operation(
          new GfttExtractionSession({
            cv,
            image,
            region: extractionRegion,
            objectSupportMask,
            roi,
            mask,
            corners,
          }),
        );
      } finally {
        corners.delete();
      }
    } finally {
      mask.delete();
    }
  } finally {
    if (roi !== image) {
      roi.delete();
    }
  }
};
