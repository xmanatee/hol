/**
 * Image-Based Anchor Service
 * Orchestrates keypoint tracking, homography estimation, and template matching
 * for robust object anchoring
 */

import { KeypointDetector } from '../cv/anchor.keypoints.js';
import { KeypointTracker } from '../cv/anchor.tracking.js';
import { HomographyEstimator } from '../cv/anchor.homography.js';
import { AnchorPersistenceSystem } from '../cv/anchor.persistence.js';
import { OneEuroFilter } from '../cv/oneEuroFilter.js';
import { testOpenCVFeatures, logOpenCVFeatures, checkCriticalFeatures } from '../cv/opencv.features.test.js';
import { logger } from '../utils/logger.js';

export class ImageAnchorService {
  constructor() {
    this.initialized = false;
    this.cv = null;
    
    // Core components
    this.keypointDetector = new KeypointDetector();
    this.keypointTracker = new KeypointTracker();
    this.homographyEstimator = new HomographyEstimator();
    this.persistenceSystem = new AnchorPersistenceSystem();
    
    // Filters for smoothing
    this.positionFilterX = new OneEuroFilter(30);
    this.positionFilterY = new OneEuroFilter(30);
    this.normalFilterX = new OneEuroFilter(30);
    this.normalFilterY = new OneEuroFilter(30);
    this.normalFilterZ = new OneEuroFilter(30);
    
    // State
    this.anchored = false;
    this.anchorState = 'inactive'; // inactive, initializing, tracking, stable, degraded, lost
    this.template = null;
    this.templateRegion = null;
    this.templateCenter = null; // Reference center point for stable positioning
    this.currentPosition = null;
    this.currentNormal = null;
    this.lastFrameTime = 0;
    this.framesSinceRefresh = 0;
    this.refreshInterval = 15; // Refresh keypoints every N frames
    
    // Resilience counters
    this.keypointFailureCount = 0;
    this.maxKeypointFailures = 3; // Allow 3 consecutive failures before degrading
    
    // Performance metrics
    this.metrics = {
      keypointCount: 0,
      trackingSuccessRate: 0,
      homographyInliers: 0,
      processingTime: 0,
      recoveryAttempts: 0
    };
    
    // Event listeners
    this.listeners = new Set();
  }

  async initialize(cv, cameraParams) {
    if (this.initialized) return;
    
    try {
      logger.info('ImageAnchor', 'Initializing...');
      
      // Test OpenCV features first
      logger.info('ImageAnchor', 'Testing OpenCV features...');
      const featureTest = logOpenCVFeatures();
      
      if (!featureTest.available) {
        throw new Error('OpenCV.js not available');
      }

      // Check critical features
      const criticalCheck = checkCriticalFeatures();
      if (!criticalCheck.allAvailable) {
        const missingFeatures = criticalCheck.missing.join(', ');
        logger.error('ImageAnchor', 'Missing critical OpenCV features:', missingFeatures);
        throw new Error(`Missing critical OpenCV features: ${missingFeatures}. Image anchor system cannot function.`);
      }

      logger.info('ImageAnchor', 'All critical OpenCV features available ✅');
      
      this.cv = cv;
      
      await this.keypointDetector.initialize(cv);
      await this.keypointTracker.initialize(cv);
      await this.homographyEstimator.initialize(cv, cameraParams);
      await this.persistenceSystem.initialize(cv);
      
      this.initialized = true;
      logger.info('ImageAnchor', 'All components initialized successfully');
      
    } catch (error) {
      logger.error('ImageAnchor', 'Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Create anchor from user tap
   * @param {ImageData} imageData - Current frame
   * @param {Object} tapPosition - {x, y} tap coordinates
   * @param {Object} boundingBox - Detection bounding box (if available)
   */
  async createAnchor(imageData, tapPosition, boundingBox = null) {
    if (!this.initialized) {
      throw new Error('ImageAnchorService not initialized');
    }

    const startTime = performance.now();
    this.anchorState = 'initializing';
    this._notifyStateChange();

    try {
      // Convert to OpenCV Mat
      const src = this.cv.matFromImageData(imageData);
      const gray = new cv.Mat();
      this.cv.cvtColor(src, gray, this.cv.COLOR_RGBA2GRAY);
      
      // Determine template region
      const templateRegion = this._calculateTemplateRegion(
        tapPosition, 
        boundingBox, 
        imageData.width, 
        imageData.height
      );

      logger.info('ImageAnchor', `Creating anchor at (${tapPosition.x}, ${tapPosition.y}) with region ${templateRegion.width}x${templateRegion.height}`);

      // Extract keypoints from template region
      const keypointResult = this.keypointDetector.extractKeypoints(this.cv, gray, templateRegion);
      
      if (keypointResult.keypoints.length < 20) {
        src.delete();
        gray.delete();
        throw new Error(`Insufficient keypoints: ${keypointResult.keypoints.length} (need at least 20)`);
      }

      // Assess template quality
      const qualityAssessment = this.keypointDetector.assessTemplateQuality(
        keypointResult.keypoints,
        keypointResult.descriptors,
        templateRegion.width,
        templateRegion.height
      );

      if (qualityAssessment.overall < 0.25) {
        src.delete();
        gray.delete();
        throw new Error(`Poor template quality: ${qualityAssessment.overall.toFixed(2)} (need > 0.25)`);
      }

      // Store template center for persistence system (still needed for template matching)
      const templateCenter = {
        x: templateRegion.x + templateRegion.width / 2,
        y: templateRegion.y + templateRegion.height / 2
      };

      // Initialize tracking with extracted keypoints and tap position (not template center)
      this.keypointTracker.initializeTracking(this.cv, keypointResult.keypoints, gray, tapPosition);

      // Store template for persistence system
      this.persistenceSystem.storeTemplate(this.cv, gray, templateRegion, templateCenter);

      // Store anchor state
      this.anchored = true;
      this.templateRegion = templateRegion;
      this.templateCenter = templateCenter; // Store for template persistence (not positioning)
      this.currentPosition = { x: tapPosition.x, y: tapPosition.y, z: 0 }; // Anchor at tap position
      this.anchorState = 'tracking';
      this.framesSinceRefresh = 0;
      
      // Initialize metrics
      this.metrics = {
        keypointCount: keypointResult.keypoints.length,
        templateQuality: qualityAssessment.overall,
        extractionMethod: keypointResult.method,
        processingTime: performance.now() - startTime,
        trackingSuccessRate: 1.0,
        homographyInliers: 0,
        recoveryAttempts: 0
      };

      // Cleanup
      src.delete();
      gray.delete();

      logger.info('ImageAnchor', `Anchor created successfully with ${keypointResult.keypoints.length} keypoints (quality: ${qualityAssessment.overall.toFixed(2)})`);
      this._notifyStateChange();

      return {
        success: true,
        position: this.currentPosition,
        keypoints: keypointResult.keypoints.length,
        quality: qualityAssessment.overall,
        method: keypointResult.method
      };

    } catch (error) {
      this.anchorState = 'inactive';
      this.anchored = false;
      this._notifyStateChange();
      logger.error('ImageAnchor', 'Failed to create anchor:', error);
      throw error;
    }
  }

  /**
   * Update anchor with new frame
   * @param {ImageData} imageData - Current frame
   * @returns {Object} Update result with pose information
   */
  updateAnchor(imageData) {
    if (!this.anchored || !this.initialized) {
      logger.warn('ImageAnchor', 'Update called but anchor not ready:', {
        anchored: this.anchored,
        initialized: this.initialized,
        anchorState: this.anchorState
      });
      return { success: false, reason: 'Not anchored' };
    }

    const startTime = performance.now();
    const timestamp = performance.now();
    
    logger.debug('ImageAnchor', 'Starting anchor update:', {
      anchorState: this.anchorState,
      position: this.currentPosition,
      imageSize: `${imageData.width}x${imageData.height}`
    });
    
    try {
      // Convert to OpenCV Mat
      const src = this.cv.matFromImageData(imageData);
      const gray = new cv.Mat();
      this.cv.cvtColor(src, gray, this.cv.COLOR_RGBA2GRAY);

      let updateResult;

      if (this.anchorState === 'tracking' || this.anchorState === 'stable') {
        // Primary tracking via keypoints
        logger.debug('ImageAnchor', 'Attempting keypoint tracking');
        updateResult = this._updateWithKeypoints(gray, timestamp);
        
        if (!updateResult.success && this.anchorState !== 'lost') {
          // Increment failure counter instead of immediately degrading
          this.keypointFailureCount++;
          
          logger.warn('ImageAnchor', 'Keypoint tracking failed:', {
            reason: updateResult.reason,
            keypointCount: this.metrics.keypointCount,
            trackingRate: this.metrics.trackingSuccessRate,
            failureCount: this.keypointFailureCount,
            maxFailures: this.maxKeypointFailures
          });
          
          // Only degrade after multiple consecutive failures
          if (this.keypointFailureCount >= this.maxKeypointFailures) {
            logger.info('ImageAnchor', `Max keypoint failures reached (${this.keypointFailureCount}), degrading to template matching`);
            this.anchorState = 'degraded';
            updateResult = this._updateWithTemplate(gray);
          } else {
            logger.info('ImageAnchor', `Keypoint failure ${this.keypointFailureCount}/${this.maxKeypointFailures}, will retry next frame`);
            // Return the failed result but don't change state yet
            updateResult = {
              success: false,
              reason: `Keypoint failure ${this.keypointFailureCount}/${this.maxKeypointFailures}: ${updateResult.reason}`,
              position: this.currentPosition,
              state: this.anchorState
            };
          }
        } else if (updateResult.success) {
          // Reset failure counter on success
          if (this.keypointFailureCount > 0) {
            logger.info('ImageAnchor', `Keypoint tracking recovered after ${this.keypointFailureCount} failures`);
            this.keypointFailureCount = 0;
          }
        }
      } else if (this.anchorState === 'degraded' || this.anchorState === 'lost') {
        // Try keypoint tracking recovery first if we have tracked points
        if (this.anchorState === 'degraded' && this.keypointTracker.trackedPoints?.length > 10) {
          logger.debug('ImageAnchor', 'Attempting keypoint tracking recovery from degraded state');
          const recoveryResult = this._updateWithKeypoints(gray, timestamp);
          
          if (recoveryResult.success) {
            logger.info('ImageAnchor', 'Keypoint tracking recovered from degraded state!');
            this.anchorState = 'tracking';
            this.keypointFailureCount = 0;
            updateResult = recoveryResult;
          } else {
            logger.debug('ImageAnchor', 'Keypoint recovery failed, falling back to template matching');
            updateResult = this._updateWithTemplate(gray);
          }
        } else {
          // Recovery via template matching
          logger.debug('ImageAnchor', 'Attempting template matching recovery');
          updateResult = this._updateWithTemplate(gray);
          
          if (updateResult.success) {
            logger.info('ImageAnchor', 'Template matching succeeded');
            // Only reinitialize keypoints if we were completely lost, not degraded
            if (this.anchorState === 'lost') {
              this._reinitializeKeypoints(gray);
              this.anchorState = 'degraded'; // Promote from lost to degraded
            }
            // If we were degraded, just stay degraded - keypoint recovery will handle it
          }
        }
      }

      // Handle complete failure
      if (!updateResult.success) {
        this.anchorState = 'lost';
        this.metrics.recoveryAttempts++;
        
        logger.warn('ImageAnchor', 'Anchor tracking completely failed:', {
          reason: updateResult.reason,
          recoveryAttempts: this.metrics.recoveryAttempts,
          previousState: this.anchorState,
          position: this.currentPosition
        });
        
        // Try full-frame search as last resort
        if (this.metrics.recoveryAttempts <= 5) {
          logger.info('ImageAnchor', 'Attempting full-frame recovery search');
          const recoveryResult = this.persistenceSystem.fullFrameSearch(this.cv, gray);
          if (recoveryResult.success) {
            logger.info('ImageAnchor', 'Full-frame recovery succeeded:', recoveryResult);
            updateResult = recoveryResult;
            this.currentPosition = {
              x: recoveryResult.position.x,
              y: recoveryResult.position.y,
              z: 0
            };
            this.anchorState = 'degraded';
          } else {
            logger.warn('ImageAnchor', 'Full-frame recovery failed');
          }
        } else {
          logger.error('ImageAnchor', 'Max recovery attempts exceeded, anchor permanently lost');
        }
      } else {
        // Reset recovery attempts on success
        if (this.metrics.recoveryAttempts > 0) {
          logger.info('ImageAnchor', 'Anchor tracking recovered successfully');
        }
        this.metrics.recoveryAttempts = 0;
      }

      // Update metrics
      this.metrics.processingTime = performance.now() - startTime;
      
      // Cleanup
      src.delete();
      gray.delete();

      this._notifyStateChange();
      return updateResult;

    } catch (error) {
      logger.error('ImageAnchor', 'Update error:', error);
      return { success: false, reason: 'Update exception: ' + error.message };
    }
  }

  /**
   * Update using keypoint tracking and homography
   */
  _updateWithKeypoints(grayImage, timestamp) {
    try {
      logger.debug('ImageAnchor', 'Keypoint tracking - starting trackToFrame');
      const trackingResult = this.keypointTracker.trackToFrame(this.cv, grayImage);
      
      logger.info('ImageAnchor', 'Keypoint tracking result:', {
        success: trackingResult.success,
        reason: trackingResult.reason || 'No reason provided',
        activePointCount: trackingResult.activePointCount,
        successRate: trackingResult.successRate,
        averageError: trackingResult.averageError
      });
      
      if (!trackingResult.success) {
        logger.warn('ImageAnchor', 'Keypoint tracking failed:', {
          ...trackingResult,
          trackerState: {
            initialized: this.keypointTracker.initialized,
            hasTrackedPoints: this.keypointTracker.trackedPoints?.length || 0,
            hasPreviousGray: !!this.keypointTracker.previousGray
          }
        });
        return {
          success: false,
          reason: trackingResult.reason || 'Keypoint tracking failed',
          state: this.anchorState
        };
      }

      // Update metrics  
      this.metrics.trackingSuccessRate = trackingResult.successRate || 0;
      this.metrics.keypointCount = trackingResult.activePointCount || 0;

      // Check if we have sufficient tracking quality
      const minSuccessRate = 0.5;
      const minActivePoints = 15;
      
      if (this.metrics.trackingSuccessRate < minSuccessRate || this.metrics.keypointCount < minActivePoints) {
        logger.warn('ImageAnchor', 'Keypoint tracking quality insufficient:', {
          successRate: this.metrics.trackingSuccessRate,
          activePointCount: this.metrics.keypointCount,
          minSuccessRate,
          minActivePoints
        });
        
        // Try to get position from available tracking data
        if (trackingResult.centroid) {
          this.currentPosition = {
            x: this.positionFilterX.filter(trackingResult.centroid.x, timestamp),
            y: this.positionFilterY.filter(trackingResult.centroid.y, timestamp),
            z: 0
          };
          
          return {
            success: true,
            position: this.currentPosition,
            normal: this.currentNormal,
            confidence: this.metrics.trackingSuccessRate,
            method: 'keypoint_centroid_only',
            state: this.anchorState
          };
        }
        
        return {
          success: false,
          reason: 'Insufficient keypoint tracking quality',
          state: this.anchorState
        };
      }

      // Try homography estimation if we have correspondences
      let homographyResult = null;
      this.metrics.homographyInliers = 0;
      
      const correspondences = this.keypointTracker.getCorrespondences();
      logger.debug('ImageAnchor', 'Homography correspondences check:', {
        correspondences: correspondences.length,
        required: 8
      });
      
      if (correspondences.length >= 8) {
        logger.debug('ImageAnchor', `Attempting homography with ${correspondences.length} correspondences`);
        
        try {
          homographyResult = this.homographyEstimator.estimateHomography(
            this.cv,
            correspondences
          );
          
          logger.debug('ImageAnchor', 'Homography result:', {
            success: homographyResult?.success,
            inliers: homographyResult?.inlierCount || 0,
            center: homographyResult?.center ? `(${homographyResult.center.x.toFixed(1)}, ${homographyResult.center.y.toFixed(1)})` : null
          });
          
          if (homographyResult?.success) {
            this.metrics.homographyInliers = homographyResult.inlierCount;
          }
        } catch (error) {
          logger.warn('ImageAnchor', 'Homography estimation error:', error);
        }
      } else {
        logger.debug('ImageAnchor', 'Skipping homography - insufficient correspondences:', {
          correspondences: correspondences.length,
          required: 8
        });
      }

      // Update position using offset-based keypoint positioning
      let newPosition = null;
      let positionMethod = 'unknown';
      
      // Always clean up homography matrix if it exists (used for normals, not position)
      if (homographyResult?.homography && !homographyResult.homography.isDeleted()) {
        homographyResult.homography.delete();
      }
      
      // Use keypoint centroid + tap offset for anchor positioning
      const anchorPosition = this.keypointTracker.getAnchorPosition();
      if (anchorPosition) {
        newPosition = {
          x: this.positionFilterX.filter(anchorPosition.x, timestamp),
          y: this.positionFilterY.filter(anchorPosition.y, timestamp),
          z: 0
        };
        positionMethod = anchorPosition.method || 'keypoint_offset';
        logger.debug('ImageAnchor', `Using keypoint offset positioning: ${positionMethod}`);
      }
      
      if (!newPosition) {
        logger.warn('ImageAnchor', 'No position data available from tracking or homography');
        return {
          success: false,
          reason: 'No position data available',
          state: this.anchorState
        };
      }
      
      this.currentPosition = newPosition;

      // Update surface normal if available from homography
      if (homographyResult?.success && homographyResult.normal) {
        this.currentNormal = {
          x: this.normalFilterX.filter(homographyResult.normal.x, timestamp),
          y: this.normalFilterY.filter(homographyResult.normal.y, timestamp),
          z: this.normalFilterZ.filter(homographyResult.normal.z, timestamp)
        };
        logger.debug('ImageAnchor', 'Updated surface normal from homography');
      }

      // Determine anchor state based on tracking quality
      const overallQuality = (this.metrics.trackingSuccessRate + Math.min(1.0, this.metrics.homographyInliers / 30)) / 2;
      const prevState = this.anchorState;
      
      if (overallQuality >= 0.8 && this.metrics.homographyInliers >= 25) {
        this.anchorState = 'stable';
      } else if (overallQuality >= 0.6 && this.metrics.homographyInliers >= 15) {
        this.anchorState = 'tracking';
      } else if (overallQuality >= 0.4) {
        this.anchorState = 'tracking'; // Keep tracking if we have reasonable quality
      } else {
        this.anchorState = 'degraded';
      }
      
      if (prevState !== this.anchorState) {
        logger.info('ImageAnchor', `Anchor state updated: ${prevState} -> ${this.anchorState} (quality: ${overallQuality.toFixed(2)})`);
      }

      // Periodic keypoint refresh for quality maintenance - only if tracking is stable
      this.framesSinceRefresh++;
      if (this.framesSinceRefresh >= this.refreshInterval && 
          overallQuality > 0.7 && 
          this.anchorState === 'stable' &&
          this.metrics.trackingSuccessRate > 0.7) {
        this._refreshKeypoints(grayImage);
        this.framesSinceRefresh = 0;
        logger.debug('ImageAnchor', 'Refreshed keypoints');
      }

      logger.debug('ImageAnchor', 'Keypoint tracking successful:', {
        method: positionMethod,
        position: `(${newPosition.x.toFixed(1)}, ${newPosition.y.toFixed(1)})`,
        quality: overallQuality.toFixed(2),
        state: this.anchorState,
        inliers: this.metrics.homographyInliers
      });

      return {
        success: true,
        position: this.currentPosition,
        normal: this.currentNormal,
        confidence: overallQuality,
        method: positionMethod,
        inliers: this.metrics.homographyInliers,
        state: this.anchorState
      };

    } catch (error) {
      logger.error('ImageAnchor', 'Error in _updateWithKeypoints:', error);
      return {
        success: false,
        reason: `Keypoint tracking error: ${error.message}`,
        state: this.anchorState
      };
    }
  }

  /**
   * Update using template matching fallback
   */
  _updateWithTemplate(grayImage) {
    const recoveryResult = this.persistenceSystem.attemptRecovery(this.cv, grayImage);
    
    if (recoveryResult.success) {
      this.currentPosition = {
        x: recoveryResult.position.x,
        y: recoveryResult.position.y,
        z: 0
      };

      return {
        success: true,
        position: this.currentPosition,
        normal: this.currentNormal, // Keep previous normal
        confidence: recoveryResult.confidence,
        method: recoveryResult.method,
        state: this.anchorState
      };
    }

    return recoveryResult;
  }

  /**
   * Refresh keypoints in current region
   */
  _refreshKeypoints(grayImage) {
    if (!this.currentPosition) return;

    const refreshRegion = {
      x: Math.max(0, this.currentPosition.x - this.templateRegion.width / 2),
      y: Math.max(0, this.currentPosition.y - this.templateRegion.height / 2),
      width: this.templateRegion.width,
      height: this.templateRegion.height
    };

    const refreshResult = this.keypointTracker.refreshKeypoints(
      this.cv,
      grayImage,
      this.keypointDetector,
      refreshRegion
    );

    if (refreshResult) {
      logger.info('ImageAnchor', 'Keypoints refreshed successfully');
    }
  }

  /**
   * Attempt to reinitialize keypoint tracking after recovery
   */
  _reinitializeKeypoints(grayImage) {
    if (!this.currentPosition) return;

    const region = {
      x: Math.max(0, this.currentPosition.x - this.templateRegion.width / 2),
      y: Math.max(0, this.currentPosition.y - this.templateRegion.height / 2),
      width: this.templateRegion.width,
      height: this.templateRegion.height
    };

    try {
      const keypointResult = this.keypointDetector.extractKeypoints(this.cv, grayImage, region);
      
      if (keypointResult.keypoints.length >= 20) {
        this.keypointTracker.initializeTracking(this.cv, keypointResult.keypoints, grayImage);
        this.anchorState = 'tracking';
        logger.info('ImageAnchor', 'Keypoint tracking reinitialized after recovery');
      }
    } catch (error) {
      logger.warn('ImageAnchor', 'Failed to reinitialize keypoints:', error);
    }
  }

  /**
   * Calculate template region from tap position and bounding box
   */
  _calculateTemplateRegion(tapPosition, boundingBox, imageWidth, imageHeight) {
    // Use ±20% of image dimensions around clicked point for keypoint detection
    const boxPercent = 0.2; // 20% in each direction = 40% total box
    const boxWidth = imageWidth * boxPercent;
    const boxHeight = imageHeight * boxPercent;
    
    // Create rectangular region centered on tap position with ±20% constraint
    const region = {
      x: Math.max(0, tapPosition.x - boxWidth),
      y: Math.max(0, tapPosition.y - boxHeight), 
      width: boxWidth * 2, // ±20% = 40% total width
      height: boxHeight * 2 // ±20% = 40% total height
    };

    // Ensure region is within image bounds
    region.x = Math.max(0, Math.min(region.x, imageWidth - region.width));
    region.y = Math.max(0, Math.min(region.y, imageHeight - region.height));
    region.width = Math.min(region.width, imageWidth - region.x);
    region.height = Math.min(region.height, imageHeight - region.y);

    return region;
  }

  /**
   * Add event listener for anchor updates
   */
  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notify listeners of state changes
   */
  _notifyStateChange() {
    const state = {
      anchored: this.anchored,
      state: this.anchorState,
      position: this.currentPosition,
      normal: this.currentNormal,
      metrics: { ...this.metrics }
    };

    this.listeners.forEach(listener => {
      try {
        if (typeof listener === 'function') {
          listener(state);
        } else if (listener.onAnchorUpdate) {
          listener.onAnchorUpdate(state);
        }
      } catch (error) {
        logger.error('ImageAnchor', 'Listener error:', error);
      }
    });
  }

  /**
   * Clear current anchor
   */
  clearAnchor() {
    if (this.anchored) {
      this.anchored = false;
      this.anchorState = 'inactive';
      this.currentPosition = null;
      this.currentNormal = null;
      this.templateRegion = null;
      this.templateCenter = null; // Clear template center reference
      this.framesSinceRefresh = 0;
      
      // Reset resilience counters
      this.keypointFailureCount = 0;
      
      // Reset filters
      this.positionFilterX = new OneEuroFilter(30);
      this.positionFilterY = new OneEuroFilter(30);
      this.normalFilterX = new OneEuroFilter(30);
      this.normalFilterY = new OneEuroFilter(30);
      this.normalFilterZ = new OneEuroFilter(30);
      
      logger.info('ImageAnchor', 'Anchor cleared');
      this._notifyStateChange();
    }
  }

  /**
   * Get current anchor state
   */
  getState() {
    return {
      anchored: this.anchored,
      state: this.anchorState,
      position: this.currentPosition,
      normal: this.currentNormal,
      metrics: { ...this.metrics }
    };
  }

  dispose() {
    this.clearAnchor();
    
    if (this.keypointDetector) this.keypointDetector.dispose();
    if (this.keypointTracker) this.keypointTracker.dispose();
    if (this.homographyEstimator) this.homographyEstimator.dispose();
    if (this.persistenceSystem) this.persistenceSystem.dispose();
    
    this.listeners.clear();
    this.initialized = false;
    
    logger.info('ImageAnchor', 'Disposed');
  }
}