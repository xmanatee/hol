/**
 * Lucas-Kanade Optical Flow Tracking for Keypoints
 * Tracks template keypoints frame-to-frame with outlier detection
 */

import { logger } from '../utils/logger.js';
import { ObjectPoseEstimator } from './anchor.objectPose.js';
import { seedHomographyRansac } from './opencvRng.js';

export class KeypointTracker {
  constructor() {
    this.initialized = false;
    this.trackedPoints = [];
    this.previousGray = null;
    this.trackingHistory = [];
    this.maxHistory = 30;
    this.nextPointId = 0;
    this.lastRefreshStats = null;
    this.objectPoseEstimator = new ObjectPoseEstimator();
    
    // Adaptive tracking parameters
    this.trackingAttempts = 0;
    this.initialLeniencyFrames = 5; // More lenient for first 5 frames
  }

  async initialize(cv) {
    if (!cv) {
      throw new Error('OpenCV not available');
    }
    
    // Lucas-Kanade parameters
    this.lkParams = {
      winSize: new cv.Size(15, 15),
      maxLevel: 3,
      criteria: new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01)
    };
    
    this.initialized = true;
    logger.info('KeypointTracker', 'Initialized Lucas-Kanade tracker');
  }

  /**
   * Initialize tracking with template keypoints
   * @param {Array} keypoints - Array of keypoint objects {x, y, ...}
   * @param {cv.Mat} grayImage - Initial grayscale image
   * @param {Object} tapPosition - User tap position {x, y} for anchor attachment
   */
  initializeTracking(cv, keypoints, grayImage, tapPosition = null) {
    if (!this.initialized) {
      throw new Error('KeypointTracker not initialized');
    }

    // Select strongest keypoints for tracking (limit to 80 for quality)
    const sortedKeypoints = [...keypoints]
      .sort((a, b) => b.response - a.response)
      .slice(0, 80);

    this.trackedPoints = sortedKeypoints.map((kp, index) => this._createTrackedPoint(
      index,
      { x: kp.pt.x, y: kp.pt.y },
      { x: kp.pt.x, y: kp.pt.y },
      kp.response
    ));
    this.nextPointId = this.trackedPoints.length;

    // Calculate actual keypoint centroid (not geometric template center)
    const xSum = this.trackedPoints.reduce((sum, pt) => sum + pt.original.x, 0);
    const ySum = this.trackedPoints.reduce((sum, pt) => sum + pt.original.y, 0);
    this.keypointCentroid = {
      x: xSum / this.trackedPoints.length,
      y: ySum / this.trackedPoints.length
    };

    // Calculate and store offset between tap position and keypoint centroid
    if (tapPosition) {
      this.tapOffset = {
        x: tapPosition.x - this.keypointCentroid.x,
        y: tapPosition.y - this.keypointCentroid.y
      };
      this.anchorOriginalPosition = { x: tapPosition.x, y: tapPosition.y };
    } else {
      // No offset if no tap position provided
      this.tapOffset = { x: 0, y: 0 };
      this.anchorOriginalPosition = { ...this.keypointCentroid };
    }

    // Store reference frame
    if (this.previousGray) {
      this.previousGray.delete();
    }
    this.previousGray = grayImage.clone();
    
    // Reset adaptive tracking state
    this.trackingAttempts = 0;
    this.lastRefreshStats = null;

    logger.info('KeypointTracker', `Initialized tracking with ${this.trackedPoints.length} keypoints`);
    logger.info('KeypointTracker', `Keypoint centroid: (${this.keypointCentroid.x.toFixed(1)}, ${this.keypointCentroid.y.toFixed(1)})`);
    logger.info('KeypointTracker', `Tap offset: (${this.tapOffset.x.toFixed(1)}, ${this.tapOffset.y.toFixed(1)})`);
  }

  /**
   * Track keypoints to next frame
   * @param {cv.Mat} currentGray - Current grayscale frame
   * @returns {Object} - Tracking results with statistics
   */
  trackToFrame(cv, currentGray) {
    logger.debug('KeypointTracker', 'trackToFrame called - checking initialization', {
      initialized: this.initialized,
      hasPreviousGray: !!this.previousGray,
      totalTrackedPoints: this.trackedPoints.length
    });

    if (!this.initialized) {
      return { success: false, reason: 'KeypointTracker not initialized with OpenCV' };
    }
    
    if (!this.previousGray) {
      return { success: false, reason: 'No previous frame available for tracking' };
    }
    
    if (this.trackedPoints.length === 0) {
      return { success: false, reason: 'No tracked points available' };
    }

    const activePoints = this.trackedPoints.filter(pt => pt.status === 'active');
    logger.debug('KeypointTracker', 'Active points check:', {
      totalPoints: this.trackedPoints.length,
      activePoints: activePoints.length,
      minRequired: 8
    });
    
    if (activePoints.length < 8) {
      return { 
        success: false, 
        reason: `Too few active points: ${activePoints.length} (need at least 8)`,
        activePointCount: activePoints.length,
        successRate: 0,
        averageError: 999
      };
    }

    try {
      // Prepare point vectors for OpenCV
      const prevPoints = new cv.Mat(activePoints.length, 1, cv.CV_32FC2);
      for (let i = 0; i < activePoints.length; i++) {
        const pt = activePoints[i];
        prevPoints.data32F[i * 2] = pt.current.x;
        prevPoints.data32F[i * 2 + 1] = pt.current.y;
      }

      // Properly initialize output matrices with correct size and type
      const nextPoints = new cv.Mat(activePoints.length, 1, cv.CV_32FC2);
      const status = new cv.Mat(activePoints.length, 1, cv.CV_8UC1);
      const error = new cv.Mat(activePoints.length, 1, cv.CV_32FC1);
      
      logger.debug('KeypointTracker', 'Matrix initialization:', {
        prevPointsSize: `${prevPoints.rows}x${prevPoints.cols}`,
        nextPointsSize: `${nextPoints.rows}x${nextPoints.cols}`,
        statusSize: `${status.rows}x${status.cols}`,
        errorSize: `${error.rows}x${error.cols}`
      });

      // Perform Lucas-Kanade tracking
      cv.calcOpticalFlowPyrLK(
        this.previousGray,
        currentGray,
        prevPoints,
        nextPoints,
        status,
        error,
        this.lkParams.winSize,
        this.lkParams.maxLevel,
        this.lkParams.criteria
      );

      // Increment tracking attempts and determine adaptive thresholds with hysteresis
      this.trackingAttempts++;
      const isInitialTracking = this.trackingAttempts <= this.initialLeniencyFrames;
      
      // Hysteresis thresholds: higher threshold to lose tracking, lower to keep it
      const loseThreshold = isInitialTracking ? 60 : 40; // Threshold to mark as lost
      const keepThreshold = isInitialTracking ? 50 : 25; // Threshold to keep active
      
      // Update tracked points with results
      let successCount = 0;
      let totalError = 0;
      const trackingResults = [];
      
      logger.debug('KeypointTracker', 'Processing Lucas-Kanade results:', {
        attempt: this.trackingAttempts,
        isInitialTracking,
        loseThreshold,
        keepThreshold,
        totalPoints: activePoints.length,
        previousFrameSize: `${this.previousGray.cols}x${this.previousGray.rows}`,
        currentFrameSize: `${currentGray.cols}x${currentGray.rows}`
      });
      
      for (let i = 0; i < activePoints.length; i++) {
        const point = activePoints[i];
        const trackingStatus = status.data[i];
        const trackingError = error.data32F[i];
        
        const result = {
          pointId: point.id,
          status: trackingStatus,
          error: trackingError,
          oldPos: `(${point.current.x.toFixed(1)}, ${point.current.y.toFixed(1)})`,
          newPos: trackingStatus === 1 && nextPoints.data32F[i * 2] !== undefined && nextPoints.data32F[i * 2 + 1] !== undefined 
            ? `(${nextPoints.data32F[i * 2].toFixed(1)}, ${nextPoints.data32F[i * 2 + 1].toFixed(1)})` 
            : 'N/A'
        };
        
        // Use hysteresis: different thresholds based on stability and current status
        const effectiveThreshold = point.isStable ? keepThreshold : loseThreshold;
        
        if (trackingStatus === 1 && trackingError < effectiveThreshold && 
            nextPoints.data32F[i * 2] !== undefined && nextPoints.data32F[i * 2 + 1] !== undefined) {
          // Successful tracking with valid coordinates
          point.current.x = nextPoints.data32F[i * 2];
          point.current.y = nextPoints.data32F[i * 2 + 1];
          point.errorHistory.push(trackingError);
          point.age++;
          point.status = 'active';
          point.inactiveAge = 0;
          point.lastSeenAttempt = this.trackingAttempts;
          point.observations = (point.observations || 0) + 1;
          
          // Update stability tracking
          point.successfulTrackingStreak++;
          point.totalSuccessfulFrames++;
          
          // Calculate stability score (weighted by streak and total success)
          const streakFactor = Math.min(1.0, point.successfulTrackingStreak / 30); // 30 frames = max streak bonus
          const totalFactor = Math.min(1.0, point.totalSuccessfulFrames / 100); // 100 frames = max total bonus
          const errorFactor = Math.max(0, 1.0 - (trackingError / effectiveThreshold)); // Lower error = higher score
          point.stabilityScore = (streakFactor * 0.4 + totalFactor * 0.4 + errorFactor * 0.2);
          
          // Mark as stable if high stability score and long tracking history
          point.isStable = point.stabilityScore > 0.7 && point.totalSuccessfulFrames > 20;
          
          successCount++;
          totalError += trackingError;
          result.outcome = 'SUCCESS';
        } else {
          // Tracking failed or invalid coordinates
          point.status = 'lost';
          point.errorHistory.push(999); // High error for failed tracking
          
          // Reset tracking streak but preserve total successful frames
          point.successfulTrackingStreak = 0;
          point.stabilityScore = Math.max(0, point.stabilityScore - 0.1); // Gradual decay
          point.isStable = false; // Lose stable status on tracking failure
          
          if (trackingStatus === 0) {
            result.outcome = 'TRACKING_FAILED';
          } else if (nextPoints.data32F[i * 2] === undefined || nextPoints.data32F[i * 2 + 1] === undefined) {
            result.outcome = 'UNDEFINED_COORDS';
          } else {
            result.outcome = 'ERROR_TOO_HIGH';
          }
        }

        trackingResults.push(result);

        // Limit error history
        if (point.errorHistory.length > 10) {
          point.errorHistory = point.errorHistory.slice(-10);
        }
      }
      
      // Log detailed results (sample of first 5 points to avoid spam)
      logger.info('KeypointTracker', 'Lucas-Kanade tracking results:', {
        attempt: this.trackingAttempts,
        isInitialTracking,
        loseThreshold,
        keepThreshold,
        successCount,
        totalPoints: activePoints.length,
        successRate: `${(successCount / activePoints.length * 100).toFixed(1)}%`,
        avgError: successCount > 0 ? (totalError / successCount).toFixed(2) : 'N/A',
        sampleResults: trackingResults.slice(0, 5)
      });

      // Cleanup OpenCV matrices
      prevPoints.delete();
      nextPoints.delete();
      status.delete();
      error.delete();

      // Filter outliers using RANSAC-style consensus (skip during initial tracking)
      if (!isInitialTracking) {
        this._filterOutliers(cv);
      } else {
        logger.debug('KeypointTracker', 'Skipping outlier filtering during initial tracking phase');
      }

      // Update previous frame
      this.previousGray.delete();
      this.previousGray = currentGray.clone();

      // Calculate success metrics
      const successRate = successCount / activePoints.length;
      const avgError = successCount > 0 ? totalError / successCount : 999;
      
      // Store tracking history
      const trackingStats = {
        timestamp: performance.now(),
        totalPoints: this.trackedPoints.length,
        activePoints: activePoints.length,
        successfulPoints: successCount,
        successRate: successRate,
        averageError: avgError,
        anchorPosition: this.getAnchorPosition()
      };
      
      this.trackingHistory.push(trackingStats);
      if (this.trackingHistory.length > this.maxHistory) {
        this.trackingHistory = this.trackingHistory.slice(-this.maxHistory);
      }

      // Try to recover outlier points if we have too few active points
      const finalActiveCount = this.trackedPoints.filter(pt => pt.status === 'active').length;
      if (finalActiveCount < 12) {
        this._recoverOutlierPoints();
      }

      // Clean up inactive keypoints to prevent memory growth and visual clutter
      this._cleanupInactiveKeypoints();

      return {
        success: successRate >= 0.5, // Require at least 50% success rate
        successRate: successRate,
        activePointCount: this.trackedPoints.filter(pt => pt.status === 'active').length,
        averageError: avgError,
        statistics: trackingStats
      };

    } catch (error) {
      logger.error('KeypointTracker', 'Tracking error:', error);
      return { success: false, reason: 'Tracking exception: ' + error.message };
    }
  }

  /**
   * Filter outlier keypoints using motion consensus
   */
  _filterOutliers() {
    const activePoints = this.trackedPoints.filter(pt => pt.status === 'active');
    
    logger.debug('KeypointTracker', 'Outlier filtering - starting:', {
      activePoints: activePoints.length,
      minRequired: 15
    });
    
    if (activePoints.length < 15) {
      logger.debug('KeypointTracker', 'Skipping outlier filtering - too few points');
      return;
    }

    const transformation = this._estimateReferenceTransformation(activePoints);
    if (!transformation) {
      logger.debug('KeypointTracker', 'Skipping outlier filtering - no coherent transform');
      return;
    }

    const residuals = activePoints.map(point => ({
      point,
      residual: this._transformationResidual(point, transformation)
    }));
    const sortedResiduals = residuals.map(item => item.residual).sort((a, b) => a - b);
    const medianResidual = sortedResiduals[Math.floor(sortedResiduals.length / 2)];

    // Filter outliers with stability consideration
    const baseThreshold = 5.0; // Base MAD threshold multiplier
    let outlierCount = 0;
    let protectedCount = 0;
    
    logger.debug('KeypointTracker', 'Outlier filtering - motion analysis:', {
      rotation: `${(transformation.rotation * 180 / Math.PI).toFixed(1)}deg`,
      scale: transformation.scale.toFixed(3),
      medianResidual: medianResidual.toFixed(2),
      baseThreshold: baseThreshold
    });
    
    for (const item of residuals) {
      const point = item.point;
      // Adaptive threshold based on stability
      let effectiveThreshold = Math.max(8, medianResidual * baseThreshold);
      if (point.isStable) {
        // Protect stable points with higher threshold (more lenient)
        effectiveThreshold *= 2.0;
        protectedCount++;
      } else if (point.stabilityScore > 0.5) {
        // Moderately stable points get some protection
        effectiveThreshold *= 1.5;
      }
      
      if (item.residual > effectiveThreshold) {
        // Only mark as outlier if not highly stable
        if (!point.isStable || point.stabilityScore < 0.8) {
          point.status = 'outlier';
          outlierCount++;
        } else {
          // Highly stable points keep active status despite motion deviation
          logger.debug('KeypointTracker', `Protected stable keypoint ${point.id} from outlier filtering`);
        }
      }
    }
    
    const remainingActive = activePoints.length - outlierCount;
    
    logger.info('KeypointTracker', 'Outlier filtering results:', {
      originalActive: activePoints.length,
      outliers: outlierCount,
      remainingActive: remainingActive,
      protectedStable: protectedCount,
      outlierRate: `${(outlierCount / activePoints.length * 100).toFixed(1)}%`
    });
  }

  /**
   * Attempt to recover outlier points when active count is too low
   */
  _recoverOutlierPoints() {
    const outlierPoints = this.trackedPoints.filter(pt => pt.status === 'outlier');
    
    if (outlierPoints.length === 0) return;
    const activePoints = this.trackedPoints.filter(pt => pt.status === 'active');
    const transformation = activePoints.length >= 3
      ? this._estimateReferenceTransformation(activePoints)
      : null;
    
    logger.debug('KeypointTracker', 'Attempting to recover outlier points:', {
      outlierCount: outlierPoints.length,
      activeCount: this.trackedPoints.filter(pt => pt.status === 'active').length
    });
    
    if (transformation) {
      let recoveredByGeometry = 0;
      outlierPoints.forEach(point => {
        const residual = this._transformationResidual(point, transformation);
        if (residual < 10) {
          point.status = 'active';
          point.stabilityScore = Math.max(point.stabilityScore, 0.45);
          recoveredByGeometry++;
        }
      });

      if (recoveredByGeometry > 0) {
        logger.info('KeypointTracker', `Recovered ${recoveredByGeometry} outlier points from similarity transform`);
        return;
      }
    }

    // Recover up to 5 outlier points that have the best error history
    const recoverablePoints = outlierPoints
      .filter(pt => pt.errorHistory.length > 0)
      .sort((a, b) => {
        const avgErrorA = a.errorHistory.reduce((sum, err) => sum + err, 0) / a.errorHistory.length;
        const avgErrorB = b.errorHistory.reduce((sum, err) => sum + err, 0) / b.errorHistory.length;
        return avgErrorA - avgErrorB; // Lower error is better
      })
      .slice(0, 5);
    
    let recoveredCount = 0;
    for (const point of recoverablePoints) {
      // Only recover points with reasonable error history
      const avgError = point.errorHistory.reduce((sum, err) => sum + err, 0) / point.errorHistory.length;
      if (avgError < 60) { // More lenient than normal threshold
        point.status = 'active';
        recoveredCount++;
      }
    }
    
    if (recoveredCount > 0) {
      logger.info('KeypointTracker', `Recovered ${recoveredCount} outlier points back to active`);
    }
  }

  /**
   * Get current anchor position using keypoint centroid + tap offset
   * This provides stable positioning that doesn't drift when keypoints are lost asymmetrically
   */
  getAnchorPosition() {
    const activePoints = this.trackedPoints.filter(pt => pt.status === 'active');
    if (activePoints.length === 0) return null;

    // Try transformation-based approach first for more robust positioning
    const transformation = this._estimateReferenceTransformation(activePoints);
    
    if (transformation) {
      const anchorOriginal = this.anchorOriginalPosition || {
        x: this.keypointCentroid.x + this.tapOffset.x,
        y: this.keypointCentroid.y + this.tapOffset.y
      };
      const anchorPosition = this._applyReferenceTransformation(anchorOriginal, transformation);

      return {
        x: anchorPosition.x,
        y: anchorPosition.y,
        confidence: transformation.confidence,
        method: 'reference_similarity_transform',
        rotation: transformation.rotation,
        scale: transformation.scale,
        inlierCount: transformation.inlierCount,
        averageResidual: transformation.averageResidual,
      };
    }

    // Fallback: use robust weighted centroid of current keypoints
    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;

    for (const pt of activePoints) {
      // Weight based on tracking quality (inverse of average error) and age
      const avgError = pt.errorHistory.length > 0 ? 
        pt.errorHistory.reduce((sum, err) => sum + err, 0) / pt.errorHistory.length : 
        10;
      const weight = Math.max(0.1, (1 / (1 + avgError)) * Math.min(pt.age, 10));
      
      weightedX += pt.current.x * weight;
      weightedY += pt.current.y * weight;
      totalWeight += weight;
    }

    const currentCentroid = {
      x: weightedX / totalWeight,
      y: weightedY / totalWeight
    };

    // Apply tap offset to get anchor position
    return {
      x: currentCentroid.x + this.tapOffset.x,
      y: currentCentroid.y + this.tapOffset.y,
      confidence: activePoints.length / this.trackedPoints.length,
      method: 'weighted_centroid_with_offset'
    };
  }

  /**
   * Estimate transformation from original template to current tracked points
   * Uses robust RANSAC-style consensus to handle outliers
   */
  _estimateReferenceTransformation(activePoints) {
    if (activePoints.length < 3) return null;

    const initialTransform = this._fitSimilarityTransform(activePoints);
    const residuals = activePoints.map(point => ({
      point,
      residual: this._transformationResidual(point, initialTransform)
    }));
    const sortedResiduals = residuals.map(item => item.residual).sort((a, b) => a - b);
    const medianResidual = sortedResiduals[Math.floor(sortedResiduals.length / 2)];
    const threshold = Math.max(8, medianResidual * 2.5);
    const inliers = residuals
      .filter(item => item.residual <= threshold)
      .map(item => item.point);

    if (inliers.length < 3 || inliers.length / activePoints.length < 0.45) {
      return null;
    }

    const refinedTransform = this._fitSimilarityTransform(inliers);
    const refinedResiduals = inliers.map(point => this._transformationResidual(point, refinedTransform));
    const averageResidual = refinedResiduals.reduce((sum, residual) => sum + residual, 0) / refinedResiduals.length;
    const residualConfidence = Math.max(0, 1 - averageResidual / 16);

    return {
      ...refinedTransform,
      confidence: (inliers.length / activePoints.length) * residualConfidence,
      inlierCount: inliers.length,
      averageResidual,
    };
  }

  _fitSimilarityTransform(points) {
    const sourceCentroid = points.reduce((sum, point) => ({
      x: sum.x + point.original.x,
      y: sum.y + point.original.y,
    }), { x: 0, y: 0 });
    sourceCentroid.x /= points.length;
    sourceCentroid.y /= points.length;

    const targetCentroid = points.reduce((sum, point) => ({
      x: sum.x + point.current.x,
      y: sum.y + point.current.y,
    }), { x: 0, y: 0 });
    targetCentroid.x /= points.length;
    targetCentroid.y /= points.length;

    let a = 0;
    let b = 0;
    let denominator = 0;
    points.forEach(point => {
      const sourceX = point.original.x - sourceCentroid.x;
      const sourceY = point.original.y - sourceCentroid.y;
      const targetX = point.current.x - targetCentroid.x;
      const targetY = point.current.y - targetCentroid.y;

      a += sourceX * targetX + sourceY * targetY;
      b += sourceX * targetY - sourceY * targetX;
      denominator += sourceX * sourceX + sourceY * sourceY;
    });

    const scale = Math.hypot(a, b) / Math.max(denominator, 1e-6);
    const rotation = Math.atan2(b, a);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const tx = targetCentroid.x - scale * (cos * sourceCentroid.x - sin * sourceCentroid.y);
    const ty = targetCentroid.y - scale * (sin * sourceCentroid.x + cos * sourceCentroid.y);

    return { tx, ty, scale, rotation };
  }

  _applyReferenceTransformation(point, transformation) {
    if (transformation.type === 'homography') {
      return this._transformHomographyPoint(point, transformation.matrix);
    }

    const cos = Math.cos(transformation.rotation);
    const sin = Math.sin(transformation.rotation);
    return {
      x: transformation.tx + transformation.scale * (cos * point.x - sin * point.y),
      y: transformation.ty + transformation.scale * (sin * point.x + cos * point.y),
    };
  }

  _invertReferenceTransformation(point, transformation) {
    if (transformation.type === 'homography') {
      return this._transformHomographyPoint(point, transformation.inverseMatrix);
    }

    const cos = Math.cos(transformation.rotation);
    const sin = Math.sin(transformation.rotation);
    const translatedX = point.x - transformation.tx;
    const translatedY = point.y - transformation.ty;
    const inverseScale = 1 / transformation.scale;

    return {
      x: inverseScale * (cos * translatedX + sin * translatedY),
      y: inverseScale * (-sin * translatedX + cos * translatedY),
    };
  }

  _transformHomographyPoint(point, matrix) {
    const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
    return {
      x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
      y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
    };
  }

  _invertHomographyMatrix(matrix) {
    const [
      a, b, c,
      d, e, f,
      g, h, i,
    ] = matrix;
    const determinant =
      a * (e * i - f * h) -
      b * (d * i - f * g) +
      c * (d * h - e * g);

    if (Math.abs(determinant) < 1e-9) return null;

    return [
      (e * i - f * h) / determinant,
      (c * h - b * i) / determinant,
      (b * f - c * e) / determinant,
      (f * g - d * i) / determinant,
      (a * i - c * g) / determinant,
      (c * d - a * f) / determinant,
      (d * h - e * g) / determinant,
      (b * g - a * h) / determinant,
      (a * e - b * d) / determinant,
    ];
  }

  _estimateReferenceHomography(cv, activePoints) {
    if (!cv || activePoints.length < 8 || typeof cv.findHomography !== 'function') {
      return null;
    }

    const srcPoints = [];
    const dstPoints = [];
    activePoints.forEach(point => {
      srcPoints.push(point.original.x, point.original.y);
      dstPoints.push(point.current.x, point.current.y);
    });

    const srcMat = cv.matFromArray(activePoints.length, 1, cv.CV_32FC2, srcPoints);
    const dstMat = cv.matFromArray(activePoints.length, 1, cv.CV_32FC2, dstPoints);
    const mask = new cv.Mat();
    seedHomographyRansac(cv);
    const homography = cv.findHomography(srcMat, dstMat, cv.RANSAC, 3, mask, 1000, 0.99);

    let inlierCount = 0;
    for (let index = 0; index < mask.rows; index++) {
      if (mask.data[index] === 1) inlierCount++;
    }

    const matrix = homography.empty() ? null : Array.from(homography.data64F);
    const inverseMatrix = matrix ? this._invertHomographyMatrix(matrix) : null;

    srcMat.delete();
    dstMat.delete();
    mask.delete();
    if (!homography.empty()) homography.delete();

    if (!matrix || !inverseMatrix || inlierCount < 8 || inlierCount / activePoints.length < 0.5) {
      return null;
    }

    const residuals = activePoints.map(point => {
      const projected = this._transformHomographyPoint(point.original, matrix);
      return Math.hypot(projected.x - point.current.x, projected.y - point.current.y);
    });
    const averageResidual = residuals.reduce((sum, residual) => sum + residual, 0) / residuals.length;

    return {
      type: 'homography',
      matrix,
      inverseMatrix,
      scale: 1,
      rotation: 0,
      confidence: Math.max(0, Math.min(1, (inlierCount / activePoints.length) * (1 - Math.min(1, averageResidual / 12)))),
      inlierCount,
      averageResidual,
    };
  }

  _replaceTrackingPointsPreservingReference(keypoints, currentGray, transformation) {
    const sortedKeypoints = [...keypoints]
      .sort((a, b) => b.response - a.response)
      .slice(0, 80);
    const anchorOriginalPosition = { ...this.anchorOriginalPosition };

    this.trackedPoints = sortedKeypoints.map((kp, index) => {
      const current = { x: kp.pt.x, y: kp.pt.y };
      return {
        id: index,
        original: this._invertReferenceTransformation(current, transformation),
        current,
        response: kp.response,
        status: 'active',
        errorHistory: [],
        age: 0,
        successfulTrackingStreak: 0,
        totalSuccessfulFrames: 0,
        stabilityScore: 0,
        isStable: false
      };
    });

    const xSum = this.trackedPoints.reduce((sum, pt) => sum + pt.original.x, 0);
    const ySum = this.trackedPoints.reduce((sum, pt) => sum + pt.original.y, 0);
    this.keypointCentroid = {
      x: xSum / this.trackedPoints.length,
      y: ySum / this.trackedPoints.length
    };
    this.anchorOriginalPosition = anchorOriginalPosition;
    this.tapOffset = {
      x: this.anchorOriginalPosition.x - this.keypointCentroid.x,
      y: this.anchorOriginalPosition.y - this.keypointCentroid.y
    };

    if (this.previousGray) {
      this.previousGray.delete();
    }
    this.previousGray = currentGray.clone();
    this.trackingAttempts = 0;
    this.nextPointId = this.trackedPoints.length;
  }

  _mergeTrackingPointsPreservingReference(keypoints, currentGray, transformation) {
    const sortedKeypoints = [...keypoints]
      .sort((a, b) => b.response - a.response);
    const maxTrackedPoints = 96;
    const minCurrentDistance = 8;
    const minReferenceDistance = 8;
    let added = 0;

    for (const kp of sortedKeypoints) {
      if (this.trackedPoints.length >= maxTrackedPoints) {
        break;
      }

      const current = { x: kp.pt.x, y: kp.pt.y };
      const original = this._invertReferenceTransformation(current, transformation);
      const overlapsExisting = this.trackedPoints.some(point => {
        const referenceDistance = Math.hypot(point.original.x - original.x, point.original.y - original.y);
        const currentDistance = point.status === 'active'
          ? Math.hypot(point.current.x - current.x, point.current.y - current.y)
          : Infinity;
        return referenceDistance < minReferenceDistance || currentDistance < minCurrentDistance;
      });

      if (overlapsExisting) {
        continue;
      }

      const id = this.nextPointId ?? (Math.max(-1, ...this.trackedPoints.map(point => point.id)) + 1);
      this.trackedPoints.push(this._createTrackedPoint(id, original, current, kp.response));
      this.nextPointId = id + 1;
      added++;
    }

    this._pruneLandmarkMap(maxTrackedPoints);
    this._recalculateReferenceCentroid();

    if (this.previousGray) {
      this.previousGray.delete();
    }
    this.previousGray = currentGray.clone();
    this.trackingAttempts = 0;
    this.lastRefreshStats = {
      added,
      total: this.trackedPoints.length,
      active: this.trackedPoints.filter(point => point.status === 'active').length,
    };

    return true;
  }

  restoreFromReferenceTransform(currentGray, transformation, inlierIds = null) {
    const inlierIdSet = inlierIds ? new Set(inlierIds) : null;
    let restored = 0;

    this.trackedPoints.forEach(point => {
      if (inlierIdSet && !inlierIdSet.has(point.id)) {
        return;
      }

      point.current = this._applyReferenceTransformation(point.original, transformation);
      point.status = 'active';
      point.inactiveAge = 0;
      point.lastSeenAttempt = this.trackingAttempts;
      point.age = (point.age || 0) + 1;
      point.observations = (point.observations || 0) + 1;
      point.successfulTrackingStreak = Math.max(point.successfulTrackingStreak || 0, 1);
      point.totalSuccessfulFrames = (point.totalSuccessfulFrames || 0) + 1;
      point.stabilityScore = Math.max(point.stabilityScore || 0, transformation.confidence || 0.5);
      point.errorHistory = [...(point.errorHistory || []), transformation.averageResidual || 0].slice(-10);
      restored++;
    });

    this._pruneLandmarkMap(96);
    this._recalculateReferenceCentroid();

    if (this.previousGray) {
      this.previousGray.delete();
    }
    this.previousGray = currentGray.clone();
    this.trackingAttempts = 0;
    this.lastRefreshStats = {
      restored,
      total: this.trackedPoints.length,
      active: this.trackedPoints.filter(point => point.status === 'active').length,
    };

    return {
      restored,
      total: this.trackedPoints.length,
      active: this.lastRefreshStats.active,
    };
  }

  _createTrackedPoint(id, original, current, response) {
    return {
      id,
      original,
      current,
      response,
      status: 'active',
      errorHistory: [],
      age: 0,
      successfulTrackingStreak: 0,
      totalSuccessfulFrames: 0,
      stabilityScore: 0,
      isStable: false,
      inactiveAge: 0,
      observations: 0,
      createdAtAttempt: this.trackingAttempts,
      lastSeenAttempt: this.trackingAttempts,
    };
  }

  _pruneLandmarkMap(maxTrackedPoints) {
    if (this.trackedPoints.length <= maxTrackedPoints) {
      return;
    }

    this.trackedPoints = [...this.trackedPoints]
      .sort((a, b) => {
        const activeDelta = (b.status === 'active') - (a.status === 'active');
        if (activeDelta !== 0) return activeDelta;
        const stableDelta = (b.isStable === true) - (a.isStable === true);
        if (stableDelta !== 0) return stableDelta;
        const scoreDelta = (b.stabilityScore || 0) - (a.stabilityScore || 0);
        if (Math.abs(scoreDelta) > 1e-6) return scoreDelta;
        return (b.totalSuccessfulFrames || 0) - (a.totalSuccessfulFrames || 0);
      })
      .slice(0, maxTrackedPoints);
  }

  _recalculateReferenceCentroid() {
    const referencePoints = this.trackedPoints.filter(point => (
      point.status === 'active' ||
      point.isStable ||
      (point.inactiveAge || 0) < 30 ||
      (point.totalSuccessfulFrames || 0) >= 45
    ));
    const pointsForCentroid = referencePoints.length > 0 ? referencePoints : this.trackedPoints;

    if (pointsForCentroid.length === 0) {
      return;
    }

    const xSum = pointsForCentroid.reduce((sum, pt) => sum + pt.original.x, 0);
    const ySum = pointsForCentroid.reduce((sum, pt) => sum + pt.original.y, 0);
    this.keypointCentroid = {
      x: xSum / pointsForCentroid.length,
      y: ySum / pointsForCentroid.length
    };

    if (this.anchorOriginalPosition) {
      this.tapOffset = {
        x: this.anchorOriginalPosition.x - this.keypointCentroid.x,
        y: this.anchorOriginalPosition.y - this.keypointCentroid.y
      };
    }
  }

  _transformationResidual(point, transformation) {
    const projected = this._applyReferenceTransformation(point.original, transformation);
    return Math.hypot(projected.x - point.current.x, projected.y - point.current.y);
  }

  /**
   * Calculate tracking stability metrics
   */
  getStabilityMetrics() {
    if (this.trackingHistory.length < 5) {
      return {
        velocityStable: false,
        coherenceStable: false,
        overallStable: false,
        metrics: {}
      };
    }

    const recent = this.trackingHistory.slice(-10);
    const velocities = [];
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1].anchorPosition;
      const curr = recent[i].anchorPosition;
      
      if (prev && curr) {
        const dt = (recent[i].timestamp - recent[i - 1].timestamp) / 1000;
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        const velocity = Math.sqrt(dx*dx + dy*dy) / dt;
        velocities.push(velocity);
      }
    }

    const avgVelocity = velocities.length > 0 ? 
      velocities.reduce((sum, v) => sum + v, 0) / velocities.length : 0;
    
    const avgSuccessRate = recent.reduce((sum, stat) => sum + stat.successRate, 0) / recent.length;
    const velocityStable = avgVelocity < 20;
    const coherenceStable = avgSuccessRate > 0.7;
    
    return {
      velocityStable: velocityStable,
      coherenceStable: coherenceStable,
      overallStable: velocityStable && coherenceStable,
      metrics: {
        averageVelocity: avgVelocity,
        averageSuccessRate: avgSuccessRate,
        activePointCount: this.trackedPoints.filter(pt => pt.status === 'active').length
      }
    };
  }

  /**
   * Get keypoint correspondences for homography estimation
   * @returns {Array} Array of {prev: {x,y}, curr: {x,y}} point pairs
   */
  getCorrespondences(options = {}) {
    const activePoints = this.trackedPoints.filter(pt => pt.status === 'active');
    const {
      maxReferenceDistance = Infinity,
      minCount = 8,
      maxCount = Infinity,
    } = options;

    const anchorReference = this.anchorOriginalPosition || this.keypointCentroid;
    const scoredPoints = activePoints.map(point => ({
      point,
      distance: anchorReference
        ? Math.hypot(point.original.x - anchorReference.x, point.original.y - anchorReference.y)
        : 0,
      quality: (point.stabilityScore || 0) + Math.min(point.age || 0, 30) / 30 + (point.response || 0),
    }));
    const locallySupported = Number.isFinite(maxReferenceDistance)
      ? scoredPoints.filter(item => item.distance <= maxReferenceDistance)
      : scoredPoints;
    const selected = locallySupported.length >= minCount
      ? locallySupported
      : scoredPoints
        .sort((a, b) => a.distance - b.distance || b.quality - a.quality)
        .slice(0, Math.min(scoredPoints.length, minCount));

    return selected
      .sort((a, b) => a.distance - b.distance || b.quality - a.quality)
      .slice(0, maxCount)
      .map(({ point }) => ({
        prev: { x: point.original.x, y: point.original.y },
        curr: { x: point.current.x, y: point.current.y },
        response: point.response,
        age: point.age
      }));
  }

  getObjectPose(options = {}) {
    const anchorReference = options.anchorReference || this.anchorOriginalPosition || this.keypointCentroid;
    const correspondences = this.getCorrespondences({
      maxReferenceDistance: options.maxReferenceDistance || Infinity,
      minCount: options.minCount || 8,
      maxCount: options.maxCount || 80,
    });

    return this.objectPoseEstimator.estimate({
      correspondences,
      anchorReference,
      previousPose: options.previousPose || null,
    });
  }

  refreshKeypoints(cv, currentGray, keypointDetector, region) {
    try {
      // Validate inputs
      if (!cv || !currentGray || !keypointDetector || !region) {
        logger.warn('KeypointTracker', 'Invalid inputs for refreshKeypoints');
        return false;
      }

      // Check if image is valid
      if (currentGray.empty() || currentGray.cols === 0 || currentGray.rows === 0) {
        logger.warn('KeypointTracker', 'Invalid image for keypoint refresh');
        return false;
      }

      // Validate region bounds
      if (region.x < 0 || region.y < 0 || 
          region.x + region.width > currentGray.cols || 
          region.y + region.height > currentGray.rows) {
        logger.warn('KeypointTracker', 'Region out of bounds for keypoint refresh');
        return false;
      }

      const activePoints = this.trackedPoints.filter(pt => pt.status === 'active');
      const referenceTransformation = this._selectRefreshReferenceTransformation(cv, activePoints);
      const newKeypoints = keypointDetector.extractKeypoints(cv, currentGray, region);
      
      if (newKeypoints.keypoints.length >= 15) {
        if (referenceTransformation) {
          this._mergeTrackingPointsPreservingReference(newKeypoints.keypoints, currentGray, referenceTransformation);
        } else {
          this.lastRefreshStats = {
            added: 0,
            total: this.trackedPoints.length,
            active: activePoints.length,
            rejected: true,
          };
          return false;
        }
        logger.info('KeypointTracker', `Refreshed tracking with ${this.trackedPoints.length} current-frame keypoints`);
        return true;
      } else {
        logger.debug('KeypointTracker', `Insufficient new keypoints for refresh: ${newKeypoints.keypoints.length}`);
      }
    } catch (error) {
      // Proper error handling for OpenCV errors
      const errorMessage = typeof error === 'number' ? `OpenCV error code: ${error}` : error.message || 'Unknown error';
      logger.error('KeypointTracker', 'Failed to refresh keypoints:', errorMessage);
    }
    
    return false;
  }

  _selectRefreshReferenceTransformation(cv, activePoints) {
    if (activePoints.length < 3) {
      return null;
    }

    const candidates = [
      activePoints.length >= 8 ? this._estimateReferenceHomography(cv, activePoints) : null,
      this._estimateReferenceTransformation(activePoints),
    ].filter(Boolean);

    return candidates
      .map(candidate => ({
        transform: candidate,
        score: this._refreshTransformationScore(candidate, activePoints.length),
      }))
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.transform || null;
  }

  _refreshTransformationScore(transform, activeCount) {
    const residual = transform.averageResidual ?? Infinity;
    const confidence = transform.confidence ?? 0;
    const inlierRatio = (transform.inlierCount || 0) / Math.max(activeCount, 1);

    if (!Number.isFinite(residual) || transform.scale <= 0.001) {
      return 0;
    }

    if (transform.type === 'homography') {
      if (confidence < 0.32 || residual > 5.5 || inlierRatio < 0.5) {
        return 0;
      }
      return confidence * 2.2 + inlierRatio * 0.8 + Math.max(0, 1 - residual / 5.5) + 0.18;
    }

    if (confidence < 0.2 || residual > 12 || inlierRatio < 0.45) {
      return 0;
    }

    return confidence * 2 + inlierRatio * 0.7 + Math.max(0, 1 - residual / 12);
  }

  /**
   * Clean up inactive keypoints to prevent memory growth and reduce visual clutter
   * Removes points that have been lost or outliers for too long
   */
  _cleanupInactiveKeypoints() {
    if (!this.trackedPoints || this.trackedPoints.length === 0) return;

    const before = this.trackedPoints.length;
    this.trackedPoints.forEach(point => {
      if (point.status === 'lost' || point.status === 'outlier') {
        point.inactiveAge = (point.inactiveAge || 0) + 1;
      } else {
        point.inactiveAge = 0;
      }
    });

    this.trackedPoints = this.trackedPoints.filter(point => {
      if (point.status === 'active') {
        return true;
      }

      const stableEnough = point.isStable ||
        (point.stabilityScore || 0) >= 0.65 ||
        (point.totalSuccessfulFrames || 0) >= 45;
      const maxInactiveAge = stableEnough ? 120 : 45;
      return (point.inactiveAge || 0) <= maxInactiveAge;
    });

    const removed = before - this.trackedPoints.length;
    if (removed > 0) {
      logger.info('KeypointTracker', `Retired ${removed} stale landmarks from tracking map`);
    }
  }

  dispose() {
    if (this.previousGray) {
      this.previousGray.delete();
      this.previousGray = null;
    }
    this.trackedPoints = [];
    this.trackingHistory = [];
    this.keypointCentroid = null;
    this.tapOffset = null;
    this.nextPointId = 0;
    this.lastRefreshStats = null;
    this.initialized = false;
  }
}
