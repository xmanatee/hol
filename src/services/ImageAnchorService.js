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
import {
  calculateTapLocalRadius,
  createTapLocalObjectSupportMask,
  createObjectSupportMaskPreview,
  isPointInsideObjectSupport,
  warpObjectSupportMask,
} from '../cv/objectSupportMask.js';
import { calculateTapLocalTemplateRegion, calculateTemplateRegion } from '../utils/templateRegion.js';
import { SurfaceNormalStabilizer } from '../utils/normalStabilizer.js';
import { logger } from '../utils/logger.js';

const POSE_MODEL = 'object-pose';
const TRACKING_MODES = new Set([POSE_MODEL, ...RECONSTRUCTION_MODE_IDS]);
const PLANAR_TARGET_CLASS_PATTERN = /book|notebook|paper|document|poster|photo|picture|painting|card|ticket|label|badge|laptop|keyboard|cell phone|smartphone|phone|tablet|tv|screen|sign|whiteboard|bag/i;
const RIGID_PLANAR_TARGET_CLASS_PATTERN = /book|notebook|paper|document|poster|photo|picture|painting|card|ticket|label|badge|laptop|keyboard|cell phone|smartphone|phone|tablet|tv|screen|sign|whiteboard/i;
const CANDIDATE_MIN_TRACKABLE_POINTS = 8;
const CANDIDATE_REFRESH_INTERVAL = 3;
const FACE_READINESS_REASON_RECONSTRUCTION = 'Build more object landmarks before showing the face';
const FACE_READINESS_REASON_POSE_RECOVERY = 'Recovering object pose before showing the face';
const MIN_ATTACHMENT_POSE_INLIERS = 8;
const MIN_PLANAR_ATTACHMENT_POSE_INLIERS = 20;
const MIN_RECONSTRUCTION_ATTACHMENT_POSE_INLIERS = 12;
const MIN_ATTACHMENT_POSE_CONFIDENCE = 0.24;
const MIN_RECONSTRUCTION_ATTACHMENT_POSE_CONFIDENCE = 0.28;
const MAX_PLANAR_ATTACHMENT_POSE_RESIDUAL = 5.5;
const MAX_OBJECT_ATTACHMENT_POSE_RESIDUAL = 6;
const MAX_RECONSTRUCTION_ATTACHMENT_POSE_RESIDUAL = 6;
const MIN_RECONSTRUCTION_ATTACHMENT_FORESHORTENING = 0.22;
const OBJECT_SUPPORT_TRACKING_PADDING_RATIO = 0.18;
const OBJECT_SUPPORT_TRACKING_MIN_PADDING = 12;
const OBJECT_SUPPORT_TRACKING_MAX_PADDING = 48;

const createPositionFilter = () => new OneEuroFilter(60, 2.4, 0.075, 1.0);
const createPlanarScaleFilter = () => new OneEuroFilter(60, 1.2, 0.08, 1.0);
const createCurvedScaleFilter = () => new OneEuroFilter(60, 2.4, 0.18, 1.0);
const createPlanarRotationFilter = () => new OneEuroFilter(60, 1.1, 0.08, 1.0);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const SCALE_STEP_LOG_LIMIT = 0.1;
const RIGID_PLANAR_POSITION_STEP_RATIO = 0.1;
const RIGID_PLANAR_BOOK_POSITION_STEP_RATIO = 0.083;
const PLANAR_POSE_POSITION_BLEND = 0.85;
const MIN_LOW_LAG_TRACKER_CONFIDENCE = 0.55;
const MAX_LOW_LAG_TRACKER_RESIDUAL = 7;
const CURVED_DROPOUT_MAX_PREDICTION_MS = 220;
const CURVED_DROPOUT_MAX_STEP = 18;
const PLANAR_POSE_POSITION_METHODS = new Set([
  RECONSTRUCTION_POSE_MODEL,
  'planar-homography',
  'homography',
  'object-pose-affine',
]);

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
    this.lastNormalPoseSource = null;

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
    this.curvedMotionSample = null;
    this.objectSupportMask = null;
    this.currentObjectSupportMask = null;
    this.expandedObjectSupportRegion = false;
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
      poseSourceHoldReason: null,
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

  _setReconstructionRegion(region) {
    this.metrics.reconstructionRegion = { ...region };
    this.reconstructor.updateReferenceRegion(region, this.anchorTargetClass);
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

    let src = null;
    let gray = null;
    try {
      src = this.cv.matFromImageData(imageData);
      gray = new this.cv.Mat();
      this.cv.cvtColor(src, gray, this.cv.COLOR_RGBA2GRAY);

      const targetClass = this._extractTargetClass(boundingBox);

      const templateRegion = this._calculateTemplateRegion(
        tapPosition,
        boundingBox,
        imageData.width,
        imageData.height
      );
      const objectSupportMask = this._selectObjectSupportMask(
        boundingBox,
        tapPosition,
        imageData.width,
        imageData.height
      );

      logger.info('ImageAnchor', `Creating anchor at (${tapPosition.x}, ${tapPosition.y}) with region ${templateRegion.width}x${templateRegion.height}`);

      const keypointResult = this._extractObjectKeypoints(gray, templateRegion, objectSupportMask, {
        minKeypoints: this.minAnchorKeypoints,
      });

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
      const reconstructionRegion = trackingRegion || templateRegion;

      if (trackingKeypoints.length > 0) {
        this.keypointTracker.initializeTracking(this.cv, trackingKeypoints, gray, tapPosition);
      }
      this.reconstructor = this._createConfiguredReconstructor(
        isReconstructionMode(this.trackingMode) ? this.trackingMode : RECONSTRUCTION_POSE_MODEL
      );
      this.reconstructor.reset({ anchorReference: tapPosition, templateRegion: reconstructionRegion, targetClass });
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
      this.expandedObjectSupportRegion = !!objectSupportMask && objectSupportMask.source === 'interactive-segmenter' &&
        !this._isTapLocalObjectSupportMask(objectSupportMask);
      this.anchorTargetClass = targetClass;
      this.normalStabilizer.reset(this.currentNormal);
      this.framesWithoutNormalPose = 0;
      this.lastNormalPoseSource = null;
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
        backgroundRejected: (keypointResult.rejectedByMask || 0) + (trackingKeypointResult.rejectedByMask || 0),
      });
      const objectSupportMaskPreview = objectSupportMask
        ? createObjectSupportMaskPreview(objectSupportMask)
        : null;

      this.anchorState = bootstrapState;
      this.framesSinceRefresh = 0;
      this.framesSinceFullFrameRecovery = this.fullFrameRecoveryInterval;

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
        reconstructionRegion: { ...reconstructionRegion },
        targetClass,
        trackingRegion: this.trackingRegion ? { ...this.trackingRegion } : null,
        objectSupportMaskSource: objectSupportMask ? objectSupportMask.source : null,
        objectSupportMaskConfidence: objectSupportMask ? objectSupportMask.confidence : null,
        maskCoverage: evidence.maskCoverage,
        maskConfidence: evidence.maskConfidence,
        keypointDensity: evidence.keypointDensity,
        backgroundRejected: evidence.backgroundRejected,
        objectSupportMaskBounds: objectSupportMask ? { ...objectSupportMask.bbox } : null,
        objectSupportMaskPreview,
        currentObjectSupportMaskSource: objectSupportMask ? objectSupportMask.source : null,
        currentObjectSupportMaskBounds: objectSupportMask ? { ...objectSupportMask.bbox } : null,
        currentObjectSupportMaskPreview: objectSupportMaskPreview,
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
    } finally {
      if (gray) {
        gray.delete();
      }
      if (src) {
        src.delete();
      }
    }
  }

  updateObjectSupportMask(objectSupportMask, { reason = 'segmentation-refresh' } = {}) {
    if (!objectSupportMask || objectSupportMask.bbox.width <= 0 || objectSupportMask.bbox.height <= 0) {
      return false;
    }

    this.objectSupportMask = objectSupportMask;
    this.currentObjectSupportMask = objectSupportMask;
    this.expandedObjectSupportRegion = true;
    this.metrics.objectSupportMaskSource = objectSupportMask.source;
    this.metrics.objectSupportMaskConfidence = objectSupportMask.confidence;
    this.metrics.objectSupportMaskBounds = { ...objectSupportMask.bbox };
    this.metrics.objectSupportMaskPreview = createObjectSupportMaskPreview(objectSupportMask);
    this.metrics.currentObjectSupportMaskSource = objectSupportMask.source;
    this.metrics.currentObjectSupportMaskBounds = { ...objectSupportMask.bbox };
    this.metrics.currentObjectSupportMaskPreview = this.metrics.objectSupportMaskPreview;
    this.trackingRegion = this._calculateObjectSupportTrackingRegion(objectSupportMask, this.trackingRegion || this.templateRegion);
    this.metrics.trackingRegion = { ...this.trackingRegion };
    this._setReconstructionRegion(this.trackingRegion);
    this.metrics.segmentationRefreshReason = reason;
    this.metrics.segmentationRefreshFrame = this.frameIndex;
    this._recordLandmarkMetrics();
    this._notifyStateChange();
    return true;
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

    logger.debugEvery('ImageAnchor', 'anchor-update-start', 1000, 'Starting anchor update:', {
      anchorState: this.anchorState,
      position: this.currentPosition,
      imageSize: `${imageData.width}x${imageData.height}`
    });

    let src = null;
    let gray = null;

    try {
      src = this.cv.matFromImageData(imageData);
      gray = new this.cv.Mat();
      this.cv.cvtColor(src, gray, this.cv.COLOR_RGBA2GRAY);

      let updateResult;

      if (this.anchorState === 'candidate' ||
          (this.anchorState === 'mapping' && this._activeTrackedPointCount() < CANDIDATE_MIN_TRACKABLE_POINTS)) {
        updateResult = this._updateProgressiveBootstrap(gray, timestamp);
      } else if (this.anchorState === 'mapping' || this.anchorState === 'tracking' || this.anchorState === 'stable') {
        // Primary tracking via keypoints
        logger.debugEvery('ImageAnchor', 'attempting-keypoint-tracking', 1000, 'Attempting keypoint tracking');
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
            if (!updateResult.success) {
              updateResult = this._createDegradedHoldResult(updateResult.reason);
            }
          } else {
            logger.debug('ImageAnchor', `Keypoint failure ${this.keypointFailureCount}/${this.maxKeypointFailures}, will retry next frame`);
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
          logger.debugEvery('ImageAnchor', 'attempting-keypoint-recovery', 1000, 'Attempting keypoint tracking recovery from degraded state');
          const recoveryResult = this._updateWithKeypoints(gray, timestamp);

          if (recoveryResult.success) {
            logger.info('ImageAnchor', 'Keypoint tracking recovered from degraded state!');
            this.anchorState = 'tracking';
            this.keypointFailureCount = 0;
            updateResult = recoveryResult;
          } else {
            logger.debugEvery('ImageAnchor', 'keypoint-recovery-fallback', 1000, 'Keypoint recovery failed, falling back to template matching');
            updateResult = this._updateWithTemplate(gray);
            if (!updateResult.success) {
              updateResult = this._createDegradedHoldResult(updateResult.reason);
            }
          }
        } else {
          // Recovery via template matching
          logger.debugEvery('ImageAnchor', 'attempting-template-recovery', 1000, 'Attempting template matching recovery');
          updateResult = this._updateWithTemplate(gray);
          if (!updateResult.success) {
            updateResult = this._createDegradedHoldResult(updateResult.reason);
          }

          if (updateResult.success && updateResult.method !== 'held-degraded-object-pose') {
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
          logger.debugEvery('ImageAnchor', 'lost-waiting-full-frame-recovery', 1000, 'Object still lost; waiting for next full-frame recovery interval');
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

      this._notifyStateChange();
      return updateResult;

    } catch (error) {
      const reason = `Update exception: ${error.message}`;
      this.metrics.lastFailureReason = reason;
      this.metrics.lastFailureStage = 'update-exception';
      this._recordAnchorUpdateResult({
        success: false,
        reason,
        position: this.currentPosition,
        normal: this.currentNormal,
        planarTransform: this.currentPlanarTransform,
        confidence: 0,
        method: 'update-exception',
        recoverable: false,
        state: this.anchorState,
      }, this.now() - startTime);
      this._notifyStateChange();
      logger.error('ImageAnchor', 'Update exception:', error);
      throw error;
    } finally {
      if (gray) {
        gray.delete();
      }
      if (src) {
        src.delete();
      }
    }
  }

  /**
   * Update using keypoint tracking and homography
   */
  _updateWithKeypoints(grayImage, timestamp) {
    logger.debugEvery('ImageAnchor', 'track-to-frame-start', 1000, 'Keypoint tracking - starting trackToFrame');
    let trackingResult = this.keypointTracker.trackToFrame(this.cv, grayImage);

    logger.debugEvery('ImageAnchor', 'keypoint-tracking-result', 1000, 'Keypoint tracking result:', {
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

    this.metrics.trackingSuccessRate = trackingResult.successRate || 0;
    this.metrics.keypointCount = trackingResult.activePointCount || 0;
    this._recordLandmarkMetrics();

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

    let poseResult = null;
    this.metrics.homographyInliers = 0;
    this.metrics.affinePoseInliers = 0;
    this.metrics.objectPoseInliers = 0;
    this.metrics.reconstructionPoseInliers = 0;
    this.metrics.reconstructionPnpInliers = 0;
    this.metrics.reconstructionPnpAverageResidual = null;
    this.metrics.poseInliers = 0;
    this.metrics.poseSource = null;
    this.metrics.poseSourceHoldReason = null;
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
    logger.debugEvery('ImageAnchor', 'pose-correspondences-check', 1000, 'Pose correspondences check:', {
      correspondences: correspondences.length,
      required: 8,
      radius: poseCorrespondenceOptions.maxReferenceDistance,
      poseModel: POSE_MODEL
    });

    if (poseResult) {
      logger.debugEvery('ImageAnchor', 'pose-result', 1000, 'Pose result:', {
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
      logger.debugEvery('ImageAnchor', 'pose-insufficient-correspondences', 1000, 'Skipping pose estimation - insufficient correspondences:', {
        correspondences: correspondences.length,
        required: 8
      });
    }

    let newPosition = null;
    let positionMethod = 'unknown';
    let planarTransform = this.currentPlanarTransform;

    const rawTrackerAnchorPosition = this.keypointTracker.getAnchorPosition(this.cv);
    const reconstructionPoseUsableForTransform = this._isUsablePoseResult(reconstructionPose, reconstructionPose?.correspondences || correspondences);
    const planarPoseUsableForTransform = this._isUsablePoseResult(planarPose, correspondences);
    const objectPoseUsableForTransform = this._isUsablePoseResult(objectPose, objectPose.correspondences || correspondences);
    const trackerAnchorPosition = this._selectTrackerAnchorPosition({
      trackerAnchorPosition: rawTrackerAnchorPosition,
      reconstructionPose,
    });
    const reconstructionConsistentWithTracker = this._isPosePositionConsistentWithTracker(
      reconstructionPose,
      trackerAnchorPosition
    );
    const useStrongCurvedReconstructionPosition = this._hasStrongCurvedReconstructionPosition(reconstructionPose);
    const useModerateCurvedReconstructionRecovery = this._hasModerateCurvedReconstructionRecovery({
      reconstructionPose,
      trackerAnchorPosition,
    });
    const useTrackedCurvedAttachmentTransform = this._shouldUseTrackedCurvedAttachmentTransform({
      reconstructionPose,
      trackerAnchorPosition,
    });
    const useBlendedCurvedAttachmentTransform = this._shouldBlendTrackerScaleForSelectedCurvedTransform({
      reconstructionPose,
      trackerAnchorPosition,
    });
    const selectedReconstructionReady = this._hasSelectedReconstructionPose(reconstructionPose);
    const suppressReconstructionForPlanarTarget = this._hasPlanarDominance() &&
      !selectedReconstructionReady &&
      !planarPoseUsableForTransform &&
      (
        (this.trackingMode === RECONSTRUCTION_POSE_MODEL && this._hasPlanarTargetClass()) ||
        !this._hasStrongNonPlanarReconstruction(reconstructionPose) ||
        !reconstructionConsistentWithTracker
      );
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
    const suppressImmatureSparsePlanarMap = this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasPlanarTargetClass() &&
      this._hasPlanarDominance() &&
      (
        (this.metrics.reconstructionMatureLandmarks || 0) < 18 ||
        (this.metrics.reconstructionPoseInliers || 0) <= 10
      );
    const holdPlanarTrackerAttachment = this._shouldHoldTrackerAttachmentForPlanarReconstruction({
      planarPoseUsable: planarPoseUsableForTransform,
      reconstructionPose,
    });

    if (planarPoseUsableForTransform && (preferPlanarPose || usePlanarPatchTransform)) {
      newPosition = this._filterPositionCandidate(planarPose.position, timestamp, planarPose.method);
      positionMethod = planarPose.method;
      planarTransform = this._updatePlanarTransform(planarPose.planarTransform, timestamp);
      this._recordPlanarHomographyMetrics(planarPose);
      logger.debugEvery('ImageAnchor', 'positioning-choice', 1000, `Using planar homography positioning: ${positionMethod}`);
    } else if (trackerAnchorPosition &&
        reconstructionPoseUsableForTransform &&
        !reconstructionConsistentWithTracker &&
        !useStrongCurvedReconstructionPosition &&
        !useModerateCurvedReconstructionRecovery) {
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
      logger.debugEvery('ImageAnchor', 'positioning-choice', 1000, 'Using tracked anchor positioning with reconstruction orientation');
    } else if (reconstructionPoseUsableForTransform &&
        ((!suppressImmatureSparsePlanarMap &&
          !suppressReconstructionForPlanarTarget) ||
          useStrongCurvedReconstructionPosition ||
          useModerateCurvedReconstructionRecovery)) {
      newPosition = this._filterPositionCandidate(reconstructionPose.position, timestamp, reconstructionPose.method);
      positionMethod = reconstructionPose.method;
      const selectedReconstructionTransform = this._adjustSelectedCurvedPlanarTransform(
        reconstructionPose.planarTransform,
        reconstructionPose
      );
      planarTransform = this._updatePlanarTransform(
        useTrackedCurvedAttachmentTransform && trackerAnchorPosition
          ? this._selectTrackedAttachmentTransform({
            trackerAnchorPosition,
            reconstructionPose,
            useTrackedTransform: true
          })
          : useBlendedCurvedAttachmentTransform && trackerAnchorPosition
            ? this._selectBlendedCurvedAttachmentTransform({
              trackerAnchorPosition,
              reconstructionPose,
            })
          : selectedReconstructionTransform,
        timestamp
      );
      this._recordReconstructionPoseMetrics(reconstructionPose);
      logger.debugEvery('ImageAnchor', 'positioning-choice', 1000, `Using sparse reconstruction positioning: ${positionMethod}`);
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
      logger.debugEvery('ImageAnchor', 'positioning-choice', 1000, 'Using planar tracker attachment through transient planar pose loss');
    } else if (objectPoseUsableForTransform) {
      newPosition = this._filterPositionCandidate(objectPose.position, timestamp, objectPose.method);
      positionMethod = objectPose.method;
      planarTransform = this._updatePlanarTransform(objectPose.planarTransform, timestamp);
      this._recordObjectPoseMetrics(objectPose);
      logger.debugEvery('ImageAnchor', 'positioning-choice', 1000, `Using object pose positioning: ${positionMethod}`);
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
      logger.debugEvery('ImageAnchor', 'positioning-choice', 1000, `Using tracker anchor positioning: ${positionMethod}`);
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
        trusted: this._shouldTrustNormalPose(normalPose),
      });
      this.framesWithoutNormalPose = 0;
      this.lastNormalPoseSource = normalPose.method;
      this.metrics.poseConfidence = poseConfidence;
      this.metrics.poseSource = normalPose.method;
      this.metrics.poseInliers = normalPose.inlierCount;
      this.metrics.poseSourceHoldReason = null;
      this.metrics.poseRejectedReason = null;
      logger.debugEvery('ImageAnchor', 'surface-normal-update', 1000, `Updated stabilized surface normal from ${normalPose.method}`);
    } else if (poseResult?.success) {
      this.framesWithoutNormalPose++;
      this.metrics.rawPoseNormal = null;
      this.metrics.poseSource = null;
      this.metrics.poseRejectedReason = this.metrics.poseSourceHoldReason ||
        this._getPoseRejectionReason(poseResult, correspondences);
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

    const poseInliers = this.metrics.poseInliers || 0;
    const overallQuality = (this.metrics.trackingSuccessRate + Math.min(1.0, poseInliers / 30)) / 2;
    const prevState = this.anchorState;

    if (overallQuality >= 0.8 && poseInliers >= 25) {
      this.anchorState = 'stable';
    } else if (overallQuality >= 0.6 && poseInliers >= 15) {
      this.anchorState = 'tracking';
    } else if (overallQuality >= 0.4) {
      this.anchorState = 'tracking';
    } else {
      this.anchorState = 'degraded';
    }

    if (prevState !== this.anchorState) {
      logger.info('ImageAnchor', `Anchor state updated: ${prevState} -> ${this.anchorState} (quality: ${overallQuality.toFixed(2)})`);
    }

    // Periodic keypoint refresh grows the persistent landmark map while tracking is usable.
    this.framesSinceRefresh++;
    if (this._shouldRefreshKeypoints({ overallQuality, poseInliers })) {
      const adaptiveRefresh = ['object-support-recovery', 'mapping-growth'].includes(this.metrics.landmarkRefreshReason);
      this._refreshKeypoints(grayImage, {
        adaptive: adaptiveRefresh,
        minNewKeypoints: adaptiveRefresh ? CANDIDATE_MIN_TRACKABLE_POINTS : 15,
      });
      this.framesSinceRefresh = 0;
      logger.debug('ImageAnchor', 'Refreshed keypoints for landmark map growth');
    }
    this._storeRelocalizationKeyframe(grayImage, { overallQuality, poseInliers });

    logger.debugEvery('ImageAnchor', 'keypoint-tracking-success', 1000, 'Keypoint tracking successful:', {
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

  _createDegradedHoldResult(reason) {
    const activePointCount = this._activeTrackedPointCount();
    if (!this.currentPosition || activePointCount < 3) {
      return {
        success: false,
        reason,
        state: this.anchorState,
      };
    }

    return {
      success: true,
      reason,
      position: this.currentPosition,
      normal: this.currentNormal,
      planarTransform: this.currentPlanarTransform,
      confidence: Math.max(0.15, Math.min(0.45, this.metrics.trackingSuccessRate || 0.2)),
      method: 'held-degraded-object-pose',
      state: this.anchorState,
      recoverable: true,
    };
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
    const hasTrackableBootstrap = this._activeTrackedPointCount() >= CANDIDATE_MIN_TRACKABLE_POINTS;
    if (hasTrackableBootstrap) {
      trackingResult = this.keypointTracker.trackToFrame(this.cv, grayImage);
      if (trackingResult.success) {
        this._rejectTrackedPointsOutsideObjectSupport();
        const anchorPosition = this.keypointTracker.getAnchorPosition(this.cv);
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
    } else if (keypointResult.keypoints.length > 0) {
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
      backgroundRejected: keypointResult.rejectedByMask || 0,
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
  _refreshKeypoints(grayImage, { adaptive = false, minNewKeypoints = 15 } = {}) {
    if (!this.currentPosition) return;

    const refreshResult = this.keypointTracker.refreshKeypoints(
      this.cv,
      grayImage,
      this.keypointDetector,
      this._getAnchoredTrackingRegion(grayImage, { allowExpansion: this._shouldUseExpandedTrackingRegion() }),
      this._getCurrentObjectSupportMask(),
      {
        adaptive,
        minNewKeypoints,
      }
    );

    if (refreshResult) {
      this._recordLandmarkMetrics();
      const refreshStats = this.keypointTracker.lastRefreshStats;
      if (refreshStats) {
        this.metrics.landmarkRefreshAdded = refreshStats.added;
        this.metrics.landmarkRefreshTotal = refreshStats.total;
        this.metrics.landmarkRefreshRejectedByMask = refreshStats.rejectedByMask || 0;
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
    this.metrics.landmarkRefreshReason = null;

    if (this.anchorState === 'mapping') {
      const activeCount = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
      const shouldRefresh = this.framesSinceRefresh >= CANDIDATE_REFRESH_INTERVAL && activeCount < 32;
      if (shouldRefresh) {
        this.metrics.landmarkRefreshReason = 'mapping-growth';
      }
      return shouldRefresh;
    }

    const geometrySupportsMapGrowth = poseInliers >= 8;
    const needsOcclusionSupport = geometrySupportsMapGrowth &&
      this.metrics.trackingSuccessRate >= 0.6 &&
      this.metrics.keypointCount >= 8 &&
      this.metrics.keypointCount < 18;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks ?? this.metrics.keypointCount;
    const objectOwnedRatio = objectOwnedLandmarks / Math.max(1, this.metrics.keypointCount);
    const matureReconstructionReady = this.metrics.reconstructionReady === true &&
      (this.metrics.reconstructionMapConfidence ?? 0) >= 0.55 &&
      (this.metrics.reconstructionMatureLandmarks ?? 0) >= 16;
    const needsObjectSupportRecovery = this.objectSupportMask &&
      !matureReconstructionReady &&
      poseInliers < 8 &&
      this.metrics.trackingSuccessRate >= 0.6 &&
      this.metrics.keypointCount >= 8 &&
      this.metrics.keypointCount < 12 &&
      objectOwnedLandmarks >= 6 &&
      objectOwnedRatio < 0.95 &&
      objectOwnedRatio >= 0.65;

    if (this.framesSinceRefresh < this.refreshInterval &&
        !needsOcclusionSupport &&
        !needsObjectSupportRecovery) {
      return false;
    }

    if (this.metrics.trackingSuccessRate < 0.55 || this.metrics.keypointCount < 12) {
      if (needsObjectSupportRecovery) {
        this.metrics.landmarkRefreshReason = 'object-support-recovery';
        return true;
      }
      if (needsOcclusionSupport) {
        this.metrics.landmarkRefreshReason = 'occlusion-support';
      }
      return needsOcclusionSupport;
    }

    if (!['tracking', 'stable', 'degraded', 'mapping'].includes(this.anchorState)) {
      return false;
    }

    const landmarkCount = this.metrics.landmarkCount || this.metrics.keypointCount;
    const mapNeedsExpansion = landmarkCount < 70;
    const poseNeedsSupport = geometrySupportsMapGrowth && poseInliers < 24;
    const trackingIsUseful = overallQuality >= 0.5 || this.anchorState === 'stable';

    const shouldRefresh = needsObjectSupportRecovery ||
      needsOcclusionSupport ||
      (geometrySupportsMapGrowth && trackingIsUseful && (mapNeedsExpansion || poseNeedsSupport || this.anchorState === 'stable'));
    if (shouldRefresh) {
      this.metrics.landmarkRefreshReason = needsObjectSupportRecovery
        ? 'object-support-recovery'
        : needsOcclusionSupport ? 'occlusion-support' : 'map-growth';
    }
    return shouldRefresh;
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
    const qualityStats = this.keypointTracker.getLandmarkQualityStats();

    this.metrics.landmarkCount = points.length;
    this.metrics.activeLandmarkCount = activePoints.length;
    this.metrics.activeLandmarks = this.metrics.activeLandmarkCount;
    this.metrics.inactiveLandmarkCount = Math.max(0, this.metrics.landmarkCount - this.metrics.activeLandmarkCount);
    this.metrics.inactiveLandmarks = this.metrics.inactiveLandmarkCount;
    this.metrics.objectOwnedLandmarks = objectOwnedLandmarks;
    this.metrics.averageLandmarkQuality = qualityStats?.average ?? 0;
    this.metrics.highQualityLandmarks = qualityStats?.highQuality ?? 0;
    this.metrics.poseEligibleLandmarks = qualityStats?.poseEligible ?? 0;
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
        point.objectOwned = true;
        this.keypointTracker.updateLandmarkQuality(point);
        continue;
      }

      point.outsideObjectFrames = (point.outsideObjectFrames || 0) + 1;
      if (point.objectOwned !== false) {
        point.objectOwned = false;
        this.keypointTracker.updateLandmarkQuality(point);
        rejected++;
      }

      const landmarkQuality = this.keypointTracker.getLandmarkQuality(point);
      if (point.outsideObjectFrames >= 2 || landmarkQuality < 0.52) {
        point.status = 'outlier';
      }
    }

    return rejected;
  }

  /**
   * Attempt to reinitialize keypoint tracking after recovery
   */
  _reinitializeKeypoints(grayImage) {
    if (!this.currentPosition) return;

    try {
      const keypointResult = this.keypointDetector.extractKeypoints(
        this.cv,
        grayImage,
        this._getAnchoredTrackingRegion(grayImage, { allowExpansion: this._shouldUseExpandedTrackingRegion() }),
        this._getCurrentObjectSupportMask()
      );

      if (keypointResult.keypoints.length >= 15) {
        this.keypointTracker.initializeTracking(this.cv, keypointResult.keypoints, grayImage, this.currentPosition);
        this.anchorState = 'tracking';
        logger.info('ImageAnchor', 'Keypoint tracking reinitialized after recovery');
      }
    } catch (error) {
      this.metrics.lastFailureReason = `Keypoint reinitialization failed: ${error.message}`;
      this.metrics.lastFailureStage = 'keypoint-reinitialization';
      logger.error('ImageAnchor', 'Keypoint reinitialization failed:', error);
      throw error;
    }
  }

  /**
   * Calculate template region from tap position and object support.
   */
  _calculateTemplateRegion(tapPosition, boundingBox, imageWidth, imageHeight) {
    if (!boundingBox?.objectSupportMask) {
      return calculateTapLocalTemplateRegion(tapPosition, imageWidth, imageHeight);
    }

    if (!this._isTapLocalObjectSupportMask(boundingBox.objectSupportMask)) {
      return calculateTemplateRegion(
        tapPosition,
        this._createObjectSupportBoundingBox(boundingBox.objectSupportMask),
        imageWidth,
        imageHeight
      );
    }

    return calculateTapLocalTemplateRegion(tapPosition, imageWidth, imageHeight);
  }

  _isTapLocalObjectSupportMask(objectSupportMask) {
    const maxTapLocalDiameter = calculateTapLocalRadius(objectSupportMask) * 2.4;
    return objectSupportMask.bbox.width <= maxTapLocalDiameter &&
      objectSupportMask.bbox.height <= maxTapLocalDiameter;
  }

  _createObjectSupportBoundingBox(objectSupportMask) {
    return {
      x1: objectSupportMask.bbox.x,
      y1: objectSupportMask.bbox.y,
      x2: objectSupportMask.bbox.x + objectSupportMask.bbox.width,
      y2: objectSupportMask.bbox.y + objectSupportMask.bbox.height,
    };
  }

  _extractTargetClass(detection) {
    return detection?.class || detection?.label || detection?.name || null;
  }

  _selectObjectSupportMask(detection, tapPosition, imageWidth, imageHeight) {
    if (detection?.objectSupportMask) {
      return detection.objectSupportMask;
    }

    return createTapLocalObjectSupportMask({
      width: imageWidth,
      height: imageHeight,
      referencePoint: tapPosition,
      createdAtFrame: this.frameIndex,
    });
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
    this.metrics.currentObjectSupportMaskPreview = createObjectSupportMaskPreview(this.currentObjectSupportMask);
    return this.currentObjectSupportMask;
  }

  _calculateTrackingRegion(boundingBox, imageWidth, imageHeight, templateRegion) {
    const objectSupportMask = boundingBox?.objectSupportMask || null;
    const center = {
      x: templateRegion.x + templateRegion.width / 2,
      y: templateRegion.y + templateRegion.height / 2,
    };

    if (!objectSupportMask) {
      return calculateTapLocalTemplateRegion(center, imageWidth, imageHeight, { scale: 1.5 });
    }

    const tapLocalSupport = objectSupportMask && this._isTapLocalObjectSupportMask(objectSupportMask);
    const regionBoundingBox = !tapLocalSupport
      ? this._createObjectSupportBoundingBox(objectSupportMask)
      : boundingBox;

    if (!tapLocalSupport) {
      if (!regionBoundingBox ||
          !Number.isFinite(regionBoundingBox.x1) ||
          !Number.isFinite(regionBoundingBox.y1) ||
          !Number.isFinite(regionBoundingBox.x2) ||
          !Number.isFinite(regionBoundingBox.y2)) {
        return { ...templateRegion };
      }

      const templateArea = templateRegion.width * templateRegion.height;
      const detectionWidth = Math.max(1, regionBoundingBox.x2 - regionBoundingBox.x1);
      const detectionHeight = Math.max(1, regionBoundingBox.y2 - regionBoundingBox.y1);
      const detectionArea = detectionWidth * detectionHeight;
      const padding = Math.max(8, Math.min(24, Math.max(templateRegion.width, templateRegion.height) * 0.12));
      const objectRegion = this._clampTemplateRegion({
        x: Math.min(regionBoundingBox.x1, templateRegion.x) - padding,
        y: Math.min(regionBoundingBox.y1, templateRegion.y) - padding,
        width: Math.max(regionBoundingBox.x2, templateRegion.x + templateRegion.width) -
          Math.min(regionBoundingBox.x1, templateRegion.x) + padding * 2,
        height: Math.max(regionBoundingBox.y2, templateRegion.y + templateRegion.height) -
          Math.min(regionBoundingBox.y1, templateRegion.y) + padding * 2,
      }, imageWidth, imageHeight);

      if (detectionArea < templateArea * 1.2) {
        return { ...templateRegion };
      }

      return objectRegion;
    }

    return calculateTapLocalTemplateRegion(center, imageWidth, imageHeight, { scale: 1.5 });
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

  _shouldUseExpandedTrackingRegion() {
    return this.expandedObjectSupportRegion;
  }

  _getAnchoredTrackingRegion(grayImage, { allowExpansion = true } = {}) {
    const sourceRegion = allowExpansion
      ? this.trackingRegion || this.templateRegion
      : this.templateRegion;
    const center = this._getTemplateCenterFromAnchorPosition();
    return this._clampTemplateRegion({
      x: center.x - sourceRegion.width / 2,
      y: center.y - sourceRegion.height / 2,
      width: sourceRegion.width,
      height: sourceRegion.height,
    }, grayImage.cols, grayImage.rows);
  }

  _calculateObjectSupportTrackingRegion(objectSupportMask, fallbackRegion) {
    const fallbackCenter = this.currentPosition ||
      objectSupportMask.referencePoint || {
        x: objectSupportMask.bbox.x + objectSupportMask.bbox.width / 2,
        y: objectSupportMask.bbox.y + objectSupportMask.bbox.height / 2,
      };
    const fallback = fallbackRegion
      ? this._clampTemplateRegion({
          x: fallbackRegion.x ?? fallbackCenter.x - fallbackRegion.width / 2,
          y: fallbackRegion.y ?? fallbackCenter.y - fallbackRegion.height / 2,
          width: fallbackRegion.width,
          height: fallbackRegion.height,
        }, objectSupportMask.width, objectSupportMask.height)
      : null;
    const padding = clamp(
      Math.max(objectSupportMask.bbox.width, objectSupportMask.bbox.height) * OBJECT_SUPPORT_TRACKING_PADDING_RATIO,
      OBJECT_SUPPORT_TRACKING_MIN_PADDING,
      OBJECT_SUPPORT_TRACKING_MAX_PADDING
    );
    const minX = fallback ? Math.min(objectSupportMask.bbox.x, fallback.x) : objectSupportMask.bbox.x;
    const minY = fallback ? Math.min(objectSupportMask.bbox.y, fallback.y) : objectSupportMask.bbox.y;
    const maxX = fallback
      ? Math.max(objectSupportMask.bbox.x + objectSupportMask.bbox.width, fallback.x + fallback.width)
      : objectSupportMask.bbox.x + objectSupportMask.bbox.width;
    const maxY = fallback
      ? Math.max(objectSupportMask.bbox.y + objectSupportMask.bbox.height, fallback.y + fallback.height)
      : objectSupportMask.bbox.y + objectSupportMask.bbox.height;
    const expanded = this._clampTemplateRegion({
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    }, objectSupportMask.width, objectSupportMask.height);

    if (!fallback) {
      return expanded;
    }

    return expanded.width * expanded.height >= fallback.width * fallback.height
      ? expanded
      : fallback;
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

    const reconstructionUsable = this._isUsablePoseResult(reconstructionPose, reconstructionPose?.correspondences || correspondences);
    const reconstructionHasRealDepth = reconstructionUsable && this._hasStrongNonPlanarReconstruction(reconstructionPose);
    const planarStrong = this._hasStrongPlanarAttachmentPose(planarPose, correspondences);
    const planarAttachmentUsable = planarStrong ||
      (this._hasPlanarTargetClass() && this._hasPlanarAttachmentPose(planarPose, correspondences));

    if (this._hasRigidPlanarTargetClass()) {
      return planarAttachmentUsable;
    }

    if (this._hasSelectedReconstructionPose(reconstructionPose)) {
      return false;
    }

    if (reconstructionHasRealDepth) {
      return false;
    }

    if (this._hasPlanarDominance() && !reconstructionHasRealDepth) {
      return planarAttachmentUsable;
    }

    if (!reconstructionUsable) {
      return planarAttachmentUsable;
    }

    if (planarAttachmentUsable && !reconstructionHasRealDepth) {
      return true;
    }

    return planarAttachmentUsable &&
      planarPose.inlierCount >= reconstructionPose.inlierCount + 6 &&
      planarPose.confidence >= reconstructionPose.confidence - 0.08;
  }

  _hasPlanarAttachmentPose(planarPose, correspondences) {
    if (!planarPose?.success) {
      return false;
    }

    const spread = planarPose.referenceSpread || this._measureReferenceSpread(correspondences);
    const inlierRatio = planarPose.inlierRatio ?? planarPose.inlierCount / Math.max(1, correspondences.length);
    const averageResidual = planarPose.averageResidual ?? Infinity;

    return planarPose.inlierCount >= 10 &&
      inlierRatio >= 0.46 &&
      (planarPose.confidence ?? 0) >= 0.34 &&
      averageResidual <= 3.25 &&
      spread.minAxis >= 18;
  }

  _hasStrongPlanarAttachmentPose(planarPose, correspondences) {
    if (!planarPose?.success) {
      return false;
    }

    const spread = planarPose.referenceSpread || this._measureReferenceSpread(correspondences);
    const inlierRatio = planarPose.inlierRatio ?? planarPose.inlierCount / Math.max(1, correspondences.length);
    const averageResidual = planarPose.averageResidual ?? Infinity;

    return planarPose.inlierCount >= MIN_PLANAR_ATTACHMENT_POSE_INLIERS &&
      inlierRatio >= 0.5 &&
      (planarPose.confidence ?? 0) >= 0.42 &&
      averageResidual <= 2.2 &&
      spread.minAxis >= 18;
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

    return this._hasStrongPlanarAttachmentPose(planarPose, correspondences) &&
      planarResidual <= Math.max(4.5, reconstructionResidual + 1.5) &&
      planarConfidence >= reconstructionConfidence - 0.22;
  }

  _selectNormalPose({ reconstructionPose, planarPose, objectPose, poseResult, correspondences, reconstructionConsistentWithTracker }) {
    const rejectPlanarNormalForCurvedTarget = this._shouldRejectPlanarNormalForCurvedTarget(reconstructionPose);

    if (this._shouldExposeSelectedPlanarSurfacePose({ reconstructionPose, planarPose })) {
      return { ...reconstructionPose, correspondences: reconstructionPose.correspondences || correspondences };
    }

    if (!rejectPlanarNormalForCurvedTarget &&
        this._shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences })) {
      return this._selectPlanarNormalCandidate({
        candidatePose: { ...planarPose, correspondences },
        reconstructionPose,
      });
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
      return this._selectPlanarNormalCandidate({
        candidatePose: { ...poseResult, correspondences },
        reconstructionPose,
      });
    }

    if (objectPoseUsable) {
      return { ...objectPose, correspondences };
    }

    if (correspondencePoseUsable) {
      return this._selectPlanarNormalCandidate({
        candidatePose: { ...poseResult, correspondences },
        reconstructionPose,
      });
    }

    return null;
  }

  _selectPlanarNormalCandidate({ candidatePose, reconstructionPose }) {
    if (this._shouldHoldPlanarNormalAfterReconstructionDropout({ candidatePose, reconstructionPose })) {
      this.metrics.poseSourceHoldReason = 'transient-reconstruction-dropout';
      return null;
    }

    return candidatePose;
  }

  _shouldExposeSelectedPlanarSurfacePose({ reconstructionPose, planarPose }) {
    if (!this._hasRigidPlanarTargetClass() ||
        this.trackingMode === RECONSTRUCTION_POSE_MODEL ||
        !this._hasSelectedReconstructionPose(reconstructionPose)) {
      return false;
    }

    return (reconstructionPose.inlierCount || 0) >= 12 &&
      (reconstructionPose.averageResidual ?? Infinity) <= 4.8 &&
      (planarPose?.inlierCount || 0) < 14;
  }

  _shouldTrustNormalPose(normalPose) {
    if (!normalPose?.success || !isReconstructionMode(normalPose.method)) {
      return false;
    }

    if (this._hasRigidPlanarTargetClass()) {
      return false;
    }

    return this._hasStrongNonPlanarReconstruction(normalPose) ||
      this._hasSelectedReconstructionPose(normalPose);
  }

  _shouldHoldPlanarNormalAfterReconstructionDropout({ candidatePose, reconstructionPose }) {
    if (!isReconstructionMode(this.trackingMode) || this._hasPlanarTargetClass()) {
      return false;
    }

    if (this.lastNormalPoseSource !== this.trackingMode || this.framesWithoutNormalPose > 1) {
      return false;
    }

    if (!this._isPlanarNormalCandidate(candidatePose) || reconstructionPose?.success) {
      return false;
    }

    const mapConfidence = this.metrics.reconstructionMapConfidence ?? 0;
    const matureLandmarks = this.metrics.reconstructionMatureLandmarks ?? 0;
    const matureReconstruction = this.metrics.reconstructionReady === true ||
      (mapConfidence >= 0.58 && matureLandmarks >= 16);
    if (!matureReconstruction) {
      return false;
    }

    const overwhelmingPlanarEvidence = (candidatePose.inlierCount || 0) >= 30 &&
      (candidatePose.inlierRatio ?? 0) >= 0.82 &&
      (candidatePose.confidence ?? 0) >= 0.9 &&
      (candidatePose.averageResidual ?? Infinity) <= 1.2;

    return !overwhelmingPlanarEvidence;
  }

  _isPlanarNormalCandidate(pose) {
    return pose?.success &&
      (pose.method === 'homography' || pose.method === 'planar-homography');
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

  _selectTrackerAnchorPosition({ trackerAnchorPosition, reconstructionPose }) {
    this.metrics.trackerAnchorAdjustment = null;
    if (this._shouldUseObjectOwnedCentroidPosition({ trackerAnchorPosition, reconstructionPose })) {
      const centroidPosition = this.keypointTracker.getCentroidAnchorPosition(this._objectOwnedActivePoints());

      if (centroidPosition) {
        this.metrics.trackerAnchorAdjustment = 'object-owned-centroid-position';
        this.metrics.trackerAnchorRawResidual = trackerAnchorPosition.averageResidual ?? null;

        return {
          ...trackerAnchorPosition,
          x: centroidPosition.x,
          y: centroidPosition.y,
          confidence: Math.min(
            trackerAnchorPosition.confidence ?? centroidPosition.confidence ?? 0,
            centroidPosition.confidence ?? trackerAnchorPosition.confidence ?? 0
          ),
          inlierCount: centroidPosition.inlierCount ?? trackerAnchorPosition.inlierCount,
          method: 'object-owned-centroid-position',
          transformMethod: trackerAnchorPosition.method,
        };
      }
    }

    if (!this._shouldUseCurvedDropoutCentroidPosition({ trackerAnchorPosition, reconstructionPose })) {
      if (this._shouldUseMatureReconstructionDropoutCentroid({ trackerAnchorPosition, reconstructionPose })) {
        const centroidPosition = this.keypointTracker.getCentroidAnchorPosition(this._objectOwnedActivePoints());

        if (centroidPosition) {
          this.metrics.trackerAnchorAdjustment = 'mature-reconstruction-dropout-centroid';
          this.metrics.trackerAnchorRawResidual = trackerAnchorPosition.averageResidual ?? null;

          return {
            ...trackerAnchorPosition,
            x: centroidPosition.x,
            y: centroidPosition.y,
            confidence: Math.min(
              trackerAnchorPosition.confidence ?? centroidPosition.confidence ?? 0,
              centroidPosition.confidence ?? trackerAnchorPosition.confidence ?? 0
            ),
            inlierCount: centroidPosition.inlierCount ?? trackerAnchorPosition.inlierCount,
            method: 'object-owned-centroid-position',
            transformMethod: trackerAnchorPosition.method,
          };
        }
      }
      return trackerAnchorPosition;
    }

    const centroidPosition = this.keypointTracker.getCentroidAnchorPosition(this._objectOwnedActivePoints());

    if (!centroidPosition) {
      return trackerAnchorPosition;
    }

    this.metrics.trackerAnchorAdjustment = 'curved-dropout-centroid-position';
    this.metrics.trackerAnchorRawResidual = trackerAnchorPosition.averageResidual ?? null;

    return {
      ...trackerAnchorPosition,
      x: centroidPosition.x,
      y: centroidPosition.y,
      confidence: Math.min(
        trackerAnchorPosition.confidence ?? centroidPosition.confidence ?? 0,
        centroidPosition.confidence ?? trackerAnchorPosition.confidence ?? 0
      ),
      inlierCount: centroidPosition.inlierCount ?? trackerAnchorPosition.inlierCount,
      method: 'curved-centroid-position',
      transformMethod: trackerAnchorPosition.method,
    };
  }

  _objectOwnedActivePoints() {
    const activePoints = (this.keypointTracker.trackedPoints || [])
      .filter(point => point.status === 'active');
    if (!this.objectSupportMask) {
      return activePoints;
    }

    return activePoints.filter(point => point.objectOwned !== false);
  }

  _shouldUseObjectOwnedCentroidPosition({ trackerAnchorPosition, reconstructionPose }) {
    const reconstructionUsable = this._isUsablePoseResult(
      reconstructionPose,
      reconstructionPose?.correspondences || []
    );
    if (!trackerAnchorPosition ||
        reconstructionUsable ||
        !this.objectSupportMask ||
        trackerAnchorPosition.method !== 'reference_similarity_transform') {
      return false;
    }

    const activeLandmarks = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks || 0;
    const residual = trackerAnchorPosition.averageResidual ?? 0;
    const confidence = trackerAnchorPosition.confidence ?? 0;
    const ownedRatio = objectOwnedLandmarks / Math.max(1, activeLandmarks);
    const targetClass = this.anchorTargetClass || '';
    const planarSurfaceModel = this.metrics.reconstructionPreview?.surface?.model === 'plane';
    const taperedSurfaceModel = this.metrics.reconstructionPreview?.surface?.model === 'tapered-cylinder' ||
      this.reconstructor?.targetSurfaceModel === 'tapered-cylinder';
    const cupLikeCoherentTarget = /cup|vase/i.test(targetClass);
    const supportsCoherentCentroid = this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      ((!this._hasPlanarTargetClass() &&
      !planarSurfaceModel &&
      !this._hasCurvedReconstructionTarget()) ||
      cupLikeCoherentTarget ||
      (taperedSurfaceModel && !/mug/i.test(targetClass)));
    const coherentCentroidMaxConfidence = cupLikeCoherentTarget || taperedSurfaceModel ? 1 : 0.14;
    const sparseCoherentObjectCluster = supportsCoherentCentroid &&
      ownedRatio >= 0.9 &&
      activeLandmarks <= 32 &&
      confidence <= coherentCentroidMaxConfidence &&
      (
        (activeLandmarks <= 18 && residual >= 16) ||
        residual >= 28
      );
    const mixedObjectCluster = ownedRatio < 0.9 &&
      activeLandmarks < 18 &&
      confidence <= 0.12 &&
      residual >= 28;

    return activeLandmarks >= 8 &&
      objectOwnedLandmarks >= 7 &&
      (mixedObjectCluster || sparseCoherentObjectCluster);
  }

  _shouldUseCurvedDropoutCentroidPosition({ trackerAnchorPosition, reconstructionPose }) {
    if (!trackerAnchorPosition ||
        reconstructionPose?.success ||
        this.trackingMode !== RECONSTRUCTION_POSE_MODEL ||
        !isReconstructionMode(this.trackingMode) ||
        !this._hasCurvedReconstructionTarget(reconstructionPose)) {
      return false;
    }

    const matureCurvedMap = this.metrics.reconstructionReady === true &&
      (this.metrics.reconstructionMapConfidence ?? 0) >= 0.65 &&
      (this.metrics.reconstructionMatureLandmarks ?? 0) >= 16;
    if (!matureCurvedMap) {
      return false;
    }

    const residual = trackerAnchorPosition.averageResidual ?? Infinity;
    const confidence = trackerAnchorPosition.confidence ?? 0;
    const activeLandmarks = this.metrics.activeLandmarks || this._activeTrackedPointCount();

    return trackerAnchorPosition.method === 'reference_similarity_transform' &&
      residual >= 18 &&
      confidence <= 0.12 &&
      activeLandmarks >= 32;
  }

  _shouldUseMatureReconstructionDropoutCentroid({ trackerAnchorPosition, reconstructionPose }) {
    if (!trackerAnchorPosition ||
        trackerAnchorPosition.method !== 'reference_similarity_transform' ||
        reconstructionPose?.success ||
        this.trackingMode !== RECONSTRUCTION_POSE_MODEL ||
        !isReconstructionMode(this.trackingMode) ||
        !this._hasPlanarTargetClass() ||
        !this.currentPosition ||
        !this.objectSupportMask) {
      return false;
    }

    const mapConfidence = this.metrics.reconstructionMapConfidence ?? 0;
    const matureLandmarks = this.metrics.reconstructionMatureLandmarks ?? 0;
    const activeLandmarks = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks ?? activeLandmarks;
    const ownedRatio = objectOwnedLandmarks / Math.max(1, activeLandmarks);
    const residual = trackerAnchorPosition.averageResidual ?? 0;

    return this.metrics.reconstructionReady === true &&
      mapConfidence >= 0.62 &&
      matureLandmarks >= 16 &&
      activeLandmarks >= 8 &&
      activeLandmarks <= 18 &&
      residual >= 18 &&
      ownedRatio >= 0.65;
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

  _selectBlendedCurvedAttachmentTransform({ trackerAnchorPosition, reconstructionPose }) {
    const selectedScale = reconstructionPose.planarTransform.scale;
    const trackerScale = trackerAnchorPosition.scale;
    return {
      ...reconstructionPose.planarTransform,
      scale: Math.sqrt(selectedScale * trackerScale),
      rotation: trackerAnchorPosition.rotation,
      confidence: Math.min(
        reconstructionPose.planarTransform.confidence ?? reconstructionPose.confidence ?? 0,
        trackerAnchorPosition.confidence ?? 0
      ),
      inlierCount: Math.min(
        reconstructionPose.planarTransform.inlierCount ?? reconstructionPose.inlierCount ?? 0,
        trackerAnchorPosition.inlierCount ?? 0
      ),
      method: 'curved-tracker-scale-blend',
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

    if (this._hasPreciseCurvedReconstructionPosition(reconstructionPose)) {
      return false;
    }

    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    const trackerDelta = this.metrics.reconstructionTrackerDelta || 0;
    const mapConfidence = reconstructionPose.preview?.statistics?.mapConfidence ??
      this.metrics.reconstructionMapConfidence ??
      reconstructionPose.confidence ??
      0;
    const inliers = reconstructionPose.inlierCount || 0;
    const averageResidual = reconstructionPose.averageResidual ?? Infinity;
    const moderateTrackerDivergence = trackerDelta >= clamp(templateSize * 0.1, 10, 18);
    const severeTrackerDivergence = trackerDelta >= clamp(templateSize * 0.28, 32, 48);
    const matureCurvedRecovery = moderateTrackerDivergence &&
      mapConfidence >= 0.72 &&
      inliers >= 18 &&
      averageResidual <= 10.5;

    return matureCurvedRecovery ||
      (severeTrackerDivergence &&
        inliers >= 16 &&
        averageResidual <= 10);
  }

  _hasModerateCurvedReconstructionRecovery({ reconstructionPose, trackerAnchorPosition }) {
    if (!reconstructionPose?.success ||
        this._hasPlanarTargetClass() ||
        !this._hasCurvedReconstructionTarget(reconstructionPose) ||
        reconstructionPose.method !== this.trackingMode ||
        !trackerAnchorPosition) {
      return false;
    }

    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    const trackerDelta = this.metrics.reconstructionTrackerDelta || 0;
    const trackerResidual = trackerAnchorPosition.averageResidual ?? 0;
    const trackerConfidence = trackerAnchorPosition.confidence ?? 0;
    const mapConfidence = reconstructionPose.preview?.statistics?.mapConfidence ??
      this.metrics.reconstructionMapConfidence ??
      reconstructionPose.confidence ??
      0;
    const matureLandmarks = this.metrics.reconstructionMatureLandmarks || 0;
    const poseResidual = reconstructionPose.averageResidual ?? Infinity;
    const poseInliers = reconstructionPose.inlierCount || 0;
    const trackerIncoherent = trackerResidual >= 12 || trackerConfidence <= 0.18;
    const trackerDiverged = trackerDelta >= clamp(templateSize * 0.08, 8, 16);

    return this.metrics.reconstructionReady === true &&
      mapConfidence >= 0.72 &&
      matureLandmarks >= 16 &&
      poseInliers >= 10 &&
      poseResidual <= 3.6 &&
      trackerIncoherent &&
      trackerDiverged;
  }

  _shouldUseTrackedCurvedAttachmentTransform({ reconstructionPose, trackerAnchorPosition }) {
    return !!trackerAnchorPosition &&
      this._hasCurvedReconstructionTarget(reconstructionPose) &&
      reconstructionPose?.success &&
      reconstructionPose.method === this.trackingMode &&
      reconstructionPose.planarTransform?.method === 'reference_similarity_transform';
  }

  _shouldBlendTrackerScaleForSelectedCurvedTransform({ reconstructionPose, trackerAnchorPosition }) {
    if (!trackerAnchorPosition ||
        !this._hasCurvedReconstructionTarget(reconstructionPose) ||
        reconstructionPose?.method !== this.trackingMode ||
        !reconstructionPose?.planarTransform ||
        reconstructionPose.planarTransform.method === 'reference_similarity_transform') {
      return false;
    }

    const selectedScale = reconstructionPose.planarTransform.scale;
    const trackerScale = trackerAnchorPosition.scale;
    if (!Number.isFinite(selectedScale) || !Number.isFinite(trackerScale) || trackerScale <= 0) {
      return false;
    }

    const trackerConfidence = trackerAnchorPosition.confidence ?? 0;
    const trackerResidual = trackerAnchorPosition.averageResidual ?? Infinity;
    const scaleRatio = selectedScale / trackerScale;

    return trackerConfidence >= 0.45 &&
      trackerResidual <= 8 &&
      (scaleRatio >= 1.28 || scaleRatio <= 0.78);
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

  _hasRigidPlanarTargetClass() {
    return RIGID_PLANAR_TARGET_CLASS_PATTERN.test(this.anchorTargetClass || '');
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

    const measuredScale = typeof anchorPosition.scale === 'number' ? anchorPosition.scale : previous.scale;
    const surfaceModel = this.metrics.reconstructionPreview?.surface?.model || '';
    const rawScale = anchorPosition.method === 'reference_similarity_transform' &&
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      surfaceModel === 'cylinder'
      ? measuredScale * 1.015
      : anchorPosition.method === RECONSTRUCTION_POSE_MODEL &&
      (/can|bottle|jar|container/i.test(this.anchorTargetClass || '') || surfaceModel === 'cylinder') &&
      (this.currentNormal?.z ?? 1) > 0.9
      ? measuredScale * 1.03
      : measuredScale;
    let boundedScale = this.currentPlanarTransform
      ? clamp(rawScale, previous.scale * Math.exp(-SCALE_STEP_LOG_LIMIT), previous.scale * Math.exp(SCALE_STEP_LOG_LIMIT))
      : rawScale;
    const shouldHoldSparseMugScaleShrink = anchorPosition.method === 'reference_similarity_transform' &&
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      /mug/i.test(this.anchorTargetClass || '');
    if (this.currentPlanarTransform && shouldHoldSparseMugScaleShrink) {
      boundedScale = Math.max(boundedScale, previous.scale * 0.985);
    }
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
    if (this._shouldUseCurvedMotionPrediction(position, method)) {
      const predicted = this._predictCurvedMotionPosition(timestamp);
      if (predicted) {
        this.metrics.positionFilterAdjustment = 'curved-motion-hold';
        return this._limitPositionStep({
          ...predicted,
          confidence: Math.min(position.confidence ?? 0, predicted.confidence),
          averageResidual: position.averageResidual,
        }, method);
      }
    }

    if (this._shouldUseHighConfidenceTrackerStepPosition(position, method)) {
      this.metrics.positionFilterAdjustment = 'high-confidence-tracker-step-position';
      return this._limitPositionStep({
        x: position.x,
        y: position.y,
        z: position.z ?? 0,
        confidence: position.confidence,
        averageResidual: position.averageResidual,
      }, method);
    }

    const filtered = {
      x: this.positionFilterX.filter(position.x, timestamp),
      y: this.positionFilterY.filter(position.y, timestamp),
      z: 0
    };

    let adjustment = null;
    let adjusted = filtered;

    if (this._shouldUseStepOnlyBookPosition()) {
      adjusted = {
        x: position.x,
        y: position.y,
        z: 0,
      };
      adjustment = 'book-step-position';
    } else if (this._shouldUsePostHoldReferenceRecoveryStep(position, method)) {
      adjusted = {
        x: position.x,
        y: position.y,
        z: 0,
        confidence: position.confidence,
        averageResidual: position.averageResidual,
      };
      adjustment = 'post-hold-reference-recovery-step';
    } else if (this._shouldUseMatureCurvedRecoveryStep(method)) {
      adjusted = {
        x: position.x,
        y: position.y,
        z: 0,
      };
      adjustment = 'curved-recovery-step-position';
    } else if (this._shouldBlendPlanarPosePosition(method)) {
      adjusted = {
        x: filtered.x + (position.x - filtered.x) * PLANAR_POSE_POSITION_BLEND,
        y: filtered.y + (position.y - filtered.y) * PLANAR_POSE_POSITION_BLEND,
        z: 0,
      };
      adjustment = 'planar-pose-blend';
    }

    this.metrics.positionFilterAdjustment = adjustment;

    return this._limitPositionStep(adjusted, method);
  }

  _shouldUseHighConfidenceTrackerStepPosition(position, method) {
    return method === 'reference_similarity_transform' &&
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL &&
      (position.confidence ?? 0) >= MIN_LOW_LAG_TRACKER_CONFIDENCE &&
      (position.averageResidual ?? Infinity) <= MAX_LOW_LAG_TRACKER_RESIDUAL;
  }

  _shouldUseCurvedMotionPrediction(position, method) {
    if (method !== 'reference_similarity_transform' ||
        !this.curvedMotionSample ||
        !this._hasCurvedReconstructionTarget() ||
        this.trackingMode === RECONSTRUCTION_POSE_MODEL ||
        this.metrics.reconstructionReady !== true) {
      return false;
    }

    const activeLandmarks = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
    const matureLandmarks = this.metrics.reconstructionMatureLandmarks || 0;
    const mapConfidence = this.metrics.reconstructionMapConfidence ?? 0;
    const confidence = position.confidence ?? 0;
    const residual = position.averageResidual ?? Infinity;

    return activeLandmarks <= 20 &&
      matureLandmarks >= 16 &&
      mapConfidence >= 0.6 &&
      (confidence <= 0.32 || residual >= 9);
  }

  _predictCurvedMotionPosition(timestamp) {
    const sample = this.curvedMotionSample;
    const elapsed = clamp(timestamp - sample.timestamp, 0, CURVED_DROPOUT_MAX_PREDICTION_MS);
    if (elapsed <= 0) {
      return {
        x: sample.position.x,
        y: sample.position.y,
        z: 0,
        confidence: sample.confidence,
      };
    }

    const predicted = {
      x: sample.position.x + sample.velocity.x * elapsed,
      y: sample.position.y + sample.velocity.y * elapsed,
      z: 0,
      confidence: sample.confidence * clamp(1 - elapsed / CURVED_DROPOUT_MAX_PREDICTION_MS, 0.35, 1),
    };

    if (!this.currentPosition) {
      return predicted;
    }

    const dx = predicted.x - this.currentPosition.x;
    const dy = predicted.y - this.currentPosition.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= CURVED_DROPOUT_MAX_STEP || distance === 0) {
      return predicted;
    }

    const scale = CURVED_DROPOUT_MAX_STEP / distance;
    return {
      ...predicted,
      x: this.currentPosition.x + dx * scale,
      y: this.currentPosition.y + dy * scale,
    };
  }

  _shouldUseStepOnlyBookPosition() {
    return /book/i.test(this.anchorTargetClass || '') && this._hasRigidPlanarTargetClass();
  }

  _shouldBlendPlanarPosePosition(method) {
    return this._hasPlanarTargetClass() &&
      this._hasPlanarDominance() &&
      PLANAR_POSE_POSITION_METHODS.has(method);
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
    let ratio = isReconstructionMode(this.trackingMode)
      ? 0.08
      : isReconstructionMode(method) ? 0.1 : 0.14;
    const postHoldReferenceRecovery = this._shouldUsePostHoldReferenceRecoveryStep(position, method);
    if (this._shouldUseMatureCurvedRecoveryStep(method)) {
      ratio = 0.12;
    } else if (postHoldReferenceRecovery) {
      ratio = 0.16;
    }
    if (this._hasRigidPlanarTargetClass()) {
      ratio = /book/i.test(this.anchorTargetClass || '')
        ? RIGID_PLANAR_BOOK_POSITION_STEP_RATIO
        : RIGID_PLANAR_POSITION_STEP_RATIO;
    }
    const maxStep = postHoldReferenceRecovery
      ? clamp(templateSize * ratio, 12, 20)
      : isReconstructionMode(this.trackingMode)
        ? clamp(templateSize * ratio, 8, 12)
        : clamp(templateSize * ratio, 8, 24);

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

  _shouldUseMatureCurvedRecoveryStep(method) {
    return isReconstructionMode(method) &&
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL &&
      method === this.trackingMode &&
      this._hasCurvedReconstructionTarget() &&
      this.metrics.reconstructionReady === true &&
      (this.metrics.reconstructionMapConfidence ?? 0) >= 0.66 &&
      (this.metrics.reconstructionMatureLandmarks || 0) >= 16 &&
      (this.metrics.reconstructionTrackerDelta || 0) >= 8;
  }

  _shouldUsePostHoldReferenceRecoveryStep(position, method) {
    return method === 'reference_similarity_transform' &&
      isReconstructionMode(this.trackingMode) &&
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL &&
      this._hasCurvedReconstructionTarget() &&
      /held-(last-pose|degraded-object-pose)/.test(this.metrics.lastUpdateMethod || '') &&
      (position.confidence ?? 0) >= 0.55 &&
      (position.averageResidual ?? Infinity) <= 6;
  }

  _adjustSelectedCurvedPlanarTransform(planarTransform, reconstructionPose) {
    if (!planarTransform ||
        this.trackingMode === RECONSTRUCTION_POSE_MODEL ||
        reconstructionPose?.method !== this.trackingMode ||
        !this._hasCurvedReconstructionTarget(reconstructionPose)) {
      return planarTransform;
    }

    const normalZ = reconstructionPose.normal?.z ?? 1;
    const foreshortening = clamp(Math.sqrt(Math.max(normalZ, 0)), 0.74, 1);
    return {
      ...planarTransform,
      scale: planarTransform.scale * foreshortening,
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
    return this._getAnchoredTrackingRegion(grayImage);
  }

  _extractObjectKeypoints(grayImage, region, objectSupportMask, { minKeypoints }) {
    const primary = this._filterKeypointsToObjectSupport(
      this.keypointDetector.extractKeypoints(this.cv, grayImage, region, objectSupportMask),
      objectSupportMask
    );
    if (primary.keypoints.length >= minKeypoints || typeof this.keypointDetector.extractAdaptiveKeypoints !== 'function') {
      return primary;
    }

    const adaptive = this._filterKeypointsToObjectSupport(
      this.keypointDetector.extractAdaptiveKeypoints(this.cv, grayImage, region, objectSupportMask, {
        minKeypoints,
      }),
      objectSupportMask
    );

    return adaptive.keypoints.length > primary.keypoints.length ? adaptive : primary;
  }

  _filterKeypointsToObjectSupport(keypointResult, objectSupportMask) {
    if (!objectSupportMask) {
      return keypointResult;
    }

    const keypoints = keypointResult.keypoints.filter(keypoint => (
      isPointInsideObjectSupport(objectSupportMask, keypoint.pt || keypoint)
    ));
    const rejectedByMask = Math.max(0, keypointResult.keypoints.length - keypoints.length);

    return {
      ...keypointResult,
      keypoints,
      count: keypoints.length,
      rejectedByMask: (keypointResult.rejectedByMask || 0) + rejectedByMask,
    };
  }

  _createReadiness({
    state,
    poseSource,
    positionSource = null,
    reconstructionReady,
    poseInliers = null,
    poseConfidence = null,
    poseAverageResidual = null,
    poseForeshortening = null,
  }) {
    const reconstructionMode = isReconstructionMode(this.trackingMode);
    const selectionReady = state !== 'inactive' && state !== 'lost';
    const trackingReady = state === 'tracking' || state === 'stable';
    const strongPlanarPose = poseSource === 'planar-homography';
    const strongReconstructionPose = reconstructionReady &&
      isReconstructionMode(poseSource) &&
      poseSource === this.trackingMode;
    const posePathReady = reconstructionMode
      ? strongReconstructionPose || strongPlanarPose
      : poseSource !== null;
    const poseQualityReady = this._isAttachmentPoseQualityReady({
      poseSource,
      poseInliers,
      poseConfidence,
      poseAverageResidual,
      poseForeshortening,
    });
    const poseReady = trackingReady && posePathReady && poseQualityReady;
    const surfaceReady = reconstructionMode
      ? poseReady && (strongReconstructionPose || strongPlanarPose)
      : poseReady;
    const attachmentSourceReady = this._isAttachmentSourceReady({
      poseSource,
      positionSource,
      reconstructionMode,
      strongPlanarPose,
      strongReconstructionPose,
    });
    const objectOwnershipReady = this._isObjectOwnershipReady();
    const attachmentReady = trackingReady && poseReady && surfaceReady && attachmentSourceReady && objectOwnershipReady;
    const faceReady = attachmentReady;
    const poseRecovery = reconstructionMode &&
      reconstructionReady &&
      (!posePathReady || !poseQualityReady || !attachmentSourceReady);
    const reason = faceReady
      ? 'Face overlay is ready'
      : poseRecovery ? FACE_READINESS_REASON_POSE_RECOVERY : FACE_READINESS_REASON_RECONSTRUCTION;

    return {
      faceReady,
      selectionReady,
      trackingReady,
      poseReady,
      poseQualityReady,
      surfaceReady,
      attachmentSourceReady,
      objectOwnershipReady,
      attachmentReady,
      reason,
    };
  }

  _isObjectOwnershipReady() {
    const measuredActiveLandmarks = this.metrics.activeLandmarkCount ?? this.metrics.keypointCount;
    if (!this.objectSupportMask && !Number.isFinite(this.metrics.objectOwnedLandmarks)) {
      return true;
    }

    if (!Number.isFinite(measuredActiveLandmarks)) {
      return true;
    }

    const activeLandmarks = measuredActiveLandmarks;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks ?? activeLandmarks;
    if (activeLandmarks < 8) {
      return false;
    }

    return objectOwnedLandmarks / Math.max(1, activeLandmarks) >= 0.65;
  }

  _isAttachmentSourceReady({
    poseSource,
    positionSource,
    reconstructionMode,
    strongPlanarPose,
    strongReconstructionPose,
  }) {
    if (!reconstructionMode || positionSource === null) {
      return true;
    }

    if (strongPlanarPose) {
      return positionSource === 'planar-homography';
    }

    return strongReconstructionPose && positionSource === poseSource;
  }

  _isAttachmentPoseQualityReady({
    poseSource,
    poseInliers = null,
    poseConfidence = null,
    poseAverageResidual = null,
    poseForeshortening = null,
  }) {
    const qualityMeasured = Number.isFinite(poseInliers) ||
      Number.isFinite(poseConfidence) ||
      Number.isFinite(poseAverageResidual) ||
      Number.isFinite(poseForeshortening);
    if (!qualityMeasured) {
      return true;
    }

    const reconstructionPose = isReconstructionMode(poseSource) && poseSource === this.trackingMode;
    const planarPose = poseSource === 'planar-homography';
    const minInliers = reconstructionPose
      ? MIN_RECONSTRUCTION_ATTACHMENT_POSE_INLIERS
      : planarPose ? MIN_PLANAR_ATTACHMENT_POSE_INLIERS
      : MIN_ATTACHMENT_POSE_INLIERS;
    const minConfidence = reconstructionPose
      ? MIN_RECONSTRUCTION_ATTACHMENT_POSE_CONFIDENCE
      : MIN_ATTACHMENT_POSE_CONFIDENCE;
    const maxResidual = reconstructionPose
      ? MAX_RECONSTRUCTION_ATTACHMENT_POSE_RESIDUAL
      : planarPose ? MAX_PLANAR_ATTACHMENT_POSE_RESIDUAL : MAX_OBJECT_ATTACHMENT_POSE_RESIDUAL;

    return (!Number.isFinite(poseInliers) || poseInliers >= minInliers) &&
      (!Number.isFinite(poseConfidence) || poseConfidence >= minConfidence) &&
      (!Number.isFinite(poseAverageResidual) || poseAverageResidual <= maxResidual) &&
      (!reconstructionPose ||
        !Number.isFinite(poseForeshortening) ||
        poseForeshortening >= MIN_RECONSTRUCTION_ATTACHMENT_FORESHORTENING);
  }

  _calculateObjectEvidence({
    objectSupportMask,
    region,
    templateKeypoints = [],
    trackingKeypoints = [],
    trackedPoints = null,
    backgroundRejected = 0,
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
      backgroundRejected: backgroundRejected + Math.max(0, trackingKeypoints.length - objectOwnedKeypoints),
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
    this._recordCurvedMotionSample(result);
    this.metrics.processingTime = processingTime;
    this.metrics.lastUpdateResult = result.success ? 'success' : 'failed';
    this.metrics.lastUpdateMethod = result.method || null;
    this.metrics.lastUpdateConfidence = typeof result.confidence === 'number' ? result.confidence : null;
    this.metrics.keypointFailureCount = this.keypointFailureCount;
    this.metrics.readiness = result.readiness || this._createReadiness({
      state: this.anchorState,
      poseSource: this.metrics.poseSource,
      positionSource: result.method || this.metrics.lastUpdateMethod,
      reconstructionReady: this.metrics.reconstructionReady,
      poseInliers: this.metrics.poseInliers,
      poseConfidence: this.metrics.poseConfidence,
      poseAverageResidual: this.metrics.poseAverageResidual,
      poseForeshortening: this.metrics.poseForeshortening,
    });

    if (!result.success) {
      this.metrics.lastFailureReason = result.reason || this.metrics.lastFailureReason || 'Anchor update failed';
      this.metrics.lastFailureStage = this.metrics.lastFailureStage || 'tracking';
    }
  }

  _recordCurvedMotionSample(result) {
    if (!result.success ||
        !result.position ||
        result.method !== this.trackingMode ||
        !isReconstructionMode(result.method) ||
        !this._hasCurvedReconstructionTarget()) {
      return;
    }

    const timestamp = this.now();
    const position = {
      x: result.position.x,
      y: result.position.y,
    };
    const previous = this.curvedMotionSample;
    const elapsed = previous ? Math.max(1, timestamp - previous.timestamp) : 0;
    const measuredVelocity = previous
      ? {
          x: (position.x - previous.position.x) / elapsed,
          y: (position.y - previous.position.y) / elapsed,
        }
      : { x: 0, y: 0 };
    const velocity = previous
      ? {
          x: previous.velocity.x * 0.45 + measuredVelocity.x * 0.55,
          y: previous.velocity.y * 0.45 + measuredVelocity.y * 0.55,
        }
      : measuredVelocity;

    this.curvedMotionSample = {
      position,
      velocity,
      timestamp,
      confidence: result.confidence ?? this.metrics.poseConfidence ?? 0.5,
    };
  }

  /**
   * Add event listener for anchor updates
   */
  addListener(listener) {
    const callback = typeof listener === 'function'
      ? listener
      : listener.onAnchorUpdate.bind(listener);
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
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

    this.listeners.forEach(listener => listener(state));
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
      this.curvedMotionSample = null;
      this.objectSupportMask = null;
      this.currentObjectSupportMask = null;
      this.expandedObjectSupportRegion = false;
      this.planarDominanceScore = 0;
      this.templateRegion = null;
      this.trackingRegion = null;
      this.templateCenter = null;
      this.templateAnchorOffset = null;
      this.anchorTargetClass = null;
      this.framesSinceRefresh = 0;
      this.framesSinceRelocalizationKeyframe = 0;
      this.framesSinceFullFrameRecovery = this.fullFrameRecoveryInterval;
      this.framesWithoutNormalPose = 0;
      this.lastNormalPoseSource = null;
      this.frameIndex = 0;

      // Reset resilience counters
      this.keypointFailureCount = 0;

      // Reset filters
      this.positionFilterX = createPositionFilter();
      this.positionFilterY = createPositionFilter();
      this.planarScaleFilter = createPlanarScaleFilter();
      this.curvedScaleFilter = createCurvedScaleFilter();
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
