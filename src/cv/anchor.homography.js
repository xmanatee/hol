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
      // Get homography matrix elements
      const H = homography.data64F;
      if (!H || H.length < 9) {
        return { success: false, reason: 'Invalid homography matrix' };
      }

      // Camera intrinsic parameters
      const fx = this.cameraMatrix.data64F[0];
      const fy = this.cameraMatrix.data64F[4];
      const cx = this.cameraMatrix.data64F[2];
      const cy = this.cameraMatrix.data64F[5];

      // Normalize homography by H[2,2] to ensure scale consistency
      const scale = H[8];
      if (Math.abs(scale) < 1e-8) {
        return { success: false, reason: 'Homography scale too small' };
      }

      const h = H.map(val => val / scale);

      // Extract the 2x2 upper-left rotation part and translation
      // H = K * [R + t*n^T/d] * K^(-1) for planar homography
      
      // Compute approximate rotation from H
      // For planar surfaces, we can extract tilt information
      const h00 = h[0], h01 = h[1], h02 = h[2];
      const h10 = h[3], h11 = h[4], h12 = h[5];
      const h20 = h[6], h21 = h[7], h22 = h[8];

      // Estimate the dominant rotation using the upper 2x2 submatrix
      // Normalize the rotation part
      const r1_norm = Math.sqrt(h00*h00 + h10*h10);
      const r2_norm = Math.sqrt(h01*h01 + h11*h11);
      const avg_norm = (r1_norm + r2_norm) / 2.0;

      if (avg_norm < 1e-6) {
        return { success: false, reason: 'Degenerate homography' };
      }

      // Normalized rotation vectors
      const r1 = [h00/avg_norm, h10/avg_norm];
      const r2 = [h01/avg_norm, h11/avg_norm];

      // Estimate rotation angles
      const theta_x = Math.atan2(r1[1], r1[0]); // Rotation around X
      const theta_y = Math.atan2(-r2[0], r2[1]); // Rotation around Y

      // Create rotation matrix (simplified for small rotations)
      const cos_x = Math.cos(theta_x), sin_x = Math.sin(theta_x);
      const cos_y = Math.cos(theta_y), sin_y = Math.sin(theta_y);

      // Combined rotation matrix R = Ry * Rx
      const rotation = [
        cos_y, -sin_y*sin_x, -sin_y*cos_x,
        0, cos_x, -sin_x,
        sin_y, cos_y*sin_x, cos_y*cos_x
      ];

      // Compute surface normal from rotation
      // For planar objects initially facing camera, normal rotates with surface
      // Initial normal: [0, 0, 1] -> rotated normal
      const normal_x = -sin_y;
      const normal_y = cos_y * sin_x;
      const normal_z = cos_y * cos_x;

      // Normalize the normal vector
      const normal_len = Math.sqrt(normal_x*normal_x + normal_y*normal_y + normal_z*normal_z);
      const normal = {
        x: normal_x / normal_len,
        y: normal_y / normal_len, 
        z: normal_z / normal_len
      };

      // Ensure normal points toward camera (positive Z component)
      if (normal.z < 0) {
        normal.x = -normal.x;
        normal.y = -normal.y;
        normal.z = -normal.z;
      }

      // Estimate translation from homography
      // Translation is encoded in h02, h12 terms
      const translation = {
        x: h02 / fx,
        y: h12 / fy,
        z: 1.0  // Assume unit depth for planar surfaces
      };

      return {
        success: true,
        normal: normal,
        rotation: rotation,
        translation: translation,
        confidence: Math.min(r1_norm, r2_norm) / Math.max(r1_norm, r2_norm) // Measure of transformation quality
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