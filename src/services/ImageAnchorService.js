/**
 * Image-Based Anchor Service
 * Orchestrates persistent keypoint tracking, object-pose estimation, and template matching
 * for robust object anchoring
 */

import { KeypointDetector } from '../cv/anchor.keypoints.js';
import { KeypointTracker } from '../cv/anchor.tracking.js';
import { HomographyEstimator } from '../cv/anchor.homography.js';
import { AffineParallaxPoseEstimator } from '../cv/anchor.affinePose.js';
import { AnchorPersistenceSystem } from '../cv/anchor.persistence.js';
import { OneEuroFilter } from '../cv/oneEuroFilter.js';
import { checkCriticalFeatures } from '../cv/opencv.features.test.js';
import { calculateTemplateRegion } from '../utils/templateRegion.js';
import { SurfaceNormalStabilizer } from '../utils/normalStabilizer.js';
import { logger } from '../utils/logger.js';

const POSE_MODEL = 'object-pose';

const unwrapAngle = (target, reference) => {
  let unwrapped = target;
  while (unwrapped - reference > Math.PI) unwrapped -= Math.PI * 2;
  while (unwrapped - reference < -Math.PI) unwrapped += Math.PI * 2;
  return unwrapped;
};

export class ImageAnchorService {
  constructor() {
    this.initialized = false;
    this.cv = null;
    
    // Core components
    this.keypointDetector = new KeypointDetector();
    this.keypointTracker = new KeypointTracker();
    this.homographyEstimator = new HomographyEstimator();
    this.affinePoseEstimator = new AffineParallaxPoseEstimator();
    this.persistenceSystem = new AnchorPersistenceSystem();
    
    // Filters for smoothing
    this.positionFilterX = new OneEuroFilter(30);
    this.positionFilterY = new OneEuroFilter(30);
    this.planarScaleFilter = new OneEuroFilter(30);
    this.planarRotationFilter = new OneEuroFilter(30);
    this.normalStabilizer = new SurfaceNormalStabilizer();
    
    // State
    this.anchored = false;
    this.anchorState = 'inactive'; // inactive, initializing, tracking, stable, degraded, lost
    this.template = null;
    this.templateRegion = null;
    this.templateCenter = null; // Reference center point for stable positioning
    this.templateAnchorOffset = null;
    this.currentPosition = null;
    this.currentNormal = null;
    this.currentPlanarTransform = null;
    this.lastFrameTime = 0;
    this.framesSinceRefresh = 0;
    this.refreshInterval = 15; // Refresh keypoints every N frames
    this.fullFrameRecoveryInterval = 6;
    this.framesSinceFullFrameRecovery = this.fullFrameRecoveryInterval;
    
    // Resilience counters
    this.keypointFailureCount = 0;
    this.maxKeypointFailures = 3; // Allow 3 consecutive failures before degrading
    
    // Performance metrics
    this.metrics = {
      keypointCount: 0,
      trackingSuccessRate: 0,
      homographyInliers: 0,
      processingTime: 0,
      recoveryAttempts: 0,
      lostFrameCount: 0,
      keypointFailureCount: 0,
      poseModel: POSE_MODEL,
      poseSource: null,
      poseInliers: 0,
      affinePoseInliers: 0,
      landmarkCount: 0,
      activeLandmarkCount: 0,
      inactiveLandmarkCount: 0,
      landmarkRefreshAdded: 0,
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
      this.currentPlanarTransform = {
        scale: 1,
        rotation: 0,
        confidence: 1,
        inlierCount: keypointResult.keypoints.length,
        method: 'created'
      };
      this.planarScaleFilter.filter(1, startTime);
      this.planarRotationFilter.filter(0, startTime);
      this.anchorState = this._getInitialAnchorState(qualityAssessment.overall);
      this.framesSinceRefresh = 0;
      this.framesSinceFullFrameRecovery = this.fullFrameRecoveryInterval;
      
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
        affinePoseInliers: 0,
        poseInliers: 0,
        poseModel: POSE_MODEL,
        poseSource: null,
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
        
        this.framesSinceFullFrameRecovery++;
        if (this.framesSinceFullFrameRecovery >= this.fullFrameRecoveryInterval) {
          logger.info('ImageAnchor', 'Attempting full-frame recovery search');
          this.framesSinceFullFrameRecovery = 0;
          const recoveryResult = this.persistenceSystem.fullFrameSearch(this.cv, gray);
          if (recoveryResult.success) {
            logger.info('ImageAnchor', 'Full-frame recovery succeeded:', recoveryResult);
            updateResult = recoveryResult;
            this.currentPosition = {
              x: recoveryResult.position.x,
              y: recoveryResult.position.y,
              z: 0
            };
            this.currentPlanarTransform = this._updatePlanarTransform({
              scale: recoveryResult.scale,
              rotation: this.currentPlanarTransform?.rotation || 0,
              confidence: recoveryResult.confidence,
              inlierCount: 0,
              method: recoveryResult.method
            }, timestamp);
            this.anchorState = 'degraded';
          } else {
            logger.warn('ImageAnchor', 'Full-frame recovery failed');
          }
        } else {
          logger.debug('ImageAnchor', 'Object still lost; waiting for next full-frame recovery interval');
          updateResult = {
            success: false,
            reason: updateResult.reason || 'Object outside camera view',
            position: this.currentPosition,
            normal: this.currentNormal,
            planarTransform: this.currentPlanarTransform,
            confidence: 0,
            method: 'recovering_object_model',
            recoverable: true,
            state: this.anchorState
          };
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
        this.framesSinceFullFrameRecovery = this.fullFrameRecoveryInterval;
        this.metrics.lastFailureReason = null;
        this.metrics.lastFailureStage = null;
        
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
      this._recordLandmarkMetrics();

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

      // Try pose estimation if we have enough local correspondences
      let poseResult = null;
      const objectPose = this._estimateObjectPoseFromTracker();
      this.metrics.homographyInliers = 0;
      this.metrics.affinePoseInliers = 0;
      this.metrics.objectPoseInliers = 0;
      this.metrics.poseInliers = 0;
      this.metrics.poseSource = null;
      this.metrics.poseModel = POSE_MODEL;
      
      const poseAttempt = this._estimatePoseFromTracker();
      const poseCorrespondenceOptions = poseAttempt.options;
      const correspondences = poseAttempt.correspondences;
      poseResult = poseAttempt.poseResult;
      this.metrics.poseKeypointCount = correspondences.length;
      this.metrics.posePatchRadius = poseCorrespondenceOptions.maxReferenceDistance;
      logger.debug('ImageAnchor', 'Pose correspondences check:', {
        correspondences: correspondences.length,
        required: 8,
        radius: poseCorrespondenceOptions.maxReferenceDistance,
        poseModel: POSE_MODEL
      });
      
      if (poseResult) {
        logger.debug('ImageAnchor', 'Pose result:', {
          poseModel: POSE_MODEL,
          source: poseResult?.method || null,
          success: poseResult?.success,
          inliers: poseResult?.inlierCount || 0,
          normal: poseResult?.normal
        });
      }

      if (poseResult?.success) {
        this._recordPoseInlierMetrics(poseResult);
      } else if (correspondences.length < 8) {
        logger.debug('ImageAnchor', 'Skipping pose estimation - insufficient correspondences:', {
          correspondences: correspondences.length,
          required: 8
        });
      }

      // Update position using offset-based keypoint positioning
      let newPosition = null;
      let positionMethod = 'unknown';
      let planarTransform = this.currentPlanarTransform;
      
      const objectPoseUsableForTransform = this._isUsablePoseResult(objectPose, objectPose.correspondences || correspondences);
      const trackerAnchorPosition = this.keypointTracker.getAnchorPosition();

      if (objectPoseUsableForTransform) {
        newPosition = {
          x: this.positionFilterX.filter(objectPose.position.x, timestamp),
          y: this.positionFilterY.filter(objectPose.position.y, timestamp),
          z: 0
        };
        positionMethod = objectPose.method;
        planarTransform = this._updatePlanarTransform(objectPose.planarTransform, timestamp);
        this._recordObjectPoseMetrics(objectPose);
        logger.debug('ImageAnchor', `Using object pose positioning: ${positionMethod}`);
      } else if (trackerAnchorPosition) {
        newPosition = {
          x: this.positionFilterX.filter(trackerAnchorPosition.x, timestamp),
          y: this.positionFilterY.filter(trackerAnchorPosition.y, timestamp),
          z: 0
        };
        positionMethod = trackerAnchorPosition.method;
        planarTransform = this._updatePlanarTransform({
          scale: trackerAnchorPosition.scale,
          rotation: trackerAnchorPosition.rotation,
          confidence: trackerAnchorPosition.confidence,
          inlierCount: trackerAnchorPosition.inlierCount,
          method: trackerAnchorPosition.method
        }, timestamp);
        if (objectPose.success) {
          this.metrics.poseRejectedReason = this._getPoseRejectionReason(objectPose, objectPose.correspondences || correspondences);
          this._recordObjectPoseMetrics(objectPose, { active: false });
        }
        logger.debug('ImageAnchor', `Using tracker anchor positioning: ${positionMethod}`);
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

      const normalPose = this._selectNormalPose({ objectPose, poseResult, correspondences });

      if (normalPose) {
        const poseConfidence = this._calculatePoseConfidence(normalPose, normalPose.correspondences || correspondences);
        this.currentNormal = this.normalStabilizer.update(normalPose.normal, {
          confidence: poseConfidence,
          inliers: normalPose.inlierCount,
        });
        this.metrics.poseConfidence = poseConfidence;
        this.metrics.poseSource = normalPose.method;
        this.metrics.poseInliers = normalPose.inlierCount;
        this.metrics.poseRejectedReason = null;
        logger.debug('ImageAnchor', `Updated stabilized surface normal from ${normalPose.method}`);
      } else if (poseResult?.success) {
        this.metrics.poseRejectedReason = this._getPoseRejectionReason(poseResult, correspondences);
      } else if (poseResult) {
        this.metrics.poseRejectedReason = poseResult.reason;
      }

      // Determine anchor state based on tracking quality
      const poseInliers = this.metrics.poseInliers || 0;
      const overallQuality = (this.metrics.trackingSuccessRate + Math.min(1.0, poseInliers / 30)) / 2;
      const prevState = this.anchorState;
      
      if (overallQuality >= 0.8 && poseInliers >= 25) {
        this.anchorState = 'stable';
      } else if (overallQuality >= 0.6 && poseInliers >= 15) {
        this.anchorState = 'tracking';
      } else if (overallQuality >= 0.4) {
        this.anchorState = 'tracking'; // Keep tracking if we have reasonable quality
      } else {
        this.anchorState = 'degraded';
      }
      
      if (prevState !== this.anchorState) {
        logger.info('ImageAnchor', `Anchor state updated: ${prevState} -> ${this.anchorState} (quality: ${overallQuality.toFixed(2)})`);
      }

      // Periodic keypoint refresh grows the persistent landmark map while tracking is usable.
      this.framesSinceRefresh++;
      if (this._shouldRefreshKeypoints({ overallQuality, poseInliers })) {
        this._refreshKeypoints(grayImage);
        this.framesSinceRefresh = 0;
        logger.debug('ImageAnchor', 'Refreshed keypoints for landmark map growth');
      }

      logger.debug('ImageAnchor', 'Keypoint tracking successful:', {
        method: positionMethod,
        position: `(${newPosition.x.toFixed(1)}, ${newPosition.y.toFixed(1)})`,
        quality: overallQuality.toFixed(2),
        state: this.anchorState,
        poseInliers
      });

      return {
        success: true,
        position: this.currentPosition,
        normal: this.currentNormal,
        planarTransform,
        confidence: overallQuality,
        method: positionMethod,
        inliers: poseInliers,
        poseSource: this.metrics.poseSource,
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
   * Update using template matching recovery
   */
  _updateWithTemplate(grayImage) {
    const recoveryResult = this.persistenceSystem.attemptRecovery(this.cv, grayImage);
    
    if (recoveryResult.success) {
      this.currentPosition = {
        x: recoveryResult.position.x,
        y: recoveryResult.position.y,
        z: 0
      };
      this.currentPlanarTransform = this._updatePlanarTransform({
        scale: recoveryResult.scale,
        rotation: this.currentPlanarTransform?.rotation || 0,
        confidence: recoveryResult.confidence,
        inlierCount: 0,
        method: recoveryResult.method
      });
      const activePointCount = this.keypointTracker.trackedPoints
        ? this.keypointTracker.trackedPoints.filter(point => point.status === 'active').length
        : 0;

      if (activePointCount >= 3 && activePointCount < 20) {
        this._refreshKeypoints(grayImage);
      } else if (activePointCount < 3) {
        this._reinitializeKeypoints(grayImage);
      }

      return {
        success: true,
        position: this.currentPosition,
        normal: this.currentNormal, // Keep previous normal
        planarTransform: this.currentPlanarTransform,
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
      this._recordLandmarkMetrics();
      const refreshStats = this.keypointTracker.lastRefreshStats;
      if (refreshStats) {
        this.metrics.landmarkRefreshAdded = refreshStats.added;
        this.metrics.landmarkRefreshTotal = refreshStats.total;
      }
      logger.info('ImageAnchor', 'Keypoints refreshed successfully');
    }
  }

  _shouldRefreshKeypoints({ overallQuality, poseInliers }) {
    if (this.framesSinceRefresh < this.refreshInterval) {
      return false;
    }

    if (this.metrics.trackingSuccessRate < 0.55 || this.metrics.keypointCount < 12) {
      return false;
    }

    if (!['tracking', 'stable', 'degraded'].includes(this.anchorState)) {
      return false;
    }

    const landmarkCount = this.metrics.landmarkCount || this.metrics.keypointCount;
    const mapNeedsExpansion = landmarkCount < 70;
    const poseNeedsSupport = poseInliers < 24;
    const trackingIsUseful = overallQuality >= 0.5 || this.anchorState === 'stable';

    return trackingIsUseful && (mapNeedsExpansion || poseNeedsSupport || this.anchorState === 'stable');
  }

  _recordLandmarkMetrics() {
    const points = this.keypointTracker?.trackedPoints || [];
    const activePoints = points.filter(point => point.status === 'active');

    this.metrics.landmarkCount = points.length || this.metrics.keypointCount || 0;
    this.metrics.activeLandmarkCount = activePoints.length || this.metrics.keypointCount || 0;
    this.metrics.inactiveLandmarkCount = Math.max(0, this.metrics.landmarkCount - this.metrics.activeLandmarkCount);
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

  _getPoseCorrespondenceOptions() {
    const templateSize = this.templateRegion
      ? Math.min(this.templateRegion.width, this.templateRegion.height)
      : 120;

    return {
      maxReferenceDistance: Math.max(42, Math.min(82, templateSize * 0.46)),
      minCount: 8,
      maxCount: 44
    };
  }

  _getWidePoseCorrespondenceOptions() {
    const templateSize = this.templateRegion
      ? Math.min(this.templateRegion.width, this.templateRegion.height)
      : 120;

    return {
      maxReferenceDistance: Math.max(104, Math.min(150, templateSize * 0.82)),
      minCount: 12,
      maxCount: 72
    };
  }

  _estimatePoseFromTracker() {
    const attempts = [
      this._getPoseCorrespondenceOptions(),
      this._getWidePoseCorrespondenceOptions()
    ];
    let bestAttempt = null;

    for (const options of attempts) {
      const correspondences = this.keypointTracker.getCorrespondences(options);
      const poseResult = correspondences.length >= 8
        ? this._estimatePoseFromCorrespondences(correspondences)
        : null;
      const attempt = {
        options,
        correspondences,
        poseResult
      };

      if (poseResult?.success && this._isUsablePoseResult(poseResult, correspondences)) {
        return attempt;
      }

      if (!bestAttempt) {
        bestAttempt = attempt;
        continue;
      }

      const bestInliers = bestAttempt.poseResult?.inlierCount || 0;
      const currentInliers = poseResult?.inlierCount || 0;
      const bestCount = bestAttempt.correspondences.length;
      const currentCount = correspondences.length;
      if (currentInliers > bestInliers || (currentInliers === bestInliers && currentCount > bestCount)) {
        bestAttempt = attempt;
      }
    }

    return bestAttempt || {
      options: this._getPoseCorrespondenceOptions(),
      correspondences: [],
      poseResult: null
    };
  }

  _estimatePoseFromCorrespondences(correspondences) {
    const homographyPose = this.homographyEstimator.estimatePose(this.cv, correspondences);
    if (homographyPose?.success) {
      return { ...homographyPose, method: 'homography' };
    }

    return this.affinePoseEstimator.estimatePose(correspondences, {
      previousNormal: this.currentNormal
    });
  }

  _estimateObjectPoseFromTracker() {
    return this.keypointTracker.getObjectPose({
      previousPose: this.currentNormal ? { normal: this.currentNormal } : null
    });
  }

  _selectNormalPose({ objectPose, poseResult, correspondences }) {
    const objectPoseUsable = this._isUsablePoseResult(objectPose, objectPose.correspondences || correspondences);
    const correspondencePoseUsable = this._isUsablePoseResult(poseResult, correspondences);

    if (correspondencePoseUsable && poseResult.method === 'homography' && poseResult.confidence > objectPose.confidence + 0.12) {
      return { ...poseResult, correspondences };
    }

    if (objectPoseUsable) {
      return { ...objectPose, correspondences };
    }

    if (correspondencePoseUsable) {
      return { ...poseResult, correspondences };
    }

    return null;
  }

  _recordPoseInlierMetrics(poseResult) {
    const inliers = poseResult.inlierCount || 0;

    this.metrics.poseInliers = inliers;

    if (poseResult.method === 'homography') {
      this.metrics.homographyInliers = inliers;
      this.metrics.affinePoseInliers = 0;
    } else if (poseResult.method === 'affine-parallax') {
      this.metrics.affinePoseInliers = inliers;
      this.metrics.homographyInliers = 0;
    }
  }

  _recordObjectPoseMetrics(objectPose, { active = true } = {}) {
    this.metrics.objectPoseInliers = objectPose.inlierCount || 0;
    this.metrics.poseInliers = Math.max(this.metrics.poseInliers || 0, objectPose.inlierCount || 0);
    if (active) {
      this.metrics.poseSource = objectPose.method;
    }
    this.metrics.poseConfidence = objectPose.confidence;
    this.metrics.poseAverageResidual = objectPose.averageResidual;
    this.metrics.poseForeshortening = objectPose.foreshortening;
  }

  _updatePlanarTransform(anchorPosition, timestamp = null) {
    const previous = this.currentPlanarTransform || {
      scale: 1,
      rotation: 0,
      confidence: 0,
      inlierCount: 0,
      method: 'uninitialized'
    };

    const rawScale = typeof anchorPosition.scale === 'number' ? anchorPosition.scale : previous.scale;
    const rawRotation = typeof anchorPosition.rotation === 'number'
      ? unwrapAngle(anchorPosition.rotation, previous.rotation)
      : previous.rotation;

    this.currentPlanarTransform = {
      scale: this.planarScaleFilter.filter(rawScale, timestamp),
      rotation: this.planarRotationFilter.filter(rawRotation, timestamp),
      confidence: typeof anchorPosition.confidence === 'number' ? anchorPosition.confidence : previous.confidence,
      inlierCount: typeof anchorPosition.inlierCount === 'number' ? anchorPosition.inlierCount : previous.inlierCount,
      method: anchorPosition.method || previous.method
    };

    return this.currentPlanarTransform;
  }

  _measureReferenceSpread(correspondences) {
    if (correspondences.length === 0) {
      return { width: 0, height: 0, minAxis: 0 };
    }

    const xs = correspondences.map(correspondence => correspondence.prev.x);
    const ys = correspondences.map(correspondence => correspondence.prev.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    return {
      width,
      height,
      minAxis: Math.min(width, height)
    };
  }

  _getPoseRejectionReason(poseResult, correspondences) {
    if (!poseResult?.success || !poseResult.normal) {
      return poseResult?.reason || 'Pose unavailable';
    }
    if (poseResult.inlierCount < 8) {
      return 'Insufficient pose inliers';
    }
    if ((poseResult.inlierRatio ?? 0) < 0.5) {
      return 'Low pose inlier ratio';
    }
    if ((poseResult.confidence ?? 0) < 0.32) {
      return 'Low pose confidence';
    }

    const spread = poseResult.referenceSpread || this._measureReferenceSpread(correspondences);
    if (spread.minAxis < 18) {
      return 'Degenerate local pose spread';
    }

    return null;
  }

  _isUsablePoseResult(poseResult, correspondences) {
    return this._getPoseRejectionReason(poseResult, correspondences) === null;
  }

  _calculatePoseConfidence(poseResult, correspondences) {
    const spread = this._measureReferenceSpread(correspondences);
    const spreadScore = Math.min(1, spread.minAxis / 42);
    const inlierRatio = poseResult.inlierRatio ?? (poseResult.inlierCount / Math.max(1, correspondences.length));
    return Math.max(0.2, Math.min(1, (poseResult.confidence ?? 0.5) * 0.5 + inlierRatio * 0.3 + spreadScore * 0.2));
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
      planarTransform: this.currentPlanarTransform,
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
      this.currentPlanarTransform = null;
      this.templateRegion = null;
      this.templateCenter = null; // Clear template center reference
      this.templateAnchorOffset = null;
      this.framesSinceRefresh = 0;
      this.framesSinceFullFrameRecovery = this.fullFrameRecoveryInterval;
      
      // Reset resilience counters
      this.keypointFailureCount = 0;
      
      // Reset filters
      this.positionFilterX = new OneEuroFilter(30);
      this.positionFilterY = new OneEuroFilter(30);
      this.planarScaleFilter = new OneEuroFilter(30);
      this.planarRotationFilter = new OneEuroFilter(30);
      this.normalStabilizer.reset();
      
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
      planarTransform: this.currentPlanarTransform,
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
