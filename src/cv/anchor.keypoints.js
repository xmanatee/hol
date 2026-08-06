/**
 * Keypoint Detection and Extraction for Image-Based Anchoring
 * Uses goodFeaturesToTrack (Shi-Tomasi corners) for reliable feature extraction
 */

import { logger } from '../utils/logger.js';
import { withGfttExtractionSession } from './anchor.keypointExtraction.js';

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

  initialize(cv) {
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

    const profile = this._primaryParameters();
    return withGfttExtractionSession(cv, image, region, objectSupportMask, [profile], (session) => {
      const result = session.detect(profile);
      logger.debug('KeypointDetector', `Extracted ${result.count} Shi-Tomasi corners`);
      return {
        ...result,
        gfttPreparationCount: 1,
      };
    });
  }

  extractAdaptiveKeypoints(cv, image, region = null, objectSupportMask = null, { minKeypoints = 12 } = {}) {
    if (!this.initialized) {
      throw new Error('KeypointDetector not initialized');
    }

    const attempts = this._adaptiveParameters();
    return withGfttExtractionSession(cv, image, region, objectSupportMask, attempts, (session) => {
      const result = session.detectAdaptive(attempts, minKeypoints);
      logger.debug('KeypointDetector', `Extracted ${result.count} adaptive Shi-Tomasi corners`);
      return {
        ...result,
        gfttPreparationCount: 1,
      };
    });
  }

  extractKeypointsWithAdaptiveFallback(
    cv,
    image,
    region = null,
    objectSupportMask = null,
    { minKeypoints = 12 } = {},
  ) {
    if (!this.initialized) {
      throw new Error('KeypointDetector not initialized');
    }

    const primary = this._primaryParameters();
    const attempts = this._adaptiveParameters();
    return withGfttExtractionSession(
      cv,
      image,
      region,
      objectSupportMask,
      [primary, ...attempts],
      (session) => {
        const result = session.detectWithAdaptiveFallback(primary, attempts, minKeypoints);
        logger.debug('KeypointDetector', `Extracted ${result.count} fallback Shi-Tomasi corners`);
        return {
          ...result,
          gfttPreparationCount: 1,
        };
      },
    );
  }

  _primaryParameters() {
    return {
      qualityLevel: this.qualityLevel,
      minDistance: this.minDistance,
      maxCorners: this.maxCorners,
      blockSize: this.blockSize,
      useHarrisDetector: this.useHarrisDetector,
      k: this.k,
    };
  }

  _adaptiveParameters() {
    return [
      {
        ...this._primaryParameters(),
        qualityLevel: Math.min(this.qualityLevel, 0.02),
        minDistance: Math.min(this.minDistance, 10),
        maxCorners: Math.max(this.maxCorners, 220),
      },
      {
        ...this._primaryParameters(),
        qualityLevel: 0.01,
        minDistance: 8,
        maxCorners: 300,
      },
      {
        ...this._primaryParameters(),
        qualityLevel: 0.006,
        minDistance: 6,
        maxCorners: 360,
      },
    ];
  }

  /**
   * Adjust corner detection parameters based on image characteristics
   * @param {number} imageSize - Approximate image size (width * height)
   * @param {number} targetCorners - Desired number of corners
   */
  adjustParameters(imageSize, targetCorners = 200) {
    // Adjust quality level based on image size
    if (imageSize > 1000000) {
      // Large images (>1MP)
      this.qualityLevel = 0.02;
      this.minDistance = 15;
    } else if (imageSize > 500000) {
      // Medium images (>500K)
      this.qualityLevel = 0.015;
      this.minDistance = 12;
    } else {
      // Small images
      this.qualityLevel = 0.01;
      this.minDistance = 8;
    }

    this.maxCorners = Math.min(targetCorners, 500);
    logger.info(
      'KeypointDetector',
      `Adjusted parameters: qualityLevel=${this.qualityLevel}, minDistance=${this.minDistance}, maxCorners=${this.maxCorners}`,
    );
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

    const grid = Array(gridRows)
      .fill()
      .map(() => Array(gridCols).fill(0));

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
    const maxPossibleStdDev = Math.sqrt((keypoints.length * keypoints.length) / 9);
    return Math.max(0, 1 - stdDev / maxPossibleStdDev);
  }

  /**
   * Assess overall template quality for Shi-Tomasi corners
   */
  assessTemplateQuality(keypoints, descriptors, imageWidth, imageHeight, offsetX = 0, offsetY = 0) {
    const keypointCount = keypoints.length;
    const spatialScore = this.calculateSpatialDistribution(
      keypoints,
      imageWidth,
      imageHeight,
      offsetX,
      offsetY,
    );

    // For corners, we focus on count and distribution (no descriptors)
    const countScore = Math.min(1, keypointCount / 80); // Normalize to 80 keypoints max (our new target)
    const qualityScore = countScore * 0.6 + spatialScore * 0.4;

    return {
      overall: qualityScore,
      keypointCount,
      spatialDistribution: spatialScore,
      descriptorUniqueness: 0, // No descriptors for corners
    };
  }

  dispose() {
    // No OpenCV objects to dispose for goodFeaturesToTrack
    this.initialized = false;
  }
}
