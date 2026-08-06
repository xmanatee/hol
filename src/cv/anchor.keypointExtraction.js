import { createRegionOpenCvMask, isPointInsideObjectSupport } from './objectSupportMask.js';

const GFTT_GRADIENT_RADIUS = 1;
const GFTT_NON_MAXIMUM_SUPPRESSION_RADIUS = 1;

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
  constructor({ cv, region, objectSupportMask, roi, mask, corners, blockSize }) {
    this.cv = cv;
    this.region = region;
    this.objectSupportMask = objectSupportMask;
    this.roi = roi;
    this.mask = mask;
    this.corners = corners;
    this.pixelCount = roi.cols * roi.rows;
    this.blockSize = blockSize;
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
    for (let index = 0; index < this.corners.rows; index++) {
      const keypoint = {
        pt: {
          x: this.corners.data32F[index * 2] + offsetX,
          y: this.corners.data32F[index * 2 + 1] + offsetY,
        },
        size: blockSize,
        angle: 0,
        response: 1.0,
        octave: 0,
        class_id: -1,
      };
      if (this.objectSupportMask && !isPointInsideObjectSupport(this.objectSupportMask, keypoint.pt)) {
        rejectedByMask++;
        continue;
      }
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

    if (best.keypoints.length >= minKeypoints || !this.objectSupportMask || !this.region) {
      return { ...best, gfttCallCount, gfttPixelCount };
    }

    const bootstrapKeypoints = this._createMaskGridBootstrapKeypoints(minKeypoints - best.keypoints.length);
    return {
      ...best,
      keypoints: [...best.keypoints, ...bootstrapKeypoints],
      method: bootstrapKeypoints.length > 0 ? 'GFTT_ADAPTIVE_GRID_BOOTSTRAP' : best.method,
      count: best.keypoints.length + bootstrapKeypoints.length,
      gfttCallCount,
      gfttPixelCount,
    };
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

  _createMaskGridBootstrapKeypoints(missingCount) {
    const keypoints = [];
    const columns = 4;
    const rows = 4;
    const existingDistance = 8;

    for (let row = 0; row < rows && keypoints.length < missingCount; row++) {
      for (let column = 0; column < columns && keypoints.length < missingCount; column++) {
        const x = Math.round(this.region.x + ((column + 0.5) * this.region.width) / columns);
        const y = Math.round(this.region.y + ((row + 0.5) * this.region.height) / rows);
        const insideMask =
          x >= 0 &&
          y >= 0 &&
          x < this.objectSupportMask.width &&
          y < this.objectSupportMask.height &&
          this.objectSupportMask.data[y * this.objectSupportMask.width + x] > 0;
        if (!insideMask) {
          continue;
        }

        const overlaps = keypoints.some(
          (point) => Math.hypot(point.pt.x - x, point.pt.y - y) < existingDistance,
        );
        if (overlaps) {
          continue;
        }

        keypoints.push({
          pt: { x, y },
          size: this.blockSize,
          angle: 0,
          response: 0.04,
          octave: 0,
          class_id: -1,
          bootstrapOnly: true,
        });
      }
    }

    return keypoints;
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
            region: extractionRegion,
            objectSupportMask,
            roi,
            mask,
            corners,
            blockSize: parameterProfiles[0].blockSize,
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
