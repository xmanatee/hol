/**
 * Homography Estimation and Surface Normal Recovery
 * Computes object pose from keypoint correspondences
 */

import { logger } from '../utils/logger.js';
import { estimatePlanarPnPPose } from './anchor.planarPnP.js';
import { seedHomographyRansac } from './opencvRng.js';

export class HomographyEstimator {
  constructor() {
    this.initialized = false;
    this.cameraMatrix = null;
    this.cameraParams = null;
    this.homographyHistory = [];
    this.maxHistory = 10;
  }

  async initialize(cv, cameraParams) {
    if (!cv) {
      throw new Error('OpenCV not available');
    }
    
    this.cameraParams = {
      fx: cameraParams.fx,
      fy: cameraParams.fy,
      cx: cameraParams.cx,
      cy: cameraParams.cy
    };
    this.cameraMatrix = null;
    
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

    let srcMat = null;
    let dstMat = null;
    let mask = null;
    let homography = null;
    let keepHomography = false;

    try {
      const srcPoints = [];
      const dstPoints = [];
      
      for (const corr of correspondences) {
        srcPoints.push(corr.prev.x, corr.prev.y);
        dstPoints.push(corr.curr.x, corr.curr.y);
      }

      srcMat = cv.matFromArray(correspondences.length, 1, cv.CV_32FC2, srcPoints);
      dstMat = cv.matFromArray(correspondences.length, 1, cv.CV_32FC2, dstPoints);
      mask = new cv.Mat();

      seedHomographyRansac(cv);
      homography = cv.findHomography(
        srcMat,
        dstMat,
        cv.RANSAC,
        2.5, // RANSAC threshold
        mask,
        2000, // Max iterations
        0.99  // Confidence
      );

      const inlierMask = [];
      let inlierCount = 0;
      for (let i = 0; i < mask.rows; i++) {
        const isInlier = mask.data[i] === 1;
        inlierMask.push(isInlier);
        if (isInlier) {
          inlierCount++;
        }
      }

      if (inlierCount < 8 || homography.empty()) {
        return {
          success: false,
          reason: 'Insufficient inliers',
          inlierCount: inlierCount
        };
      }

      const homographyData = new Float64Array(homography.data64F);
      const residuals = correspondences.map((corr, index) => {
        const denominator = homographyData[6] * corr.prev.x + homographyData[7] * corr.prev.y + homographyData[8];
        const projectedX = (homographyData[0] * corr.prev.x + homographyData[1] * corr.prev.y + homographyData[2]) / denominator;
        const projectedY = (homographyData[3] * corr.prev.x + homographyData[4] * corr.prev.y + homographyData[5]) / denominator;
        return {
          value: Math.hypot(projectedX - corr.curr.x, projectedY - corr.curr.y),
          inlier: inlierMask[index],
        };
      });
      const inlierCorrespondences = correspondences.filter((_, index) => inlierMask[index]);
      const inlierResiduals = residuals.filter(item => item.inlier).map(item => item.value);
      const averageResidual = inlierResiduals.reduce((sum, value) => sum + value, 0) / Math.max(1, inlierResiduals.length);
      const maxResidual = Math.max(...inlierResiduals, 0);

      this.homographyHistory.push({
        timestamp: performance.now(),
        matrix: homographyData,
        inlierCount: inlierCount,
        correspondenceCount: correspondences.length,
        averageResidual,
      });

      if (this.homographyHistory.length > this.maxHistory) {
        this.homographyHistory = this.homographyHistory.slice(-this.maxHistory);
      }

      keepHomography = true;
      const result = {
        success: true,
        homography: homography,
        inlierCount: inlierCount,
        inlierRatio: inlierCount / correspondences.length,
        conditionNumber: this._calculateConditionNumber(homographyData),
        averageResidual,
        maxResidual,
        matrix: homographyData,
        inlierCorrespondences
      };

      return result;

    } catch (error) {
      logger.error('HomographyEstimator', 'Error estimating homography:', error);
      return {
        success: false,
        reason: 'Estimation error: ' + error.message,
        inlierCount: 0
      };
    } finally {
      if (srcMat) {
        srcMat.delete();
      }
      if (dstMat) {
        dstMat.delete();
      }
      if (mask) {
        mask.delete();
      }
      if (homography && !keepHomography) {
        homography.delete();
      }
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
      const poseResult = this._extractPoseFromHomography(cv, homography);
      
      if (!poseResult.success) {
        return { success: false, reason: poseResult.reason };
      }

      return {
        success: true,
        normal: poseResult.normal,
        rotation: poseResult.rotation,
        translation: [
          poseResult.translation.x,
          poseResult.translation.y,
          poseResult.translation.z
        ],
        confidence: poseResult.confidence
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

    let srcPoint = null;
    let dstPoint = null;

    try {
      srcPoint = cv.matFromArray(1, 1, cv.CV_32FC2, [templateCenter.x, templateCenter.y]);
      dstPoint = new cv.Mat();

      cv.perspectiveTransform(srcPoint, dstPoint, homography);

      const transformedX = dstPoint.data32F[0];
      const transformedY = dstPoint.data32F[1];

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
    } finally {
      if (srcPoint) {
        srcPoint.delete();
      }
      if (dstPoint) {
        dstPoint.delete();
      }
    }
  }

  /**
   * Get surface normal and pose from correspondences
   * @param {Array} correspondences - Keypoint correspondences
   * @returns {Object} - Complete pose estimation result
   */
  estimatePose(cv, correspondences, options = {}) {
    const homographyResult = this.estimateHomography(cv, correspondences);
    
    if (!homographyResult.success) {
      return homographyResult;
    }

    const planarPnPPose = options.anchorReference
      ? this.estimatePlanarPnPPose(
          cv,
          homographyResult.inlierCorrespondences || correspondences,
          options.anchorReference
        )
      : null;
    const poseResult = planarPnPPose?.success
      ? planarPnPPose
      : this.decomposeHomography(cv, homographyResult.homography);
    
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
      averageResidual: homographyResult.averageResidual,
      maxResidual: homographyResult.maxResidual,
      foreshortening: poseResult.foreshortening ?? poseResult.normal.z,
      referenceSpread: poseResult.referenceSpread,
      homographyMatrix: homographyResult.matrix
    };
  }

  estimatePlanarPnPPose(cv, correspondences, anchorReference) {
    return estimatePlanarPnPPose({
      cv,
      correspondences,
      anchorReference,
      cameraParams: this.cameraParams,
    });
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

      const { fx, fy, cx, cy } = this.cameraParams;
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
        foreshortening: normal.z,
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
    this.cameraParams = null;
    this.homographyHistory = [];
    this.initialized = false;
  }
}
