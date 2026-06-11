/**
 * Keypoint Detection and Extraction for Image-Based Anchoring
 * Uses goodFeaturesToTrack (Shi-Tomasi corners) for reliable feature extraction
 */

import { logger } from '../utils/logger.js';
import { createRegionOpenCvMask } from './objectSupportMask.js';

export class KeypointDetector {
  constructor() {
    this.initialized = false;
    
    // Shi-Tomasi corner detection parameters - optimized for higher quality, fewer points
    this.maxCorners = 150;
    this.qualityLevel = 0.05;
    this.minDistance = 15;
    this.blockSize = 3;
    this.useHarrisDetector = false;
    this.k = 0.04;
  }

  async initialize(cv) {
    if (!cv) {
      throw new Error('OpenCV not available');
    }
    
    // No specific initialization needed for goodFeaturesToTrack
    // Just verify the function is available
    if (typeof cv.goodFeaturesToTrack !== 'function') {
      throw new Error('goodFeaturesToTrack not available in this OpenCV.js build');
    }
    
    this.initialized = true;
    logger.info('KeypointDetector', 'Initialized with Shi-Tomasi corner detector (goodFeaturesToTrack)');
  }

  /**
   * Extract keypoints using Shi-Tomasi corner detection
   * @param {cv.Mat} image - Input image (grayscale)
   * @param {Object} region - {x, y, width, height} region of interest
   * @returns {Object} - {keypoints, descriptors, method}
   */
  extractKeypoints(cv, image, region = null, objectSupportMask = null) {
    if (!this.initialized) {
      throw new Error('KeypointDetector not initialized');
    }

    const extractionRegion = region || (objectSupportMask
      ? { x: 0, y: 0, width: image.cols, height: image.rows }
      : null);
    let roi = image;
    if (extractionRegion) {
      const rect = new cv.Rect(extractionRegion.x, extractionRegion.y, extractionRegion.width, extractionRegion.height);
      roi = image.roi(rect);
    }

    try {
      // Extract corners using goodFeaturesToTrack (Shi-Tomasi)
      const corners = new cv.Mat();
      const mask = objectSupportMask && extractionRegion
        ? createRegionOpenCvMask(cv, objectSupportMask, extractionRegion)
        : new cv.Mat();
      
      cv.goodFeaturesToTrack(
        roi,                      // Input image
        corners,                  // Output corners
        this.maxCorners,          // Maximum number of corners
        this.qualityLevel,        // Quality level (0.01 = good corners)
        this.minDistance,         // Minimum distance between corners
        mask,                     // Mask (empty = use entire image)
        this.blockSize,           // Block size for corner detection
        this.useHarrisDetector,   // Use Harris detector (false = Shi-Tomasi)
        this.k                    // Harris detector parameter
      );

      // Convert corners to keypoint format
      const keypoints = [];
      for (let i = 0; i < corners.rows; i++) {
        const x = corners.data32F[i * 2];
        const y = corners.data32F[i * 2 + 1];
        
        // Adjust coordinates if we used a ROI
        const adjustedX = extractionRegion ? x + extractionRegion.x : x;
        const adjustedY = extractionRegion ? y + extractionRegion.y : y;
        
        keypoints.push({
          pt: { x: adjustedX, y: adjustedY },
          size: this.blockSize,
          angle: 0,
          response: 1.0,
          octave: 0,
          class_id: -1
        });
      }

      // Cleanup
      corners.delete();
      mask.delete();
      if (roi !== image) roi.delete();

      logger.info('KeypointDetector', `Extracted ${keypoints.length} Shi-Tomasi corners`);
      
      return {
        keypoints: keypoints,
        descriptors: null, // Shi-Tomasi doesn't provide descriptors
        method: 'GFTT', // Good Features To Track
        maskSource: objectSupportMask ? objectSupportMask.source : null,
        count: keypoints.length
      };
      
    } catch (error) {
      logger.error('KeypointDetector', 'Error extracting corners:', error);
      if (roi !== image) roi.delete();
      return { keypoints: [], descriptors: null, method: 'FAILED', count: 0 };
    }
  }

  extractAdaptiveKeypoints(cv, image, region = null, objectSupportMask = null, { minKeypoints = 12 } = {}) {
    const original = {
      qualityLevel: this.qualityLevel,
      minDistance: this.minDistance,
      maxCorners: this.maxCorners,
    };
    const attempts = [
      { qualityLevel: Math.min(this.qualityLevel, 0.02), minDistance: Math.min(this.minDistance, 10), maxCorners: Math.max(this.maxCorners, 220) },
      { qualityLevel: 0.01, minDistance: 8, maxCorners: 300 },
      { qualityLevel: 0.006, minDistance: 6, maxCorners: 360 },
    ];
    let best = { keypoints: [], descriptors: null, method: 'GFTT_ADAPTIVE', count: 0 };

    for (const attempt of attempts) {
      this.qualityLevel = attempt.qualityLevel;
      this.minDistance = attempt.minDistance;
      this.maxCorners = attempt.maxCorners;
      const result = this.extractKeypoints(cv, image, region, objectSupportMask);
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

    this.qualityLevel = original.qualityLevel;
    this.minDistance = original.minDistance;
    this.maxCorners = original.maxCorners;

    if (best.keypoints.length >= minKeypoints || !objectSupportMask || !region) {
      return best;
    }

    const bootstrapKeypoints = this._createMaskGridBootstrapKeypoints(
      objectSupportMask,
      region,
      minKeypoints - best.keypoints.length
    );

    return {
      ...best,
      keypoints: [...best.keypoints, ...bootstrapKeypoints],
      method: bootstrapKeypoints.length > 0 ? 'GFTT_ADAPTIVE_GRID_BOOTSTRAP' : best.method,
      count: best.keypoints.length + bootstrapKeypoints.length,
    };
  }

  _createMaskGridBootstrapKeypoints(objectSupportMask, region, missingCount) {
    const keypoints = [];
    const columns = 4;
    const rows = 4;
    const existingDistance = 8;

    for (let row = 0; row < rows && keypoints.length < missingCount; row++) {
      for (let column = 0; column < columns && keypoints.length < missingCount; column++) {
        const x = Math.round(region.x + (column + 0.5) * region.width / columns);
        const y = Math.round(region.y + (row + 0.5) * region.height / rows);
        if (!this._pointInsideMask(objectSupportMask, x, y)) {
          continue;
        }

        const overlaps = keypoints.some(point => Math.hypot(point.pt.x - x, point.pt.y - y) < existingDistance);
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

  _pointInsideMask(objectSupportMask, x, y) {
    return x >= 0 &&
      y >= 0 &&
      x < objectSupportMask.width &&
      y < objectSupportMask.height &&
      objectSupportMask.data[y * objectSupportMask.width + x] > 0;
  }

  /**
   * Adjust corner detection parameters based on image characteristics
   * @param {number} imageSize - Approximate image size (width * height)
   * @param {number} targetCorners - Desired number of corners
   */
  adjustParameters(imageSize, targetCorners = 200) {
    // Adjust quality level based on image size
    if (imageSize > 1000000) { // Large images (>1MP)
      this.qualityLevel = 0.02;
      this.minDistance = 15;
    } else if (imageSize > 500000) { // Medium images (>500K)
      this.qualityLevel = 0.015;
      this.minDistance = 12;
    } else { // Small images
      this.qualityLevel = 0.01;
      this.minDistance = 8;
    }
    
    this.maxCorners = Math.min(targetCorners, 500);
    logger.info('KeypointDetector', `Adjusted parameters: qualityLevel=${this.qualityLevel}, minDistance=${this.minDistance}, maxCorners=${this.maxCorners}`);
  }

  /**
   * Calculate spatial distribution score for keypoint quality assessment
   */
  calculateSpatialDistribution(keypoints, imageWidth, imageHeight, offsetX = 0, offsetY = 0) {
    if (keypoints.length < 10) return 0;

    // Divide image into 3x3 grid
    const gridCols = 3;
    const gridRows = 3;
    const cellWidth = imageWidth / gridCols;
    const cellHeight = imageHeight / gridRows;
    
    const grid = Array(gridRows).fill().map(() => Array(gridCols).fill(0));
    
    // Count keypoints in each cell
    for (const kp of keypoints) {
      const x = (kp.pt ? kp.pt.x : kp.x) - offsetX;
      const y = (kp.pt ? kp.pt.y : kp.y) - offsetY;
      const col = Math.min(Math.floor(x / cellWidth), gridCols - 1);
      const row = Math.min(Math.floor(y / cellHeight), gridRows - 1);
      grid[row][col]++;
    }
    
    // Calculate distribution uniformity (lower standard deviation = better distribution)
    const counts = grid.flat();
    const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    const variance = counts.reduce((sum, count) => sum + Math.pow(count - mean, 2), 0) / counts.length;
    const stdDev = Math.sqrt(variance);
    
    // Convert to 0-1 score (lower stddev = higher score)
    const maxPossibleStdDev = Math.sqrt(keypoints.length * keypoints.length / 9);
    return Math.max(0, 1 - (stdDev / maxPossibleStdDev));
  }

  /**
   * Assess overall template quality for Shi-Tomasi corners
   */
  assessTemplateQuality(keypoints, descriptors, imageWidth, imageHeight, offsetX = 0, offsetY = 0) {
    const keypointCount = keypoints.length;
    const spatialScore = this.calculateSpatialDistribution(keypoints, imageWidth, imageHeight, offsetX, offsetY);
    
    // For corners, we focus on count and distribution (no descriptors) 
    const countScore = Math.min(1, keypointCount / 80); // Normalize to 80 keypoints max (our new target)
    const qualityScore = countScore * 0.6 + spatialScore * 0.4;
    
    return {
      overall: qualityScore,
      keypointCount: keypointCount,
      spatialDistribution: spatialScore,
      descriptorUniqueness: 0 // No descriptors for corners
    };
  }

  dispose() {
    // No OpenCV objects to dispose for goodFeaturesToTrack
    this.initialized = false;
  }
}
