/**
 * Lucas-Kanade Optical Flow Tracking for Keypoints
 * Tracks template keypoints frame-to-frame with outlier detection
 */

import { logger } from '../utils/logger.js';

export class KeypointTracker {
  constructor() {
    this.initialized = false;
    this.trackedPoints = [];
    this.previousGray = null;
    this.trackingHistory = [];
    this.maxHistory = 30;
    
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
    const sortedKeypoints = keypoints
      .sort((a, b) => b.response - a.response)
      .slice(0, 80);

    this.trackedPoints = sortedKeypoints.map((kp, index) => ({
      id: index,
      original: { x: kp.pt.x, y: kp.pt.y },
      current: { x: kp.pt.x, y: kp.pt.y },
      response: kp.response,
      status: 'active',
      errorHistory: [],
      age: 0,
      // Stability tracking
      successfulTrackingStreak: 0,  // Consecutive successful tracking frames
      totalSuccessfulFrames: 0,     // Total frames successfully tracked
      stabilityScore: 0,            // Computed stability metric (0-1)
      isStable: false               // High stability flag for protection
    }));

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
    } else {
      // No offset if no tap position provided
      this.tapOffset = { x: 0, y: 0 };
    }

    // Store reference frame
    if (this.previousGray) {
      this.previousGray.delete();
    }
    this.previousGray = grayImage.clone();
    
    // Reset adaptive tracking state
    this.trackingAttempts = 0;

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
        averageError: avgError
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

    // Calculate median motion vector
    const motionVectors = [];
    for (const pt of activePoints) {
      motionVectors.push({
        dx: pt.current.x - pt.original.x,
        dy: pt.current.y - pt.original.y,
        point: pt
      });
    }

    // Find median motion
    const dxValues = motionVectors.map(mv => mv.dx).sort((a, b) => a - b);
    const dyValues = motionVectors.map(mv => mv.dy).sort((a, b) => a - b);
    
    const medianDx = dxValues[Math.floor(dxValues.length / 2)];
    const medianDy = dyValues[Math.floor(dyValues.length / 2)];

    // Calculate MAD (Median Absolute Deviation)
    const dxDeviations = dxValues.map(dx => Math.abs(dx - medianDx));
    const dyDeviations = dyValues.map(dy => Math.abs(dy - medianDy));
    
    const madDx = dxDeviations.sort((a, b) => a - b)[Math.floor(dxDeviations.length / 2)];
    const madDy = dyDeviations.sort((a, b) => a - b)[Math.floor(dyDeviations.length / 2)];

    // Filter outliers with stability consideration
    const baseThreshold = 5.0; // Base MAD threshold multiplier
    let outlierCount = 0;
    let protectedCount = 0;
    
    logger.debug('KeypointTracker', 'Outlier filtering - motion analysis:', {
      medianMotion: `(${medianDx.toFixed(2)}, ${medianDy.toFixed(2)})`,
      madValues: `(${madDx.toFixed(2)}, ${madDy.toFixed(2)})`,
      baseThreshold: baseThreshold
    });
    
    for (const mv of motionVectors) {
      const point = mv.point;
      
      // Adaptive threshold based on stability
      let effectiveThreshold = baseThreshold;
      if (point.isStable) {
        // Protect stable points with higher threshold (more lenient)
        effectiveThreshold = baseThreshold * 2.0; // 10.0x MAD for stable points
        protectedCount++;
      } else if (point.stabilityScore > 0.5) {
        // Moderately stable points get some protection
        effectiveThreshold = baseThreshold * 1.5; // 7.5x MAD
      }
      
      const dxOutlier = Math.abs(mv.dx - medianDx) > effectiveThreshold * madDx;
      const dyOutlier = Math.abs(mv.dy - medianDy) > effectiveThreshold * madDy;
      
      if (dxOutlier || dyOutlier) {
        // Only mark as outlier if not highly stable
        if (!point.isStable || point.stabilityScore < 0.8) {
          mv.point.status = 'outlier';
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
    
    logger.debug('KeypointTracker', 'Attempting to recover outlier points:', {
      outlierCount: outlierPoints.length,
      activeCount: this.trackedPoints.filter(pt => pt.status === 'active').length
    });
    
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

    // Calculate current keypoint centroid
    let currentCentroid = null;

    // Try transformation-based approach first for more robust positioning
    const transformation = this._estimateReferenceTransformation(activePoints);
    
    if (transformation) {
      // Apply transformation to original keypoint centroid
      const transformedCentroid = {
        x: transformation.tx + transformation.scale * Math.cos(transformation.rotation) * this.keypointCentroid.x - transformation.scale * Math.sin(transformation.rotation) * this.keypointCentroid.y,
        y: transformation.ty + transformation.scale * Math.sin(transformation.rotation) * this.keypointCentroid.x + transformation.scale * Math.cos(transformation.rotation) * this.keypointCentroid.y
      };

      currentCentroid = transformedCentroid;
      
      // Apply tap offset to get anchor position
      const anchorPosition = {
        x: currentCentroid.x + this.tapOffset.x,
        y: currentCentroid.y + this.tapOffset.y,
        confidence: transformation.confidence,
        method: 'reference_transform_with_offset'
      };
      
      return anchorPosition;
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

    currentCentroid = {
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

    // Calculate motion vectors from original to current positions
    const motionVectors = activePoints.map(pt => ({
      dx: pt.current.x - pt.original.x,
      dy: pt.current.y - pt.original.y,
      point: pt
    }));

    // Find consensus translation using median
    const dxValues = motionVectors.map(mv => mv.dx).sort((a, b) => a - b);
    const dyValues = motionVectors.map(mv => mv.dy).sort((a, b) => a - b);
    
    const consensusDx = dxValues[Math.floor(dxValues.length / 2)];
    const consensusDy = dyValues[Math.floor(dyValues.length / 2)];

    // Count inliers (points consistent with consensus motion)
    const threshold = 10; // pixels
    const inliers = motionVectors.filter(mv => 
      Math.abs(mv.dx - consensusDx) < threshold && 
      Math.abs(mv.dy - consensusDy) < threshold
    );

    const inlierRatio = inliers.length / motionVectors.length;
    
    if (inlierRatio < 0.4) {
      return null; // Not enough consensus
    }

    // Simple similarity transformation (translation + scale + rotation)
    // For now, assume mostly translation with small rotation/scale changes
    return {
      tx: consensusDx,
      ty: consensusDy,
      scale: 1.0, // Could be estimated from point distances
      rotation: 0.0, // Could be estimated from point relationships
      confidence: inlierRatio,
      inlierCount: inliers.length
    };
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

    const recent = this.trackingHistory.slice(-10); // Last 10 frames
    
    // Calculate velocity stability
    const velocities = [];
    for (let i = 1; i < recent.length; i++) {
      const prev = this.getAnchorPositionAtTime(recent[i-1].timestamp);
      const curr = this.getAnchorPositionAtTime(recent[i].timestamp);
      
      if (prev && curr) {
        const dt = (recent[i].timestamp - recent[i-1].timestamp) / 1000; // seconds
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        const velocity = Math.sqrt(dx*dx + dy*dy) / dt;
        velocities.push(velocity);
      }
    }

    const avgVelocity = velocities.length > 0 ? 
      velocities.reduce((sum, v) => sum + v, 0) / velocities.length : 0;
    
    // Calculate success rate stability
    const avgSuccessRate = recent.reduce((sum, stat) => sum + stat.successRate, 0) / recent.length;
    
    // Stability criteria
    const velocityStable = avgVelocity < 20; // pixels per second
    const coherenceStable = avgSuccessRate > 0.7; // 70% success rate
    
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
  getCorrespondences() {
    const activePoints = this.trackedPoints.filter(pt => pt.status === 'active');
    
    return activePoints.map(pt => ({
      prev: { x: pt.original.x, y: pt.original.y },
      curr: { x: pt.current.x, y: pt.current.y },
      response: pt.response,
      age: pt.age
    }));
  }

  /**
   * Helper method to get anchor position at specific timestamp
   */
  getAnchorPositionAtTime() {
    // This is a simplified version - in practice you'd interpolate
    return this.getAnchorPosition();
  }

  /**
   * Refresh tracking by re-detecting keypoints in current region
   */
  refreshKeypoints(cv, currentGray, keypointDetector, region, anchorPosition) {
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

      const newKeypoints = keypointDetector.extractKeypoints(cv, currentGray, region);
      
      if (newKeypoints.keypoints.length >= 15) {
        this.initializeTracking(cv, newKeypoints.keypoints, currentGray, anchorPosition);
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

  /**
   * Clean up inactive keypoints to prevent memory growth and reduce visual clutter
   * Removes points that have been lost or outliers for too long
   */
  _cleanupInactiveKeypoints() {
    if (!this.trackedPoints || this.trackedPoints.length === 0) return;
    
    const initialCount = this.trackedPoints.length;
    const activeCount = this.trackedPoints.filter(pt => pt.status === 'active').length;
    
    // Only clean up if we have enough active points to maintain tracking
    if (activeCount < 15) {
      logger.debug('KeypointTracker', 'Skipping cleanup - too few active points:', activeCount);
      return;
    }
    
    // Mark points for removal if they've been inactive for too long
    let removedCount = 0;
    this.trackedPoints = this.trackedPoints.filter(point => {
      // Keep all active points
      if (point.status === 'active') return true;
      
      // Remove lost or outlier points that have aged beyond threshold
      // Age represents frames since the point was last active
      if (point.status === 'lost' || point.status === 'outlier') {
        point.age = (point.age || 0) + 1;
        
        // Remove after 30 frames (~1 second at 30fps) of being inactive
        if (point.age > 30) {
          removedCount++;
          return false;
        }
      }
      
      return true; // Keep the point for now
    });
    
    if (removedCount > 0) {
      const finalActiveCount = this.trackedPoints.filter(pt => pt.status === 'active').length;
      logger.info('KeypointTracker', 'Cleaned up inactive keypoints:', {
        removed: removedCount,
        totalPoints: `${initialCount} -> ${this.trackedPoints.length}`,
        activePoints: finalActiveCount,
        memoryReduction: `${((removedCount / initialCount) * 100).toFixed(1)}%`
      });
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
    this.initialized = false;
  }
}
