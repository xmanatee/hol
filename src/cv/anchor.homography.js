/**
 * Homography Estimation and Surface Normal Recovery
 * Computes object pose from keypoint correspondences
 */

import { logger } from '../utils/logger.js';
import {
  createPlanarPnPWorkspace,
  disposePlanarPnPWorkspace,
  estimatePlanarPnPPose,
} from './anchor.planarPnP.js';
import {
  createHomographyWorkspace,
  disposeHomographyWorkspace,
  prepareHomographyWorkspace,
} from './anchor.homographyWorkspace.js';
import { seedHomographyRansac } from './opencvRng.js';

export class HomographyEstimator {
  constructor() {
    this.initialized = false;
    this.cameraMatrix = null;
    this.distortionCoefficients = null;
    this.homographyWorkspace = null;
    this.planarPnPWorkspace = null;
    this.cameraParams = null;
    this.previousPlanarPnPPose = null;
  }

  initialize(cv, cameraParams) {
    if (!cv) {
      throw new Error('OpenCV not available');
    }

    this._releaseNativeInputs();
    this.cameraParams = {
      fx: cameraParams.fx,
      fy: cameraParams.fy,
      cx: cameraParams.cx,
      cy: cameraParams.cy,
    };
    this.cameraMatrix = cv.matFromArray(3, 3, cv.CV_64F, [
      cameraParams.fx,
      0,
      cameraParams.cx,
      0,
      cameraParams.fy,
      cameraParams.cy,
      0,
      0,
      1,
    ]);
    this.distortionCoefficients = cv.Mat.zeros(4, 1, cv.CV_64F);
    this.homographyWorkspace = createHomographyWorkspace(cv);
    this.planarPnPWorkspace = createPlanarPnPWorkspace(cv);
    this.resetTracking();

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
        inlierCount: 0,
      };
    }

    let homography = null;
    let keepHomography = false;

    try {
      prepareHomographyWorkspace(cv, this.homographyWorkspace, correspondences.length);
      const sourceValues = this.homographyWorkspace.sourcePoints.data32F;
      const destinationValues = this.homographyWorkspace.destinationPoints.data32F;
      for (let index = 0; index < correspondences.length; index++) {
        const correspondence = correspondences[index];
        const offset = index * 2;
        sourceValues[offset] = correspondence.prev.x;
        sourceValues[offset + 1] = correspondence.prev.y;
        destinationValues[offset] = correspondence.curr.x;
        destinationValues[offset + 1] = correspondence.curr.y;
      }

      seedHomographyRansac(cv);
      homography = cv.findHomography(
        this.homographyWorkspace.sourcePoints,
        this.homographyWorkspace.destinationPoints,
        cv.RANSAC,
        2.5, // RANSAC threshold
        this.homographyWorkspace.inlierMask,
        1250, // Max iterations
        0.99, // Confidence
      );

      const inlierMask = this.homographyWorkspace.inlierMask;
      const inlierMaskValues = inlierMask.data;
      let inlierCount = 0;
      for (let i = 0; i < inlierMask.rows; i++) {
        if (inlierMaskValues[i] === 1) {
          inlierCount++;
        }
      }

      if (inlierCount < 8 || homography.empty()) {
        return {
          success: false,
          reason: 'Insufficient inliers',
          inlierCount,
        };
      }

      const homographyData = new Float64Array(homography.data64F);
      const inlierCorrespondences = [];
      let totalResidual = 0;
      let maxResidual = 0;
      correspondences.forEach((corr, index) => {
        if (inlierMaskValues[index] !== 1) return;
        inlierCorrespondences.push(corr);
        const denominator =
          homographyData[6] * corr.prev.x + homographyData[7] * corr.prev.y + homographyData[8];
        const projectedX =
          (homographyData[0] * corr.prev.x + homographyData[1] * corr.prev.y + homographyData[2]) /
          denominator;
        const projectedY =
          (homographyData[3] * corr.prev.x + homographyData[4] * corr.prev.y + homographyData[5]) /
          denominator;
        const residual = Math.hypot(projectedX - corr.curr.x, projectedY - corr.curr.y);
        totalResidual += residual;
        maxResidual = Math.max(maxResidual, residual);
      });
      const averageResidual = totalResidual / inlierCorrespondences.length;

      keepHomography = true;
      const result = {
        success: true,
        homography,
        inlierCount,
        inlierRatio: inlierCount / correspondences.length,
        averageResidual,
        maxResidual,
        matrix: homographyData,
        inlierCorrespondences,
      };

      return result;
    } catch (error) {
      logger.error('HomographyEstimator', 'Error estimating homography:', error);
      return {
        success: false,
        reason: 'Estimation error: ' + error.message,
        inlierCount: 0,
      };
    } finally {
      if (homography && !keepHomography) {
        homography.delete();
      }
    }
  }

  /**
   * Get surface normal and pose from correspondences
   * @param {Array} correspondences - Keypoint correspondences
   * @param {{x: number, y: number}} anchorReference - Tapped point in the reference frame
   * @returns {Object} - Complete pose estimation result
   */
  estimatePose(cv, correspondences, anchorReference) {
    const homographyResult = this.estimateHomography(cv, correspondences);

    if (!homographyResult.success) {
      return homographyResult;
    }

    const poseResult = this.estimatePlanarPnPPose(
      cv,
      homographyResult.inlierCorrespondences || correspondences,
      anchorReference,
    );

    // Clean up homography matrix
    homographyResult.homography.delete();

    if (!poseResult.success) {
      return {
        success: false,
        reason: poseResult.reason,
        inlierCount: homographyResult.inlierCount,
      };
    }

    return {
      success: true,
      normal: poseResult.normal,
      rotationVector: poseResult.rotationVector,
      rotation: poseResult.rotation,
      translation: poseResult.translation,
      inlierCount: homographyResult.inlierCount,
      inlierRatio: homographyResult.inlierRatio,
      confidence: poseResult.confidence,
      averageResidual: homographyResult.averageResidual,
      maxResidual: homographyResult.maxResidual,
      foreshortening: poseResult.foreshortening ?? poseResult.normal.z,
      pnpBranchSelection: poseResult.branchSelection || null,
      referenceSpread: poseResult.referenceSpread,
      homographyMatrix: homographyResult.matrix,
    };
  }

  estimatePlanarPnPPose(cv, correspondences, anchorReference) {
    return estimatePlanarPnPPose({
      cv,
      correspondences,
      anchorReference,
      cameraParams: this.cameraParams,
      cameraMatrix: this.cameraMatrix,
      distortionCoefficients: this.distortionCoefficients,
      workspace: this.planarPnPWorkspace,
      previousPose: this.previousPlanarPnPPose,
    });
  }

  commitPlanarPnPPose(pose) {
    this.previousPlanarPnPPose = {
      rotationVector: pose.rotationVector,
      translation: pose.translation,
      normal: pose.normal,
    };
  }

  resetTracking() {
    this.breakPoseContinuity();
  }

  breakPoseContinuity() {
    this.previousPlanarPnPPose = null;
  }

  /**
   * Create camera matrix from field of view and viewport
   */
  static createCameraMatrix(fov, width, height) {
    const focalLength = height / 2 / Math.tan((fov * Math.PI) / 180 / 2);

    return {
      fx: focalLength,
      fy: focalLength,
      cx: width / 2,
      cy: height / 2,
    };
  }
  _releaseNativeInputs() {
    if (this.cameraMatrix) {
      this.cameraMatrix.delete();
      this.cameraMatrix = null;
    }
    if (this.distortionCoefficients) {
      this.distortionCoefficients.delete();
      this.distortionCoefficients = null;
    }
    if (this.homographyWorkspace) {
      disposeHomographyWorkspace(this.homographyWorkspace);
      this.homographyWorkspace = null;
    }
    if (this.planarPnPWorkspace) {
      disposePlanarPnPWorkspace(this.planarPnPWorkspace);
      this.planarPnPWorkspace = null;
    }
  }

  dispose() {
    this._releaseNativeInputs();
    this.cameraParams = null;
    this.resetTracking();
    this.initialized = false;
  }
}
