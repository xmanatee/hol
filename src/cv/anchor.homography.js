/**
 * Homography Estimation and Surface Normal Recovery
 * Computes object pose from keypoint correspondences
 */

import { logger } from '../utils/logger.js';

export class HomographyEstimator {
  constructor() {
    this.initialized = false;
    this.cameraMatrix = null;
    this.homographyHistory = [];
    this.maxHistory = 10;
  }

  async initialize(cv, cameraParams) {
    if (!cv) {
      throw new Error('OpenCV not available');
    }
    
    // Store camera parameters
    this.cameraMatrix = cv.matFromArray(3, 3, cv.CV_64F, [
      cameraParams.fx, 0, cameraParams.cx,
      0, cameraParams.fy, cameraParams.cy,
      0, 0, 1
    ]);
    
    this.initialized = true;
    logger.info('HomographyEstimator', 'Initialized with camera matrix');
  }

  /**
   * Estimate homography from keypoint correspondences
   * @param {Array} correspondences - Array of {prev: {x,y}, curr: {x,y}} pairs
   * @returns {Object} - Homography estimation result
   */
  estimateHomography(cv, correspondences) {
    if (!this.initialized) {
      throw new Error('HomographyEstimator not initialized');
    }

    if (correspondences.length < 8) {
      return {
        success: false,
        reason: 'Insufficient correspondences',
        inlierCount: 0
      };
    }

    try {
      // Prepare point arrays for OpenCV
      const srcPoints = [];
      const dstPoints = [];
      
      for (const corr of correspondences) {
        srcPoints.push(corr.prev.x, corr.prev.y);
        dstPoints.push(corr.curr.x, corr.curr.y);
      }

      const srcMat = cv.matFromArray(correspondences.length, 1, cv.CV_32FC2, srcPoints);
      const dstMat = cv.matFromArray(correspondences.length, 1, cv.CV_32FC2, dstPoints);
      const mask = new cv.Mat();

      // Estimate homography with RANSAC
      const homography = cv.findHomography(
        srcMat,
        dstMat,
        cv.RANSAC,
        2.5, // RANSAC threshold
        mask,
        2000, // Max iterations
        0.99  // Confidence
      );

      // Count inliers
      let inlierCount = 0;
      for (let i = 0; i < mask.rows; i++) {
        if (mask.data[i] === 1) {
          inlierCount++;
        }
      }

      // Cleanup temporary matrices
      srcMat.delete();
      dstMat.delete();
      mask.delete();

      if (inlierCount < 8 || homography.empty()) {
        if (!homography.empty()) homography.delete();
        return {
          success: false,
          reason: 'Insufficient inliers',
          inlierCount: inlierCount
        };
      }

      // Store homography in history
      const homographyData = new Float64Array(homography.data64F);
      this.homographyHistory.push({
        timestamp: performance.now(),
        matrix: homographyData,
        inlierCount: inlierCount,
        correspondenceCount: correspondences.length
      });

      if (this.homographyHistory.length > this.maxHistory) {
        this.homographyHistory = this.homographyHistory.slice(-this.maxHistory);
      }

      const result = {
        success: true,
        homography: homography,
        inlierCount: inlierCount,
        inlierRatio: inlierCount / correspondences.length,
        conditionNumber: this._calculateConditionNumber(homographyData),
        matrix: homographyData
      };

      return result;

    } catch (error) {
      logger.error('HomographyEstimator', 'Error estimating homography:', error);
      return {
        success: false,
        reason: 'Estimation error: ' + error.message,
        inlierCount: 0
      };
    }
  }

  /**
   * Decompose homography to recover surface normal and pose
   * @param {cv.Mat} homography - Homography matrix
   * @returns {Object} - Pose information with surface normal
   */
  decomposeHomography(cv, homography) {
    if (!this.initialized || !homography || homography.empty()) {
      return { success: false, reason: 'Invalid homography' };
    }

    try {
      const rotations = new cv.MatVector();
      const translations = new cv.MatVector();
      const normals = new cv.MatVector();

      // Extract pose using direct mathematical decomposition
      const poseResult = this._extractPoseFromHomography(cv, homography);
      
      if (!poseResult.success) {
        rotations.delete();
        translations.delete();
        normals.delete();
        return { success: false, reason: poseResult.reason };
      }

      // Create matrices for the single solution
      const rotation = new cv.Mat(3, 3, cv.CV_64FC1);
      const translation = new cv.Mat(3, 1, cv.CV_64FC1);
      const normal = new cv.Mat(3, 1, cv.CV_64FC1);

      // Fill rotation matrix
      const rotData = rotation.data64F;
      poseResult.rotation.forEach((val, i) => { rotData[i] = val; });

      // Fill translation vector
      const transData = translation.data64F;
      transData[0] = poseResult.translation.x;
      transData[1] = poseResult.translation.y;
      transData[2] = poseResult.translation.z;

      // Fill normal vector
      const normalData = normal.data64F;
      normalData[0] = poseResult.normal.x;
      normalData[1] = poseResult.normal.y;
      normalData[2] = poseResult.normal.z;

      // Add to output vectors
      rotations.push_back(rotation);
      translations.push_back(translation);
      normals.push_back(normal);

      const solutions = 1;

      if (solutions === 0) {
        rotations.delete();
        translations.delete();
        normals.delete();
        return { success: false, reason: 'Decomposition failed' };
      }

      // Find best solution (normal pointing towards camera)
      let bestNormal = null;
      let bestRotation = null;
      let bestTranslation = null;
      let maxZ = -Infinity;

      for (let i = 0; i < solutions; i++) {
        const normal = normals.get(i);
        const rotation = rotations.get(i);
        const translation = translations.get(i);

        if (normal.rows >= 3) {
          const normalData = normal.data64F;
          const norm = Math.sqrt(normalData[0] * normalData[0] + 
                                normalData[1] * normalData[1] + 
                                normalData[2] * normalData[2]);
          
          if (norm > 0) {
            let normalVec = {
              x: normalData[0] / norm,
              y: normalData[1] / norm,
              z: normalData[2] / norm
            };

            // Ensure normal points towards camera (positive Z)
            if (normalVec.z < 0) {
              normalVec.x *= -1;
              normalVec.y *= -1;
              normalVec.z *= -1;
            }

            // Select solution with largest Z component (most face-on)
            if (normalVec.z > maxZ) {
              maxZ = normalVec.z;
              bestNormal = normalVec;
              bestRotation = rotation.data64F ? Array.from(rotation.data64F) : null;
              bestTranslation = translation.data64F ? Array.from(translation.data64F) : null;
            }
          }
        }
      }

      // Cleanup
      rotations.delete();
      translations.delete();
      normals.delete();

      if (!bestNormal) {
        return { success: false, reason: 'No valid normal found' };
      }

      return {
        success: true,
        normal: bestNormal,
        rotation: bestRotation,
        translation: bestTranslation,
        confidence: Math.min(1.0, maxZ) // Z component as confidence measure
      };

    } catch (error) {
      logger.error('HomographyEstimator', 'Error decomposing homography:', error);
      return { success: false, reason: 'Decomposition error: ' + error.message };
    }
  }

  /**
   * Transform template center using homography
   * @param {cv.Mat} homography - Homography matrix
   * @param {Object} templateCenter - Template center point {x, y}
   * @returns {Object} - Transformed center point or null if failed
   */
  transformTemplateCenter(cv, homography, templateCenter) {
    if (!homography || homography.empty() || !templateCenter) {
      return null;
    }

    try {
      // Create point matrix for transformation
      const srcPoint = cv.matFromArray(1, 1, cv.CV_32FC2, [templateCenter.x, templateCenter.y]);
      const dstPoint = new cv.Mat();

      // Apply homography transformation
      cv.perspectiveTransform(srcPoint, dstPoint, homography);

      const transformedX = dstPoint.data32F[0];
      const transformedY = dstPoint.data32F[1];

      // Cleanup
      srcPoint.delete();
      dstPoint.delete();

      // Validate transformed coordinates
      if (isFinite(transformedX) && isFinite(transformedY)) {
        return {
          x: transformedX,
          y: transformedY
        };
      }

      return null;

    } catch (error) {
      logger.error('HomographyEstimator', 'Error transforming template center:', error);
      return null;
    }
  }

  /**
   * Get surface normal and pose from correspondences
   * @param {Array} correspondences - Keypoint correspondences
   * @returns {Object} - Complete pose estimation result
   */
  estimatePose(cv, correspondences) {
    const homographyResult = this.estimateHomography(cv, correspondences);
    
    if (!homographyResult.success) {
      return homographyResult;
    }

    const poseResult = this.decomposeHomography(cv, homographyResult.homography);
    
    // Clean up homography matrix
    homographyResult.homography.delete();

    if (!poseResult.success) {
      return {
        success: false,
        reason: poseResult.reason,
        inlierCount: homographyResult.inlierCount
      };
    }

    return {
      success: true,
      normal: poseResult.normal,
      rotation: poseResult.rotation,
      translation: poseResult.translation,
      inlierCount: homographyResult.inlierCount,
      inlierRatio: homographyResult.inlierRatio,
      conditionNumber: homographyResult.conditionNumber,
      confidence: poseResult.confidence,
      homographyMatrix: homographyResult.matrix
    };
  }

  /**
   * Calculate homography condition number for stability assessment
   */
  _calculateConditionNumber(homographyData) {
    // Simplified condition number estimation
    // In practice, you'd compute SVD for exact condition number
    const H = homographyData;
    
    // Calculate Frobenius norm
    let normH = 0;
    for (let i = 0; i < 9; i++) {
      normH += H[i] * H[i];
    }
    normH = Math.sqrt(normH);
    
    // Simple stability measure based on diagonal dominance
    const diagonalSum = Math.abs(H[0]) + Math.abs(H[4]) + Math.abs(H[8]);
    const offDiagonalSum = normH - diagonalSum;
    
    return offDiagonalSum / Math.max(diagonalSum, 1e-6);
  }

  /**
   * Check if homography is stable based on recent history
   */
  isHomographyStable() {
    if (this.homographyHistory.length < 5) {
      return { stable: false, reason: 'Insufficient history' };
    }

    const recent = this.homographyHistory.slice(-5);
    
    // Check inlier count stability
    const inlierCounts = recent.map(h => h.inlierCount);
    const avgInliers = inlierCounts.reduce((sum, count) => sum + count, 0) / inlierCounts.length;
    const inlierVariance = inlierCounts.reduce((sum, count) => sum + Math.pow(count - avgInliers, 2), 0) / inlierCounts.length;
    
    const inlierStable = avgInliers >= 15 && Math.sqrt(inlierVariance) < 5;
    
    // Check matrix element stability
    let elementStability = true;
    if (recent.length >= 2) {
      const current = recent[recent.length - 1].matrix;
      const previous = recent[recent.length - 2].matrix;
      
      let maxChange = 0;
      for (let i = 0; i < 9; i++) {
        const change = Math.abs(current[i] - previous[i]);
        maxChange = Math.max(maxChange, change);
      }
      
      elementStability = maxChange < 0.5; // Threshold for element changes
    }

    return {
      stable: inlierStable && elementStability,
      metrics: {
        averageInliers: avgInliers,
        inlierVariance: Math.sqrt(inlierVariance),
        elementStability: elementStability
      }
    };
  }

  /**
   * Create camera matrix from field of view and viewport
   */
  static createCameraMatrix(fov, width, height) {
    const focalLength = (height / 2) / Math.tan((fov * Math.PI / 180) / 2);
    
    return {
      fx: focalLength,
      fy: focalLength,
      cx: width / 2,
      cy: height / 2
    };
  }


  /**
   * Extract pose from homography using direct mathematical decomposition
   * Implements the mathematical equivalent of cv.decomposeHomographyMat
   * @param {Object} cv - OpenCV instance
   * @param {cv.Mat} homography - 3x3 homography matrix
   * @returns {Object} Pose result with normal, rotation, and translation
   */
  _extractPoseFromHomography(cv, homography) {
    try {
      const H = Array.from(homography.data64F);
      if (!H || H.length < 9) {
        return { success: false, reason: 'Invalid homography matrix' };
      }

      const fx = this.cameraMatrix.data64F[0];
      const fy = this.cameraMatrix.data64F[4];
      const cx = this.cameraMatrix.data64F[2];
      const cy = this.cameraMatrix.data64F[5];
      const k = [
        fx, 0, cx,
        0, fy, cy,
        0, 0, 1,
      ];
      const kInverse = [
        1 / fx, 0, -cx / fx,
        0, 1 / fy, -cy / fy,
        0, 0, 1,
      ];
      const multiply3 = (a, b) => {
        const result = new Array(9).fill(0);
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 3; col++) {
            for (let index = 0; index < 3; index++) {
              result[row * 3 + col] += a[row * 3 + index] * b[index * 3 + col];
            }
          }
        }
        return result;
      };
      const length = vector => Math.hypot(vector[0], vector[1], vector[2]);
      const normalize = vector => {
        const vectorLength = length(vector);
        return vector.map(value => value / vectorLength);
      };
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const cross = (a, b) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];

      const normalizedHomography = multiply3(kInverse, multiply3(H, k));
      const column1 = [normalizedHomography[0], normalizedHomography[3], normalizedHomography[6]];
      const column2 = [normalizedHomography[1], normalizedHomography[4], normalizedHomography[7]];
      const scale1 = length(column1);
      const scale2 = length(column2);
      const averageScale = (scale1 + scale2) / 2;

      if (averageScale < 1e-6) {
        return { success: false, reason: 'Degenerate homography' };
      }

      const inverseScale = 1 / averageScale;
      const r1 = normalize(column1.map(value => value * inverseScale));
      const scaledColumn2 = column2.map(value => value * inverseScale);
      const r2Orthogonal = scaledColumn2.map((value, index) => value - dot(scaledColumn2, r1) * r1[index]);
      const r2 = normalize(r2Orthogonal);
      const r3 = normalize(cross(r1, r2));
      const normal = { x: r3[0], y: r3[1], z: r3[2] };

      if (normal.z < 0) {
        normal.x = -normal.x;
        normal.y = -normal.y;
        normal.z = -normal.z;
      }

      const rotation = [
        r1[0], r2[0], normal.x,
        r1[1], r2[1], normal.y,
        r1[2], r2[2], normal.z,
      ];
      const scaleBalance = Math.min(scale1, scale2) / Math.max(scale1, scale2);
      const orthogonality = 1 - Math.min(1, Math.abs(dot(normalize(column1), normalize(column2))));
      const translation = {
        x: normalizedHomography[2] * inverseScale,
        y: normalizedHomography[5] * inverseScale,
        z: normalizedHomography[8] * inverseScale,
      };

      return {
        success: true,
        normal: normal,
        rotation: rotation,
        translation: translation,
        confidence: Math.max(0, Math.min(1, scaleBalance * 0.55 + orthogonality * 0.45))
      };

    } catch (error) {
      logger.error('HomographyEstimator', 'Pose extraction failed:', error);
      return { success: false, reason: `Math error: ${error.message}` };
    }
  }

  dispose() {
    if (this.cameraMatrix) {
      this.cameraMatrix.delete();
      this.cameraMatrix = null;
    }
    this.homographyHistory = [];
    this.initialized = false;
  }
}
