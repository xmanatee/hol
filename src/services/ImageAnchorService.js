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
import { checkCriticalFeatures } from '../cv/opencv.features.test.js';
import { calculateTemplateRegion } from '../utils/templateRegion.js';
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
    this.templateAnchorOffset = null;
    this.currentPosition = null;
    this.currentNormal = null;
    this.lastFrameTime = 0;
    this.framesSinceRefresh = 0;
    this.refreshInterval = 15; // Refresh keypoints every N frames
    
    // Resilience counters
    this.keypointFailureCount = 0;
    this.maxKeypointFailures = 3; // Allow 3 consecutive failures before degrading
    
    // Auto-reset functionality for permanently lost anchors
    this.autoResetTimer = null;
    this.autoResetDelay = 3000; // 3 seconds before auto-reset
    this.permanentlyLost = false;
    
    // Performance metrics
    this.metrics = {
      keypointCount: 0,
      trackingSuccessRate: 0,
      homographyInliers: 0,
      processingTime: 0,
      recoveryAttempts: 0,
      lostFrameCount: 0,
      keypointFailureCount: 0,
      lastFailureReason: null,
      lastFailureStage: null,
      lastUpdateResult: null,
      lastUpdateMethod: null
    };
    
    // Event listeners
    this.listeners = new Set();

    this.minAnchorKeypoints = 12;
    this.minimumTemplateQuality = 0.12;
    this.targetTemplateQuality = 0.25;
  }

  async initialize(cv, cameraParams) {
    if (this.initialized) return;
    
    try {
      logger.info('ImageAnchor', 'Initializing...');

      const criticalCheck = checkCriticalFeatures();
      if (!criticalCheck.allAvailable) {
        const missingFeatures = criticalCheck.missing.join(', ');
        const error = criticalCheck.error || `Missing critical OpenCV features: ${missingFeatures}`;
        logger.error('ImageAnchor', error);
        throw new Error(error);
      }

      logger.info('ImageAnchor', 'All critical OpenCV features available');
      
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
      const gray = new this.cv.Mat();
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
      
      if (keypointResult.keypoints.length < this.minAnchorKeypoints) {
        const message = `Insufficient keypoints: ${keypointResult.keypoints.length} (need at least ${this.minAnchorKeypoints})`;
        this._recordAnchorFailure('keypoints', message, {
          keypointCount: keypointResult.keypoints.length,
          templateKeypoints: keypointResult.keypoints.length,
          templateRegion,
          extractionMethod: keypointResult.method,
          processingTime: performance.now() - startTime
        });
        src.delete();
        gray.delete();
        throw new Error(message);
      }

      // Assess template quality
      const qualityAssessment = this.keypointDetector.assessTemplateQuality(
        keypointResult.keypoints,
        keypointResult.descriptors,
        templateRegion.width,
        templateRegion.height,
        templateRegion.x,
        templateRegion.y
      );

      if (!this._isUsableTemplateQuality(qualityAssessment.overall)) {
        const message = `Poor template quality: ${qualityAssessment.overall.toFixed(2)} (need at least ${this.minimumTemplateQuality.toFixed(2)})`;
        this._recordAnchorFailure('template-quality', message, {
          keypointCount: keypointResult.keypoints.length,
          templateKeypoints: keypointResult.keypoints.length,
          templateQuality: qualityAssessment.overall,
          qualityState: 'failed',
          templateRegion,
          extractionMethod: keypointResult.method,
          processingTime: performance.now() - startTime
        });
        src.delete();
        gray.delete();
        throw new Error(message);
      }

      // Store template center for persistence system (still needed for template matching)
      const templateCenter = {
        x: templateRegion.x + templateRegion.width / 2,
        y: templateRegion.y + templateRegion.height / 2
      };
      const templateAnchorOffset = {
        x: tapPosition.x - templateCenter.x,
        y: tapPosition.y - templateCenter.y
      };

      // Initialize tracking with extracted keypoints and tap position (not template center)
      this.keypointTracker.initializeTracking(this.cv, keypointResult.keypoints, gray, tapPosition);

      // Store template for persistence system
      this.persistenceSystem.storeTemplate(this.cv, gray, templateRegion, tapPosition);

      // Store anchor state
      this.anchored = true;
      this.templateRegion = templateRegion;
      this.templateCenter = templateCenter; // Store for template persistence (not positioning)
      this.templateAnchorOffset = templateAnchorOffset;
      this.currentPosition = { x: tapPosition.x, y: tapPosition.y, z: 0 }; // Anchor at tap position
      this.anchorState = this._getInitialAnchorState(qualityAssessment.overall);
      this.framesSinceRefresh = 0;
      
      // Initialize metrics
      this.metrics = {
        keypointCount: keypointResult.keypoints.length,
        templateKeypoints: keypointResult.keypoints.length,
        templateQuality: qualityAssessment.overall,
        qualityState: this._getTemplateQualityState(qualityAssessment.overall),
        templateRegion: { ...templateRegion },
        templateCenter: { ...templateCenter },
        templateAnchorOffset: { ...templateAnchorOffset },
        templateRegionArea: templateRegion.width * templateRegion.height,
        extractionMethod: keypointResult.method,
        processingTime: performance.now() - startTime,
        trackingSuccessRate: 1.0,
        homographyInliers: 0,
        recoveryAttempts: 0,
        lostFrameCount: 0,
        keypointFailureCount: 0,
        lastFailureReason: null,
        lastFailureStage: null,
        lastUpdateResult: 'created',
        lastUpdateMethod: keypointResult.method,
        createdAt: Date.now()
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
        method: keypointResult.method,
        state: this.anchorState
      };

    } catch (error) {
      if (!this.metrics.lastFailureReason) {
        this._recordAnchorFailure('create-anchor', error.message, {
          processingTime: performance.now() - startTime
        });
      }
      this.anchorState = 'inactive';
      this.anchored = false;
      this._notifyStateChange();
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
      const gray = new this.cv.Mat();
      this.cv.cvtColor(src, gray, this.cv.COLOR_RGBA2GRAY);

      let updateResult;

      if (this.anchorState === 'tracking' || this.anchorState === 'stable') {
        // Primary tracking via keypoints
        logger.debug('ImageAnchor', 'Attempting keypoint tracking');
        updateResult = this._updateWithKeypoints(gray, timestamp);
        
        if (!updateResult.success && this.anchorState !== 'lost') {
          // Increment failure counter instead of immediately degrading
          this.keypointFailureCount++;
          this.metrics.keypointFailureCount = this.keypointFailureCount;
          this.metrics.lastFailureReason = updateResult.reason || 'Keypoint tracking failed';
          this.metrics.lastFailureStage = 'keypoint-tracking';
          
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
              state: this.anchorState,
              recoverable: true
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
      if (!updateResult.success && !updateResult.recoverable) {
        this.anchorState = 'lost';
        this.metrics.recoveryAttempts++;
        this.metrics.lostFrameCount = (this.metrics.lostFrameCount || 0) + 1;
        this.metrics.lastFailureReason = updateResult.reason || 'Anchor tracking failed';
        this.metrics.lastFailureStage = 'tracking';
        
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
          this._startAutoResetTimer();
        }
      } else if (!updateResult.success) {
        this.metrics.lastFailureReason = updateResult.reason || 'Keypoint tracking failed';
        this.metrics.lastFailureStage = 'keypoint-tracking';
      } else {
        // Reset recovery attempts on success
        if (this.metrics.recoveryAttempts > 0) {
          logger.info('ImageAnchor', 'Anchor tracking recovered successfully');
        }
        this.metrics.recoveryAttempts = 0;
        this.metrics.lostFrameCount = 0;
        this.metrics.lastFailureReason = null;
        this.metrics.lastFailureStage = null;
        
        // Cancel auto-reset timer if tracking recovered
        this._cancelAutoResetTimer();
      }

      // Update metrics
      this._recordAnchorUpdateResult(updateResult, performance.now() - startTime);
      
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
      const minActivePoints = 12;
      
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

    const templateCenter = this._getTemplateCenterFromAnchorPosition();
    const refreshRegion = {
      x: templateCenter.x - this.templateRegion.width / 2,
      y: templateCenter.y - this.templateRegion.height / 2,
      width: this.templateRegion.width,
      height: this.templateRegion.height
    };

    const refreshResult = this.keypointTracker.refreshKeypoints(
      this.cv,
      grayImage,
      this.keypointDetector,
      this._clampTemplateRegion(refreshRegion, grayImage.cols, grayImage.rows),
      this.currentPosition
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

    const templateCenter = this._getTemplateCenterFromAnchorPosition();
    const region = {
      x: templateCenter.x - this.templateRegion.width / 2,
      y: templateCenter.y - this.templateRegion.height / 2,
      width: this.templateRegion.width,
      height: this.templateRegion.height
    };

    try {
      const keypointResult = this.keypointDetector.extractKeypoints(
        this.cv,
        grayImage,
        this._clampTemplateRegion(region, grayImage.cols, grayImage.rows)
      );
      
      if (keypointResult.keypoints.length >= 15) {
        this.keypointTracker.initializeTracking(this.cv, keypointResult.keypoints, grayImage, this.currentPosition);
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
    return calculateTemplateRegion(tapPosition, boundingBox, imageWidth, imageHeight);
  }

  _getTemplateCenterFromAnchorPosition() {
    const offset = this.templateAnchorOffset || { x: 0, y: 0 };
    return {
      x: this.currentPosition.x - offset.x,
      y: this.currentPosition.y - offset.y
    };
  }

  _clampTemplateRegion(region, imageWidth, imageHeight) {
    const width = Math.min(region.width, imageWidth);
    const height = Math.min(region.height, imageHeight);

    return {
      x: Math.round(Math.max(0, Math.min(region.x, imageWidth - width))),
      y: Math.round(Math.max(0, Math.min(region.y, imageHeight - height))),
      width: Math.round(width),
      height: Math.round(height)
    };
  }

  _isUsableTemplateQuality(quality) {
    return quality >= this.minimumTemplateQuality;
  }

  _getTemplateQualityState(quality) {
    return quality >= this.targetTemplateQuality ? 'strong' : 'weak';
  }

  _getInitialAnchorState(quality) {
    return quality >= this.targetTemplateQuality ? 'tracking' : 'degraded';
  }

  _recordAnchorFailure(stage, reason, metrics = {}) {
    this.metrics = {
      ...this.metrics,
      ...metrics,
      templateRegion: metrics.templateRegion ? { ...metrics.templateRegion } : this.metrics.templateRegion,
      lastFailureStage: stage,
      lastFailureReason: reason,
      lastFailureAt: performance.now(),
      lastUpdateResult: 'failed'
    };
  }

  _recordAnchorUpdateResult(result, processingTime) {
    this.metrics.processingTime = processingTime;
    this.metrics.lastUpdateResult = result.success ? 'success' : 'failed';
    this.metrics.lastUpdateMethod = result.method || null;
    this.metrics.lastUpdateConfidence = typeof result.confidence === 'number' ? result.confidence : null;
    this.metrics.keypointFailureCount = this.keypointFailureCount;

    if (!result.success) {
      this.metrics.lastFailureReason = result.reason || this.metrics.lastFailureReason || 'Anchor update failed';
      this.metrics.lastFailureStage = this.metrics.lastFailureStage || 'tracking';
    }
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
      this.templateAnchorOffset = null;
      this.framesSinceRefresh = 0;
      
      // Reset resilience counters
      this.keypointFailureCount = 0;
      
      // Cancel any pending auto-reset timer
      this._cancelAutoResetTimer();
      
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

  /**
   * Start auto-reset timer for permanently lost anchors
   */
  _startAutoResetTimer() {
    if (this.autoResetTimer) {
      clearTimeout(this.autoResetTimer);
    }
    
    this.permanentlyLost = true;
    
    logger.info('ImageAnchor', `Starting auto-reset timer: ${this.autoResetDelay}ms`);
    
    this.autoResetTimer = setTimeout(() => {
      if (this.permanentlyLost && this.anchored) {
        logger.info('ImageAnchor', 'Auto-resetting permanently lost anchor to detection mode');
        
        // Notify listeners about auto-reset before clearing
        this._notifyAutoReset();
        
        // Clear the anchor (transitions back to detection mode)
        this.clearAnchor();
        
        // Emit special auto-reset notification
        this._notifyStateChange();
      }
    }, this.autoResetDelay);
  }
  
  /**
   * Cancel auto-reset timer (when tracking recovers)
   */
  _cancelAutoResetTimer() {
    if (this.autoResetTimer) {
      clearTimeout(this.autoResetTimer);
      this.autoResetTimer = null;
      
      if (this.permanentlyLost) {
        logger.info('ImageAnchor', 'Cancelled auto-reset timer - tracking recovered');
        this.permanentlyLost = false;
      }
    }
  }
  
  /**
   * Notify listeners about auto-reset event
   */
  _notifyAutoReset() {
    const resetEvent = {
      type: 'auto-reset',
      reason: 'permanently_lost',
      message: 'Anchor lost, returning to detection mode',
      timestamp: performance.now()
    };

    this.listeners.forEach(listener => {
      try {
        if (typeof listener === 'function') {
          listener(resetEvent);
        } else if (listener.onAutoReset) {
          listener.onAutoReset(resetEvent);
        }
      } catch (error) {
        logger.error('ImageAnchor', 'Auto-reset listener error:', error);
      }
    });
  }

  dispose() {
    this.clearAnchor();
    
    // Cancel any pending auto-reset timer
    this._cancelAutoResetTimer();
    
    if (this.keypointDetector) this.keypointDetector.dispose();
    if (this.keypointTracker) this.keypointTracker.dispose();
    if (this.homographyEstimator) this.homographyEstimator.dispose();
    if (this.persistenceSystem) this.persistenceSystem.dispose();
    
    this.listeners.clear();
    this.initialized = false;
    
    logger.info('ImageAnchor', 'Disposed');
  }
}
