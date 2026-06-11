/**
 * Image-Based Anchor Service
 * Orchestrates persistent keypoint tracking, object-pose estimation, and template matching
 * for robust object anchoring
 */

import { KeypointDetector } from '../cv/anchor.keypoints.js';
import { KeypointTracker } from '../cv/anchor.tracking.js';
import { PatchKeyframeRelocalizer } from '../cv/anchor.relocalization.js';
import { HomographyEstimator } from '../cv/anchor.homography.js';
import { AffineParallaxPoseEstimator } from '../cv/anchor.affinePose.js';
import {
  createReconstructionEngine,
  isReconstructionMode,
  RECONSTRUCTION_MODE_IDS,
  RECONSTRUCTION_POSE_MODEL,
} from '../cv/anchor.reconstructionModes.js';
import { AnchorPersistenceSystem } from '../cv/anchor.persistence.js';
import { OneEuroFilter } from '../cv/oneEuroFilter.js';
import { checkCriticalFeatures } from '../cv/opencv.features.test.js';
import { isPointInsideObjectSupport, warpObjectSupportMask } from '../cv/objectSupportMask.js';
import { calculateTemplateRegion } from '../utils/templateRegion.js';
import { SurfaceNormalStabilizer } from '../utils/normalStabilizer.js';
import { logger } from '../utils/logger.js';

const POSE_MODEL = 'object-pose';
const TRACKING_MODES = new Set([POSE_MODEL, ...RECONSTRUCTION_MODE_IDS]);
const PLANAR_TARGET_CLASS_PATTERN = /book|laptop|keyboard|cell phone|tablet|tv|screen|sign|bag/i;
const CANDIDATE_MIN_TRACKABLE_POINTS = 8;
const CANDIDATE_REFRESH_INTERVAL = 3;
const FACE_READINESS_REASON_RECONSTRUCTION = 'Build more object landmarks before showing the face';

const createPositionFilter = () => new OneEuroFilter(60, 2.4, 0.075, 1.0);
const createPlanarScaleFilter = () => new OneEuroFilter(60, 1.2, 0.08, 1.0);
const createCurvedScaleFilter = () => new OneEuroFilter(60, 2.4, 0.18, 1.0);
const createPlanarRotationFilter = () => new OneEuroFilter(60, 1.1, 0.08, 1.0);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const SCALE_STEP_LOG_LIMIT = 0.1;

const transformHomographyPoint = (matrix, point) => {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];

  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator
  };
};

const unwrapAngle = (target, reference) => {
  let unwrapped = target;
  while (unwrapped - reference > Math.PI) unwrapped -= Math.PI * 2;
  while (unwrapped - reference < -Math.PI) unwrapped += Math.PI * 2;
  return unwrapped;
};

export class ImageAnchorService {
  constructor({ now = () => performance.now() } = {}) {
    this.initialized = false;
    this.cv = null;
    this.cameraParams = null;
    this.now = now;
    
    // Core components
    this.keypointDetector = new KeypointDetector();
    this.keypointTracker = new KeypointTracker();
    this.relocalizer = new PatchKeyframeRelocalizer();
    this.homographyEstimator = new HomographyEstimator();
    this.affinePoseEstimator = new AffineParallaxPoseEstimator();
    this.reconstructor = createReconstructionEngine(RECONSTRUCTION_POSE_MODEL);
    this.persistenceSystem = new AnchorPersistenceSystem();
    
    // Filters for smoothing
    this.positionFilterX = createPositionFilter();
    this.positionFilterY = createPositionFilter();
    this.planarScaleFilter = createPlanarScaleFilter();
    this.curvedScaleFilter = createCurvedScaleFilter();
    this.planarRotationFilter = createPlanarRotationFilter();
    this.normalStabilizer = new SurfaceNormalStabilizer();
    this.framesWithoutNormalPose = 0;
    
    // State
    this.anchored = false;
    this.anchorState = 'inactive'; // inactive, initializing, tracking, stable, degraded, lost
    this.template = null;
    this.templateRegion = null;
    this.trackingRegion = null;
    this.templateCenter = null; // Reference center point for stable positioning
    this.templateAnchorOffset = null;
    this.currentPosition = null;
    this.currentNormal = null;
    this.currentPlanarTransform = null;
    this.objectSupportMask = null;
    this.currentObjectSupportMask = null;
    this.anchorTargetClass = null;
    this.trackingMode = POSE_MODEL;
    this.planarDominanceScore = 0;
    this.lastFrameTime = 0;
    this.framesSinceRefresh = 0;
    this.refreshInterval = 15; // Refresh keypoints every N frames
    this.framesSinceRelocalizationKeyframe = 0;
    this.relocalizationKeyframeInterval = 10;
    this.fullFrameRecoveryInterval = 6;
    this.framesSinceFullFrameRecovery = this.fullFrameRecoveryInterval;
    this.frameIndex = 0;
    
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
      trackingMode: this.trackingMode,
      poseSource: null,
      poseInliers: 0,
      affinePoseInliers: 0,
      reconstructionPreview: null,
      landmarkCount: 0,
      activeLandmarkCount: 0,
      inactiveLandmarkCount: 0,
      landmarkRefreshAdded: 0,
      lastFailureReason: null,
      lastFailureStage: null,
      lastUpdateResult: null,
      lastUpdateMethod: null,
      relocalizationKeyframes: 0,
      relocalizationDescriptors: 0,
      relocalizationMatches: 0,
      relocalizationInliers: 0,
      relocalizationResult: null
    };
    
    // Event listeners
    this.listeners = new Set();

    this.minAnchorKeypoints = 12;
    this.minimumTemplateQuality = 0.12;
    this.targetTemplateQuality = 0.25;
  }

  _createConfiguredReconstructor(mode) {
    const reconstructor = createReconstructionEngine(mode);
    if (this.cv && this.cameraParams) {
      reconstructor.configure({
        cv: this.cv,
        cameraParams: this.cameraParams,
      });
    }
    return reconstructor;
  }

  setTrackingMode(mode) {
    if (!TRACKING_MODES.has(mode)) {
      throw new Error(`Unsupported anchor tracking mode: ${mode}`);
    }

    this.trackingMode = mode;
    this.metrics.trackingMode = mode;
    this.metrics.poseModel = isReconstructionMode(mode) ? mode : POSE_MODEL;

    if (this.anchored && this.currentPosition) {
      this.reconstructor = this._createConfiguredReconstructor(
        isReconstructionMode(mode) ? mode : RECONSTRUCTION_POSE_MODEL
      );
      this.reconstructor.reset({
        anchorReference: this.keypointTracker.anchorOriginalPosition || this.currentPosition,
        templateRegion: this.trackingRegion || this.templateRegion || {
          x: this.currentPosition.x - 60,
          y: this.currentPosition.y - 60,
          width: 120,
          height: 120,
        },
        targetClass: this.anchorTargetClass,
      });
      this.metrics.reconstructionState = this.reconstructor.getState().state;
      this.metrics.reconstructionReady = false;
    }

    this._notifyStateChange();
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
      this.cameraParams = { ...cameraParams };
      
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

    const startTime = this.now();
    this.anchorState = 'initializing';
    this.planarDominanceScore = 0;
    this._notifyStateChange();

    try {
      // Convert to OpenCV Mat
      const src = this.cv.matFromImageData(imageData);
      const gray = new this.cv.Mat();
      this.cv.cvtColor(src, gray, this.cv.COLOR_RGBA2GRAY);
      
      const targetClass = this._extractTargetClass(boundingBox);

      // Determine template region
      const templateRegion = this._calculateTemplateRegion(
        tapPosition, 
        boundingBox, 
        imageData.width, 
        imageData.height
      );
      const objectSupportMask = this._selectObjectSupportMask(boundingBox);

      logger.info('ImageAnchor', `Creating anchor at (${tapPosition.x}, ${tapPosition.y}) with region ${templateRegion.width}x${templateRegion.height}`);

      // Extract keypoints from template region
      const keypointResult = this._extractObjectKeypoints(gray, templateRegion, objectSupportMask, {
        minKeypoints: this.minAnchorKeypoints,
      });

      // Assess template quality
      const qualityAssessment = this.keypointDetector.assessTemplateQuality(
        keypointResult.keypoints,
        keypointResult.descriptors,
        templateRegion.width,
        templateRegion.height,
        templateRegion.x,
        templateRegion.y
      );
      const hasProgressiveObjectEvidence = !!objectSupportMask;
      const hasStrongInitialKeypoints = keypointResult.keypoints.length >= this.minAnchorKeypoints;
      const hasUsableTemplateQuality = this._isUsableTemplateQuality(qualityAssessment.overall);
      const shouldCreateCandidate = hasProgressiveObjectEvidence &&
        (!hasStrongInitialKeypoints || !hasUsableTemplateQuality);

      if (!hasStrongInitialKeypoints && !shouldCreateCandidate) {
        const message = `Insufficient keypoints: ${keypointResult.keypoints.length} (need at least ${this.minAnchorKeypoints})`;
        this._recordAnchorFailure('keypoints', message, {
          keypointCount: keypointResult.keypoints.length,
          templateKeypoints: keypointResult.keypoints.length,
          templateRegion,
          extractionMethod: keypointResult.method,
          processingTime: this.now() - startTime
        });
        src.delete();
        gray.delete();
        throw new Error(message);
      }

      if (!hasUsableTemplateQuality && !shouldCreateCandidate) {
        const message = `Poor template quality: ${qualityAssessment.overall.toFixed(2)} (need at least ${this.minimumTemplateQuality.toFixed(2)})`;
        this._recordAnchorFailure('template-quality', message, {
          keypointCount: keypointResult.keypoints.length,
          templateKeypoints: keypointResult.keypoints.length,
          templateQuality: qualityAssessment.overall,
          qualityState: 'failed',
          templateRegion,
          extractionMethod: keypointResult.method,
          processingTime: this.now() - startTime
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

      const trackingRegion = this._calculateTrackingRegion(
        boundingBox,
        imageData.width,
        imageData.height,
        templateRegion
      );
      const trackingKeypointResult = trackingRegion
        ? this._extractObjectKeypoints(gray, trackingRegion, objectSupportMask, {
            minKeypoints: this.minAnchorKeypoints,
          })
        : keypointResult;
      const trackingKeypoints = this._mergeTrackingKeypoints(
        keypointResult.keypoints,
        trackingKeypointResult.keypoints
      );

      if (trackingKeypoints.length > 0) {
        this.keypointTracker.initializeTracking(this.cv, trackingKeypoints, gray, tapPosition);
      }
      this.reconstructor = this._createConfiguredReconstructor(
        isReconstructionMode(this.trackingMode) ? this.trackingMode : RECONSTRUCTION_POSE_MODEL
      );
      this.reconstructor.reset({ anchorReference: tapPosition, templateRegion, targetClass });
      const keyframeResult = trackingKeypoints.length > 0
        ? this.relocalizer.storeKeyframeFromTrackedPoints(
          gray,
          this.keypointTracker.trackedPoints,
          startTime
        )
        : { success: false, keyframeCount: 0, descriptorCount: 0, reason: 'No bootstrap landmarks available' };
      this.framesSinceRelocalizationKeyframe = 0;

      // Store template for persistence system
      this.persistenceSystem.storeTemplate(this.cv, gray, templateRegion, tapPosition);

      // Store anchor state
      this.anchored = true;
      this.templateRegion = templateRegion;
      this.trackingRegion = trackingRegion || { ...templateRegion };
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
      this.currentNormal = { x: 0, y: 0, z: 1 };
      this.objectSupportMask = objectSupportMask;
      this.currentObjectSupportMask = objectSupportMask;
      this.anchorTargetClass = targetClass;
      this.normalStabilizer.reset(this.currentNormal);
      this.framesWithoutNormalPose = 0;
      this.planarScaleFilter.filter(1, startTime);
      this.curvedScaleFilter.filter(1, startTime);
      this.planarRotationFilter.filter(0, startTime);
      const bootstrapState = shouldCreateCandidate
        ? this._getProgressiveBootstrapState(trackingKeypoints.length, qualityAssessment.overall)
        : this._getInitialAnchorState(qualityAssessment.overall);
      const readiness = this._createReadiness({
        state: bootstrapState,
        poseSource: null,
        reconstructionReady: false,
      });
      const evidence = this._calculateObjectEvidence({
        objectSupportMask,
        region: trackingRegion || templateRegion,
        templateKeypoints: keypointResult.keypoints,
        trackingKeypoints,
      });

      this.anchorState = bootstrapState;
      this.framesSinceRefresh = 0;
      this.framesSinceFullFrameRecovery = this.fullFrameRecoveryInterval;
      
      // Initialize metrics
      this.metrics = {
        keypointCount: trackingKeypoints.length,
        activeLandmarks: trackingKeypoints.length,
        objectOwnedLandmarks: evidence.objectOwnedLandmarks,
        inactiveLandmarks: 0,
        templateKeypoints: keypointResult.keypoints.length,
        trackingKeypoints: trackingKeypoints.length,
        templateQuality: qualityAssessment.overall,
        qualityState: this._getTemplateQualityState(qualityAssessment.overall),
        templateRegion: { ...templateRegion },
        targetClass,
        trackingRegion: this.trackingRegion ? { ...this.trackingRegion } : null,
        objectSupportMaskSource: objectSupportMask ? objectSupportMask.source : null,
        objectSupportMaskConfidence: objectSupportMask ? objectSupportMask.confidence : null,
        maskCoverage: evidence.maskCoverage,
        maskConfidence: evidence.maskConfidence,
        keypointDensity: evidence.keypointDensity,
        backgroundRejected: evidence.backgroundRejected,
        objectSupportMaskBounds: objectSupportMask ? { ...objectSupportMask.bbox } : null,
        currentObjectSupportMaskSource: objectSupportMask ? objectSupportMask.source : null,
        currentObjectSupportMaskBounds: objectSupportMask ? { ...objectSupportMask.bbox } : null,
        templateCenter: { ...templateCenter },
        templateAnchorOffset: { ...templateAnchorOffset },
        templateRegionArea: templateRegion.width * templateRegion.height,
        extractionMethod: keypointResult.method,
        processingTime: this.now() - startTime,
        trackingSuccessRate: 1.0,
        homographyInliers: 0,
        affinePoseInliers: 0,
        poseInliers: 0,
        poseModel: isReconstructionMode(this.trackingMode) ? this.trackingMode : POSE_MODEL,
        trackingMode: this.trackingMode,
        poseSource: null,
        readiness,
        reconstructionState: this.reconstructor.getState().state,
        reconstructionReady: false,
        reconstructionFrames: 0,
        reconstructionLandmarks: 0,
        reconstructionDepthQuality: 0,
        reconstructionPreview: this.reconstructor.getState().preview,
        relocalizationKeyframes: keyframeResult.keyframeCount || 0,
        relocalizationDescriptors: keyframeResult.descriptorCount || 0,
        relocalizationMatches: 0,
        relocalizationInliers: 0,
        relocalizationResult: keyframeResult.success ? 'keyframe-stored' : 'keyframe-skipped',
        relocalizationReason: keyframeResult.reason || null,
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
        objectSupportMaskSource: objectSupportMask ? objectSupportMask.source : null,
        state: this.anchorState,
        readiness,
        evidence,
        trackingMode: this.trackingMode,
        reconstructionState: this.metrics.reconstructionState,
        reconstructionReady: this.metrics.reconstructionReady
      };

    } catch (error) {
      if (!this.metrics.lastFailureReason) {
        this._recordAnchorFailure('create-anchor', error.message, {
          processingTime: this.now() - startTime
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

    const startTime = this.now();
    const timestamp = startTime;
    this.frameIndex++;
    
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

      if (this.anchorState === 'candidate' ||
          (this.anchorState === 'mapping' && this._activeTrackedPointCount() < CANDIDATE_MIN_TRACKABLE_POINTS)) {
        updateResult = this._updateProgressiveBootstrap(gray, timestamp);
      } else if (this.anchorState === 'mapping' || this.anchorState === 'tracking' || this.anchorState === 'stable') {
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
            updateResult = {
              success: true,
              reason: `Keypoint failure ${this.keypointFailureCount}/${this.maxKeypointFailures}: ${updateResult.reason}`,
              position: this.currentPosition,
              normal: this.currentNormal,
              planarTransform: this.currentPlanarTransform,
              confidence: Math.max(0, (this.metrics.trackingSuccessRate || 0) * 0.5),
              method: 'held-last-pose',
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
        if (this.keypointTracker.trackedPoints?.length > 0) {
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
      this._recordAnchorUpdateResult(updateResult, this.now() - startTime);
      
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
      let trackingResult = this.keypointTracker.trackToFrame(this.cv, grayImage);
      
      logger.info('ImageAnchor', 'Keypoint tracking result:', {
        success: trackingResult.success,
        reason: trackingResult.reason || 'No reason provided',
        activePointCount: trackingResult.activePointCount,
        successRate: trackingResult.successRate,
        averageError: trackingResult.averageError
      });
      
      if (!trackingResult.success) {
        const relocalizationResult = this._attemptKeyframeRelocalization(grayImage, timestamp, trackingResult.reason);
        if (relocalizationResult.success) {
          trackingResult = relocalizationResult.trackingResult;
          logger.info('ImageAnchor', 'Recovered keypoint tracking through descriptor relocalization:', {
            restored: relocalizationResult.restore?.restored,
            matches: relocalizationResult.matches,
            inliers: relocalizationResult.inliers,
            confidence: relocalizationResult.confidence
          });
        } else {
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
            reason: relocalizationResult.reason || trackingResult.reason || 'Keypoint tracking failed',
            state: this.anchorState
          };
        }
      }

      const maskRejected = this._rejectTrackedPointsOutsideObjectSupport();
      if (maskRejected > 0) {
        trackingResult.activePointCount = this._activeTrackedPointCount();
        this.metrics.backgroundRejected = (this.metrics.backgroundRejected || 0) + maskRejected;
      }

      // Update metrics  
      this.metrics.trackingSuccessRate = trackingResult.successRate || 0;
      this.metrics.keypointCount = trackingResult.activePointCount || 0;
      this._recordLandmarkMetrics();

      // Check if we have sufficient tracking quality
      const minSuccessRate = 0.45;
      const minActivePoints = 8;
      
      if (this.metrics.trackingSuccessRate < minSuccessRate || this.metrics.keypointCount < minActivePoints) {
        const relocalizationResult = this._attemptKeyframeRelocalization(grayImage, timestamp, 'Insufficient keypoint tracking quality');
        if (relocalizationResult.success) {
          trackingResult = relocalizationResult.trackingResult;
          this.metrics.trackingSuccessRate = trackingResult.successRate || 0;
          this.metrics.keypointCount = trackingResult.activePointCount || 0;
          this._recordLandmarkMetrics();
        } else {
          logger.warn('ImageAnchor', 'Keypoint tracking quality insufficient:', {
            successRate: this.metrics.trackingSuccessRate,
            activePointCount: this.metrics.keypointCount,
            minSuccessRate,
            minActivePoints
          });

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
      }

      const preliminaryAnchorPosition = this.keypointTracker.getAnchorPosition();
      if (this._shouldAttemptGeometryRelocalization(preliminaryAnchorPosition)) {
        const relocalizationResult = this._attemptKeyframeRelocalization(grayImage, timestamp, 'Reference geometry became incoherent');
        if (relocalizationResult.success) {
          trackingResult = relocalizationResult.trackingResult;
          this.metrics.trackingSuccessRate = trackingResult.successRate || 0;
          this.metrics.keypointCount = trackingResult.activePointCount || 0;
          this._recordLandmarkMetrics();
          logger.info('ImageAnchor', 'Recovered incoherent geometry through descriptor relocalization:', {
            restored: relocalizationResult.restore?.restored,
            matches: relocalizationResult.matches,
            inliers: relocalizationResult.inliers,
            confidence: relocalizationResult.confidence
          });
        }
      }

      // Try pose estimation if we have enough local correspondences
      let poseResult = null;
      this.metrics.homographyInliers = 0;
      this.metrics.affinePoseInliers = 0;
      this.metrics.objectPoseInliers = 0;
      this.metrics.reconstructionPoseInliers = 0;
      this.metrics.reconstructionPnpInliers = 0;
      this.metrics.reconstructionPnpAverageResidual = null;
      this.metrics.poseInliers = 0;
      this.metrics.poseSource = null;
      this.metrics.poseModel = isReconstructionMode(this.trackingMode) ? this.trackingMode : POSE_MODEL;
      const objectPose = this._estimateObjectPoseFromTracker();
      const reconstructionPose = this._updateReconstructionPoseFromTracker(timestamp, grayImage);
      
      const poseAttempt = this._estimatePoseFromTracker();
      const poseCorrespondenceOptions = poseAttempt.options;
      const correspondences = poseAttempt.correspondences;
      poseResult = poseAttempt.poseResult;
      const planarPose = this._createPlanarHomographyPose(poseResult, correspondences);
      this._updatePlanarDominance(planarPose, correspondences);
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
      
      const trackerAnchorPosition = this.keypointTracker.getAnchorPosition();
      const reconstructionPoseUsableForTransform = this._isUsablePoseResult(reconstructionPose, reconstructionPose?.correspondences || correspondences);
      const planarPoseUsableForTransform = this._isUsablePoseResult(planarPose, correspondences);
      const objectPoseUsableForTransform = this._isUsablePoseResult(objectPose, objectPose.correspondences || correspondences);
      const reconstructionConsistentWithTracker = this._isPosePositionConsistentWithTracker(
        reconstructionPose,
        trackerAnchorPosition
      );
      const useStrongCurvedReconstructionPosition = this._hasStrongCurvedReconstructionPosition(reconstructionPose);
      const useTolerantCurvedReconstructionRecovery = this._hasTolerantCurvedReconstructionRecovery(reconstructionPose);
      const selectedReconstructionReady = this._hasSelectedReconstructionPose(reconstructionPose);
      const suppressReconstructionForPlanarTarget = this._hasPlanarDominance() &&
        !selectedReconstructionReady &&
        (!this._hasStrongNonPlanarReconstruction(reconstructionPose) || !reconstructionConsistentWithTracker) &&
        !planarPoseUsableForTransform;
      const preferPlanarPose = this._shouldPreferPlanarHomography({
        planarPose,
        reconstructionPose,
        correspondences
      });
      const usePlanarPatchTransform = this._shouldUsePlanarPatchTransform({
        planarPose,
        reconstructionPose,
        correspondences
      });
      const holdPlanarTrackerAttachment = this._shouldHoldTrackerAttachmentForPlanarReconstruction({
        planarPoseUsable: planarPoseUsableForTransform,
        reconstructionPose,
      });

      if (planarPoseUsableForTransform && (preferPlanarPose || usePlanarPatchTransform)) {
        newPosition = this._filterPositionCandidate(planarPose.position, timestamp, planarPose.method);
        positionMethod = planarPose.method;
        planarTransform = this._updatePlanarTransform(planarPose.planarTransform, timestamp);
        this._recordPlanarHomographyMetrics(planarPose);
        logger.debug('ImageAnchor', `Using planar homography positioning: ${positionMethod}`);
      } else if (trackerAnchorPosition &&
          reconstructionPoseUsableForTransform &&
          !reconstructionConsistentWithTracker &&
          !useStrongCurvedReconstructionPosition) {
        newPosition = this._filterPositionCandidate(trackerAnchorPosition, timestamp, trackerAnchorPosition.method);
        positionMethod = trackerAnchorPosition.method;
        planarTransform = this._updatePlanarTransform(
          this._selectTrackedAttachmentTransform({
            trackerAnchorPosition,
            reconstructionPose,
            useTrackedTransform: true
          }),
          timestamp
        );
        this._recordReconstructionPoseMetrics(reconstructionPose, { active: false });
        logger.debug('ImageAnchor', 'Using tracked anchor positioning with reconstruction orientation');
      } else if (reconstructionPoseUsableForTransform &&
          (!suppressReconstructionForPlanarTarget || useStrongCurvedReconstructionPosition)) {
        newPosition = this._filterPositionCandidate(reconstructionPose.position, timestamp, reconstructionPose.method);
        positionMethod = reconstructionPose.method;
        planarTransform = this._updatePlanarTransform(
          useTolerantCurvedReconstructionRecovery && trackerAnchorPosition
            ? this._selectTrackedAttachmentTransform({
              trackerAnchorPosition,
              reconstructionPose,
              useTrackedTransform: true
            })
            : reconstructionPose.planarTransform,
          timestamp
        );
        this._recordReconstructionPoseMetrics(reconstructionPose);
        logger.debug('ImageAnchor', `Using sparse reconstruction positioning: ${positionMethod}`);
      } else if (trackerAnchorPosition && holdPlanarTrackerAttachment) {
        newPosition = this._filterPositionCandidate(trackerAnchorPosition, timestamp, trackerAnchorPosition.method);
        positionMethod = trackerAnchorPosition.method;
        planarTransform = this._updatePlanarTransform({
          scale: trackerAnchorPosition.scale,
          rotation: trackerAnchorPosition.rotation,
          confidence: trackerAnchorPosition.confidence,
          inlierCount: trackerAnchorPosition.inlierCount,
          method: trackerAnchorPosition.method
        }, timestamp);
        if (objectPose.success) {
          this._recordObjectPoseMetrics(objectPose, { active: false });
        }
        logger.debug('ImageAnchor', 'Using planar tracker attachment through transient planar pose loss');
      } else if (objectPoseUsableForTransform) {
        newPosition = this._filterPositionCandidate(objectPose.position, timestamp, objectPose.method);
        positionMethod = objectPose.method;
        planarTransform = this._updatePlanarTransform(objectPose.planarTransform, timestamp);
        this._recordObjectPoseMetrics(objectPose);
        logger.debug('ImageAnchor', `Using object pose positioning: ${positionMethod}`);
      } else if (trackerAnchorPosition) {
        newPosition = this._filterPositionCandidate(trackerAnchorPosition, timestamp, trackerAnchorPosition.method);
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

      const normalPose = this._selectNormalPose({
        reconstructionPose,
        planarPose,
        objectPose,
        poseResult,
        correspondences,
        reconstructionConsistentWithTracker
      });

      if (normalPose) {
        const poseConfidence = this._calculatePoseConfidence(normalPose, normalPose.correspondences || correspondences);
        const reacquiredPose = this.framesWithoutNormalPose >= 3;
        this.metrics.rawPoseNormal = normalPose.normal ? { ...normalPose.normal } : null;
        this.currentNormal = this.normalStabilizer.update(normalPose.normal, {
          confidence: poseConfidence,
          inliers: normalPose.inlierCount,
          foreshortening: normalPose.foreshortening,
          reacquired: reacquiredPose,
          trusted: isReconstructionMode(normalPose.method) &&
            (this._hasStrongNonPlanarReconstruction(normalPose) || this._hasSelectedReconstructionPose(normalPose)),
        });
        this.framesWithoutNormalPose = 0;
        this.metrics.poseConfidence = poseConfidence;
        this.metrics.poseSource = normalPose.method;
        this.metrics.poseInliers = normalPose.inlierCount;
        this.metrics.poseRejectedReason = null;
        logger.debug('ImageAnchor', `Updated stabilized surface normal from ${normalPose.method}`);
      } else if (poseResult?.success) {
        this.framesWithoutNormalPose++;
        this.metrics.rawPoseNormal = null;
        this.metrics.poseSource = null;
        this.metrics.poseRejectedReason = this._getPoseRejectionReason(poseResult, correspondences);
      } else if (poseResult) {
        this.framesWithoutNormalPose++;
        this.metrics.rawPoseNormal = null;
        this.metrics.poseSource = null;
        this.metrics.poseRejectedReason = poseResult.reason;
      } else {
        this.framesWithoutNormalPose++;
        this.metrics.rawPoseNormal = null;
        this.metrics.poseSource = null;
      }

      if (!normalPose && this._shouldRelaxStaleCurvedNormal()) {
        this.currentNormal = this.normalStabilizer.update({ x: 0, y: 0, z: 1 }, {
          confidence: 0.55,
          inliers: 12,
          foreshortening: 0.98,
        });
        this.metrics.normalRelaxation = 'curved-surface-pose-dropout';
      } else {
        this.metrics.normalRelaxation = null;
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
      this._storeRelocalizationKeyframe(grayImage, { overallQuality, poseInliers });

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

  _updateProgressiveBootstrap(grayImage, timestamp) {
    const recoveryResult = this.persistenceSystem.attemptRecovery(this.cv, grayImage, this.currentPosition);
    if (recoveryResult.success) {
      this.currentPosition = {
        x: this.positionFilterX.filter(recoveryResult.position.x, timestamp),
        y: this.positionFilterY.filter(recoveryResult.position.y, timestamp),
        z: 0,
      };
      this.currentPlanarTransform = this._updatePlanarTransform({
        scale: recoveryResult.scale,
        rotation: this.currentPlanarTransform?.rotation || 0,
        confidence: recoveryResult.confidence,
        inlierCount: 0,
        method: recoveryResult.method,
      }, timestamp);
    }

    let trackingResult = null;
    const hasTrackableBootstrap = this._activeTrackedPointCount() >= CANDIDATE_MIN_TRACKABLE_POINTS &&
      typeof this.keypointTracker.trackToFrame === 'function';
    if (hasTrackableBootstrap) {
      trackingResult = this.keypointTracker.trackToFrame(this.cv, grayImage);
      if (trackingResult.success) {
        this._rejectTrackedPointsOutsideObjectSupport();
        const anchorPosition = typeof this.keypointTracker.getAnchorPosition === 'function'
          ? this.keypointTracker.getAnchorPosition()
          : null;
        if (anchorPosition) {
          this.currentPosition = {
            x: this.positionFilterX.filter(anchorPosition.x, timestamp),
            y: this.positionFilterY.filter(anchorPosition.y, timestamp),
            z: 0,
          };
          this.currentPlanarTransform = this._updatePlanarTransform({
            scale: anchorPosition.scale ?? this.currentPlanarTransform?.scale ?? 1,
            rotation: anchorPosition.rotation ?? this.currentPlanarTransform?.rotation ?? 0,
            confidence: anchorPosition.confidence ?? trackingResult.successRate ?? 0.5,
            inlierCount: anchorPosition.inlierCount ?? trackingResult.activePointCount ?? 0,
            method: anchorPosition.method ?? 'candidate-tracking',
          }, timestamp);
        }
      }
    }

    const region = this._getProgressiveBootstrapRegion(grayImage);
    const objectSupportMask = this._getCurrentObjectSupportMask();
    const keypointResult = this._extractObjectKeypoints(grayImage, region, objectSupportMask, {
      minKeypoints: CANDIDATE_MIN_TRACKABLE_POINTS,
    });
    const qualityAssessment = this.keypointDetector.assessTemplateQuality(
      keypointResult.keypoints,
      keypointResult.descriptors,
      region.width,
      region.height,
      region.x,
      region.y
    );

    const activeBeforeRefresh = this._activeTrackedPointCount();
    if (activeBeforeRefresh < 3 && keypointResult.keypoints.length > 0) {
      this.keypointTracker.initializeTracking(this.cv, keypointResult.keypoints, grayImage, this.currentPosition);
    } else if (keypointResult.keypoints.length > 0 &&
        typeof this.keypointTracker.refreshKeypoints === 'function') {
      this.keypointTracker.refreshKeypoints(
        this.cv,
        grayImage,
        this.keypointDetector,
        region,
        objectSupportMask,
        {
          minNewKeypoints: CANDIDATE_MIN_TRACKABLE_POINTS,
          adaptive: true,
        }
      );
    }

    const activeLandmarks = this._activeTrackedPointCount();
    this.anchorState = this._getProgressiveBootstrapState(activeLandmarks, qualityAssessment.overall);
    const readiness = this._createReadiness({
      state: this.anchorState,
      poseSource: null,
      reconstructionReady: false,
    });
    const evidence = this._calculateObjectEvidence({
      objectSupportMask,
      region,
      templateKeypoints: keypointResult.keypoints,
      trackingKeypoints: keypointResult.keypoints,
      trackedPoints: this.keypointTracker.trackedPoints,
    });

    this.metrics = {
      ...this.metrics,
      keypointCount: activeLandmarks,
      activeLandmarks,
      activeLandmarkCount: activeLandmarks,
      inactiveLandmarks: Math.max(0, (this.keypointTracker.trackedPoints?.length || 0) - activeLandmarks),
      inactiveLandmarkCount: Math.max(0, (this.keypointTracker.trackedPoints?.length || 0) - activeLandmarks),
      objectOwnedLandmarks: evidence.objectOwnedLandmarks,
      templateQuality: qualityAssessment.overall,
      qualityState: this._getTemplateQualityState(qualityAssessment.overall),
      trackingSuccessRate: trackingResult?.successRate ?? (activeLandmarks >= CANDIDATE_MIN_TRACKABLE_POINTS ? 0.5 : 0),
      maskCoverage: evidence.maskCoverage,
      maskConfidence: evidence.maskConfidence,
      keypointDensity: evidence.keypointDensity,
      backgroundRejected: evidence.backgroundRejected,
      readiness,
      lastFailureReason: readiness.faceReady ? null : readiness.reason,
      lastFailureStage: readiness.faceReady ? null : 'progressive-bootstrap',
    };

    return {
      success: true,
      position: this.currentPosition,
      normal: this.currentNormal,
      planarTransform: this.currentPlanarTransform,
      confidence: trackingResult?.successRate ?? (activeLandmarks >= CANDIDATE_MIN_TRACKABLE_POINTS ? 0.5 : 0.25),
      method: recoveryResult.success ? 'candidate_template_bootstrap' : 'candidate_landmark_bootstrap',
      state: this.anchorState,
      readiness,
      evidence,
      recoverable: true,
    };
  }

  _attemptKeyframeRelocalization(grayImage, timestamp, failureReason) {
    if (!this.relocalizer.hasKeyframes()) {
      return {
        success: false,
        reason: failureReason || 'No descriptor keyframes available for relocalization'
      };
    }

    const keypointResult = this.keypointDetector.extractKeypoints(
      this.cv,
      grayImage,
      null,
      this._getCurrentObjectSupportMask()
    );
    const relocalizationResult = this.relocalizer.relocalize(grayImage, keypointResult.keypoints);
    this.metrics.relocalizationKeyframes = relocalizationResult.keyframeCount || this.metrics.relocalizationKeyframes || 0;
    this.metrics.relocalizationQueryKeypoints = keypointResult.keypoints.length;
    this.metrics.relocalizationMatches = relocalizationResult.matchCount || 0;
    this.metrics.relocalizationInliers = relocalizationResult.inlierCount || 0;
    this.metrics.relocalizationConfidence = relocalizationResult.confidence || 0;
    this.metrics.relocalizationResult = relocalizationResult.success ? 'success' : 'failed';
    this.metrics.relocalizationReason = relocalizationResult.reason || null;

    if (!relocalizationResult.success) {
      return {
        success: false,
        reason: relocalizationResult.reason || failureReason || 'Descriptor relocalization failed'
      };
    }

    const restore = this.keypointTracker.restoreFromReferenceTransform(
      grayImage,
      relocalizationResult.transform,
      relocalizationResult.inlierIds
    );

    if (restore.restored < 8) {
      const reason = `Descriptor relocalization restored only ${restore.restored} landmarks`;
      this.metrics.relocalizationResult = 'failed';
      this.metrics.relocalizationReason = reason;
      return { success: false, reason };
    }

    this.keypointFailureCount = 0;
    this.metrics.relocalizationRestored = restore.restored;
    this.metrics.relocalizationActiveLandmarks = restore.active;

    return {
      success: true,
      method: relocalizationResult.method,
      restore,
      matches: relocalizationResult.matchCount,
      inliers: relocalizationResult.inlierCount,
      confidence: relocalizationResult.confidence,
      trackingResult: {
        success: true,
        successRate: Math.max(0.5, Math.min(1, relocalizationResult.confidence)),
        activePointCount: restore.active,
        averageError: relocalizationResult.averageResidual,
        method: relocalizationResult.method,
        relocalized: true,
        statistics: {
          timestamp,
          totalPoints: restore.total,
          activePoints: restore.active,
          successfulPoints: restore.restored,
          successRate: Math.max(0.5, Math.min(1, relocalizationResult.confidence)),
          averageError: relocalizationResult.averageResidual,
        }
      }
    };
  }

  _storeRelocalizationKeyframe(grayImage, { overallQuality = 1, poseInliers = 0, force = false } = {}) {
    this.framesSinceRelocalizationKeyframe++;
    const activeCount = this.keypointTracker.trackedPoints
      ? this.keypointTracker.trackedPoints.filter(point => point.status === 'active').length
      : 0;

    if (!force && this.framesSinceRelocalizationKeyframe < this.relocalizationKeyframeInterval) {
      return null;
    }

    if (!force && (overallQuality < 0.58 || activeCount < 16 || poseInliers < 8)) {
      return null;
    }

    const result = this.relocalizer.storeKeyframeFromTrackedPoints(
      grayImage,
      this.keypointTracker.trackedPoints
    );

    this.metrics.relocalizationKeyframes = result.keyframeCount || this.metrics.relocalizationKeyframes || 0;
    this.metrics.relocalizationDescriptors = result.descriptorCount || this.metrics.relocalizationDescriptors || 0;
    this.metrics.relocalizationKeyframeResult = result.success ? 'stored' : 'skipped';
    this.metrics.relocalizationKeyframeReason = result.reason || null;

    if (result.success) {
      this.framesSinceRelocalizationKeyframe = 0;
    }

    return result;
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
      this._getCurrentObjectSupportMask()
    );

    if (refreshResult) {
      this._recordLandmarkMetrics();
      const refreshStats = this.keypointTracker.lastRefreshStats;
      if (refreshStats) {
        this.metrics.landmarkRefreshAdded = refreshStats.added;
        this.metrics.landmarkRefreshTotal = refreshStats.total;
      }
      this._storeRelocalizationKeyframe(grayImage, {
        force: true,
        overallQuality: this.metrics.trackingSuccessRate || 1,
        poseInliers: this.metrics.poseInliers || 0
      });
      logger.info('ImageAnchor', 'Keypoints refreshed successfully');
    }
  }

  _shouldRefreshKeypoints({ overallQuality, poseInliers }) {
    if (this.anchorState === 'mapping') {
      const activeCount = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
      return this.framesSinceRefresh >= CANDIDATE_REFRESH_INTERVAL && activeCount < 32;
    }

    const geometrySupportsMapGrowth = poseInliers >= 8;
    const needsOcclusionSupport = geometrySupportsMapGrowth &&
      this.metrics.trackingSuccessRate >= 0.6 &&
      this.metrics.keypointCount >= 8 &&
      this.metrics.keypointCount < 18;

    if (this.framesSinceRefresh < this.refreshInterval && !needsOcclusionSupport) {
      return false;
    }

    if (this.metrics.trackingSuccessRate < 0.55 || this.metrics.keypointCount < 12) {
      return needsOcclusionSupport;
    }

    if (!['tracking', 'stable', 'degraded', 'mapping'].includes(this.anchorState)) {
      return false;
    }

    const landmarkCount = this.metrics.landmarkCount || this.metrics.keypointCount;
    const mapNeedsExpansion = landmarkCount < 70;
    const poseNeedsSupport = geometrySupportsMapGrowth && poseInliers < 24;
    const trackingIsUseful = overallQuality >= 0.5 || this.anchorState === 'stable';

    return needsOcclusionSupport ||
      (geometrySupportsMapGrowth && trackingIsUseful && (mapNeedsExpansion || poseNeedsSupport || this.anchorState === 'stable'));
  }

  _shouldAttemptGeometryRelocalization(anchorPosition) {
    if (!this.relocalizer.hasKeyframes()) {
      return false;
    }

    const activeCount = this.metrics.keypointCount || 0;
    const residual = anchorPosition?.averageResidual ?? 0;
    const geometryIncoherentWithFewLandmarks = activeCount < 18 && residual > 24;

    return activeCount < 12 || geometryIncoherentWithFewLandmarks;
  }

  _recordLandmarkMetrics() {
    const points = this.keypointTracker?.trackedPoints || [];
    const activePoints = points.filter(point => point.status === 'active');
    const objectSupportMask = this._getCurrentObjectSupportMask();
    const objectOwnedLandmarks = objectSupportMask
      ? activePoints.filter(point => isPointInsideObjectSupport(objectSupportMask, point.current)).length
      : activePoints.length;

    this.metrics.landmarkCount = points.length;
    this.metrics.activeLandmarkCount = activePoints.length;
    this.metrics.activeLandmarks = this.metrics.activeLandmarkCount;
    this.metrics.inactiveLandmarkCount = Math.max(0, this.metrics.landmarkCount - this.metrics.activeLandmarkCount);
    this.metrics.inactiveLandmarks = this.metrics.inactiveLandmarkCount;
    this.metrics.objectOwnedLandmarks = objectOwnedLandmarks;
  }

  _rejectTrackedPointsOutsideObjectSupport() {
    const objectSupportMask = this._getCurrentObjectSupportMask();
    if (!objectSupportMask) {
      return 0;
    }

    let rejected = 0;
    for (const point of this.keypointTracker.trackedPoints || []) {
      if (point.status !== 'active') {
        continue;
      }

      if (isPointInsideObjectSupport(objectSupportMask, point.current)) {
        point.outsideObjectFrames = 0;
        continue;
      }

      point.outsideObjectFrames = (point.outsideObjectFrames || 0) + 1;
      if (point.outsideObjectFrames >= 2) {
        point.status = 'outlier';
        rejected++;
      }
    }

    return rejected;
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
        this._clampTemplateRegion(region, grayImage.cols, grayImage.rows),
        this._getCurrentObjectSupportMask()
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

  _extractTargetClass(detection) {
    return detection?.class || detection?.label || detection?.name || null;
  }

  _selectObjectSupportMask(detection) {
    if (!detection) {
      return null;
    }

    if (detection.objectSupportMask) {
      return detection.objectSupportMask;
    }

    return null;
  }

  _getCurrentObjectSupportMask() {
    if (!this.objectSupportMask || !this.currentPosition || !this.currentPlanarTransform) {
      return this.objectSupportMask;
    }

    this.currentObjectSupportMask = warpObjectSupportMask(this.objectSupportMask, {
      position: this.currentPosition,
      scale: this.currentPlanarTransform.scale,
      rotation: this.currentPlanarTransform.rotation,
      updatedAtFrame: this.frameIndex,
    });

    this.metrics.currentObjectSupportMaskSource = this.currentObjectSupportMask.source;
    this.metrics.currentObjectSupportMaskBounds = { ...this.currentObjectSupportMask.bbox };
    return this.currentObjectSupportMask;
  }

  _calculateTrackingRegion(boundingBox, imageWidth, imageHeight, templateRegion) {
    if (!boundingBox ||
        !Number.isFinite(boundingBox.x1) ||
        !Number.isFinite(boundingBox.y1) ||
        !Number.isFinite(boundingBox.x2) ||
        !Number.isFinite(boundingBox.y2)) {
      return { ...templateRegion };
    }

    const templateArea = templateRegion.width * templateRegion.height;
    const detectionWidth = Math.max(1, boundingBox.x2 - boundingBox.x1);
    const detectionHeight = Math.max(1, boundingBox.y2 - boundingBox.y1);
    const detectionArea = detectionWidth * detectionHeight;
    const padding = Math.max(8, Math.min(24, Math.max(templateRegion.width, templateRegion.height) * 0.12));
    const objectRegion = this._clampTemplateRegion({
      x: Math.min(boundingBox.x1, templateRegion.x) - padding,
      y: Math.min(boundingBox.y1, templateRegion.y) - padding,
      width: Math.max(boundingBox.x2, templateRegion.x + templateRegion.width) -
        Math.min(boundingBox.x1, templateRegion.x) + padding * 2,
      height: Math.max(boundingBox.y2, templateRegion.y + templateRegion.height) -
        Math.min(boundingBox.y1, templateRegion.y) + padding * 2,
    }, imageWidth, imageHeight);

    if (detectionArea < templateArea * 1.2) {
      return { ...templateRegion };
    }

    return objectRegion;
  }

  _mergeTrackingKeypoints(templateKeypoints, objectKeypoints) {
    const normalizeKeypoint = keypoint => keypoint.pt
      ? keypoint
      : {
          ...keypoint,
          pt: { x: keypoint.x, y: keypoint.y },
        };
    const minDistance = 7;
    const candidates = [
      ...templateKeypoints.map(normalizeKeypoint).map(keypoint => ({
        ...keypoint,
        response: (keypoint.response || 1) + 0.25,
      })),
      ...objectKeypoints.map(normalizeKeypoint),
    ].sort((left, right) => (right.response || 0) - (left.response || 0));
    const merged = [];

    for (const keypoint of candidates) {
      const overlaps = merged.some(existing => (
        Math.hypot(existing.pt.x - keypoint.pt.x, existing.pt.y - keypoint.pt.y) < minDistance
      ));
      if (!overlaps) {
        merged.push(keypoint);
      }
    }

    return merged;
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

      if (!bestAttempt || this._scorePoseAttempt(attempt) > this._scorePoseAttempt(bestAttempt)) {
        bestAttempt = attempt;
      }
    }

    return bestAttempt || {
      options: this._getPoseCorrespondenceOptions(),
      correspondences: [],
      poseResult: null
    };
  }

  _scorePoseAttempt(attempt) {
    const poseResult = attempt.poseResult;
    if (!poseResult?.success) {
      return attempt.correspondences.length / 1000;
    }

    const usableScore = this._isUsablePoseResult(poseResult, attempt.correspondences) ? 2 : 0;
    const inlierRatio = poseResult.inlierRatio ?? poseResult.inlierCount / Math.max(1, attempt.correspondences.length);
    const residualScore = clamp(1 - (poseResult.averageResidual ?? 0) / 5.5, 0, 1);
    const spread = poseResult.referenceSpread || this._measureReferenceSpread(attempt.correspondences);
    const spreadScore = clamp(spread.minAxis / 80, 0, 1);
    const coverageScore = clamp(Math.hypot(spread.width, spread.height) / 180, 0, 1);
    const countScore = clamp(attempt.correspondences.length / 36, 0, 1);

    return usableScore +
      (poseResult.confidence ?? 0) * 0.34 +
      inlierRatio * 0.16 +
      residualScore * 0.2 +
      spreadScore * 0.08 +
      coverageScore * 0.16 +
      countScore * 0.06;
  }

  _estimatePoseFromCorrespondences(correspondences) {
    const homographyPose = this.homographyEstimator.estimatePose(this.cv, correspondences, {
      anchorReference: this.keypointTracker.anchorOriginalPosition
    });
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

  _createPlanarHomographyPose(poseResult, correspondences) {
    if (!poseResult?.success || poseResult.method !== 'homography' || !poseResult.homographyMatrix) {
      return null;
    }

    const anchorReference = this.keypointTracker.anchorOriginalPosition;
    const referenceSpread = poseResult.referenceSpread || this._measureReferenceSpread(correspondences);
    const basis = Math.max(18, Math.min(72, referenceSpread.minAxis * 0.28));
    const position2d = transformHomographyPoint(poseResult.homographyMatrix, anchorReference);
    const basisX = transformHomographyPoint(poseResult.homographyMatrix, {
      x: anchorReference.x + basis,
      y: anchorReference.y
    });
    const basisY = transformHomographyPoint(poseResult.homographyMatrix, {
      x: anchorReference.x,
      y: anchorReference.y + basis
    });
    const vectorX = {
      x: basisX.x - position2d.x,
      y: basisX.y - position2d.y
    };
    const vectorY = {
      x: basisY.x - position2d.x,
      y: basisY.y - position2d.y
    };
    const scale = Math.sqrt(Math.max(1e-9, Math.hypot(vectorX.x, vectorX.y) * Math.hypot(vectorY.x, vectorY.y))) / basis;
    const residualScore = clamp(1 - (poseResult.averageResidual || 0) / 8, 0, 1);
    const inlierRatio = poseResult.inlierRatio ?? poseResult.inlierCount / Math.max(1, correspondences.length);
    const confidence = clamp((poseResult.confidence || 0) * 0.46 + inlierRatio * 0.36 + residualScore * 0.18, 0, 1);

    return {
      success: true,
      method: 'planar-homography',
      position: { x: position2d.x, y: position2d.y, z: 0 },
      normal: poseResult.normal,
      planarTransform: {
        scale,
        rotation: Math.atan2(vectorX.y, vectorX.x),
        confidence,
        inlierCount: poseResult.inlierCount,
        method: 'planar-homography',
      },
      confidence,
      inlierCount: poseResult.inlierCount,
      inlierRatio,
      averageResidual: poseResult.averageResidual || 0,
      foreshortening: poseResult.normal?.z ?? 1,
      referenceSpread,
      homographyMatrix: poseResult.homographyMatrix,
      correspondences
    };
  }

  _updateReconstructionPoseFromTracker(timestamp, grayImage) {
    if (!isReconstructionMode(this.trackingMode)) {
      this._recordReconstructionMetrics(this.reconstructor.getState());
      return null;
    }

    const reconstructionState = this.reconstructor.addFrameFromTrackedPoints(this.keypointTracker.trackedPoints, timestamp, grayImage);
    this._recordReconstructionMetrics(reconstructionState);

    const pose = this.reconstructor.estimatePoseFromTrackedPoints(this.keypointTracker.trackedPoints, grayImage);
    if (!pose.success) {
      this.metrics.reconstructionPoseRejectedReason = pose.reason;
      return pose;
    }

    this.metrics.reconstructionPoseRejectedReason = null;
    return {
      ...pose,
      correspondences: this.keypointTracker.trackedPoints
        .filter(point => point.status === 'active')
        .map(point => ({
          prev: { x: point.original.x, y: point.original.y },
          curr: { x: point.current.x, y: point.current.y },
        }))
    };
  }

  _shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences }) {
    const planarUsable = this._isUsablePoseResult(planarPose, correspondences);
    if (!planarUsable) {
      return false;
    }

    if (this._hasSelectedReconstructionPose(reconstructionPose)) {
      return false;
    }

    const reconstructionUsable = this._isUsablePoseResult(reconstructionPose, reconstructionPose?.correspondences || correspondences);
    const reconstructionHasRealDepth = reconstructionUsable && this._hasStrongNonPlanarReconstruction(reconstructionPose);

    if (reconstructionHasRealDepth) {
      return false;
    }

    if (this._hasPlanarDominance() && !reconstructionHasRealDepth) {
      return true;
    }

    if (!reconstructionUsable) {
      return true;
    }

    const planarStrong = planarPose.inlierCount >= 16 && planarPose.inlierRatio >= 0.58 && planarPose.confidence >= 0.48;

    if (planarStrong && !reconstructionHasRealDepth) {
      return true;
    }

    return planarStrong &&
      planarPose.inlierCount >= reconstructionPose.inlierCount + 6 &&
      planarPose.confidence >= reconstructionPose.confidence - 0.08;
  }

  _shouldUsePlanarPatchTransform({ planarPose, reconstructionPose, correspondences }) {
    if (!isReconstructionMode(this.trackingMode)) {
      return false;
    }

    if (this._hasSelectedReconstructionPose(reconstructionPose)) {
      return false;
    }

    if (!this._isUsablePoseResult(planarPose, correspondences)) {
      return false;
    }

    const reconstructionCorrespondences = reconstructionPose?.correspondences || correspondences;
    if (!this._isUsablePoseResult(reconstructionPose, reconstructionCorrespondences)) {
      return false;
    }

    const planarResidual = planarPose.averageResidual ?? Infinity;
    const reconstructionResidual = reconstructionPose.averageResidual ?? Infinity;
    const planarConfidence = planarPose.confidence ?? 0;
    const reconstructionConfidence = reconstructionPose.confidence ?? 0;

    return planarPose.inlierCount >= 10 &&
      planarResidual <= Math.max(4.5, reconstructionResidual + 1.5) &&
      planarConfidence >= reconstructionConfidence - 0.22;
  }

  _selectNormalPose({ reconstructionPose, planarPose, objectPose, poseResult, correspondences, reconstructionConsistentWithTracker }) {
    const rejectPlanarNormalForCurvedTarget = this._shouldRejectPlanarNormalForCurvedTarget(reconstructionPose);

    if (!rejectPlanarNormalForCurvedTarget &&
        this._shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences })) {
      return { ...planarPose, correspondences };
    }

    const reconstructionHighInlierNormal = this._hasStrongNonPlanarReconstruction(reconstructionPose) &&
      (reconstructionPose.inlierCount || 0) >= 24 &&
      (reconstructionPose.averageResidual ?? Infinity) <= 2.4;
    const reconstructionPoseUsable = this._isUsablePoseResult(reconstructionPose, reconstructionPose?.correspondences || correspondences) &&
      (!this._hasPlanarDominance() ||
        this._hasSelectedReconstructionPose(reconstructionPose) ||
        (this._hasStrongNonPlanarReconstruction(reconstructionPose) && reconstructionConsistentWithTracker) ||
        reconstructionHighInlierNormal);
    const objectPoseUsable = this._isUsablePoseResult(objectPose, objectPose.correspondences || correspondences);
    const correspondencePoseUsable = !rejectPlanarNormalForCurvedTarget &&
      this._isUsablePoseResult(poseResult, correspondences);
    const objectTiltMagnitude = objectPose?.normal
      ? Math.hypot(objectPose.normal.x, objectPose.normal.y)
      : 0;
    const correspondenceTiltMagnitude = poseResult?.normal
      ? Math.hypot(poseResult.normal.x, poseResult.normal.y)
      : 0;
    const objectPoseShowsForeshortening = objectPoseUsable &&
      objectPose.foreshortening < 0.92 &&
      objectTiltMagnitude > 0.18;
    const correspondencePoseLooksFaceOn = !correspondencePoseUsable ||
      correspondenceTiltMagnitude < objectTiltMagnitude * 0.45;

    if (reconstructionPoseUsable) {
      return { ...reconstructionPose, correspondences: reconstructionPose.correspondences || correspondences };
    }

    if (objectPoseShowsForeshortening && correspondencePoseLooksFaceOn) {
      return { ...objectPose, correspondences };
    }

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

    if (poseResult.method === 'homography' || poseResult.method === 'planar-homography') {
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

  _recordPlanarHomographyMetrics(planarPose) {
    this._recordPoseInlierMetrics(planarPose);
    this.metrics.poseSource = planarPose.method;
    this.metrics.poseConfidence = planarPose.confidence;
    this.metrics.poseAverageResidual = planarPose.averageResidual;
    this.metrics.poseForeshortening = planarPose.foreshortening;
  }

  _updatePlanarDominance(planarPose, correspondences) {
    const inlierRatio = planarPose
      ? planarPose.inlierRatio ?? planarPose.inlierCount / Math.max(1, correspondences.length)
      : 0;
    const strongPlanarEvidence = planarPose?.success &&
      planarPose.inlierCount >= 8 &&
      inlierRatio >= 0.45 &&
      (planarPose.averageResidual ?? 0) <= 2.2;

    if (strongPlanarEvidence) {
      this.planarDominanceScore = Math.min(8, this.planarDominanceScore + 1);
    } else if ((this.metrics.keypointCount || 0) >= 12) {
      this.planarDominanceScore = Math.max(0, this.planarDominanceScore - 0.1);
    }

    this.metrics.planarDominanceScore = this.planarDominanceScore;
    this.metrics.planarDominant = this._hasPlanarDominance();
  }

  _hasPlanarDominance() {
    return this.planarDominanceScore >= 4;
  }

  _shouldHoldTrackerAttachmentForPlanarReconstruction({ planarPoseUsable, reconstructionPose }) {
    return isReconstructionMode(this.trackingMode) &&
      this._hasPlanarTargetClass() &&
      this._hasPlanarDominance() &&
      !planarPoseUsable &&
      !this._hasSelectedReconstructionPose(reconstructionPose);
  }

  _isPosePositionConsistentWithTracker(pose, trackerAnchorPosition) {
    if (!pose?.success || !pose.position || !trackerAnchorPosition) {
      return false;
    }

    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    const maxDelta = clamp(templateSize * 0.1, 10, 18);
    const delta = Math.hypot(
      pose.position.x - trackerAnchorPosition.x,
      pose.position.y - trackerAnchorPosition.y
    );

    this.metrics.reconstructionTrackerDelta = delta;
    this.metrics.reconstructionTrackerConsistent = delta <= maxDelta;
    return delta <= maxDelta;
  }

  _selectTrackedAttachmentTransform({ trackerAnchorPosition, reconstructionPose, useTrackedTransform = false }) {
    if (useTrackedTransform) {
      return {
        scale: trackerAnchorPosition.scale,
        rotation: trackerAnchorPosition.rotation,
        confidence: trackerAnchorPosition.confidence,
        inlierCount: trackerAnchorPosition.inlierCount,
        method: trackerAnchorPosition.method
      };
    }

    if (this._hasPlanarDominance() && reconstructionPose?.planarTransform) {
      return {
        ...reconstructionPose.planarTransform,
        rotation: trackerAnchorPosition.rotation,
        method: 'tracked-anchor-reconstruction-scale',
      };
    }

    if (this._hasPlanarDominance() && this.currentPlanarTransform) {
      return {
        ...this.currentPlanarTransform,
        rotation: trackerAnchorPosition.rotation,
        method: 'tracked-anchor-planar-transform',
      };
    }

    return {
      scale: trackerAnchorPosition.scale,
      rotation: trackerAnchorPosition.rotation,
      confidence: trackerAnchorPosition.confidence,
      inlierCount: trackerAnchorPosition.inlierCount,
      method: trackerAnchorPosition.method
    };
  }

  _hasStrongNonPlanarReconstruction(reconstructionPose) {
    if (!reconstructionPose?.success) {
      return false;
    }

    if (this.trackingMode === RECONSTRUCTION_POSE_MODEL && this._hasPlanarTargetClass()) {
      return false;
    }

    const depthQuality = reconstructionPose.depthQuality ?? this.metrics.reconstructionDepthQuality ?? 0;
    const mapConfidence = reconstructionPose.preview?.statistics?.mapConfidence ??
      this.metrics.reconstructionMapConfidence ??
      reconstructionPose.confidence ??
      0;
    const inliers = reconstructionPose.inlierCount || 0;

    return depthQuality >= 0.06 && mapConfidence >= 0.55 && inliers >= 12;
  }

  _hasStrongCurvedReconstructionPosition(reconstructionPose) {
    if (!this._hasStrongNonPlanarReconstruction(reconstructionPose) || this._hasPlanarTargetClass()) {
      return false;
    }

    return this._hasPreciseCurvedReconstructionPosition(reconstructionPose) ||
      this._hasTolerantCurvedReconstructionRecovery(reconstructionPose);
  }

  _hasPreciseCurvedReconstructionPosition(reconstructionPose) {
    if (!this._hasCurvedReconstructionTarget(reconstructionPose) ||
        reconstructionPose.method !== this.trackingMode) {
      return false;
    }

    return (reconstructionPose.inlierCount || 0) >= 18 &&
      (reconstructionPose.averageResidual ?? Infinity) <= 3.2;
  }

  _hasTolerantCurvedReconstructionRecovery(reconstructionPose) {
    if (!this._hasStrongNonPlanarReconstruction(reconstructionPose) ||
        this._hasPlanarTargetClass() ||
        !this._hasCurvedReconstructionTarget(reconstructionPose) ||
        reconstructionPose.method !== this.trackingMode) {
      return false;
    }

    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    const trackerDelta = this.metrics.reconstructionTrackerDelta || 0;
    const severeTrackerDivergence = trackerDelta >= clamp(templateSize * 0.28, 32, 48);

    return severeTrackerDivergence &&
      (reconstructionPose.inlierCount || 0) >= 16 &&
      (reconstructionPose.averageResidual ?? Infinity) <= 10;
  }

  _shouldRejectPlanarNormalForCurvedTarget(reconstructionPose) {
    return isReconstructionMode(this.trackingMode) &&
      this._hasCurvedReconstructionTarget(reconstructionPose) &&
      !this._hasSelectedReconstructionPose(reconstructionPose);
  }

  _shouldRelaxStaleCurvedNormal() {
    if (!isReconstructionMode(this.trackingMode) || this._hasPlanarTargetClass()) {
      return false;
    }

    if (this.framesWithoutNormalPose < 3) {
      return false;
    }

    const currentTilt = Math.hypot(this.currentNormal.x, this.currentNormal.y);

    return this._hasCurvedReconstructionTarget() && currentTilt > 0.18;
  }

  _hasCurvedReconstructionTarget(reconstructionPose) {
    if (this._hasPlanarTargetClass()) {
      return false;
    }

    const surfaceModel = reconstructionPose?.preview?.surface?.model ||
      this.metrics.reconstructionPreview?.surface?.model ||
      '';

    return /cylinder|ellipsoid/.test(surfaceModel) ||
      /cup|mug|vase|can|bottle|jar|container|ball|sphere/i.test(this.anchorTargetClass || '');
  }

  _hasPlanarTargetClass() {
    return PLANAR_TARGET_CLASS_PATTERN.test(this.anchorTargetClass || '');
  }

  _hasSelectedReconstructionPose(reconstructionPose) {
    if (!reconstructionPose?.success || reconstructionPose.method !== this.trackingMode) {
      return false;
    }

    if (this.trackingMode === RECONSTRUCTION_POSE_MODEL) return false;

    const mapConfidence = reconstructionPose.preview?.statistics?.mapConfidence ??
      this.metrics.reconstructionMapConfidence ??
      reconstructionPose.confidence ??
      0;
    return mapConfidence >= 0.48 && (reconstructionPose.inlierCount || 0) >= 12;
  }

  _recordReconstructionMetrics(reconstructionState) {
    const statistics = reconstructionState.statistics || reconstructionState.preview?.statistics || null;
    this.metrics.reconstructionState = reconstructionState.state;
    this.metrics.reconstructionReady = reconstructionState.ready;
    this.metrics.reconstructionFrames = reconstructionState.frameCount;
    this.metrics.reconstructionLandmarks = reconstructionState.landmarkCount;
    this.metrics.reconstructionDepthQuality = reconstructionState.depthQuality;
    this.metrics.reconstructionFailureReason = reconstructionState.lastFailureReason;
    this.metrics.reconstructionPreview = reconstructionState.preview || null;
    this.metrics.reconstructionMapConfidence = statistics?.mapConfidence;
    this.metrics.reconstructionAverageSupport = statistics?.averageSupport;
    this.metrics.reconstructionAverageReliability = statistics?.averageReliability;
    this.metrics.reconstructionGeometricConsistency = statistics?.geometricConsistency;
    this.metrics.reconstructionMatureLandmarks = statistics?.matureLandmarks;
  }

  _recordReconstructionPoseMetrics(reconstructionPose, { active = true } = {}) {
    this.metrics.reconstructionPoseInliers = reconstructionPose.inlierCount || 0;
    this.metrics.poseInliers = Math.max(this.metrics.poseInliers || 0, reconstructionPose.inlierCount || 0);
    if (active) {
      this.metrics.poseSource = reconstructionPose.method;
    }
    this.metrics.poseConfidence = reconstructionPose.confidence;
    this.metrics.poseAverageResidual = reconstructionPose.averageResidual;
    this.metrics.poseForeshortening = reconstructionPose.depthQuality;
    this.metrics.reconstructionPnpInliers = reconstructionPose.pnpInlierCount || 0;
    this.metrics.reconstructionPnpAverageResidual = reconstructionPose.pnpAverageResidual ?? null;
    this.metrics.reconstructionPreview = reconstructionPose.preview || this.metrics.reconstructionPreview || null;
    this.metrics.reconstructionMapConfidence = reconstructionPose.preview?.statistics?.mapConfidence ?? this.metrics.reconstructionMapConfidence;
    this.metrics.reconstructionAverageSupport = reconstructionPose.preview?.statistics?.averageSupport ?? this.metrics.reconstructionAverageSupport;
    this.metrics.reconstructionAverageReliability = reconstructionPose.preview?.statistics?.averageReliability ?? this.metrics.reconstructionAverageReliability;
    this.metrics.reconstructionGeometricConsistency = reconstructionPose.preview?.statistics?.geometricConsistency ?? this.metrics.reconstructionGeometricConsistency;
    this.metrics.reconstructionMatureLandmarks = reconstructionPose.preview?.statistics?.matureLandmarks ?? this.metrics.reconstructionMatureLandmarks;
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
    const boundedScale = this.currentPlanarTransform
      ? clamp(rawScale, previous.scale * Math.exp(-SCALE_STEP_LOG_LIMIT), previous.scale * Math.exp(SCALE_STEP_LOG_LIMIT))
      : rawScale;
    const rawRotation = typeof anchorPosition.rotation === 'number'
      ? unwrapAngle(anchorPosition.rotation, previous.rotation)
      : previous.rotation;

    this.currentPlanarTransform = {
      scale: this._scaleFilterFor(anchorPosition).filter(boundedScale, timestamp),
      rotation: this.planarRotationFilter.filter(rawRotation, timestamp),
      confidence: typeof anchorPosition.confidence === 'number' ? anchorPosition.confidence : previous.confidence,
      inlierCount: typeof anchorPosition.inlierCount === 'number' ? anchorPosition.inlierCount : previous.inlierCount,
      method: anchorPosition.method || previous.method
    };

    return this.currentPlanarTransform;
  }

  _scaleFilterFor(anchorPosition) {
    return this._hasCurvedReconstructionTarget(anchorPosition)
      ? this.curvedScaleFilter
      : this.planarScaleFilter;
  }

  _filterPositionCandidate(position, timestamp, method) {
    const filtered = {
      x: this.positionFilterX.filter(position.x, timestamp),
      y: this.positionFilterY.filter(position.y, timestamp),
      z: 0
    };

    return this._limitPositionStep(filtered, method);
  }

  _limitPositionStep(position, method = 'unknown') {
    if (!this.currentPosition || !this.metrics.lastUpdateResult) {
      return position;
    }

    const deltaX = position.x - this.currentPosition.x;
    const deltaY = position.y - this.currentPosition.y;
    const distance = Math.hypot(deltaX, deltaY);
    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    const ratio = isReconstructionMode(this.trackingMode)
      ? 0.08
      : isReconstructionMode(method) ? 0.1 : 0.14;
    const maxStep = clamp(templateSize * ratio, 8, 24);

    if (distance <= maxStep || distance === 0) {
      return position;
    }

    const scale = maxStep / distance;
    return {
      x: this.currentPosition.x + deltaX * scale,
      y: this.currentPosition.y + deltaY * scale,
      z: position.z ?? 0
    };
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

    const method = poseResult.method || '';
    const isPlanarHomography = method === 'homography' || method === 'planar-homography';
    const isSelectedReconstruction = isReconstructionMode(method) && method === this.trackingMode;
    const averageResidual = poseResult.averageResidual ?? 0;
    const allowPlanarRecovery = isPlanarHomography &&
      this._hasPlanarDominance() &&
      poseResult.inlierCount >= 8 &&
      averageResidual <= 3.25;
    const minInlierRatio = isSelectedReconstruction ? 0.24 : allowPlanarRecovery ? 0.32 : 0.5;
    const minConfidence = isSelectedReconstruction ? 0.22 : allowPlanarRecovery ? 0.24 : 0.32;
    const minSpread = isSelectedReconstruction ? 12 : allowPlanarRecovery ? 14 : 18;

    if ((poseResult.inlierRatio ?? 0) < minInlierRatio) {
      return 'Low pose inlier ratio';
    }
    if ((poseResult.confidence ?? 0) < minConfidence) {
      return 'Low pose confidence';
    }

    const maxResidual = isSelectedReconstruction ? 14 : isPlanarHomography ? 5.5 : 6;
    if (averageResidual > maxResidual) {
      return 'High pose residual';
    }

    const spread = poseResult.referenceSpread || this._measureReferenceSpread(correspondences);
    if (spread.minAxis < minSpread) {
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

  _getProgressiveBootstrapState(keypointCount, quality) {
    return keypointCount >= CANDIDATE_MIN_TRACKABLE_POINTS && quality >= this.minimumTemplateQuality
      ? 'mapping'
      : 'candidate';
  }

  _activeTrackedPointCount() {
    return (this.keypointTracker.trackedPoints || []).filter(point => point.status === 'active').length;
  }

  _getProgressiveBootstrapRegion(grayImage) {
    const sourceRegion = this.trackingRegion || this.templateRegion;
    const templateCenter = this._getTemplateCenterFromAnchorPosition();
    return this._clampTemplateRegion({
      x: templateCenter.x - sourceRegion.width / 2,
      y: templateCenter.y - sourceRegion.height / 2,
      width: sourceRegion.width,
      height: sourceRegion.height,
    }, grayImage.cols, grayImage.rows);
  }

  _extractObjectKeypoints(grayImage, region, objectSupportMask, { minKeypoints }) {
    const primary = this.keypointDetector.extractKeypoints(this.cv, grayImage, region, objectSupportMask);
    if (primary.keypoints.length >= minKeypoints || typeof this.keypointDetector.extractAdaptiveKeypoints !== 'function') {
      return primary;
    }

    const adaptive = this.keypointDetector.extractAdaptiveKeypoints(this.cv, grayImage, region, objectSupportMask, {
      minKeypoints,
    });

    return adaptive.keypoints.length > primary.keypoints.length ? adaptive : primary;
  }

  _createReadiness({ state, poseSource, reconstructionReady }) {
    const reconstructionMode = isReconstructionMode(this.trackingMode);
    const strongPlanarPose = poseSource === 'planar-homography';
    const faceReady = state !== 'candidate' &&
      state !== 'mapping' &&
      (!reconstructionMode || reconstructionReady || strongPlanarPose);
    const reason = faceReady
      ? 'Face overlay is ready'
      : FACE_READINESS_REASON_RECONSTRUCTION;

    return { faceReady, reason };
  }

  _calculateObjectEvidence({
    objectSupportMask,
    region,
    templateKeypoints = [],
    trackingKeypoints = [],
    trackedPoints = null,
  }) {
    const regionArea = Math.max(1, region.width * region.height);
    const maskPixels = objectSupportMask
      ? this._countMaskPixelsInRegion(objectSupportMask, region)
      : regionArea;
    const objectOwnedKeypoints = objectSupportMask
      ? trackingKeypoints.filter(keypoint => isPointInsideObjectSupport(objectSupportMask, keypoint.pt || keypoint)).length
      : trackingKeypoints.length;
    const activeTrackedPoints = trackedPoints
      ? trackedPoints.filter(point => point.status === 'active')
      : [];
    const objectOwnedTrackedPoints = objectSupportMask
      ? activeTrackedPoints.filter(point => isPointInsideObjectSupport(objectSupportMask, point.current)).length
      : activeTrackedPoints.length;
    const objectOwnedLandmarks = trackedPoints ? objectOwnedTrackedPoints : objectOwnedKeypoints;

    return {
      maskCoverage: maskPixels / regionArea,
      maskConfidence: objectSupportMask ? objectSupportMask.confidence : null,
      templateKeypoints: templateKeypoints.length,
      activeLandmarks: trackedPoints ? activeTrackedPoints.length : trackingKeypoints.length,
      objectOwnedLandmarks,
      keypointDensity: objectOwnedKeypoints / regionArea,
      backgroundRejected: Math.max(0, trackingKeypoints.length - objectOwnedKeypoints),
    };
  }

  _countMaskPixelsInRegion(objectSupportMask, region) {
    let pixels = 0;
    for (let y = 0; y < region.height; y++) {
      const frameY = region.y + y;
      if (frameY < 0 || frameY >= objectSupportMask.height) {
        continue;
      }

      for (let x = 0; x < region.width; x++) {
        const frameX = region.x + x;
        if (frameX >= 0 &&
            frameX < objectSupportMask.width &&
            objectSupportMask.data[frameY * objectSupportMask.width + frameX] > 0) {
          pixels++;
        }
      }
    }

    return pixels;
  }

  _recordAnchorFailure(stage, reason, metrics = {}) {
    this.metrics = {
      ...this.metrics,
      ...metrics,
      templateRegion: metrics.templateRegion ? { ...metrics.templateRegion } : this.metrics.templateRegion,
      lastFailureStage: stage,
      lastFailureReason: reason,
      lastFailureAt: this.now(),
      lastUpdateResult: 'failed'
    };
  }

  _recordAnchorUpdateResult(result, processingTime) {
    this.metrics.processingTime = processingTime;
    this.metrics.lastUpdateResult = result.success ? 'success' : 'failed';
    this.metrics.lastUpdateMethod = result.method || null;
    this.metrics.lastUpdateConfidence = typeof result.confidence === 'number' ? result.confidence : null;
    this.metrics.keypointFailureCount = this.keypointFailureCount;
    this.metrics.readiness = result.readiness || this._createReadiness({
      state: this.anchorState,
      poseSource: this.metrics.poseSource,
      reconstructionReady: this.metrics.reconstructionReady,
    });

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
      this.objectSupportMask = null;
      this.currentObjectSupportMask = null;
      this.planarDominanceScore = 0;
      this.templateRegion = null;
      this.trackingRegion = null;
      this.templateCenter = null; // Clear template center reference
      this.templateAnchorOffset = null;
      this.anchorTargetClass = null;
      this.framesSinceRefresh = 0;
      this.framesSinceRelocalizationKeyframe = 0;
      this.framesSinceFullFrameRecovery = this.fullFrameRecoveryInterval;
      this.framesWithoutNormalPose = 0;
      this.frameIndex = 0;
      
      // Reset resilience counters
      this.keypointFailureCount = 0;
      
      // Reset filters
      this.positionFilterX = createPositionFilter();
      this.positionFilterY = createPositionFilter();
      this.planarScaleFilter = createPlanarScaleFilter();
      this.planarRotationFilter = createPlanarRotationFilter();
      this.normalStabilizer.reset();
      this.reconstructor.reset({ anchorReference: { x: 0, y: 0 } });
      this.relocalizer.clear();
      
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
