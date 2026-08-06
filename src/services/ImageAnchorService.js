/**
 * Image-Based Anchor Service
 * Orchestrates persistent keypoint tracking, object-pose estimation, and template matching
 * for robust object anchoring
 */

import { KeypointDetector } from '../cv/anchor.keypoints.js';
import { CANDIDATE_TRACKING_MIN_POINTS, KeypointTracker } from '../cv/anchor.tracking.js';
import { OrbKeyframeRelocalizer } from '../cv/anchor.relocalization.js';
import { HomographyEstimator } from '../cv/anchor.homography.js';
import { AffineParallaxPoseEstimator } from '../cv/anchor.affinePose.js';
import {
  DEPTH_FUSION_POSE_MODEL,
  DIRECT_PHOTOMETRIC_POSE_MODEL,
  isReconstructionMode,
  PARAMETRIC_SURFACE_POSE_MODEL,
  RECONSTRUCTION_MODE_IDS,
  RECONSTRUCTION_POSE_MODEL,
} from '../cv/anchor.reconstructionModes.js';
import { createReconstructionEngine } from '../cv/anchor.reconstructionEngineFactory.js';
import {
  isConfirmedObjectOwnedLandmark,
  isProbationaryObjectOwnedLandmark,
  isReconstructionEligibleLandmark,
} from '../cv/landmarkOwnership.js';
import { ObjectSurfaceModel } from '../cv/objectSurfaceModel.js';
import {
  arbitratePoseCandidates,
  selectPoseNormalOwner,
  selectPosePositionOwner,
} from '../cv/poseCandidateArbiter.js';
import {
  modelFromRegion,
  SURFACE_MODEL_CYLINDER,
  SURFACE_MODEL_ELLIPSOID,
  SURFACE_MODEL_PLANE,
  SURFACE_MODEL_TAPERED_CYLINDER,
} from '../cv/anchor.parametricGeometry.js';
import { AnchorPersistenceSystem } from '../cv/anchor.persistence.js';
import { OneEuroFilter } from '../cv/oneEuroFilter.js';
import { checkCriticalFeatures } from '../cv/opencv.features.js';
import {
  calculateTapLocalRadius,
  createTapLocalObjectSupportMask,
  createObjectSupportMask,
  createObjectSupportMaskPreview,
  isPointInsideObjectSupport,
  OBJECT_SUPPORT_MASK_SOURCES,
  warpObjectSupportMask,
} from '../cv/objectSupportMask.js';
import { calculateTapLocalTemplateRegion, calculateTemplateRegion } from '../utils/templateRegion.js';
import { angularDistanceBetweenNormals, SurfaceNormalStabilizer } from '../utils/normalStabilizer.js';
import { logger } from '../utils/logger.js';
import { CURVED_OBJECT_RECOVERY_REASON } from '../cv/curvedObjectRecovery.js';
import { WEAKLY_OBSERVED_NORMAL_INNOVATION_REASON } from '../cv/poseDropoutRecovery.js';
import {
  isObjectSupportRefreshSignalActive,
  isRecoveryObjectSupportRefreshReason,
  mergeObjectSupportRefreshSignal,
} from '../cv/objectSupportRefreshSignal.js';

const POSE_MODEL = 'object-pose';
const TRACKING_MODES = new Set([POSE_MODEL, ...RECONSTRUCTION_MODE_IDS]);
const PLANAR_TARGET_CLASS_PATTERN =
  /book|notebook|paper|document|poster|photo|picture|painting|card|ticket|label|badge|laptop|keyboard|cell phone|smartphone|phone|tablet|tv|screen|sign|whiteboard|bag/i;
const RIGID_PLANAR_TARGET_CLASS_PATTERN =
  /book|notebook|paper|document|poster|photo|picture|painting|card|ticket|label|badge|laptop|keyboard|cell phone|smartphone|phone|tablet|tv|screen|sign|whiteboard/i;
const GENERIC_TARGET_CLASS_PATTERN = /^(generic-object|object|unknown)$/i;
const MUG_TARGET_CLASS_PATTERN = /mug/i;
const NON_PRIMITIVE_TARGET_CLASS_PATTERN = /person|human|body|face|head|portrait|mask/i;
const SURFACE_CLASS_HINT_PATTERN =
  /shelf|shelves|bookcase|cabinet|drawer|rack|wardrobe|closet|box|package|crate|face|head|portrait|mask|book|notebook|paper|document|poster|photo|picture|painting|card|ticket|label|badge|laptop|keyboard|cell phone|smartphone|phone|tablet|tv|screen|sign|whiteboard|cup|mug|vase|ball|sphere|round|can|bottle|jar|container/i;
const CAN_LIKE_TARGET_CLASS_PATTERN = /can|jar|container/i;
const MIN_GENERIC_PRIMITIVE_MASK_FILL_RATIO = 0.58;
const MIN_GENERIC_PLANAR_MASK_FILL_RATIO = 0.94;
const MIN_GENERIC_PLANAR_MASK_ASPECT = 0.4;
const MAX_GENERIC_PLANAR_MASK_ASPECT = 2.5;
const MIN_OBJECT_WIDE_RELOCALIZATION_MASK_CONFIDENCE = 0.8;
const TEXTURED_PLANAR_RECOVERY_EXCLUSION_PATTERN = /book|notebook/i;
const CANDIDATE_MIN_TRACKABLE_POINTS = 8;
const CANDIDATE_REFRESH_INTERVAL = 3;
const RELOCALIZATION_MAP_GROWTH_TARGET = 24;
const RELOCALIZATION_MAP_GROWTH_MIN_CANDIDATES = 12;
const LEARNED_RELOCALIZATION_INTERVAL = 2;
const LEARNED_REFERENCE_REFRESH_KEYFRAME_COUNT = 3;
const MIN_LOCAL_RELOCALIZATION_INLIERS = 5;
const MIN_GLOBAL_RELOCALIZATION_INLIERS = 8;
const MIN_LEARNED_RELOCALIZATION_INLIERS = 8;
const COVERAGE_BALANCED_REFRESH_REASONS = new Set(['mapping-growth', 'map-growth']);
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
const MIN_PLANAR_NORMAL_CONFIDENCE = 0.5;
const OBJECT_SUPPORT_TRACKING_PADDING_RATIO = 0.18;
const OBJECT_SUPPORT_TRACKING_MIN_PADDING = 12;
const OBJECT_SUPPORT_TRACKING_MAX_PADDING = 48;
const RELOCALIZATION_SEARCH_PADDING_RATIO = 0.18;
const RELOCALIZATION_SEARCH_MIN_PADDING = 24;
const RELOCALIZATION_SEARCH_MAX_PADDING = 64;
const MAX_INITIAL_TRACKING_KEYPOINTS = 64;

const createPositionFilter = () => new OneEuroFilter(60, 2.4, 0.075, 1.0);
const createPlanarScaleFilter = () => new OneEuroFilter(60, 1.2, 0.08, 1.0);
const createCurvedScaleFilter = () => new OneEuroFilter(60, 2.4, 0.18, 1.0);
const createPlanarRotationFilter = () => new OneEuroFilter(60, 1.1, 0.08, 1.0);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const vectorMagnitude = (vector) => Math.hypot(vector.x, vector.y);
const pointDistance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);
const learnedRuntimeFailure = (error) => ({
  success: false,
  reason: `XFeat runtime failure: ${error.message}`,
  runtimeFailure: true,
});
const SCALE_STEP_LOG_LIMIT = 0.1;
const RECONSTRUCTION_POSITION_STEP_RATIO = 0.08;
const MATURE_CURVED_RECOVERY_POSITION_STEP_RATIO = 0.12;
const RIGID_PLANAR_POSITION_STEP_RATIO = 0.1;
const RIGID_PLANAR_BOOK_POSITION_STEP_RATIO = 0.083;
const RIGID_PLANAR_RECOVERY_DOMINANCE_SCORE = 3.4;
const OBJECT_SUPPORT_RECOVERY_REASON_PATTERN = /dropout|recovery/i;
const PLANAR_POSE_POSITION_BLEND = 0.85;
const MIN_LOW_LAG_TRACKER_CONFIDENCE = 0.55;
const MAX_LOW_LAG_TRACKER_RESIDUAL = 7;
const MIN_COHERENT_CURVED_TRACKER_CONFIDENCE = 0.4;
const MAX_COHERENT_CURVED_TRACKER_RESIDUAL = 9;
const MIN_COHERENT_CURVED_TRACKER_INLIERS = 16;
const MIN_COHERENT_CURVED_TRACKER_LANDMARKS = 40;
const MIN_COHERENT_CURVED_TRACKER_SPEED = 0.08;
const MIN_COHERENT_CURVED_TRACKER_ALIGNMENT = 0.75;
const MAX_COHERENT_CURVED_TRACKER_PREDICTION_DELTA = 5;
const MAX_COHERENT_CURVED_TRACKER_SAMPLE_AGE_MS = 75;
const COHERENT_CURVED_TRACKER_RAW_WEIGHT = 0.5;
const MIN_WEAK_MUG_MOTION_BRIDGE_DELTA = 3;
const MAX_WEAK_MUG_MOTION_BRIDGE_ALIGNMENT = -0.25;
const MAX_WEAK_MUG_MOTION_BRIDGE_INLIERS = 13;
const MIN_WEAK_MUG_MOTION_BRIDGE_MATURE_LANDMARKS = 18;
const MIN_CURVED_REFERENCE_BLEND_CONFIDENCE = 0.25;
const MAX_CURVED_REFERENCE_BLEND_RESIDUAL = 12;
const DIRECT_CURVED_DROPOUT_SCALE_RELAXATION = 0.02;
const MIN_CURVED_REFERENCE_BLEND_INLIERS = 8;
const MAX_DIRECT_CURVED_MOTION_SAMPLE_RESIDUAL = 6.5;
const MIN_CURVED_RELOCALIZATION_MOTION_SPEED = 0.08;
const MAX_CURVED_RELOCALIZATION_CANDIDATE_ALIGNMENT = 0.25;
const CURVED_BOOTSTRAP_MOTION_METHODS = new Set(['planar-homography', 'object-pose-affine']);
const MIN_CURVED_BOOTSTRAP_MOTION_CONFIDENCE = 0.55;
const MAX_CURVED_BOOTSTRAP_MOTION_RESIDUAL = 5.5;
const MIN_CURVED_BOOTSTRAP_MOTION_INLIERS = 8;
const MIN_SELECTED_CURVED_REFERENCE_SCALE_CONFIDENCE = 0.05;
const MIN_SELECTED_CURVED_REFERENCE_SCALE_INLIERS = 12;
const MAX_SEVERE_CURVED_REFERENCE_CONFIDENCE = 0.08;
const MIN_SEVERE_CURVED_REFERENCE_RESIDUAL = 24;
const MIN_SEVERE_CURVED_REFERENCE_TRACKER_DELTA = 24;
const MAX_SEVERE_CURVED_REFERENCE_LANDMARKS = 32;
const MAX_DIRECT_MUG_DEFORMED_REFERENCE_LANDMARKS = 24;
const MIN_CATASTROPHIC_SPARSE_MUG_REFERENCE_RESIDUAL = 40;
const MIN_DEPTH_CURVED_RECOVERY_CONFIDENCE = 0.4;
const MAX_REVERSING_PARAMETRIC_MOTION_MAP_CONFIDENCE = 0.7;
const MAX_REVERSING_PARAMETRIC_MOTION_INLIERS = 17;
const MIN_REVERSING_PARAMETRIC_MOTION_DELTA = 6;
const MAX_REVERSING_PARAMETRIC_MUG_MOTION_MAP_CONFIDENCE = 0.8;
const MIN_REVERSING_PARAMETRIC_MUG_MOTION_DELTA = 3;
const MIN_COHERENT_PARAMETRIC_RELEASE_ACTIVE_LANDMARKS = 18;
const MIN_COHERENT_PARAMETRIC_RELEASE_MAP_CONFIDENCE = 0.6;
const MAX_COHERENT_PARAMETRIC_RELEASE_TRACKER_DELTA = 2;
const CURVED_DROPOUT_MAX_PREDICTION_MS = 150;
const PARAMETRIC_CYLINDER_DROPOUT_MAX_PREDICTION_MS = 260;
const CURVED_DROPOUT_MAX_STEP = 18;
const SPARSE_CURVED_REFERENCE_MAX_STEP = 8;
const SPARSE_MUG_DIVERGENCE_RATIO = 0.18;
const SPARSE_MUG_DIVERGENCE_MIN_PX = 20;
const SPARSE_MUG_DIVERGENCE_MAX_PX = 32;
const SPARSE_MUG_DIVERGENCE_MAX_INLIERS = 15;
const SPARSE_MUG_DIVERGENCE_MIN_RESIDUAL = 4.5;
const OBJECT_SUPPORT_POSITION_CORRECTION_MIN_DELTA = 4;
const MOTION_HELD_SUPPORT_RECOVERY_MIN_RATIO = 0.16;
const IMMATURE_MUG_SUPPORT_RECOVERY_LANDMARKS = 16;
const IMMATURE_MUG_HIGH_ACTIVE_LANDMARKS = 20;
const IMMATURE_MUG_SUPPORT_RECOVERY_MAX_STEP = 6;
const SUPPORT_RECOVERY_MOTION_MAX_AGE_MS = 250;
const SUPPORT_RECOVERY_MOTION_MIN_SPEED = 0.02;
const SUPPORT_RECOVERY_MOTION_MIN_CONFIDENCE = 0.55;
const SUPPORT_RECOVERY_MOTION_MIN_ALIGNMENT = 0.35;
const SUPPORT_RECOVERY_MOTION_MIN_DISPLACEMENT = 4;
const SUPPORT_RECOVERY_MOTION_MAX_STEP_RATIO = 0.14;
const SUPPORT_RECOVERY_MOTION_MIN_STEP = 12;
const SUPPORT_RECOVERY_MOTION_MAX_STEP = 28;
const PARAMETRIC_RECOVERY_MIN_MAP_CONFIDENCE = 0.55;
const PARAMETRIC_RECOVERY_MIN_MATURE_LANDMARKS = 16;
const PARAMETRIC_RECOVERY_MAX_ACTIVE_LANDMARKS = 24;
const PARAMETRIC_CAN_RECOVERY_MIN_MAPPED_FRAMES = 12;
const SPARSE_GENERIC_TAPERED_SUPPORT_RECOVERY_MAX_STEP = 6;
const SPARSE_CYLINDER_BOOTSTRAP_SUPPORT_RECOVERY_MATURE_LANDMARKS = 16;
const SPARSE_CYLINDER_BOOTSTRAP_SUPPORT_RECOVERY_MAX_STEP = 7;
const SPARSE_CYLINDER_HIGH_RESIDUAL_SUPPORT_RECOVERY_MAX_STEP = 4;
const SPARSE_CYLINDER_SUPPORT_RECOVERY_MAX_STEP = 9;
const SPARSE_CYLINDER_HIGH_RESIDUAL_SUPPORT_RECOVERY_MIN_RESIDUAL = MAX_CURVED_REFERENCE_BLEND_RESIDUAL;
const SPARSE_CAN_STALE_POSE_MIN_DROPOUT_FRAMES = 3;
const SPARSE_CAN_STALE_POSE_MIN_TRACKER_DELTA = 32;
const DEPTH_CUP_SUPPORT_RECOVERY_MAX_STEP = 5;
const NON_CURVED_PERIODIC_SUPPORT_CORRECTION_MAX_STEP = 6;
const GENERIC_RECONSTRUCTION_POSITION_STEP_RATIO = 1 / 12;
const SPARSE_MUG_MOTION_HOLD_MAX_ACTIVE_LANDMARKS = 27;
const SPARSE_MUG_SUPPORT_RECOVERY_MAX_ACTIVE_LANDMARKS = 20;
const SPARSE_MUG_SUPPORT_RECOVERY_MAX_STEP = 6;
const SPARSE_CYLINDER_MOTION_HOLD_MAX_ACTIVE_LANDMARKS = 44;
const SPARSE_MUG_PERIODIC_SUPPORT_CORRECTION_MIN_DELTA = 12;
const SPARSE_MUG_PERIODIC_SUPPORT_CORRECTION_MAX_ACTIVE_LANDMARKS = 36;
const SPARSE_MUG_PERIODIC_SUPPORT_CORRECTION_MIN_MAP_CONFIDENCE = 0.55;
const SPARSE_MUG_PERIODIC_SUPPORT_CORRECTION_MAX_STEP = 8;
const SPARSE_MUG_SUPPORT_CORRECTION_HOLD_FRAMES = 7;
const SPARSE_MUG_SUPPORT_CORRECTION_MIN_BACKTRACK_STEP = 3;
const SPARSE_MUG_SUPPORT_HELD_NORMAL_MAX_WEAK_INLIERS = 17;
const SPARSE_MUG_SUPPORT_HELD_NORMAL_MIN_MAP_CONFIDENCE = 0.75;
const SPARSE_MUG_SUPPORT_HELD_NORMAL_MIN_MATURE_LANDMARKS = 16;
const PARTIAL_OCCLUSION_MIN_PRIOR_POSE_INLIERS = 12;
const MIN_SPARSE_NORMAL_OBSERVABILITY = 0.05;
const MAX_WEAKLY_OBSERVED_NORMAL_INLIERS = 18;
const MIN_WEAKLY_OBSERVED_NORMAL_INNOVATION = 0.25;
const PLANAR_POSE_POSITION_METHODS = new Set([
  RECONSTRUCTION_POSE_MODEL,
  'planar-homography',
  'homography',
  'object-pose-affine',
]);
const TRACKER_SPINE_POSITION_METHODS = new Set([
  'reference_similarity_transform',
  'object-owned-centroid-position',
  'curved-centroid-position',
  'keypoint_centroid_only',
]);
const CURVED_SURFACE_MODELS = new Set([
  SURFACE_MODEL_CYLINDER,
  SURFACE_MODEL_TAPERED_CYLINDER,
  SURFACE_MODEL_ELLIPSOID,
]);

const transformHomographyPoint = (matrix, point) => {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];

  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
};

const unwrapAngle = (target, reference) => {
  let unwrapped = target;
  while (unwrapped - reference > Math.PI) unwrapped -= Math.PI * 2;
  while (unwrapped - reference < -Math.PI) unwrapped += Math.PI * 2;
  return unwrapped;
};

export class ImageAnchorService {
  constructor({ now = () => performance.now(), profileUpdates = false, learnedRelocalizer = null } = {}) {
    this.initialized = false;
    this.cv = null;
    this.cameraParams = null;
    this.now = now;
    this.profileUpdates = profileUpdates;

    // Core components
    this.keypointDetector = new KeypointDetector();
    this.keypointTracker = new KeypointTracker();
    this.relocalizer = new OrbKeyframeRelocalizer();
    this.learnedRelocalizer = learnedRelocalizer;
    this.learnedReferencePromise = null;
    this.homographyEstimator = new HomographyEstimator();
    this.affinePoseEstimator = new AffineParallaxPoseEstimator();
    this.reconstructor = createReconstructionEngine(RECONSTRUCTION_POSE_MODEL);
    this.objectSurfaceModel = new ObjectSurfaceModel();
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
    this.templateRegion = null;
    this.trackingRegion = null;
    this.templateCenter = null; // Reference center point for stable positioning
    this.templateAnchorOffset = null;
    this.currentPosition = null;
    this.frameStartPosition = null;
    this.currentNormal = null;
    this.currentPlanarTransform = null;
    this.curvedMotionSample = null;
    this.localizeCurvedRelocalizationSearch = false;
    this.objectSupportMask = null;
    this.currentObjectSupportMask = null;
    this.objectSupportProjectionCache = null;
    this.objectSupportAnchorUv = null;
    this.objectSupportCorrectionHold = null;
    this.expandedObjectSupportRegion = false;
    this.anchorTargetClass = null;
    this.rigidPlanarRecoveryEligible = false;
    this.trackingMode = POSE_MODEL;
    this.planarDominanceScore = 0;
    this.framesSinceRefresh = 0;
    this.refreshInterval = 15; // Refresh keypoints every N frames
    this.framesSinceRelocalizationKeyframe = 0;
    this.relocalizationKeyframeInterval = 4;
    this.relocalizationValidationInterval = 3;
    this.lastSuccessfulRelocalizationFrame = -Infinity;
    this.lastLearnedRelocalizationAttemptFrame = -Infinity;
    this.frameIndex = 0;
    this.lastKeypointReinitializationFrame = -Infinity;

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
      targetPresent: false,
      poseModel: POSE_MODEL,
      trackingMode: this.trackingMode,
      poseSource: null,
      poseSourceHoldReason: null,
      posePositionRole: null,
      posePositionReason: null,
      trackerReferenceScope: null,
      trackerLocalReferenceResidual: null,
      poseNormalRole: null,
      poseNormalReason: null,
      poseNormalCandidateSource: null,
      poseObs: null,
      planarPnpBranchSelection: null,
      normalPoseRejectedCandidates: {},
      poseInliers: 0,
      affinePoseInliers: 0,
      reconstructionPreview: null,
      landmarkCount: 0,
      activeLandmarkCount: 0,
      inactiveLandmarkCount: 0,
      landmarkRefreshAdded: 0,
      landmarkRefreshProbationary: 0,
      landmarkRefreshCoverageBefore: null,
      landmarkRefreshCoverageAfter: null,
      landmarkRefreshCoverageCellCount: null,
      landmarkRefreshOccupiedBefore: null,
      landmarkRefreshOccupiedAfter: null,
      landmarkRefreshCandidateCount: null,
      landmarkRefreshGfttCallCount: null,
      landmarkRefreshGfttPixelCount: null,
      landmarkRefreshGfttPreparationCount: null,
      keypointReinitializationResult: null,
      keypointReinitializationReason: null,
      keypointReinitializationCandidateCount: null,
      keypointReinitializationGfttCallCount: null,
      keypointReinitializationGfttPixelCount: null,
      keypointReinitializationGfttPreparationCount: null,
      ownershipProbationLandmarks: 0,
      reconstructionMapHeldForRecoveryValidation: false,
      landmarkOwnershipPromoted: 0,
      lastFailureReason: null,
      lastFailureStage: null,
      lastUpdateResult: null,
      lastUpdateMethod: null,
      relocalizationKeyframes: 0,
      relocalizationDescriptors: 0,
      relocalizationMatches: 0,
      relocalizationInliers: 0,
      relocalizationSuccessFrame: null,
      relocalizationResult: null,
      relocalizationMethod: null,
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
    if (this.trackingMode === mode) {
      return;
    }

    this.trackingMode = mode;
    this.metrics.trackingMode = mode;
    this.metrics.poseModel = isReconstructionMode(mode) ? mode : POSE_MODEL;

    if (this.anchored && this.currentPosition) {
      this.reconstructor.dispose();
      this.reconstructor = this._createConfiguredReconstructor(
        isReconstructionMode(mode) ? mode : RECONSTRUCTION_POSE_MODEL,
      );
      this.reconstructor.reset({
        anchorReference: this.keypointTracker.anchorOriginalPosition || this.currentPosition,
        templateRegion: this.trackingRegion ||
          this.templateRegion || {
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

    const criticalCheck = checkCriticalFeatures(cv);
    if (!criticalCheck.allAvailable) {
      const missingFeatures = criticalCheck.missing.join(', ');
      const error = criticalCheck.error || `Missing critical OpenCV features: ${missingFeatures}`;
      logger.error('ImageAnchor', error);
      throw new Error(error);
    }

    this.cv = cv;
    this.cameraParams = { ...cameraParams };

    await this.keypointDetector.initialize(cv);
    await this.keypointTracker.initialize(cv);
    await this.homographyEstimator.initialize(cv, cameraParams);
    await this.persistenceSystem.initialize(cv);

    this.initialized = true;
  }

  /**
   * Create anchor from user tap
   * @param {ImageData} imageData - Current frame
   * @param {Object} tapPosition - {x, y} tap coordinates
   * @param {Object} selectionRegion - Object-support region selected by the tap
   */
  async createAnchor(imageData, tapPosition, selectionRegion = null) {
    if (!this.initialized) {
      throw new Error('ImageAnchorService not initialized');
    }

    const startTime = this.now();
    this.anchorState = 'initializing';
    this.planarDominanceScore = 0;
    this.homographyEstimator.resetTracking();
    this._notifyStateChange();

    let src = null;
    try {
      src = this.cv.matFromImageData(imageData);
      const gray = this.keypointTracker.acquireGrayFrame(this.cv);
      this.cv.cvtColor(src, gray, this.cv.COLOR_RGBA2GRAY);

      const targetClass = this._extractSurfaceHint(selectionRegion);

      const templateRegion = this._calculateTemplateRegion(
        tapPosition,
        selectionRegion,
        imageData.width,
        imageData.height,
      );
      const objectSupportMask = this._selectObjectSupportMask(
        selectionRegion,
        tapPosition,
        imageData.width,
        imageData.height,
      );
      this.rigidPlanarRecoveryEligible = this._isRigidPlanarRecoverySelection(targetClass, objectSupportMask);

      const keypointResult = this._extractObjectKeypoints(gray, templateRegion, objectSupportMask, {
        minKeypoints: this.minAnchorKeypoints,
      });

      const qualityAssessment = this.keypointDetector.assessTemplateQuality(
        keypointResult.keypoints,
        keypointResult.descriptors,
        templateRegion.width,
        templateRegion.height,
        templateRegion.x,
        templateRegion.y,
      );
      const hasProgressiveObjectEvidence = !!objectSupportMask;
      const hasStrongInitialKeypoints = keypointResult.keypoints.length >= this.minAnchorKeypoints;
      const hasUsableTemplateQuality = this._isUsableTemplateQuality(qualityAssessment.overall);
      const shouldCreateCandidate =
        hasProgressiveObjectEvidence && (!hasStrongInitialKeypoints || !hasUsableTemplateQuality);

      if (!hasStrongInitialKeypoints && !shouldCreateCandidate) {
        const message = `Insufficient keypoints: ${keypointResult.keypoints.length} (need at least ${this.minAnchorKeypoints})`;
        this._recordAnchorFailure('keypoints', message, {
          keypointCount: keypointResult.keypoints.length,
          templateKeypoints: keypointResult.keypoints.length,
          templateRegion,
          extractionMethod: keypointResult.method,
          processingTime: this.now() - startTime,
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
          processingTime: this.now() - startTime,
        });
        throw new Error(message);
      }

      // Store template center for persistence system (still needed for template matching)
      const templateCenter = {
        x: templateRegion.x + templateRegion.width / 2,
        y: templateRegion.y + templateRegion.height / 2,
      };
      const templateAnchorOffset = {
        x: tapPosition.x - templateCenter.x,
        y: tapPosition.y - templateCenter.y,
      };

      const trackingRegion = this._calculateTrackingRegion(
        selectionRegion,
        imageData.width,
        imageData.height,
        templateRegion,
      );
      const trackingKeypointResult = trackingRegion
        ? this._extractObjectKeypoints(gray, trackingRegion, objectSupportMask, {
            minKeypoints: this.minAnchorKeypoints,
          })
        : keypointResult;
      const trackingKeypoints = this._mergeTrackingKeypoints(
        keypointResult.keypoints,
        trackingKeypointResult.keypoints,
      );
      const reconstructionRegion = trackingRegion || templateRegion;

      if (trackingKeypoints.length > 0) {
        this.keypointTracker.initializeTracking(this.cv, trackingKeypoints, gray, {
          tapPosition,
          admission: 'trusted-selection',
        });
      }
      this.reconstructor.dispose();
      this.reconstructor = this._createConfiguredReconstructor(
        isReconstructionMode(this.trackingMode) ? this.trackingMode : RECONSTRUCTION_POSE_MODEL,
      );
      this.reconstructor.reset({
        anchorReference: tapPosition,
        templateRegion: reconstructionRegion,
        targetClass,
      });
      if (this.reconstructor.ready) {
        await this.reconstructor.ready;
      }
      const tapDescriptorRecoveryEligible =
        this.rigidPlanarRecoveryEligible ||
        (this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
          MUG_TARGET_CLASS_PATTERN.test(targetClass || '') &&
          this._hasTrustedObjectWideRelocalizationSupport(objectSupportMask));
      const keyframeResult =
        trackingKeypoints.length > 0 && tapDescriptorRecoveryEligible
          ? this.relocalizer.storeKeyframe({
              cv: this.cv,
              grayImage: gray,
              trackedPoints: this.keypointTracker.trackedPoints,
              anchorPoint: tapPosition,
              timestamp: startTime,
              includeFreshLandmarks: true,
              translationInvariantRedundancy: true,
            })
          : {
              success: false,
              keyframeCount: 0,
              descriptorCount: 0,
              reason:
                trackingKeypoints.length > 0
                  ? 'Tap-time descriptor recovery requires rigid planar or trusted object-wide support'
                  : 'No bootstrap landmarks available',
            };
      this.framesSinceRelocalizationKeyframe = 0;
      this.lastSuccessfulRelocalizationFrame = -Infinity;
      this.lastLearnedRelocalizationAttemptFrame = -Infinity;

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
        method: 'created',
      };
      this.currentNormal = { x: 0, y: 0, z: 1 };
      this.objectSupportMask = objectSupportMask;
      this.currentObjectSupportMask = objectSupportMask;
      this.objectSupportProjectionCache = null;
      this.objectSupportAnchorUv = this._calculateObjectSupportAnchorUv(objectSupportMask, tapPosition);
      this.localizeCurvedRelocalizationSearch = false;
      this.expandedObjectSupportRegion =
        !!objectSupportMask &&
        objectSupportMask.source === 'interactive-segmenter' &&
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
        backgroundRejected:
          (keypointResult.rejectedByMask || 0) + (trackingKeypointResult.rejectedByMask || 0),
      });
      const objectSupportMaskPreview = objectSupportMask
        ? createObjectSupportMaskPreview(objectSupportMask)
        : null;
      this.objectSurfaceModel.reset();
      const surfaceState = this._updateObjectSurfaceMetrics({
        objectSupportMask,
        poseResidual: 0,
      });

      this.anchorState = bootstrapState;
      this.framesSinceRefresh = 0;
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
        objectSupportAnchorUv: this.objectSupportAnchorUv ? { ...this.objectSupportAnchorUv } : null,
        objectSupportMaskPreview,
        currentObjectSupportMaskSource: objectSupportMask ? objectSupportMask.source : null,
        currentObjectSupportMaskBounds: objectSupportMask ? { ...objectSupportMask.bbox } : null,
        currentObjectSupportMaskPreview: objectSupportMaskPreview,
        ...this._surfaceMetricFields(surfaceState),
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
        relocalizationSuccessFrame: null,
        relocalizationResult: keyframeResult.success ? 'keyframe-stored' : 'keyframe-skipped',
        relocalizationReason: keyframeResult.reason || null,
        relocalizationMethod: null,
        learnedRelocalizationAttempted: false,
        recoveryAttempts: 0,
        lostFrameCount: 0,
        keypointFailureCount: 0,
        targetPresent: true,
        lastFailureReason: null,
        lastFailureStage: null,
        lastUpdateResult: 'created',
        lastUpdateMethod: keypointResult.method,
        createdAt: Date.now(),
      };

      if (this.learnedRelocalizer && this.rigidPlanarRecoveryEligible && trackingKeypoints.length > 0) {
        this._storeLearnedReference(imageData);
      } else {
        this.learnedReferencePromise = null;
      }

      this._notifyStateChange();

      return {
        success: true,
        targetPresent: true,
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
        reconstructionReady: this.metrics.reconstructionReady,
      };
    } catch (error) {
      if (!this.metrics.lastFailureReason) {
        this._recordAnchorFailure('create-anchor', error.message, {
          processingTime: this.now() - startTime,
        });
      }
      this.anchorState = 'inactive';
      this.anchored = false;
      this._notifyStateChange();
      throw error;
    } finally {
      if (src) {
        src.delete();
      }
    }
  }

  updateObjectSupportMask(objectSupportMask, { reason }) {
    if (!objectSupportMask || objectSupportMask.bbox.width <= 0 || objectSupportMask.bbox.height <= 0) {
      return false;
    }

    if (!this.objectSupportAnchorUv) {
      this.objectSupportAnchorUv = this._calculateObjectSupportAnchorUv(
        objectSupportMask,
        this.currentPosition || objectSupportMask.referencePoint,
      );
    }

    const correctedAnchorPosition = this._applyObjectSupportPositionCorrection(objectSupportMask, reason);
    const anchoredSupportMask = this._createAnchorReferencedObjectSupportMask(
      objectSupportMask,
      correctedAnchorPosition ||
        this._objectSupportAnchorPosition(objectSupportMask) ||
        objectSupportMask.referencePoint,
    );

    this.objectSupportMask = anchoredSupportMask;
    this.currentObjectSupportMask = anchoredSupportMask;
    this.objectSupportProjectionCache = null;
    this.expandedObjectSupportRegion = true;
    this.metrics.objectSupportMaskSource = anchoredSupportMask.source;
    this.metrics.objectSupportMaskConfidence = anchoredSupportMask.confidence;
    this.metrics.objectSupportMaskBounds = { ...anchoredSupportMask.bbox };
    this.metrics.objectSupportAnchorUv = this.objectSupportAnchorUv
      ? { ...this.objectSupportAnchorUv }
      : null;
    this.metrics.objectSupportMaskPreview = createObjectSupportMaskPreview(anchoredSupportMask);
    this.metrics.currentObjectSupportMaskSource = anchoredSupportMask.source;
    this.metrics.currentObjectSupportMaskBounds = { ...anchoredSupportMask.bbox };
    this.metrics.currentObjectSupportMaskPreview = this.metrics.objectSupportMaskPreview;
    const trackingRegionBase =
      this._shouldBoundRigidPlanarTrackingRegion() && this.templateRegion
        ? {
            ...this.templateRegion,
            x: this.currentPosition.x - this.templateRegion.width / 2,
            y: this.currentPosition.y - this.templateRegion.height / 2,
          }
        : this.trackingRegion || this.templateRegion;
    this.trackingRegion = this._calculateObjectSupportTrackingRegion(anchoredSupportMask, trackingRegionBase);
    this.metrics.trackingRegion = { ...this.trackingRegion };
    this._setReconstructionRegion(this.trackingRegion);
    const refreshSignal = mergeObjectSupportRefreshSignal({
      currentReason: this.metrics.segmentationRefreshReason ?? null,
      currentFrame: this.metrics.segmentationRefreshFrame ?? null,
      incomingReason: reason,
      incomingFrame: this.frameIndex,
    });
    this.metrics.segmentationRefreshReason = refreshSignal.reason;
    this.metrics.segmentationRefreshFrame = refreshSignal.frame;
    this._recordLandmarkMetrics();
    this._notifyStateChange();
    return true;
  }

  _calculateObjectSupportAnchorUv(objectSupportMask, anchorPosition) {
    if (!objectSupportMask?.bbox || !anchorPosition) {
      return null;
    }

    const { bbox } = objectSupportMask;
    if (bbox.width <= 0 || bbox.height <= 0) {
      return null;
    }

    return {
      u: clamp((anchorPosition.x - bbox.x) / bbox.width, 0, 1),
      v: clamp((anchorPosition.y - bbox.y) / bbox.height, 0, 1),
    };
  }

  _objectSupportAnchorPosition(objectSupportMask) {
    if (!objectSupportMask?.bbox || !this.objectSupportAnchorUv) {
      return null;
    }

    const { bbox } = objectSupportMask;
    if (bbox.width <= 0 || bbox.height <= 0) {
      return null;
    }

    return {
      x: bbox.x + bbox.width * this.objectSupportAnchorUv.u,
      y: bbox.y + bbox.height * this.objectSupportAnchorUv.v,
      z: 0,
    };
  }

  _createAnchorReferencedObjectSupportMask(objectSupportMask, referencePoint) {
    return createObjectSupportMask({
      width: objectSupportMask.width,
      height: objectSupportMask.height,
      data: objectSupportMask.data,
      source: objectSupportMask.source,
      confidence: objectSupportMask.confidence,
      referencePoint,
      createdAtFrame: objectSupportMask.createdAtFrame,
      updatedAtFrame: objectSupportMask.updatedAtFrame,
    });
  }

  _applyObjectSupportPositionCorrection(objectSupportMask, reason) {
    this.metrics.objectSupportFrameStepLimited = false;
    let candidate = this._objectSupportAnchorPosition(objectSupportMask);
    if (!candidate || !this.currentPosition || objectSupportMask.source === 'warped-mask') {
      this.metrics.objectSupportPositionCorrection = null;
      this.metrics.objectSupportPositionSource = null;
      return null;
    }

    if (this._shouldKeepTrackerPositionDuringSupportRecovery(reason)) {
      this.metrics.objectSupportPositionCorrection = null;
      this.metrics.objectSupportPositionSource = null;
      return null;
    }

    candidate = this._adjustObjectSupportCorrectionCandidate(candidate, reason);
    const deltaX = candidate.x - this.currentPosition.x;
    const deltaY = candidate.y - this.currentPosition.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (this._shouldIgnoreMotionHeldSupportCorrection(objectSupportMask, distance, reason)) {
      this.metrics.objectSupportPositionCorrection = null;
      this.metrics.objectSupportPositionSource = null;
      return null;
    }

    const maxStep = this._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, reason, distance);
    if (distance < OBJECT_SUPPORT_POSITION_CORRECTION_MIN_DELTA || maxStep <= 0) {
      this.metrics.objectSupportPositionCorrection = null;
      this.metrics.objectSupportPositionSource = null;
      return null;
    }

    const stepScale = distance > maxStep ? maxStep / distance : 1;
    const supportCorrected = {
      x: this.currentPosition.x + deltaX * stepScale,
      y: this.currentPosition.y + deltaY * stepScale,
      z: 0,
    };
    const frameConstrained = this._constrainPositionToFrameStep(
      supportCorrected,
      this.metrics.lastUpdateMethod || 'unknown',
    );
    const corrected = frameConstrained.position;
    const previous = { ...this.currentPosition };
    const appliedStep = pointDistance(corrected, previous);

    if (appliedStep <= 1e-6) {
      this.metrics.objectSupportPositionCorrection = null;
      this.metrics.objectSupportPositionSource = null;
      this.metrics.objectSupportFrameStepLimited = frameConstrained.limited;
      return null;
    }

    this.currentPosition = corrected;
    this._recordObjectSupportCorrectionHold({
      previous,
      corrected,
      reason,
    });
    this.positionFilterX = createPositionFilter();
    this.positionFilterY = createPositionFilter();
    this.positionFilterX.filter(corrected.x, this.now());
    this.positionFilterY.filter(corrected.y, this.now());
    this.metrics.objectSupportPositionCorrection = reason;
    this.metrics.objectSupportPositionSource = objectSupportMask.source;
    this.metrics.objectSupportPositionDelta = distance;
    this.metrics.objectSupportPositionStep = appliedStep;
    this.metrics.objectSupportFrameStepLimited = frameConstrained.limited;

    return corrected;
  }

  _constrainPositionToFrameStep(position, method) {
    if (!this.frameStartPosition) {
      return { position, limited: false };
    }

    const maxStep = this._maxPositionStep(position, method);
    const deltaX = position.x - this.frameStartPosition.x;
    const deltaY = position.y - this.frameStartPosition.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (distance <= maxStep || distance === 0) {
      return { position, limited: false };
    }

    const scale = maxStep / distance;
    return {
      position: {
        ...position,
        x: this.frameStartPosition.x + deltaX * scale,
        y: this.frameStartPosition.y + deltaY * scale,
      },
      limited: true,
    };
  }

  _adjustObjectSupportCorrectionCandidate(candidate, reason) {
    if (
      this.trackingMode === 'parametric-surface' &&
      /mug/i.test(this.anchorTargetClass || '') &&
      reason === CURVED_OBJECT_RECOVERY_REASON
    ) {
      return {
        ...candidate,
        y: this.currentPosition.y,
      };
    }

    return candidate;
  }

  _recordObjectSupportCorrectionHold({ previous, corrected, reason }) {
    const direction = {
      x: corrected.x - previous.x,
      y: corrected.y - previous.y,
    };
    const magnitude = vectorMagnitude(direction);
    this.objectSupportCorrectionHold =
      magnitude > 0
        ? {
            frameIndex: this.frameIndex,
            direction,
            magnitude,
            reason,
          }
        : null;
  }

  _shouldKeepTrackerPositionDuringSupportRecovery(reason) {
    const active = this.metrics.activeLandmarkCount ?? this.metrics.activeLandmarks ?? 0;
    return (
      this._hasUnreadyHandledMugPoseDropoutRecovery(reason) && active >= IMMATURE_MUG_HIGH_ACTIVE_LANDMARKS
    );
  }

  _hasUnreadyHandledMugRecoveryTarget() {
    return (
      this._hasMugLikeTarget() &&
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL &&
      isReconstructionMode(this.trackingMode) &&
      this.metrics.reconstructionReady !== true &&
      (this.trackingMode === DEPTH_FUSION_POSE_MODEL ||
        (this.metrics.reconstructionMatureLandmarks ?? 0) < IMMATURE_MUG_SUPPORT_RECOVERY_LANDMARKS)
    );
  }

  _hasUnreadyHandledMugMotionRecoveryTarget() {
    if (
      !this._hasMugLikeTarget() ||
      !isReconstructionMode(this.trackingMode) ||
      this.metrics.reconstructionReady === true
    ) {
      return false;
    }

    return (
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL ||
      this._hasTrustedObjectWideRelocalizationSupport(this.objectSupportMask)
    );
  }

  _hasUnreadyHandledMugPoseDropoutRecovery(reason) {
    return this._hasUnreadyHandledMugRecoveryTarget() && reason === 'pose-dropout-recovery';
  }

  _shouldIgnoreMotionHeldSupportCorrection(objectSupportMask, distance, reason) {
    if (
      !this._hasCurvedReconstructionTarget() ||
      this.metrics.positionFilterAdjustment !== 'curved-motion-hold'
    ) {
      return false;
    }

    if (!OBJECT_SUPPORT_RECOVERY_REASON_PATTERN.test(reason)) {
      return true;
    }

    const maxExtent = Math.max(objectSupportMask.bbox.width, objectSupportMask.bbox.height);
    const stalePredictionDistance = this._hasHandledMugCurvedObjectRecovery(reason)
      ? clamp(maxExtent * 0.06, 6, 14)
      : clamp(maxExtent * MOTION_HELD_SUPPORT_RECOVERY_MIN_RATIO, 24, 42);
    return distance < stalePredictionDistance;
  }

  _hasHandledMugCurvedObjectRecovery(reason) {
    return (
      this.trackingMode === 'parametric-surface' &&
      /mug/i.test(this.anchorTargetClass || '') &&
      reason === CURVED_OBJECT_RECOVERY_REASON
    );
  }

  _getObjectSupportPositionCorrectionMaxStep(
    objectSupportMask,
    reason = 'segmentation-refresh',
    distance = 0,
  ) {
    if (this._hasRigidPlanarTargetClass()) {
      return 0;
    }

    const maxExtent = Math.max(objectSupportMask.bbox.width, objectSupportMask.bbox.height);
    const mugLike = this._hasMugLikeTarget();
    const bottleLike = this._hasCylinderLikeTarget();
    const cupLike = this._hasTaperedCylinderLikeTarget();
    const curved = this._hasCurvedReconstructionTarget();
    const ratio = curved ? 0.24 : 0.3;
    const recoveryCorrection = OBJECT_SUPPORT_RECOVERY_REASON_PATTERN.test(reason);
    if (
      mugLike &&
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      !recoveryCorrection &&
      this._shouldUseSparseMugPeriodicSupportCorrection({
        reason,
        distance,
        active: this.metrics.activeLandmarkCount ?? this.metrics.keypointCount ?? 0,
      })
    ) {
      return Math.min(clamp(maxExtent * 0.08, 6, 10), SPARSE_MUG_PERIODIC_SUPPORT_CORRECTION_MAX_STEP);
    }
    if (curved && !recoveryCorrection) {
      return 0;
    }
    if (
      !curved &&
      !recoveryCorrection &&
      !NON_PRIMITIVE_TARGET_CLASS_PATTERN.test(this.anchorTargetClass || '')
    ) {
      return Math.min(clamp(maxExtent * ratio, 8, 16), NON_CURVED_PERIODIC_SUPPORT_CORRECTION_MAX_STEP);
    }
    if (
      this._hasGenericTargetClass() &&
      (this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL || this.trackingMode === 'parametric-surface') &&
      recoveryCorrection
    ) {
      return 0;
    }
    if (
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasKnownDepthCylinderTargetClass() &&
      recoveryCorrection &&
      (this.metrics.reconstructionReady !== true ||
        (this.metrics.reconstructionMatureLandmarks ?? 0) <
          SPARSE_CYLINDER_BOOTSTRAP_SUPPORT_RECOVERY_MATURE_LANDMARKS)
    ) {
      return SPARSE_CYLINDER_BOOTSTRAP_SUPPORT_RECOVERY_MAX_STEP;
    }
    if (
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasKnownDepthCylinderTargetClass() &&
      recoveryCorrection &&
      Number.isFinite(this.metrics.poseAverageResidual) &&
      this.metrics.poseAverageResidual > SPARSE_CYLINDER_HIGH_RESIDUAL_SUPPORT_RECOVERY_MIN_RESIDUAL
    ) {
      return SPARSE_CYLINDER_HIGH_RESIDUAL_SUPPORT_RECOVERY_MAX_STEP;
    }
    if (
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasKnownDepthCylinderTargetClass() &&
      recoveryCorrection
    ) {
      return SPARSE_CYLINDER_SUPPORT_RECOVERY_MAX_STEP;
    }
    if (mugLike && this.trackingMode === DEPTH_FUSION_POSE_MODEL) {
      return 4;
    }
    if (mugLike && this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL) {
      return 2;
    }
    if (mugLike && this.trackingMode === RECONSTRUCTION_POSE_MODEL) {
      const active = this.metrics.activeLandmarkCount ?? this.metrics.keypointCount ?? 0;
      return recoveryCorrection && active <= SPARSE_MUG_SUPPORT_RECOVERY_MAX_ACTIVE_LANDMARKS
        ? SPARSE_MUG_SUPPORT_RECOVERY_MAX_STEP
        : 0;
    }
    if (mugLike && this.trackingMode === 'parametric-surface') {
      const maxStep = recoveryCorrection ? clamp(maxExtent * ratio, 8, 12) : 0;
      return this._hasUnreadyHandledMugPoseDropoutRecovery(reason)
        ? Math.min(maxStep, IMMATURE_MUG_SUPPORT_RECOVERY_MAX_STEP)
        : maxStep;
    }
    if (cupLike && this.trackingMode === RECONSTRUCTION_POSE_MODEL && recoveryCorrection) {
      return this._hasGenericTargetClass() ? SPARSE_GENERIC_TAPERED_SUPPORT_RECOVERY_MAX_STEP : 0;
    }
    if (cupLike && this.trackingMode === DEPTH_FUSION_POSE_MODEL && recoveryCorrection) {
      return Math.min(clamp(maxExtent * ratio, 8, 14), DEPTH_CUP_SUPPORT_RECOVERY_MAX_STEP);
    }
    let hardMax = curved ? 10 : 16;
    if (bottleLike) {
      hardMax = recoveryCorrection ? 10 : 12;
    } else if (cupLike) {
      hardMax = recoveryCorrection ? 14 : 12;
    }
    if (mugLike) {
      hardMax = 12;
    }
    return clamp(maxExtent * ratio, 8, hardMax);
  }

  _shouldUseSparseMugPeriodicSupportCorrection({ reason, distance, active }) {
    return (
      reason === 'periodic-segmentation-refresh' &&
      distance >= SPARSE_MUG_PERIODIC_SUPPORT_CORRECTION_MIN_DELTA &&
      active >= CANDIDATE_MIN_TRACKABLE_POINTS &&
      active <= SPARSE_MUG_PERIODIC_SUPPORT_CORRECTION_MAX_ACTIVE_LANDMARKS &&
      this.metrics.reconstructionReady === true &&
      (this.metrics.reconstructionMapConfidence ?? 0) >=
        SPARSE_MUG_PERIODIC_SUPPORT_CORRECTION_MIN_MAP_CONFIDENCE
    );
  }

  /**
   * Update anchor with new frame
   * @param {ImageData} imageData - Current frame
   * @returns {Object} Update result with pose information
   */
  async updateAnchor(imageData, depthContext = {}) {
    if (!this.anchored || !this.initialized) {
      logger.warn('ImageAnchor', 'Update called but anchor not ready:', {
        anchored: this.anchored,
        initialized: this.initialized,
        anchorState: this.anchorState,
      });
      return { success: false, targetPresent: false, reason: 'Not anchored' };
    }

    const startTime = this.now();
    const updateTimings = this.profileUpdates ? {} : null;
    const timingStart = this._startUpdateTiming(updateTimings);
    const timestamp = startTime;
    this.frameIndex++;
    this._resetFrameMetrics();

    let src = null;

    try {
      src = this.cv.matFromImageData(imageData);
      const gray = this.keypointTracker.acquireGrayFrame(this.cv);
      this.cv.cvtColor(src, gray, this.cv.COLOR_RGBA2GRAY);
      this._recordUpdateTiming(updateTimings, 'framePrepareMs', timingStart);

      let updateResult;

      if (
        this.anchorState === 'candidate' ||
        (this.anchorState === 'mapping' && this._activeTrackedPointCount() < CANDIDATE_MIN_TRACKABLE_POINTS)
      ) {
        const stageStart = this._startUpdateTiming(updateTimings);
        updateResult = this._updateProgressiveBootstrap(gray, timestamp);
        this._recordUpdateTiming(updateTimings, 'bootstrapUpdateMs', stageStart);
      } else if (
        this.anchorState === 'mapping' ||
        this.anchorState === 'tracking' ||
        this.anchorState === 'stable'
      ) {
        const stageStart = this._startUpdateTiming(updateTimings);
        updateResult = await this._updateWithKeypoints(
          gray,
          timestamp,
          depthContext,
          updateTimings,
          imageData,
        );
        this._recordUpdateTiming(updateTimings, 'keypointUpdateMs', stageStart);

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
            maxFailures: this.maxKeypointFailures,
          });

          // Only degrade after multiple consecutive failures
          if (this.keypointFailureCount >= this.maxKeypointFailures) {
            this.anchorState = 'lost';
            updateResult = {
              success: false,
              targetPresent: false,
              reason: updateResult.reason,
              position: this.currentPosition,
              normal: this.currentNormal,
              planarTransform: this.currentPlanarTransform,
              confidence: 0,
              method: 'target-lost',
              state: this.anchorState,
              recoverable: true,
            };
          } else {
            updateResult = {
              success: true,
              targetPresent: false,
              reason: `Keypoint failure ${this.keypointFailureCount}/${this.maxKeypointFailures}: ${updateResult.reason}`,
              position: this.currentPosition,
              normal: this.currentNormal,
              planarTransform: this.currentPlanarTransform,
              confidence: Math.max(0, (this.metrics.trackingSuccessRate || 0) * 0.5),
              method: 'held-last-pose',
              state: this.anchorState,
              recoverable: true,
            };
          }
        } else if (updateResult.success) {
          this.keypointFailureCount = 0;
        }
      } else if (this.anchorState === 'degraded') {
        const stageStart = this._startUpdateTiming(updateTimings);
        const recoveryResult = await this._updateWithKeypoints(
          gray,
          timestamp,
          depthContext,
          updateTimings,
          imageData,
        );
        this._recordUpdateTiming(updateTimings, 'keypointUpdateMs', stageStart);
        if (recoveryResult.success) {
          this.anchorState = 'tracking';
          this.keypointFailureCount = 0;
          updateResult = { ...recoveryResult, targetPresent: true, state: this.anchorState };
        } else if (this._canResumeProgressiveBootstrap()) {
          this.anchorState = 'candidate';
          const readiness = this._createReadiness({
            state: this.anchorState,
            poseSource: null,
            reconstructionReady: false,
          });
          updateResult = {
            ...recoveryResult,
            success: false,
            targetPresent: false,
            position: this.currentPosition,
            normal: this.currentNormal,
            planarTransform: this.currentPlanarTransform,
            confidence: 0,
            method: 'progressive-bootstrap-reset',
            state: this.anchorState,
            readiness,
            recoverable: true,
          };
        } else {
          this.anchorState = 'lost';
          updateResult = {
            ...recoveryResult,
            success: false,
            targetPresent: false,
            position: this.currentPosition,
            normal: this.currentNormal,
            planarTransform: this.currentPlanarTransform,
            confidence: 0,
            method: 'global-relocalization-search',
            state: this.anchorState,
            recoverable: true,
          };
        }
      } else if (this.anchorState === 'lost') {
        const stageStart = this._startUpdateTiming(updateTimings);
        const recoveryResult = await this._updateWithKeypoints(
          gray,
          timestamp,
          depthContext,
          updateTimings,
          imageData,
          { requireGlobalRelocalization: true },
        );
        this._recordUpdateTiming(updateTimings, 'keypointUpdateMs', stageStart);
        if (recoveryResult.success) {
          this.anchorState = 'tracking';
          this.keypointFailureCount = 0;
          updateResult = { ...recoveryResult, targetPresent: true, state: this.anchorState };
        } else {
          this.anchorState = 'lost';
          updateResult = {
            ...recoveryResult,
            success: false,
            targetPresent: false,
            position: this.currentPosition,
            normal: this.currentNormal,
            planarTransform: this.currentPlanarTransform,
            confidence: 0,
            method: 'global-relocalization-search',
            state: this.anchorState,
            recoverable: true,
          };
        }
      }

      if (!updateResult.success && !updateResult.recoverable) {
        this.anchorState = 'lost';
        updateResult = {
          ...updateResult,
          targetPresent: false,
          position: this.currentPosition,
          normal: this.currentNormal,
          planarTransform: this.currentPlanarTransform,
          confidence: 0,
          method: updateResult.method || 'target-lost',
          state: this.anchorState,
          recoverable: true,
        };
      }

      if (updateResult.targetPresent === false || !updateResult.success) {
        if (this.anchorState === 'lost') {
          this.metrics.recoveryAttempts++;
          this.metrics.lostFrameCount = (this.metrics.lostFrameCount || 0) + 1;
        }
        this.metrics.lastFailureReason = updateResult.reason || 'Keypoint tracking failed';
        this.metrics.lastFailureStage = 'keypoint-tracking';
      } else {
        // Reset recovery attempts on success
        this.metrics.recoveryAttempts = 0;
        this.metrics.lostFrameCount = 0;
        this.metrics.lastFailureReason = null;
        this.metrics.lastFailureStage = null;
      }

      if (updateTimings) {
        updateTimings.totalMs = performance.now() - timingStart;
      }
      this._recordAnchorUpdateResult(updateResult, this.now() - startTime, updateTimings);

      this._notifyStateChange();
      return updateResult;
    } catch (error) {
      const reason = `Update exception: ${error.message}`;
      this.metrics.lastFailureReason = reason;
      this.metrics.lastFailureStage = 'update-exception';
      if (updateTimings) {
        updateTimings.totalMs = performance.now() - timingStart;
      }
      this._recordAnchorUpdateResult(
        {
          success: false,
          reason,
          position: this.currentPosition,
          normal: this.currentNormal,
          planarTransform: this.currentPlanarTransform,
          confidence: 0,
          method: 'update-exception',
          targetPresent: false,
          recoverable: false,
          state: this.anchorState,
        },
        this.now() - startTime,
        updateTimings,
      );
      this._notifyStateChange();
      logger.error('ImageAnchor', 'Update exception:', error);
      throw error;
    } finally {
      if (src) {
        src.delete();
      }
    }
  }

  /**
   * Update using keypoint tracking and homography
   */
  async _updateWithKeypoints(
    grayImage,
    timestamp,
    depthContext = {},
    updateTimings = null,
    imageData = null,
    { requireGlobalRelocalization = false } = {},
  ) {
    let relocalizationAttempted = false;
    let relocalizedThisUpdate = false;
    let relocalizationFrameFeatures = null;
    let anchorPositionEvaluation;
    const attemptRelocalization = async (reason, { searchRegion = null } = {}) => {
      if (relocalizationAttempted) {
        return {
          success: false,
          reason: 'Descriptor relocalization already attempted during this update',
        };
      }

      relocalizationAttempted = true;
      const relocalizationStart = this._startUpdateTiming(updateTimings);
      const result = await this._attemptKeyframeRelocalization(grayImage, reason, searchRegion, imageData, {
        minimumInliers: requireGlobalRelocalization
          ? MIN_GLOBAL_RELOCALIZATION_INLIERS
          : MIN_LOCAL_RELOCALIZATION_INLIERS,
      });
      relocalizationFrameFeatures = result.frameFeatures || null;
      if (result.success) {
        relocalizedThisUpdate = true;
        // Descriptor restoration replaces the point geometry behind any earlier evaluation.
        anchorPositionEvaluation = null;
      }
      if (updateTimings && result.timings) {
        updateTimings.relocalizationFeatureExtractionMs = result.timings.featureExtractionMs;
        updateTimings.relocalizationKeyframeSearchMs = result.timings.keyframeSearchMs;
      }
      this._recordUpdateTiming(updateTimings, 'relocalizationMs', relocalizationStart);
      return result;
    };

    let stageStart = this._startUpdateTiming(updateTimings);
    let trackingResult;
    if (requireGlobalRelocalization) {
      const relocalizationResult = await attemptRelocalization(
        'Target lost; global descriptor relocalization required',
      );
      if (!relocalizationResult.success) {
        return {
          success: false,
          targetPresent: false,
          reason: relocalizationResult.reason,
          state: this.anchorState,
        };
      }
      trackingResult = relocalizationResult.trackingResult;
    } else {
      trackingResult = this.keypointTracker.trackFrame(this.cv, grayImage);
      this._recordUpdateTiming(updateTimings, 'keypointTrackMs', stageStart);
      if (this._canAdmitPartialFlow(trackingResult)) {
        trackingResult.success = true;
        trackingResult.reason = null;
        trackingResult.admission = 'partial-occlusion-consensus';
      }
    }
    const trackingValidationStart = this._startUpdateTiming(updateTimings);

    if (!trackingResult.success) {
      const relocalizationResult = await attemptRelocalization(trackingResult.reason);
      if (relocalizationResult.success) {
        trackingResult = relocalizationResult.trackingResult;
      } else {
        logger.warn('ImageAnchor', 'Keypoint tracking failed:', {
          ...trackingResult,
          trackerState: {
            initialized: this.keypointTracker.initialized,
            hasTrackedPoints: this.keypointTracker.trackedPoints?.length || 0,
            hasPreviousGray: !!this.keypointTracker.previousGray,
          },
        });
        this._recordUpdateTiming(updateTimings, 'trackingValidationMs', trackingValidationStart);
        return {
          success: false,
          targetPresent: false,
          reason: relocalizationResult.reason || trackingResult.reason || 'Keypoint tracking failed',
          state: this.anchorState,
        };
      }
    }

    this.metrics.landmarkOwnershipPromoted = 0;
    const maskRejected = relocalizedThisUpdate ? 0 : this._rejectTrackedPointsOutsideObjectSupport();
    if (maskRejected > 0) {
      const activeAfterMaskValidation = this._activeTrackedPointCount();
      trackingResult.activePointCount = activeAfterMaskValidation;
      this.metrics.backgroundRejected = (this.metrics.backgroundRejected || 0) + maskRejected;
    }

    this.metrics.trackingSuccessRate = trackingResult.successRate || 0;
    this.metrics.keypointCount = trackingResult.activePointCount || 0;
    this.metrics.partialOcclusionFlow = trackingResult.partialFlow;
    this.metrics.trackingAdmission = trackingResult.admission ?? 'standard-lk';
    stageStart = this._startUpdateTiming(updateTimings);
    this._recordLandmarkMetrics();
    this._updateObjectSurfaceMetrics({
      objectSupportMask: this._getCurrentObjectSupportMask(),
      poseResidual: trackingResult.averageError ?? null,
    });
    this._recordUpdateTiming(updateTimings, 'landmarkMetricsMs', stageStart);

    const minSuccessRate = 0.45;
    const minActivePoints = 8;

    const partialOcclusionSupported =
      trackingResult.admission === 'partial-occlusion-consensus' &&
      (this.metrics.objectOwnedLandmarks ?? 0) >= minActivePoints;
    if (
      (this.metrics.trackingSuccessRate < minSuccessRate && !partialOcclusionSupported) ||
      this.metrics.keypointCount < minActivePoints
    ) {
      const relocalizationResult = await attemptRelocalization('Insufficient keypoint tracking quality');
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
          minActivePoints,
        });

        if (trackingResult.centroid) {
          this.currentPosition = {
            x: this.positionFilterX.filter(trackingResult.centroid.x, timestamp),
            y: this.positionFilterY.filter(trackingResult.centroid.y, timestamp),
            z: 0,
          };

          this._recordUpdateTiming(updateTimings, 'trackingValidationMs', trackingValidationStart);
          return {
            success: true,
            targetPresent: true,
            position: this.currentPosition,
            normal: this.currentNormal,
            confidence: this.metrics.trackingSuccessRate,
            method: 'keypoint_centroid_only',
            state: this.anchorState,
          };
        }

        this._recordUpdateTiming(updateTimings, 'trackingValidationMs', trackingValidationStart);
        return {
          success: false,
          targetPresent: false,
          reason: 'Insufficient keypoint tracking quality',
          state: this.anchorState,
        };
      }
    }

    stageStart = this._startUpdateTiming(updateTimings);
    anchorPositionEvaluation = this.keypointTracker.createAnchorPositionEvaluation();
    this._recordUpdateTiming(updateTimings, 'preliminaryAttachmentEvidenceMs', stageStart);
    const preliminaryAnchorPosition = anchorPositionEvaluation.position;
    const validateRelocalizedReference =
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL &&
      preliminaryAnchorPosition?.referenceFrame === 'orb-keyframe' &&
      this.frameIndex - this.lastSuccessfulRelocalizationFrame >= this.relocalizationValidationInterval;
    if (
      this._shouldAttemptGeometryRelocalization(preliminaryAnchorPosition) ||
      validateRelocalizedReference
    ) {
      const relocalizationResult = await attemptRelocalization(
        validateRelocalizedReference
          ? 'Validating recovered ORB reference geometry'
          : 'Reference geometry became incoherent',
        {
          searchRegion: this._selectGeometryRelocalizationSearchRegion(grayImage),
        },
      );
      if (relocalizationResult.success) {
        trackingResult = relocalizationResult.trackingResult;
        this.metrics.trackingSuccessRate = trackingResult.successRate || 0;
        this.metrics.keypointCount = trackingResult.activePointCount || 0;
        this._recordLandmarkMetrics();
      }
    }

    this._recordUpdateTiming(updateTimings, 'trackingValidationMs', trackingValidationStart);

    this.metrics.homographyInliers = 0;
    this.metrics.affinePoseInliers = 0;
    this.metrics.objectPoseInliers = 0;
    this.metrics.reconstructionPoseInliers = 0;
    this.metrics.reconstructionPoseNormal = null;
    this.metrics.reconstructionPoseNormalDetached = false;
    this.metrics.poseObs = null;
    this.metrics.reconstructionPnpInliers = 0;
    this.metrics.reconstructionPnpAverageResidual = null;
    this.metrics.poseInliers = 0;
    this.metrics.poseSource = null;
    this.metrics.poseSourceHoldReason = null;
    this.metrics.poseNormalRole = null;
    this.metrics.poseNormalReason = null;
    this.metrics.poseNormalCandidateSource = null;
    this.metrics.planarPnpBranchSelection = null;
    this.metrics.poseModel = isReconstructionMode(this.trackingMode) ? this.trackingMode : POSE_MODEL;
    const poseEstimationStart = this._startUpdateTiming(updateTimings);
    stageStart = this._startUpdateTiming(updateTimings);
    const objectPose = this._estimateObjectPoseFromTracker();
    this._recordUpdateTiming(updateTimings, 'objectPoseMs', stageStart);
    const reconstructionPose = this._updateReconstructionPoseFromTracker(
      timestamp,
      grayImage,
      depthContext,
      updateTimings,
      imageData,
    );

    stageStart = this._startUpdateTiming(updateTimings);
    const skipPlanarPose = this._shouldSkipPlanarPoseForSelectedReconstruction(reconstructionPose);
    const poseAttempt = skipPlanarPose
      ? {
          options: this._getPoseCorrespondenceOptions(),
          correspondences: reconstructionPose.correspondences || [],
          poseResult: null,
        }
      : this._estimatePoseFromTracker();
    const poseCorrespondenceOptions = poseAttempt.options;
    const correspondences = poseAttempt.correspondences;
    const poseResult = poseAttempt.poseResult;
    const planarPose = skipPlanarPose ? null : this._createPlanarHomographyPose(poseResult, correspondences);
    if (!skipPlanarPose) {
      this._updatePlanarDominance(planarPose, correspondences);
    }
    this._recordUpdateTiming(updateTimings, 'planarPoseMs', stageStart);
    this._recordUpdateTiming(updateTimings, 'poseEstimationMs', poseEstimationStart);
    this.metrics.poseKeypointCount = correspondences.length;
    this.metrics.posePatchRadius = poseCorrespondenceOptions.maxReferenceDistance;

    if (poseResult?.success) {
      this._recordPoseInlierMetrics(poseResult);
    }

    let newPosition = null;
    let positionMethod = 'unknown';
    let planarTransform = this.currentPlanarTransform;

    const poseSelectionStart = this._startUpdateTiming(updateTimings);
    if (!anchorPositionEvaluation) {
      stageStart = this._startUpdateTiming(updateTimings);
      anchorPositionEvaluation = this.keypointTracker.createAnchorPositionEvaluation();
      this._recordUpdateTiming(updateTimings, 'trackerAttachmentEvidenceMs', stageStart);
    }
    stageStart = this._startUpdateTiming(updateTimings);
    const rawTrackerAnchorPosition = this.keypointTracker.resolveAnchorPositionEvaluation(
      this.cv,
      anchorPositionEvaluation,
      {
        preferObjectWideSimilarity: this._shouldPreferObjectWideTrackerSimilarity(),
      },
    );
    this._recordUpdateTiming(updateTimings, 'trackerAttachmentResolveMs', stageStart);
    this.metrics.trackerReferenceScope = rawTrackerAnchorPosition?.referenceScope || null;
    this.metrics.trackerLocalReferenceResidual = rawTrackerAnchorPosition?.localReferenceResidual ?? null;
    const trackerAnchorPosition = this._selectTrackerAnchorPosition({
      trackerAnchorPosition: rawTrackerAnchorPosition,
      reconstructionPose,
    });
    const reconstructionConsistentWithTracker = this._isPosePositionConsistentWithTracker(
      reconstructionPose,
      trackerAnchorPosition,
    );
    const poseArbitration = this._recordPoseCandidates({
      reconstructionPose,
      planarPose,
      objectPose,
      poseResult,
      trackerAnchorPosition,
      reconstructionConsistentWithTracker,
      correspondences,
    });
    if (
      this._hasRigidPlanarTargetClass() &&
      poseResult?.success &&
      poseResult.method === 'homography' &&
      poseResult.rotationVector &&
      poseArbitration.byRole.planar?.normalAllowed === true
    ) {
      this.homographyEstimator.commitPlanarPnPPose(poseResult);
    } else {
      this.homographyEstimator.breakPoseContinuity();
    }
    const planarPoseUsableForTransform = poseArbitration.byRole.planar?.positionAllowed === true;
    const useStrongCurvedReconstructionPosition =
      this._hasStrongCurvedReconstructionPosition(reconstructionPose);
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
    const rejectDivergentCurvedPosition = this._shouldRejectDivergentCurvedPosition(reconstructionPose);
    const selectedReconstructionPositionReady = selectedReconstructionReady && !rejectDivergentCurvedPosition;
    const suppressReconstructionForPlanarTarget =
      this._hasPlanarDominance() &&
      !selectedReconstructionReady &&
      !planarPoseUsableForTransform &&
      ((this.trackingMode === RECONSTRUCTION_POSE_MODEL && this._hasPlanarTargetClass()) ||
        !this._hasStrongNonPlanarReconstruction(reconstructionPose) ||
        !reconstructionConsistentWithTracker);
    const preferPlanarPose = this._shouldPreferPlanarHomography({
      planarPose,
      reconstructionPose,
      correspondences,
    });
    const usePlanarPatchTransform = this._shouldUsePlanarPatchTransform({
      planarPose,
      reconstructionPose,
      correspondences,
    });
    const suppressImmatureSparsePlanarMap =
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasPlanarTargetClass() &&
      this._hasPlanarDominance() &&
      ((this.metrics.reconstructionMatureLandmarks || 0) < 18 ||
        (this.metrics.reconstructionPoseInliers || 0) <= 10);
    const holdPlanarTrackerAttachment = this._shouldHoldTrackerAttachmentForPlanarReconstruction({
      planarPoseUsable: planarPoseUsableForTransform,
      reconstructionPose,
    });
    const rejectedReconstruction = poseArbitration.byRole.reconstruction?.attachmentRejectionReason || null;
    const useArbiterPlanarPosition = this._shouldUseArbiterPlanarPosition({
      poseArbitration,
      planarPose,
      trackerAnchorPosition,
    });
    const useArbiterReconstructionPosition =
      !rejectDivergentCurvedPosition &&
      this._shouldUseArbiterReconstructionPosition({
        poseArbitration,
        reconstructionPose,
        trackerAnchorPosition,
      });
    const holdDepthFusionTrackerPosition = this._shouldHoldTrackerPositionForDepthFusion({
      trackerAnchorPosition,
      reconstructionPose,
      useArbiterReconstructionPosition,
    });
    const reconstructionCandidateAllowed =
      !rejectDivergentCurvedPosition &&
      (!rejectedReconstruction ||
        rejectedReconstruction === 'low-confidence' ||
        selectedReconstructionPositionReady ||
        useStrongCurvedReconstructionPosition ||
        useModerateCurvedReconstructionRecovery ||
        useArbiterReconstructionPosition);
    const positionSelection = selectPosePositionOwner({
      arbitration: poseArbitration,
      policy: {
        preferPlanar: preferPlanarPose,
        usePlanarPatch: usePlanarPatchTransform,
        useArbiterPlanar: useArbiterPlanarPosition,
        reconstructionAllowed: reconstructionCandidateAllowed,
        releaseWeakTracker: this._hasRigidPlanarTargetClass() && this._hasPlanarDominance(),
        holdDepthFusionTracker: holdDepthFusionTrackerPosition,
        reconstructionConsistentWithTracker,
        useStrongReconstruction: useStrongCurvedReconstructionPosition,
        useModerateReconstruction: useModerateCurvedReconstructionRecovery,
        useArbiterReconstruction: useArbiterReconstructionPosition,
        suppressImmatureReconstruction: suppressImmatureSparsePlanarMap,
        suppressPlanarTargetReconstruction: suppressReconstructionForPlanarTarget,
        holdPlanarTrackerAttachment,
        useTrackedReconstructionTransform: useTrackedCurvedAttachmentTransform,
        useBlendedReconstructionTransform: useBlendedCurvedAttachmentTransform,
      },
    });
    this.metrics.posePositionRole = positionSelection?.role || null;
    this.metrics.posePositionReason = positionSelection?.reason || null;
    const absoluteRelocalization = requireGlobalRelocalization && relocalizedThisUpdate;

    if (positionSelection?.role === 'planar') {
      newPosition = this._filterPositionCandidate(
        this._posePositionCandidate(planarPose),
        timestamp,
        planarPose.method,
        { absoluteRelocalization },
      );
      positionMethod = planarPose.method;
      planarTransform = this._updatePlanarTransform(
        this._selectPlanarAttachmentTransform({
          planarPose,
          trackerAnchorPosition,
          correspondences,
        }),
        timestamp,
        { absoluteRelocalization },
      );
      this._recordPlanarHomographyMetrics(planarPose);
    } else if (positionSelection?.role === 'reconstruction') {
      const reconstructionPosition = this._selectReconstructionPositionCandidate({
        reconstructionPose,
        poseArbitration,
        trackerAnchorPosition,
      });
      newPosition = this._filterPositionCandidate(
        reconstructionPosition,
        timestamp,
        reconstructionPose.method,
        { absoluteRelocalization },
      );
      if (reconstructionPosition.adjustment) {
        this.metrics.positionFilterAdjustment = reconstructionPosition.adjustment;
      }
      positionMethod = reconstructionPose.method;
      const selectedReconstructionTransform = this._adjustSelectedCurvedPlanarTransform(
        reconstructionPose.planarTransform,
        reconstructionPose,
      );
      const reconstructionTransform =
        positionSelection.transform === 'tracker-reconstruction'
          ? this._selectTrackedAttachmentTransform({
              trackerAnchorPosition,
              reconstructionPose,
              useTrackedTransform: true,
            })
          : positionSelection.transform === 'blended-reconstruction'
            ? this._selectBlendedCurvedAttachmentTransform({
                trackerAnchorPosition,
                reconstructionPose,
              })
            : selectedReconstructionTransform;
      planarTransform = this._updatePlanarTransform(reconstructionTransform, timestamp, {
        absoluteRelocalization,
      });
      this._recordReconstructionPoseMetrics(reconstructionPose);
    } else if (positionSelection?.role === 'object') {
      newPosition = this._filterPositionCandidate(
        this._posePositionCandidate(objectPose),
        timestamp,
        objectPose.method,
        { absoluteRelocalization },
      );
      positionMethod = objectPose.method;
      planarTransform = this._updatePlanarTransform(objectPose.planarTransform, timestamp, {
        absoluteRelocalization,
      });
      this._recordObjectPoseMetrics(objectPose);
    } else if (positionSelection?.role === 'tracker') {
      newPosition = this._filterPositionCandidate(
        trackerAnchorPosition,
        timestamp,
        trackerAnchorPosition.method,
        { absoluteRelocalization },
      );
      positionMethod = trackerAnchorPosition.method;
      const trackerTransform =
        positionSelection.transform === 'blended-reconstruction'
          ? this._selectBlendedCurvedAttachmentTransform({
              trackerAnchorPosition,
              reconstructionPose,
            })
          : this._selectTrackedAttachmentTransform({
              trackerAnchorPosition,
              reconstructionPose,
              useTrackedTransform: true,
            });
      planarTransform = this._updatePlanarTransform(trackerTransform, timestamp, { absoluteRelocalization });

      if (
        positionSelection.reason === 'depth-fusion-tracker-spine' ||
        positionSelection.reason === 'reconstruction-inconsistent-with-tracker'
      ) {
        this._recordReconstructionPoseMetrics(reconstructionPose, { active: false });
      } else if (positionSelection.reason === 'planar-pose-dropout' && objectPose.success) {
        this._recordObjectPoseMetrics(objectPose, { active: false });
      } else if (positionSelection.reason === 'tracker-fallback' && objectPose.success) {
        this.metrics.poseRejectedReason = this._getPoseRejectionReason(
          objectPose,
          objectPose.correspondences || correspondences,
        );
        this._recordObjectPoseMetrics(objectPose, { active: false });
      }
    }

    if (!newPosition) {
      logger.warn('ImageAnchor', 'No position data available from tracking or homography');
      this._recordUpdateTiming(updateTimings, 'poseSelectionMs', poseSelectionStart);
      return {
        success: false,
        reason: 'No position data available',
        state: this.anchorState,
      };
    }

    this.currentPosition = newPosition;
    const { selection: normalSelection, pose: normalPose } = this._resolveNormalPose({
      poseArbitration,
      reconstructionPose,
      planarPose,
      objectPose,
      poseResult,
      correspondences,
      preferPlanar: preferPlanarPose,
    });
    this.metrics.poseNormalRole = normalSelection?.role || null;
    this.metrics.poseNormalReason = normalSelection?.reason || null;
    this.metrics.poseNormalCandidateSource = normalPose?.method || null;
    this.metrics.poseSourceHoldReason = poseArbitration.candidates.some(
      (candidate) => candidate.normalRejectionReason === 'transient-reconstruction-dropout',
    )
      ? 'transient-reconstruction-dropout'
      : null;

    if (normalPose) {
      const poseConfidence = this._calculatePoseConfidence(
        normalPose,
        normalPose.correspondences || correspondences,
      );
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
    } else if (poseResult?.success) {
      this.framesWithoutNormalPose++;
      this.metrics.rawPoseNormal = null;
      this.metrics.poseSource = null;
      this.metrics.poseRejectedReason =
        this.metrics.poseSourceHoldReason || this._getPoseRejectionReason(poseResult, correspondences);
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
      this.currentNormal = this.normalStabilizer.update(
        { x: 0, y: 0, z: 1 },
        {
          confidence: 0.55,
          inliers: 12,
          foreshortening: 0.98,
        },
      );
      this.metrics.normalRelaxation = 'curved-surface-pose-dropout';
    } else {
      this.metrics.normalRelaxation = null;
    }

    const poseInliers = this.metrics.poseInliers || 0;
    const overallQuality = (this.metrics.trackingSuccessRate + Math.min(1.0, poseInliers / 30)) / 2;
    this.anchorState = this._selectTrackingState({ overallQuality, poseInliers });
    this._recordUpdateTiming(updateTimings, 'poseSelectionMs', poseSelectionStart);

    // Descriptor relocalization restores pose from a deliberately small, strict inlier set.
    // Grow the LK map once in that recovered coordinate frame so the next occlusion does not
    // depend on the same sparse descriptor subset.
    this.framesSinceRefresh++;
    const relocalizationGrowth =
      relocalizedThisUpdate &&
      this.metrics.activeLandmarkCount >= 5 &&
      this.metrics.activeLandmarkCount < RELOCALIZATION_MAP_GROWTH_TARGET;
    if (relocalizationGrowth) {
      this.metrics.landmarkRefreshReason = 'relocalization-growth';
      const refreshOutcome = this._refreshKeypoints(grayImage, {
        adaptive: true,
        minNewKeypoints: RELOCALIZATION_MAP_GROWTH_MIN_CANDIDATES,
        storeFreshRelocalizationKeyframe: true,
        frameFeatures: relocalizationFrameFeatures,
        ...(imageData ? { learnedImageData: imageData } : {}),
        anchorPositionEvaluation,
        updateTimings,
      });
      if (refreshOutcome.success) {
        this.framesSinceRefresh = 0;
      }
    }

    // Periodic keypoint refresh grows the persistent landmark map while tracking is usable.
    if (!relocalizationGrowth && this._shouldRefreshKeypoints({ overallQuality, poseInliers })) {
      const adaptiveRefresh = [
        'object-support-recovery',
        'mapping-growth',
        'support-growth',
        'support-recovery',
      ].includes(this.metrics.landmarkRefreshReason);
      const refreshOutcome = this._refreshKeypoints(grayImage, {
        adaptive: adaptiveRefresh,
        minNewKeypoints: adaptiveRefresh ? CANDIDATE_MIN_TRACKABLE_POINTS : 15,
        frameFeatures: relocalizationFrameFeatures,
        ...(imageData ? { learnedImageData: imageData } : {}),
        anchorPositionEvaluation,
        updateTimings,
      });
      const shouldReinitialize =
        !refreshOutcome.success && adaptiveRefresh && this._shouldReinitializeAfterFailedSupportRefresh();
      let reinitializationOutcome = null;
      if (shouldReinitialize) {
        const supportMask = this.objectSupportMask;
        const recoveryAnchor = this._createSupportRecoveryPosition(rawTrackerAnchorPosition);
        reinitializationOutcome = this._reinitializeKeypoints(grayImage, {
          minKeypoints: CANDIDATE_MIN_TRACKABLE_POINTS,
          objectSupportMask: supportMask,
          region: supportMask ? this._calculateObjectSupportTrackingRegion(supportMask, null) : null,
          anchorPosition: recoveryAnchor,
          resetReconstruction: true,
          reason: 'support-recovery-reference-collapse',
          updateTimings,
        });
        this.metrics.landmarkRefreshCandidateCount = reinitializationOutcome.candidateCount;
        if (!reinitializationOutcome.success) {
          this.metrics.landmarkRefreshFailureReason = reinitializationOutcome.status;
        }
      }
      if (refreshOutcome.success || reinitializationOutcome?.success) {
        this.framesSinceRefresh = 0;
      }
    }
    this._storeRelocalizationKeyframe(grayImage, {
      frameFeatures: relocalizationFrameFeatures,
      ...(imageData ? { learnedImageData: imageData } : {}),
      updateTimings,
    });

    return {
      success: true,
      targetPresent: true,
      position: this.currentPosition,
      normal: this.currentNormal,
      planarTransform,
      confidence: overallQuality,
      positionConfidence: newPosition.confidence ?? null,
      positionAverageResidual: newPosition.averageResidual ?? null,
      positionInlierCount: newPosition.inlierCount ?? null,
      method: positionMethod,
      inliers: poseInliers,
      poseSource: this.metrics.poseSource,
      state: this.anchorState,
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
      this.currentPlanarTransform = this._updatePlanarTransform(
        {
          scale: recoveryResult.scale,
          rotation: this.currentPlanarTransform?.rotation || 0,
          confidence: recoveryResult.confidence,
          inlierCount: 0,
          method: recoveryResult.method,
        },
        timestamp,
      );
    }

    let trackingResult = null;
    const hasTrackableBootstrap = this._activeTrackedPointCount() >= CANDIDATE_TRACKING_MIN_POINTS;
    if (hasTrackableBootstrap) {
      trackingResult = this.keypointTracker.trackCandidate(this.cv, grayImage);
      if (trackingResult.success) {
        this._rejectTrackedPointsOutsideObjectSupport();
        const anchorPosition = this.keypointTracker.getAnchorPosition(this.cv);
        if (anchorPosition && this._activeTrackedPointCount() >= CANDIDATE_TRACKING_MIN_POINTS) {
          this.currentPosition = {
            x: this.positionFilterX.filter(anchorPosition.x, timestamp),
            y: this.positionFilterY.filter(anchorPosition.y, timestamp),
            z: 0,
          };
          this.currentPlanarTransform = this._updatePlanarTransform(
            {
              scale: anchorPosition.scale ?? this.currentPlanarTransform?.scale ?? 1,
              rotation: anchorPosition.rotation ?? this.currentPlanarTransform?.rotation ?? 0,
              confidence: anchorPosition.confidence ?? trackingResult.successRate ?? 0.5,
              inlierCount: anchorPosition.inlierCount ?? trackingResult.activePointCount ?? 0,
              method: anchorPosition.method ?? 'candidate-tracking',
            },
            timestamp,
          );
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
      region.y,
    );

    const activeBeforeRefresh = this._activeTrackedPointCount();
    if (activeBeforeRefresh < 3 && keypointResult.keypoints.length > 0) {
      this.keypointTracker.initializeTracking(this.cv, keypointResult.keypoints, grayImage, {
        tapPosition: this.currentPosition,
        admission: 'trusted-selection',
      });
    } else if (keypointResult.keypoints.length > 0) {
      const refreshPlan = this.keypointTracker.planKeypointRefresh(this.cv);
      if (refreshPlan.kind === 'reference') {
        this.keypointTracker.refreshKeypoints({
          cv: this.cv,
          plan: refreshPlan,
          currentGray: grayImage,
          keypointDetector: this.keypointDetector,
          region,
          objectSupportMask,
          minNewKeypoints: CANDIDATE_MIN_TRACKABLE_POINTS,
          adaptive: true,
        });
      }
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
      trackingSuccessRate:
        trackingResult?.successRate ?? (activeLandmarks >= CANDIDATE_MIN_TRACKABLE_POINTS ? 0.5 : 0),
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
      targetPresent: true,
      position: this.currentPosition,
      normal: this.currentNormal,
      planarTransform: this.currentPlanarTransform,
      confidence:
        trackingResult?.successRate ?? (activeLandmarks >= CANDIDATE_MIN_TRACKABLE_POINTS ? 0.5 : 0.25),
      method: recoveryResult.success ? 'candidate_template_bootstrap' : 'candidate_landmark_bootstrap',
      state: this.anchorState,
      readiness,
      evidence,
      recoverable: true,
    };
  }

  async _attemptKeyframeRelocalization(
    grayImage,
    failureReason,
    searchRegion = null,
    imageData = null,
    { minimumInliers = MIN_LOCAL_RELOCALIZATION_INLIERS } = {},
  ) {
    const hasOrbKeyframes = this.relocalizer.hasKeyframes();
    if (!hasOrbKeyframes && !this.learnedReferencePromise) {
      return {
        success: false,
        reason: failureReason || 'No descriptor keyframes available for relocalization',
      };
    }

    const orbResult = hasOrbKeyframes
      ? searchRegion
        ? this.relocalizer.relocalize(this.cv, grayImage, { searchRegion })
        : this.relocalizer.relocalize(this.cv, grayImage)
      : {
          success: false,
          reason: 'No ORB keyframe available',
          queryFeatureCount: 0,
          matchCount: 0,
          inlierCount: 0,
        };
    let relocalizationResult = orbResult;
    let learnedResult = null;
    const learnedRelocalizationDue =
      this.frameIndex - this.lastLearnedRelocalizationAttemptFrame >= LEARNED_RELOCALIZATION_INTERVAL;
    if (!orbResult.success && this.learnedReferencePromise && imageData && learnedRelocalizationDue) {
      this.lastLearnedRelocalizationAttemptFrame = this.frameIndex;
      this.metrics.learnedRelocalizationAttempted = true;
      const learnedReference = await this.learnedReferencePromise;
      if (learnedReference.runtimeFailure) {
        logger.warn('ImageAnchor', learnedReference.reason);
      }
      if (this.learnedRelocalizer.hasReference()) {
        learnedResult = await this.learnedRelocalizer
          .relocalize(imageData)
          .then((result) => result, learnedRuntimeFailure);
        if (learnedResult.success) {
          relocalizationResult = {
            ...learnedResult,
            frameFeatures: orbResult.frameFeatures || null,
          };
        }
      }
    }
    if (learnedResult?.runtimeFailure) {
      logger.warn('ImageAnchor', learnedResult.reason);
    }
    const requiredInliers = learnedResult?.success
      ? Math.max(minimumInliers, MIN_LEARNED_RELOCALIZATION_INLIERS)
      : minimumInliers;
    this.metrics.relocalizationKeyframes =
      relocalizationResult.keyframeCount || this.metrics.relocalizationKeyframes || 0;
    this.metrics.relocalizationQueryKeypoints = relocalizationResult.queryFeatureCount || 0;
    this.metrics.relocalizationQueryRegion = relocalizationResult.searchRegion ||
      searchRegion || {
        x: 0,
        y: 0,
        width: grayImage.cols,
        height: grayImage.rows,
      };
    this.metrics.relocalizationMatches = relocalizationResult.matchCount || 0;
    this.metrics.relocalizationInliers = relocalizationResult.inlierCount || 0;
    this.metrics.relocalizationConfidence = relocalizationResult.confidence || 0;
    this.metrics.relocalizationAverageResidual = relocalizationResult.averageResidual ?? null;
    this.metrics.relocalizationGeometryModel = relocalizationResult.transform?.model || null;
    this.metrics.relocalizationKeyframeId = relocalizationResult.keyframeId ?? null;
    this.metrics.relocalizationResult = relocalizationResult.success ? 'success' : 'failed';
    this.metrics.relocalizationReason = relocalizationResult.reason || null;
    this.metrics.relocalizationMethod = relocalizationResult.method || null;

    if (!relocalizationResult.success) {
      return {
        success: false,
        reason: relocalizationResult.reason || failureReason || 'Descriptor relocalization failed',
        timings: relocalizationResult.timings,
        frameFeatures: relocalizationResult.frameFeatures || null,
      };
    }

    if (relocalizationResult.inlierCount < requiredInliers) {
      const reason = `Descriptor relocalization found only ${relocalizationResult.inlierCount} inliers; ${requiredInliers} required`;
      this.metrics.relocalizationResult = 'failed';
      this.metrics.relocalizationReason = reason;
      return {
        success: false,
        reason,
        timings: relocalizationResult.timings,
        frameFeatures: relocalizationResult.frameFeatures || null,
      };
    }

    const alignedRelocalization = this._alignRelocalizationAnchorWithCurvedMotion(relocalizationResult);
    const restore = this.keypointTracker.restoreFromRelocalizationMatches(
      grayImage,
      alignedRelocalization.inlierMatches,
      alignedRelocalization,
    );

    if (restore.restored < requiredInliers) {
      const reason = `Descriptor relocalization restored only ${restore.restored} landmarks; ${requiredInliers} required`;
      this.metrics.relocalizationResult = 'failed';
      this.metrics.relocalizationReason = reason;
      return {
        success: false,
        reason,
        timings: relocalizationResult.timings,
        frameFeatures: relocalizationResult.frameFeatures || null,
      };
    }

    this.keypointFailureCount = 0;
    this.lastSuccessfulRelocalizationFrame = this.frameIndex;
    this.metrics.relocalizationSuccessFrame = this.frameIndex;
    this.metrics.relocalizationRestored = restore.restored;
    this.metrics.relocalizationActiveLandmarks = restore.active;

    return {
      success: true,
      method: relocalizationResult.method,
      restore,
      matches: relocalizationResult.matchCount,
      inliers: relocalizationResult.inlierCount,
      confidence: relocalizationResult.confidence,
      timings: relocalizationResult.timings,
      frameFeatures: relocalizationResult.frameFeatures || null,
      trackingResult: {
        success: true,
        successRate: Math.max(0.5, Math.min(1, relocalizationResult.confidence)),
        activePointCount: restore.active,
        averageError: relocalizationResult.averageResidual,
        method: relocalizationResult.method,
        relocalized: true,
      },
    };
  }

  _storeLearnedReference(imageData, accepted = true, extend = false) {
    if (!accepted || !this.learnedRelocalizer || (this.learnedReferencePromise && !extend)) {
      return this.learnedReferencePromise;
    }
    this.learnedReferencePromise = this.learnedRelocalizer
      .storeReference({
        imageData,
        trackedPoints: this.keypointTracker.trackedPoints,
        anchorPoint: this.currentPosition,
      })
      .then((result) => result, learnedRuntimeFailure);
    return this.learnedReferencePromise;
  }

  _storeRelocalizationKeyframe(
    grayImage,
    {
      force = false,
      includeFreshLandmarks = false,
      frameFeatures = null,
      learnedImageData = null,
      updateTimings = null,
    } = {},
  ) {
    const stageStart = this._startUpdateTiming(updateTimings);
    const finish = (value) => {
      this._recordUpdateTiming(updateTimings, 'keyframeStoreMs', stageStart);
      return value;
    };
    this.framesSinceRelocalizationKeyframe++;
    const activePoints = this.keypointTracker.trackedPoints
      ? this.keypointTracker.trackedPoints.filter((point) => point.status === 'active')
      : [];
    const activeCount = activePoints.length;
    const objectOwnedCount = activePoints.filter(isReconstructionEligibleLandmark).length;

    const storedKeyframes = this.relocalizer.getKeyframeCount();
    const keyframeInterval =
      storedKeyframes === 0
        ? 5
        : storedKeyframes === 1
          ? 2
          : activeCount <= 12
            ? 2
            : activeCount <= 18
              ? 3
              : this.relocalizationKeyframeInterval;
    if (!force && this.framesSinceRelocalizationKeyframe < keyframeInterval) {
      return finish(null);
    }

    if (
      !force &&
      (activeCount < 9 || objectOwnedCount < 8 || (this.metrics.trackingSuccessRate || 0) < 0.65)
    ) {
      return finish(null);
    }

    const result = this.relocalizer.storeKeyframe({
      cv: this.cv,
      grayImage,
      trackedPoints: this.keypointTracker.trackedPoints,
      anchorPoint: this.currentPosition,
      timestamp: this.now(),
      includeFreshLandmarks,
      frameFeatures,
      translationInvariantRedundancy: this.rigidPlanarRecoveryEligible,
    });
    if (updateTimings && Number.isFinite(result.featureExtractionMs)) {
      updateTimings.keyframeFeatureExtractionMs =
        (updateTimings.keyframeFeatureExtractionMs || 0) + result.featureExtractionMs;
    }

    this.metrics.relocalizationKeyframes = result.keyframeCount || this.metrics.relocalizationKeyframes || 0;
    this.metrics.relocalizationDescriptors =
      result.descriptorCount || this.metrics.relocalizationDescriptors || 0;
    this.metrics.relocalizationKeyframeResult = result.success ? 'stored' : 'skipped';
    this.metrics.relocalizationKeyframeReason = result.reason || null;

    if (result.success || result.storageEvaluated) {
      this.framesSinceRelocalizationKeyframe = 0;
    }

    if (learnedImageData && (!this.anchorTargetClass || this._hasGenericTargetClass())) {
      this._storeLearnedReference(
        learnedImageData,
        result.success,
        result.keyframeCount === LEARNED_REFERENCE_REFRESH_KEYFRAME_COUNT,
      );
    }

    return finish(result);
  }

  /**
   * Refresh keypoints in current region
   */
  _refreshKeypoints(
    grayImage,
    {
      adaptive = false,
      minNewKeypoints = 15,
      storeFreshRelocalizationKeyframe = false,
      frameFeatures = null,
      learnedImageData = null,
      anchorPositionEvaluation = null,
      updateTimings = null,
    } = {},
  ) {
    if (!this.currentPosition) {
      return {
        success: false,
        status: 'failed',
        reason: 'missing-anchor-position',
      };
    }

    const stageStart = this._startUpdateTiming(updateTimings);

    const objectSupportMask = this._getCurrentObjectSupportMask();
    const region = this._getAnchoredTrackingRegion(grayImage, {
      allowExpansion: this._shouldUseExpandedTrackingRegion(),
    });
    const recoveryReferenceTransform = this._createRecoveryReferenceTransform();
    const refreshPlan = this.keypointTracker.planKeypointRefresh(this.cv, {
      recoveryReferenceTransform,
      attachmentEvidence: anchorPositionEvaluation?.attachmentEvidence || null,
    });
    const refreshOptions = {
      adaptive,
      minNewKeypoints,
      admission: this._shouldQuarantineFreshRecoveryLandmarks() ? 'recovery-probation' : 'routine-refresh',
      candidateOrder: COVERAGE_BALANCED_REFRESH_REASONS.has(this.metrics.landmarkRefreshReason)
        ? 'mask-coverage'
        : 'response-ranked',
    };
    const refreshOutcome =
      refreshPlan.kind === 'no-reference'
        ? {
            success: false,
            status: this._isSupportRefreshReinitializationEligible()
              ? 'reinitialization-required'
              : 'skipped',
            added: 0,
            recovered: 0,
            probationaryAdded: 0,
            rejectedByMask: 0,
            total: refreshPlan.total,
            active: refreshPlan.activeCount,
            candidateCount: null,
            gfttCallCount: 0,
            gfttPixelCount: 0,
            gfttPreparationCount: 0,
            minNewKeypoints,
            referenceTransformSource: null,
            reason: 'no-reference-transform',
          }
        : this.keypointTracker.refreshKeypoints({
            cv: this.cv,
            plan: refreshPlan,
            currentGray: grayImage,
            keypointDetector: this.keypointDetector,
            region,
            objectSupportMask,
            ...refreshOptions,
          });

    this.metrics.landmarkRefreshAdded = refreshOutcome.added ?? 0;
    this.metrics.landmarkRefreshRecovered = refreshOutcome.recovered ?? 0;
    this.metrics.landmarkRefreshProbationary = refreshOutcome.probationaryAdded ?? 0;
    this.metrics.landmarkRefreshTotal = refreshOutcome.total;
    this.metrics.landmarkRefreshActive = refreshOutcome.active;
    this.metrics.landmarkRefreshRejectedByMask = refreshOutcome.rejectedByMask || 0;
    this.metrics.landmarkRefreshCandidateCount = refreshOutcome.candidateCount;
    this.metrics.landmarkRefreshGfttCallCount = refreshOutcome.gfttCallCount;
    this.metrics.landmarkRefreshGfttPixelCount = refreshOutcome.gfttPixelCount;
    this.metrics.landmarkRefreshGfttPreparationCount = refreshOutcome.gfttPreparationCount;
    this.metrics.landmarkRefreshReferenceSource = refreshOutcome.referenceTransformSource;
    this.metrics.landmarkRefreshFailureReason = refreshOutcome.reason;
    this.metrics.landmarkRefreshCoverageBefore = refreshOutcome.coverageBefore ?? null;
    this.metrics.landmarkRefreshCoverageAfter = refreshOutcome.coverageAfter ?? null;
    this.metrics.landmarkRefreshCoverageCellCount = refreshOutcome.coverageCellCount ?? null;
    this.metrics.landmarkRefreshOccupiedBefore = refreshOutcome.coverageOccupiedBefore ?? null;
    this.metrics.landmarkRefreshOccupiedAfter = refreshOutcome.coverageOccupiedAfter ?? null;

    if (refreshOutcome.success) {
      this._recordLandmarkMetrics();
      this._recordUpdateTiming(updateTimings, 'keypointRefreshMs', stageStart);
      this._storeRelocalizationKeyframe(grayImage, {
        force: true,
        includeFreshLandmarks: storeFreshRelocalizationKeyframe,
        frameFeatures,
        learnedImageData,
        updateTimings,
      });
      return refreshOutcome;
    }

    this._recordUpdateTiming(updateTimings, 'keypointRefreshMs', stageStart);
    return refreshOutcome;
  }

  _createRecoveryReferenceTransform() {
    const recentSupportRecovery =
      isRecoveryObjectSupportRefreshReason(this.metrics.segmentationRefreshReason ?? null) &&
      Number.isFinite(this.metrics.segmentationRefreshFrame) &&
      this.frameIndex - this.metrics.segmentationRefreshFrame <= 2;
    const activeLandmarks = this.metrics.activeLandmarkCount ?? this.metrics.keypointCount ?? 0;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks ?? activeLandmarks;
    const originalAnchor = this.keypointTracker.anchorOriginalPosition;
    const attachment = this.currentPlanarTransform;
    const hasEligibleTarget =
      this._hasMugLikeTarget() ||
      (this._hasCanLikeTargetClass() &&
        (this.metrics.reconstructionFrames || 0) >= PARAMETRIC_CAN_RECOVERY_MIN_MAPPED_FRAMES);

    if (
      this.trackingMode !== PARAMETRIC_SURFACE_POSE_MODEL ||
      !hasEligibleTarget ||
      this.metrics.landmarkRefreshReason !== 'support-recovery' ||
      !recentSupportRecovery ||
      this.metrics.reconstructionReady !== true ||
      (this.metrics.reconstructionMapConfidence ?? 0) < PARAMETRIC_RECOVERY_MIN_MAP_CONFIDENCE ||
      (this.metrics.reconstructionMatureLandmarks || 0) < PARAMETRIC_RECOVERY_MIN_MATURE_LANDMARKS ||
      (this.metrics.reconstructionPoseInliers || 0) > 0 ||
      activeLandmarks < CANDIDATE_MIN_TRACKABLE_POINTS ||
      activeLandmarks > PARAMETRIC_RECOVERY_MAX_ACTIVE_LANDMARKS ||
      objectOwnedLandmarks / Math.max(1, activeLandmarks) < 0.65 ||
      (this.metrics.trackingSuccessRate ?? 0) < 0.55 ||
      !originalAnchor ||
      !this.currentPosition ||
      !attachment
    ) {
      return null;
    }

    const motionPredictedPosition = this.curvedMotionSample
      ? this._predictCurvedMotionPosition(this.now())
      : null;
    const recoveryPosition = motionPredictedPosition || this.currentPosition;
    this.metrics.recoveryReferencePositionSource = motionPredictedPosition
      ? 'curved-motion-prediction'
      : 'current-attachment';
    const scale = attachment.scale;
    const rotation = attachment.rotation;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    return {
      tx: recoveryPosition.x - scale * (cos * originalAnchor.x - sin * originalAnchor.y),
      ty: recoveryPosition.y - scale * (sin * originalAnchor.x + cos * originalAnchor.y),
      scale,
      rotation,
    };
  }

  _shouldQuarantineFreshRecoveryLandmarks() {
    const targetClass = this.anchorTargetClass || '';
    return (
      this.trackingMode === DEPTH_FUSION_POSE_MODEL &&
      this.metrics.landmarkRefreshReason === 'support-recovery' &&
      /cup/i.test(targetClass) &&
      !/mug/i.test(targetClass)
    );
  }

  _shouldReinitializeAfterFailedSupportRefresh() {
    return (
      this.metrics.landmarkRefreshFailureReason === 'no-reference-transform' &&
      this._isSupportRefreshReinitializationEligible()
    );
  }

  _isSupportRefreshReinitializationEligible() {
    const mugLikeTarget = this._hasMugLikeTarget();
    const unreadyMugRecovery = this._hasUnreadyHandledMugRecoveryTarget();
    const supportedPrimitiveTarget =
      !mugLikeTarget && (this._hasCylinderLikeTarget() || this._hasTaperedCylinderLikeTarget());
    if (
      this.metrics.landmarkRefreshReason !== 'support-recovery' ||
      !this.objectSupportMask ||
      !isReconstructionMode(this.trackingMode) ||
      (!unreadyMugRecovery && !supportedPrimitiveTarget) ||
      this.frameIndex - this.lastKeypointReinitializationFrame < 8
    ) {
      return false;
    }

    const genericPrimitive = this._hasGenericTargetClass() && this._hasDenseGenericPrimitiveSupport();
    const knownCylinder = this._hasCylinderLikeTarget() && !this._hasTaperedCylinderLikeTarget();
    if (
      this.trackingMode === DEPTH_FUSION_POSE_MODEL &&
      !unreadyMugRecovery &&
      !genericPrimitive &&
      !knownCylinder
    ) {
      return false;
    }

    if (this._hasGenericTargetClass() && !genericPrimitive) {
      return false;
    }

    const active = this.metrics.activeLandmarkCount ?? this.metrics.keypointCount ?? 0;
    const owned = this.metrics.objectOwnedLandmarks ?? active;
    const ownedRatio = owned / Math.max(1, active);
    const maxActiveLandmarks =
      this.trackingMode === DEPTH_FUSION_POSE_MODEL && this._hasKnownDepthCylinderTargetClass() ? 24 : 16;
    return (
      active >= CANDIDATE_MIN_TRACKABLE_POINTS &&
      active <= maxActiveLandmarks &&
      owned >= 8 &&
      ownedRatio >= 0.65 &&
      (this.metrics.poseInliers ?? 0) < MIN_ATTACHMENT_POSE_INLIERS &&
      (this.metrics.trackingSuccessRate ?? 0) >= 0.55
    );
  }

  _createSupportRecoveryPosition(trackerPosition) {
    const sample = this.curvedMotionSample;
    if (
      !this._isSupportRefreshReinitializationEligible() ||
      !this.currentPosition ||
      !trackerPosition ||
      (trackerPosition.inlierCount ?? 0) < CANDIDATE_MIN_TRACKABLE_POINTS
    ) {
      return null;
    }

    const supportMask = this._getCurrentObjectSupportMask();
    if (sample && sample.confidence >= SUPPORT_RECOVERY_MOTION_MIN_CONFIDENCE) {
      const sampleAge = this.now() - sample.timestamp;
      const speed = vectorMagnitude(sample.velocity);
      if (
        sampleAge > 0 &&
        sampleAge <= SUPPORT_RECOVERY_MOTION_MAX_AGE_MS &&
        speed >= SUPPORT_RECOVERY_MOTION_MIN_SPEED
      ) {
        const displacement = {
          x: trackerPosition.x - this.currentPosition.x,
          y: trackerPosition.y - this.currentPosition.y,
        };
        const displacementMagnitude = vectorMagnitude(displacement);
        const motionDirection = {
          x: sample.velocity.x / speed,
          y: sample.velocity.y / speed,
        };
        const alignedDisplacement = displacement.x * motionDirection.x + displacement.y * motionDirection.y;
        if (
          alignedDisplacement >= SUPPORT_RECOVERY_MOTION_MIN_DISPLACEMENT &&
          alignedDisplacement / Math.max(1, displacementMagnitude) >= SUPPORT_RECOVERY_MOTION_MIN_ALIGNMENT
        ) {
          const supportExtent = Math.max(supportMask.bbox.width, supportMask.bbox.height);
          const step = Math.min(
            alignedDisplacement,
            clamp(
              supportExtent * SUPPORT_RECOVERY_MOTION_MAX_STEP_RATIO,
              SUPPORT_RECOVERY_MOTION_MIN_STEP,
              SUPPORT_RECOVERY_MOTION_MAX_STEP,
            ),
          );
          return {
            x: this.currentPosition.x + motionDirection.x * step,
            y: this.currentPosition.y + motionDirection.y * step,
            z: 0,
          };
        }
      }
    }

    const supportPosition = this._objectSupportAnchorPosition(supportMask);
    if (
      !this._hasGenericTargetClass() ||
      trackerPosition.method !== 'reference_similarity_transform' ||
      !this._hasTrustedObjectWideRelocalizationSupport(this.objectSupportMask) ||
      !supportPosition ||
      pointDistance(trackerPosition, this.currentPosition) <=
        this._maxPositionStep(trackerPosition, trackerPosition.method) * 2 ||
      pointDistance(supportPosition, trackerPosition) >
        clamp(Math.max(supportMask.bbox.width, supportMask.bbox.height) * 0.06, 6, 14)
    ) {
      return null;
    }

    this.metrics.recoveryReferencePositionSource = 'support-tracker-consensus';
    return { ...trackerPosition, z: 0, absolute: true };
  }

  _hasDenseGenericPrimitiveSupport() {
    if (
      !this._hasGenericTargetClass() ||
      !this.objectSupportMask ||
      this._hasSparseGenericSupportMask(this.objectSupportMask)
    ) {
      return false;
    }

    return (
      this._targetSurfaceModel() === SURFACE_MODEL_CYLINDER ||
      this._targetSurfaceModel() === SURFACE_MODEL_TAPERED_CYLINDER
    );
  }

  _shouldRefreshKeypoints({ overallQuality, poseInliers }) {
    this.metrics.landmarkRefreshReason = null;

    if (this.anchorState === 'mapping') {
      const activeCount = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
      const shouldRefreshMapping = this.framesSinceRefresh >= CANDIDATE_REFRESH_INTERVAL && activeCount < 32;
      if (shouldRefreshMapping) {
        this.metrics.landmarkRefreshReason = 'mapping-growth';
      }
      return shouldRefreshMapping;
    }

    const geometrySupportsMapGrowth = poseInliers >= 8;
    const needsOcclusionSupport =
      geometrySupportsMapGrowth &&
      this.metrics.trackingSuccessRate >= 0.6 &&
      this.metrics.keypointCount >= 8 &&
      this.metrics.keypointCount < 18;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks ?? this.metrics.keypointCount;
    const objectOwnedRatio = objectOwnedLandmarks / Math.max(1, this.metrics.keypointCount);
    const matureReconstructionReady =
      this.metrics.reconstructionReady === true &&
      (this.metrics.reconstructionMapConfidence ?? 0) >= 0.55 &&
      (this.metrics.reconstructionMatureLandmarks ?? 0) >= 16;
    const supportRefreshFrame = this.metrics.segmentationRefreshFrame;
    const recentSupportRefresh =
      Number.isFinite(supportRefreshFrame) && this.frameIndex - supportRefreshFrame <= 2;
    const recoverySupportJustRefreshed =
      recentSupportRefresh &&
      isRecoveryObjectSupportRefreshReason(this.metrics.segmentationRefreshReason ?? null) &&
      poseInliers < MIN_ATTACHMENT_POSE_INLIERS &&
      this.metrics.trackingSuccessRate >= 0.45 &&
      this.metrics.keypointCount >= 6 &&
      this.metrics.keypointCount <= 24 &&
      objectOwnedLandmarks >= 6 &&
      objectOwnedRatio >= 0.65;
    const supportJustExpanded =
      !matureReconstructionReady &&
      ['tap-local-support-growth', 'periodic-segmentation-refresh', 'object-ownership-recovery'].includes(
        this.metrics.segmentationRefreshReason,
      ) &&
      recentSupportRefresh &&
      this.metrics.trackingSuccessRate >= 0.45 &&
      this.metrics.keypointCount >= 6 &&
      objectOwnedLandmarks >= 6;
    const needsObjectSupportRecovery =
      this.objectSupportMask &&
      !matureReconstructionReady &&
      poseInliers < 8 &&
      this.metrics.trackingSuccessRate >= 0.6 &&
      this.metrics.keypointCount >= 8 &&
      this.metrics.keypointCount < 12 &&
      objectOwnedLandmarks >= 6 &&
      objectOwnedRatio < 0.95 &&
      objectOwnedRatio >= 0.65;
    const landmarkCount = this.metrics.landmarkCount || this.metrics.keypointCount;
    const mapNeedsExpansion = landmarkCount < 70;
    const deferPlanarOcclusionGrowth =
      this._hasRigidPlanarTargetClass() &&
      needsOcclusionSupport &&
      !mapNeedsExpansion &&
      (this.metrics.homographyInliers || 0) === 0 &&
      !needsObjectSupportRecovery &&
      !supportJustExpanded &&
      !recoverySupportJustRefreshed;

    if (deferPlanarOcclusionGrowth) {
      return false;
    }

    if (
      this.framesSinceRefresh < this.refreshInterval &&
      !needsOcclusionSupport &&
      !needsObjectSupportRecovery &&
      !supportJustExpanded &&
      !recoverySupportJustRefreshed
    ) {
      return false;
    }

    if (recoverySupportJustRefreshed) {
      this.metrics.landmarkRefreshReason = 'support-recovery';
      return true;
    }

    if (supportJustExpanded) {
      this.metrics.landmarkRefreshReason = 'support-growth';
      return true;
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

    const poseNeedsSupport = geometrySupportsMapGrowth && poseInliers < 24;
    const trackingIsUseful = overallQuality >= 0.5 || this.anchorState === 'stable';

    const shouldRefresh =
      needsObjectSupportRecovery ||
      needsOcclusionSupport ||
      (geometrySupportsMapGrowth &&
        trackingIsUseful &&
        (mapNeedsExpansion || poseNeedsSupport || this.anchorState === 'stable'));
    if (shouldRefresh) {
      this.metrics.landmarkRefreshReason = needsObjectSupportRecovery
        ? 'object-support-recovery'
        : needsOcclusionSupport
          ? 'occlusion-support'
          : 'map-growth';
    }
    return shouldRefresh;
  }

  _shouldAttemptGeometryRelocalization(anchorPosition) {
    if (!this.relocalizer.hasKeyframes()) {
      return false;
    }

    const activeCount = this.metrics.keypointCount || 0;
    const landmarkCount = this.metrics.landmarkCount || activeCount;
    const residual = anchorPosition?.averageResidual ?? 0;
    const geometryIncoherentWithFewLandmarks = activeCount < 18 && residual > 24;
    const sparseRigidPlanarReference =
      activeCount < 18 &&
      landmarkCount >= 70 &&
      this._hasRigidPlanarTargetClass() &&
      anchorPosition?.method === 'reference_similarity_transform';
    const deformedReadyDirectMugReference =
      this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL &&
      this._hasMugLikeTarget() &&
      this.metrics.reconstructionReady === true &&
      activeCount <= MAX_DIRECT_MUG_DEFORMED_REFERENCE_LANDMARKS &&
      residual >= MIN_SEVERE_CURVED_REFERENCE_RESIDUAL;
    const collapsedReadySparseMugReference =
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasMugLikeTarget() &&
      this.metrics.reconstructionReady === true &&
      (this.metrics.reconstructionPoseInliers || 0) >= MIN_ATTACHMENT_POSE_INLIERS &&
      activeCount <= MAX_SEVERE_CURVED_REFERENCE_LANDMARKS &&
      residual >= MIN_CATASTROPHIC_SPARSE_MUG_REFERENCE_RESIDUAL;
    return (
      activeCount < 12 ||
      geometryIncoherentWithFewLandmarks ||
      sparseRigidPlanarReference ||
      deformedReadyDirectMugReference ||
      collapsedReadySparseMugReference
    );
  }

  _recordLandmarkMetrics() {
    const points = this.keypointTracker?.trackedPoints || [];
    const objectSupportMask = this._getCurrentObjectSupportMask();
    let activeLandmarks = 0;
    let objectOwnedLandmarks = 0;
    let qualityLandmarks = 0;
    let qualitySum = 0;
    let highQualityLandmarks = 0;
    let poseEligibleLandmarks = 0;
    let ownershipProbationLandmarks = 0;
    for (const point of points) {
      if (point.status !== 'active') continue;
      activeLandmarks++;
      const insideObjectSupport =
        !objectSupportMask || isPointInsideObjectSupport(objectSupportMask, point.current);
      if (insideObjectSupport && isConfirmedObjectOwnedLandmark(point)) {
        objectOwnedLandmarks++;
        const quality = this.keypointTracker.getLandmarkQuality(point);
        qualityLandmarks++;
        qualitySum += quality;
        if (quality >= 0.7) highQualityLandmarks++;
        if (quality >= 0.52) poseEligibleLandmarks++;
      } else if (insideObjectSupport && isProbationaryObjectOwnedLandmark(point)) {
        ownershipProbationLandmarks++;
      }
    }

    this.metrics.landmarkCount = points.length;
    this.metrics.activeLandmarkCount = activeLandmarks;
    this.metrics.activeLandmarks = this.metrics.activeLandmarkCount;
    this.metrics.inactiveLandmarkCount = Math.max(
      0,
      this.metrics.landmarkCount - this.metrics.activeLandmarkCount,
    );
    this.metrics.inactiveLandmarks = this.metrics.inactiveLandmarkCount;
    this.metrics.objectOwnedLandmarks = objectOwnedLandmarks;
    this.metrics.averageLandmarkQuality = qualityLandmarks ? qualitySum / qualityLandmarks : 0;
    this.metrics.highQualityLandmarks = highQualityLandmarks;
    this.metrics.poseEligibleLandmarks = poseEligibleLandmarks;
    this.metrics.ownershipProbationLandmarks = ownershipProbationLandmarks;
  }

  _surfaceMetricFields(surfaceState) {
    return {
      surfacePrior: surfaceState.surfacePrior,
      surfaceCoverage: surfaceState.coverage,
      surfaceLockedLandmarks: surfaceState.lockedLandmarks,
      surfaceContourSegments: surfaceState.contourSegments.length,
      surfaceCellCount: surfaceState.cellCount,
      surfaceOccupiedCells: surfaceState.occupiedCells,
      silhouetteCoverage: surfaceState.silhouetteCoverage,
      contourFitResidual: surfaceState.contourFitResidual,
      landmarksInsideMask: surfaceState.landmarksInsideMask,
      landmarksOutsideMask: surfaceState.landmarksOutsideMask,
      occlusionState: surfaceState.occlusionState,
      surfaceGrowthAllowed: surfaceState.allowGrowth,
      surfaceOcclusionReason: surfaceState.lastOcclusionReason,
    };
  }

  _updateObjectSurfaceMetrics({ objectSupportMask, poseResidual = null }) {
    const surfaceState = this.objectSurfaceModel.update({
      objectSupportMask,
      landmarks: this.keypointTracker?.trackedPoints || [],
      targetClass: this.anchorTargetClass,
      poseResidual,
    });
    Object.assign(this.metrics, this._surfaceMetricFields(surfaceState));
    return surfaceState;
  }

  _poseCandidateFromPose(
    pose,
    {
      role,
      source = pose?.method,
      positionRejectionReason,
      normalRejectionReason,
      objectOwnedRatio,
      continuity = 0.5,
      mapMaturity = 0,
      attachmentEligible = true,
      contourFitResidual = this.metrics.contourFitResidual,
      silhouetteCoverage = this.metrics.silhouetteCoverage,
    } = {},
  ) {
    if (!pose?.success) {
      return null;
    }

    return {
      role,
      source,
      position: pose.position,
      normal: pose.normal || null,
      planarTransform: pose.planarTransform || null,
      inliers: pose.inlierCount || pose.inliers || 0,
      residual: pose.averageResidual ?? pose.residual ?? Infinity,
      confidence: pose.confidence ?? 0,
      objectOwnedRatio,
      continuity,
      mapMaturity,
      attachmentEligible,
      positionRejectionReason,
      normalRejectionReason,
      contourFitResidual,
      silhouetteCoverage,
    };
  }

  _posePositionCandidate(pose) {
    return {
      ...pose.position,
      confidence: pose.confidence,
      averageResidual: pose.averageResidual,
      inlierCount: pose.inlierCount,
    };
  }

  _selectReconstructionPositionCandidate({ reconstructionPose, poseArbitration, trackerAnchorPosition }) {
    const position = this._posePositionCandidate(reconstructionPose);
    const reconstructionCandidate = poseArbitration.byRole.reconstruction;
    const trackerCandidate = poseArbitration.byRole.tracker;
    const usePlanarConsensus =
      this.trackingMode === PARAMETRIC_SURFACE_POSE_MODEL &&
      reconstructionPose.method === PARAMETRIC_SURFACE_POSE_MODEL &&
      this._targetSurfaceModel(reconstructionPose) === SURFACE_MODEL_PLANE &&
      this._hasRigidPlanarTargetClass() &&
      this._hasPlanarDominance() &&
      trackerAnchorPosition?.method === 'reference_similarity_transform' &&
      reconstructionCandidate.positionAllowed &&
      trackerCandidate?.positionAllowed &&
      !trackerCandidate.positionQualityRejectionReason;

    if (!usePlanarConsensus) {
      return position;
    }

    const reconstructionWeight = reconstructionCandidate.positionScore;
    const trackerWeight = trackerCandidate.positionScore;
    const totalWeight = reconstructionWeight + trackerWeight;

    return {
      ...position,
      x: (position.x * reconstructionWeight + trackerAnchorPosition.x * trackerWeight) / totalWeight,
      y: (position.y * reconstructionWeight + trackerAnchorPosition.y * trackerWeight) / totalWeight,
      adjustment: 'planar-reconstruction-consensus',
    };
  }

  _normalCandidateRejectionReason({
    role,
    pose,
    reconstructionPose,
    planarPose,
    reconstructionConsistentWithTracker,
    correspondences,
  }) {
    if (!pose?.success || !pose.normal) {
      return 'normal-unavailable';
    }

    if (this._isPlanarNormalCandidate(pose) && (pose.confidence ?? 0) < MIN_PLANAR_NORMAL_CONFIDENCE) {
      return 'low-normal-confidence';
    }

    if (
      pose.method === 'object-pose-affine' &&
      this._hasRigidPlanarTargetClass() &&
      this._hasPlanarDominance()
    ) {
      return 'planar-target-requires-planar-normal';
    }

    if (this._weakNormal(pose)) {
      return WEAKLY_OBSERVED_NORMAL_INNOVATION_REASON;
    }

    if (
      isReconstructionMode(pose.method) &&
      this._hasCurvedReconstructionTarget(pose) &&
      !reconstructionConsistentWithTracker &&
      !this._hasStrongNonPlanarReconstruction(pose)
    ) {
      return 'weak-inconsistent-reconstruction-normal';
    }

    if (
      (role === 'planar' || role === 'local') &&
      this._shouldRejectPlanarNormalForCurvedTarget(reconstructionPose)
    ) {
      return 'curved-target-rejects-local-normal';
    }

    if (
      (role === 'planar' || role === 'local') &&
      this._shouldHoldPlanarNormalAfterReconstructionDropout({
        candidatePose: pose,
        reconstructionPose,
      })
    ) {
      return 'transient-reconstruction-dropout';
    }

    if (
      role === 'reconstruction' &&
      this._shouldExposeSelectedPlanarSurfacePose({ reconstructionPose, planarPose })
    ) {
      return null;
    }

    const geometryReason = this._getPoseRejectionReason(pose, correspondences);
    if (geometryReason) {
      return geometryReason;
    }

    if (role !== 'reconstruction') {
      return null;
    }

    if (this._hasIncompleteSelectedSurfacePrior(reconstructionPose)) {
      return 'incomplete-selected-surface-prior';
    }

    const reconstructionHighInlierNormal =
      this._hasStrongNonPlanarReconstruction(reconstructionPose) &&
      (reconstructionPose.inlierCount || 0) >= 24 &&
      (reconstructionPose.averageResidual ?? Infinity) <= 2.4;
    const reconstructionOwnsDominantSurface =
      !this._hasPlanarDominance() ||
      this._canSelectedReconstructionOwnAttachment(reconstructionPose) ||
      (this._hasStrongNonPlanarReconstruction(reconstructionPose) && reconstructionConsistentWithTracker) ||
      reconstructionHighInlierNormal;

    return reconstructionOwnsDominantSurface ? null : 'planar-dominance-rejects-reconstruction-normal';
  }

  _recordPoseCandidates({
    reconstructionPose,
    planarPose,
    objectPose,
    poseResult,
    trackerAnchorPosition,
    reconstructionConsistentWithTracker,
    correspondences,
  }) {
    const objectOwnedRatio =
      (this.metrics.objectOwnedLandmarks || 0) /
      Math.max(1, this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0);
    const mapMaturity = Math.min(1, (this.metrics.reconstructionMatureLandmarks || 0) / 18);
    const candidates = [
      this._poseCandidateFromPose(reconstructionPose, {
        role: 'reconstruction',
        positionRejectionReason: this._getPoseTransformRejectionReason(
          reconstructionPose,
          reconstructionPose?.correspondences || correspondences,
        ),
        normalRejectionReason: this._normalCandidateRejectionReason({
          role: 'reconstruction',
          pose: reconstructionPose,
          reconstructionPose,
          planarPose,
          reconstructionConsistentWithTracker,
          correspondences: reconstructionPose?.correspondences || correspondences,
        }),
        objectOwnedRatio,
        continuity: reconstructionConsistentWithTracker ? 1 : 0.25,
        mapMaturity,
        attachmentEligible:
          reconstructionPose?.method === this.trackingMode &&
          !this._hasIncompleteSelectedSurfacePrior(reconstructionPose),
      }),
      this._poseCandidateFromPose(planarPose, {
        role: 'planar',
        positionRejectionReason: this._getPoseTransformRejectionReason(planarPose, correspondences),
        normalRejectionReason: this._normalCandidateRejectionReason({
          role: 'planar',
          pose: planarPose,
          reconstructionPose,
          planarPose,
          reconstructionConsistentWithTracker,
          correspondences,
        }),
        objectOwnedRatio,
        continuity: 0.72,
        mapMaturity: this._hasPlanarDominance() ? 0.8 : 0.35,
      }),
      this._poseCandidateFromPose(objectPose, {
        role: 'object',
        positionRejectionReason: this._getPoseTransformRejectionReason(
          objectPose,
          objectPose?.correspondences || correspondences,
        ),
        normalRejectionReason: this._normalCandidateRejectionReason({
          role: 'object',
          pose: objectPose,
          reconstructionPose,
          planarPose,
          reconstructionConsistentWithTracker,
          correspondences: objectPose?.correspondences || correspondences,
        }),
        objectOwnedRatio,
        continuity: 0.6,
        mapMaturity: 0.25,
      }),
      this._poseCandidateFromPose(poseResult, {
        role: 'local',
        positionRejectionReason: 'Normal-only local pose',
        normalRejectionReason: this._normalCandidateRejectionReason({
          role: 'local',
          pose: poseResult,
          reconstructionPose,
          planarPose,
          reconstructionConsistentWithTracker,
          correspondences,
        }),
        objectOwnedRatio,
        continuity: 0.65,
        mapMaturity: this._hasPlanarDominance() ? 0.75 : 0.3,
        attachmentEligible: false,
      }),
      trackerAnchorPosition
        ? {
            role: 'tracker',
            source: trackerAnchorPosition.method,
            position: trackerAnchorPosition,
            normal: null,
            planarTransform: {
              scale: trackerAnchorPosition.scale,
              rotation: trackerAnchorPosition.rotation,
            },
            inliers: trackerAnchorPosition.inlierCount || 0,
            residual: trackerAnchorPosition.averageResidual ?? Infinity,
            confidence: trackerAnchorPosition.confidence ?? 0,
            objectOwnedRatio,
            continuity: 0.85,
            mapMaturity: 0,
            attachmentEligible: false,
            contourFitResidual: this.metrics.contourFitResidual,
            silhouetteCoverage: this.metrics.silhouetteCoverage,
          }
        : null,
    ].filter(Boolean);
    const result = arbitratePoseCandidates({ candidates, requireObjectOwnership: true });

    this.metrics.poseOverlayCandidateSource = result.selectedOverlay?.source || null;
    this.metrics.poseOverlayCandidateScore = result.selectedOverlay?.score ?? null;
    this.metrics.poseAttachmentCandidateSource = result.selectedAttachment?.source || null;
    this.metrics.poseAttachmentCandidateScore = result.selectedAttachment?.score ?? null;
    this.metrics.posePositionCandidateSource = result.selectedPosition?.source || null;
    this.metrics.posePositionCandidateScore = result.selectedPosition?.positionScore ?? null;
    this.metrics.normalPoseRejectedCandidates = Object.fromEntries(
      result.candidates
        .filter((candidate) => candidate.normal && !candidate.normalAllowed)
        .map((candidate) => [candidate.source, candidate.normalRejectionReason]),
    );
    this.metrics.poseCandidates = result.candidates.map((candidate) => ({
      role: candidate.role,
      source: candidate.source,
      score: candidate.score,
      positionScore: candidate.positionScore,
      confidence: candidate.confidence,
      inliers: candidate.inliers,
      residual: candidate.residual,
      rejected: candidate.rejectionReason,
      positionAllowed: candidate.positionAllowed,
      positionQualityRejected: candidate.positionQualityRejectionReason,
      normalAllowed: candidate.normalAllowed,
      normalRejected: candidate.normalRejectionReason,
      transformAllowed: candidate.transformAllowed,
      transformRejected: candidate.transformRejectionReason,
      attachmentAllowed: candidate.attachmentAllowed,
      attachmentRejected: candidate.attachmentRejectionReason,
      overlayAllowed: candidate.overlayAllowed,
      positionRejected: candidate.positionRejectionReason,
      contourFitResidual: candidate.contourFitResidual,
      silhouetteCoverage: candidate.silhouetteCoverage,
    }));
    this.metrics.rejectedPoseCandidates = result.rejected;

    return result;
  }

  _shouldUseArbiterPlanarPosition({ poseArbitration, planarPose, trackerAnchorPosition }) {
    if (
      poseArbitration.selectedAttachment?.source !== planarPose?.method ||
      trackerAnchorPosition?.method !== 'reference_similarity_transform'
    ) {
      return false;
    }

    return poseArbitration.byRole.tracker?.positionQualityRejectionReason === 'weak-geometry';
  }

  _shouldUseArbiterReconstructionPosition({ poseArbitration, reconstructionPose, trackerAnchorPosition }) {
    if (
      poseArbitration.selectedAttachment?.source !== reconstructionPose?.method ||
      reconstructionPose?.method !== this.trackingMode ||
      !this._hasCurvedReconstructionTarget(reconstructionPose) ||
      trackerAnchorPosition?.method !== 'reference_similarity_transform'
    ) {
      return false;
    }

    const mapConfidence =
      reconstructionPose.preview?.statistics?.mapConfidence ??
      this.metrics.reconstructionMapConfidence ??
      reconstructionPose.confidence ??
      0;
    const matureLandmarks =
      reconstructionPose.preview?.statistics?.matureLandmarks ??
      this.metrics.reconstructionMatureLandmarks ??
      0;
    const matureCurvedMap =
      this.metrics.reconstructionReady === true && mapConfidence >= 0.6 && matureLandmarks >= 16;
    const trackerRejected =
      poseArbitration.byRole.tracker?.positionQualityRejectionReason === 'weak-geometry';

    if (this.trackingMode === RECONSTRUCTION_POSE_MODEL) {
      return trackerRejected && matureCurvedMap;
    }

    if (
      this.trackingMode === DEPTH_FUSION_POSE_MODEL &&
      this._depthFusionOwnsCurvedPositionTarget(reconstructionPose)
    ) {
      const minInliers =
        this._hasTaperedCylinderLikeTarget(reconstructionPose) && !this._hasMugLikeTarget() ? 9 : 12;

      return (
        trackerRejected &&
        matureCurvedMap &&
        (reconstructionPose.inlierCount || 0) >= minInliers &&
        (reconstructionPose.averageResidual ?? Infinity) <= 6.2 &&
        (reconstructionPose.confidence ?? 0) >= MIN_DEPTH_CURVED_RECOVERY_CONFIDENCE
      );
    }

    return (
      trackerRejected &&
      matureCurvedMap &&
      (reconstructionPose.inlierCount || 0) >= 10 &&
      (reconstructionPose.averageResidual ?? Infinity) <= 3.6
    );
  }

  _rejectTrackedPointsOutsideObjectSupport() {
    const objectSupportMask = this._getCurrentObjectSupportMask();
    if (!objectSupportMask) {
      return 0;
    }

    const ownership = this.keypointTracker.updateObjectOwnership(objectSupportMask);
    this.metrics.landmarkOwnershipPromoted = ownership.promoted;
    return ownership.rejected;
  }

  _canAdmitPartialFlow(trackingResult) {
    return (
      trackingResult.success === false &&
      !!trackingResult.partialFlow &&
      this.keypointFailureCount === 0 &&
      this.metrics.targetPresent === true &&
      this.trackingMode === PARAMETRIC_SURFACE_POSE_MODEL &&
      this._hasMatureCurvedMap(0.6) &&
      (this.metrics.poseInliers ?? 0) >= PARTIAL_OCCLUSION_MIN_PRIOR_POSE_INLIERS
    );
  }

  /**
   * Attempt to reinitialize keypoint tracking after recovery
   */
  _reinitializeKeypoints(
    grayImage,
    {
      minKeypoints = 15,
      objectSupportMask,
      region = null,
      anchorPosition = null,
      resetReconstruction = false,
      reason = 'keypoint-reinitialization',
      updateTimings = null,
    } = {},
  ) {
    if (!this.currentPosition) {
      return {
        success: false,
        status: 'missing-anchor-position',
        candidateCount: null,
        gfttCallCount: 0,
        gfttPixelCount: 0,
        gfttPreparationCount: 0,
      };
    }

    const stageStart = this._startUpdateTiming(updateTimings);
    const finish = (outcome) => {
      this._recordUpdateTiming(updateTimings, 'keypointReinitializationMs', stageStart);
      return outcome;
    };
    const extractionRegion =
      region ??
      this._getAnchoredTrackingRegion(grayImage, { allowExpansion: this._shouldUseExpandedTrackingRegion() });
    const keypointResult = this._extractObjectKeypoints(grayImage, extractionRegion, objectSupportMask, {
      minKeypoints,
    });

    this.metrics.keypointReinitializationCandidateCount = keypointResult.keypoints.length;
    this.metrics.keypointReinitializationReason = reason;
    this.metrics.keypointReinitializationGfttCallCount = keypointResult.gfttCallCount;
    this.metrics.keypointReinitializationGfttPixelCount = keypointResult.gfttPixelCount;
    this.metrics.keypointReinitializationGfttPreparationCount = keypointResult.gfttPreparationCount;
    if (keypointResult.keypoints.length < minKeypoints) {
      this.metrics.keypointReinitializationResult = 'insufficient-candidates';
      return finish({
        success: false,
        status: 'insufficient-candidates',
        candidateCount: keypointResult.keypoints.length,
        gfttCallCount: keypointResult.gfttCallCount,
        gfttPixelCount: keypointResult.gfttPixelCount,
        gfttPreparationCount: keypointResult.gfttPreparationCount,
      });
    }

    const nextAnchorCandidate = anchorPosition ?? this.currentPosition;
    const frameConstrained =
      anchorPosition?.absolute === true
        ? { position: nextAnchorCandidate, limited: false }
        : this._constrainPositionToFrameStep(nextAnchorCandidate, reason);
    const nextAnchorPosition = frameConstrained.position;
    const anchorDelta = pointDistance(nextAnchorPosition, this.currentPosition);
    this.currentPosition = {
      x: nextAnchorPosition.x,
      y: nextAnchorPosition.y,
      z: nextAnchorPosition.z ?? 0,
    };
    this.positionFilterX = createPositionFilter();
    this.positionFilterY = createPositionFilter();
    this.positionFilterX.filter(this.currentPosition.x, this.now());
    this.positionFilterY.filter(this.currentPosition.y, this.now());
    this.keypointTracker.initializeTracking(this.cv, keypointResult.keypoints, grayImage, {
      tapPosition: this.currentPosition,
      admission: 'trusted-selection',
    });
    this.anchorState = 'tracking';
    this._recordLandmarkMetrics();
    this.metrics.keypointReinitializationResult = 'reinitialized';
    this.metrics.keypointReinitializationLandmarks = keypointResult.keypoints.length;
    this.metrics.keypointReinitializationAnchorDelta = anchorDelta;
    this.metrics.keypointReinitializationFrameStepLimited = frameConstrained.limited;
    this.lastKeypointReinitializationFrame = this.frameIndex;
    if (resetReconstruction) {
      this._resetReconstructionAfterKeypointReinitialization(extractionRegion);
    }
    return finish({
      success: true,
      status: 'reinitialized',
      candidateCount: keypointResult.keypoints.length,
      gfttCallCount: keypointResult.gfttCallCount,
      gfttPixelCount: keypointResult.gfttPixelCount,
      gfttPreparationCount: keypointResult.gfttPreparationCount,
      anchorDelta,
      frameStepLimited: frameConstrained.limited,
      reconstructionReset: resetReconstruction,
    });
  }

  _resetReconstructionAfterKeypointReinitialization(region) {
    this.reconstructor.reset({
      anchorReference: this.currentPosition,
      templateRegion: region,
      targetClass: this.anchorTargetClass,
    });
    const state = this.reconstructor.getState();
    this.metrics.reconstructionState = state.state;
    this.metrics.reconstructionReady = state.ready;
    this.metrics.reconstructionFrames = state.frameCount;
    this.metrics.reconstructionLandmarks = state.landmarkCount;
    this.metrics.reconstructionPreview = state.preview;
    this.metrics.reconstructionFailureReason = 'Rebuilding reconstruction after support recovery';
  }

  /**
   * Calculate template region from tap position and object support.
   */
  _calculateTemplateRegion(tapPosition, selectionRegion, imageWidth, imageHeight) {
    if (!selectionRegion?.objectSupportMask) {
      return calculateTapLocalTemplateRegion(tapPosition, imageWidth, imageHeight);
    }

    if (!this._isTapLocalObjectSupportMask(selectionRegion.objectSupportMask)) {
      return calculateTemplateRegion(
        tapPosition,
        this._createObjectSupportBoundingBox(selectionRegion.objectSupportMask),
        imageWidth,
        imageHeight,
      );
    }

    return calculateTapLocalTemplateRegion(tapPosition, imageWidth, imageHeight);
  }

  _isTapLocalObjectSupportMask(objectSupportMask) {
    const maxTapLocalDiameter = calculateTapLocalRadius(objectSupportMask) * 2.4;
    return (
      objectSupportMask.bbox.width <= maxTapLocalDiameter &&
      objectSupportMask.bbox.height <= maxTapLocalDiameter
    );
  }

  _createObjectSupportBoundingBox(objectSupportMask) {
    return {
      x1: objectSupportMask.bbox.x,
      y1: objectSupportMask.bbox.y,
      x2: objectSupportMask.bbox.x + objectSupportMask.bbox.width,
      y2: objectSupportMask.bbox.y + objectSupportMask.bbox.height,
    };
  }

  _extractSurfaceHint(selectionRegion) {
    return selectionRegion?.surfaceHint || null;
  }

  _isRigidPlanarRecoverySelection(targetClass, objectSupportMask) {
    if (RIGID_PLANAR_TARGET_CLASS_PATTERN.test(targetClass || '')) {
      return true;
    }
    if (targetClass && !GENERIC_TARGET_CLASS_PATTERN.test(targetClass)) {
      return false;
    }
    if (objectSupportMask?.source !== OBJECT_SUPPORT_MASK_SOURCES.INTERACTIVE_SEGMENTER) {
      return false;
    }
    const bboxArea = objectSupportMask.bbox.width * objectSupportMask.bbox.height;
    const fillRatio = objectSupportMask.pixelCount / Math.max(1, bboxArea);
    const aspect = objectSupportMask.bbox.width / Math.max(1, objectSupportMask.bbox.height);
    return (
      fillRatio >= MIN_GENERIC_PLANAR_MASK_FILL_RATIO &&
      aspect >= MIN_GENERIC_PLANAR_MASK_ASPECT &&
      aspect <= MAX_GENERIC_PLANAR_MASK_ASPECT
    );
  }

  _hasTrustedObjectWideRelocalizationSupport(objectSupportMask) {
    return (
      objectSupportMask.confidence >= MIN_OBJECT_WIDE_RELOCALIZATION_MASK_CONFIDENCE &&
      !this._isTapLocalObjectSupportMask(objectSupportMask)
    );
  }

  _selectObjectSupportMask(selectionRegion, tapPosition, imageWidth, imageHeight) {
    if (selectionRegion?.objectSupportMask) {
      return selectionRegion.objectSupportMask;
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

    const cache = this.objectSupportProjectionCache;
    if (
      cache &&
      cache.sourceMask === this.objectSupportMask &&
      cache.frameIndex === this.frameIndex &&
      cache.positionX === this.currentPosition.x &&
      cache.positionY === this.currentPosition.y &&
      cache.scale === this.currentPlanarTransform.scale &&
      cache.rotation === this.currentPlanarTransform.rotation
    ) {
      return cache.mask;
    }

    this.currentObjectSupportMask = warpObjectSupportMask(this.objectSupportMask, {
      position: this.currentPosition,
      scale: this.currentPlanarTransform.scale,
      rotation: this.currentPlanarTransform.rotation,
      updatedAtFrame: this.frameIndex,
    });
    this.objectSupportProjectionCache = {
      sourceMask: this.objectSupportMask,
      frameIndex: this.frameIndex,
      positionX: this.currentPosition.x,
      positionY: this.currentPosition.y,
      scale: this.currentPlanarTransform.scale,
      rotation: this.currentPlanarTransform.rotation,
      mask: this.currentObjectSupportMask,
    };

    this.metrics.currentObjectSupportMaskSource = this.currentObjectSupportMask.source;
    this.metrics.currentObjectSupportMaskBounds = { ...this.currentObjectSupportMask.bbox };
    this.metrics.currentObjectSupportMaskPreview = createObjectSupportMaskPreview(
      this.currentObjectSupportMask,
    );
    return this.currentObjectSupportMask;
  }

  _calculateTrackingRegion(selectionRegion, imageWidth, imageHeight, templateRegion) {
    const objectSupportMask = selectionRegion?.objectSupportMask || null;
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
      : selectionRegion;

    if (!tapLocalSupport) {
      if (
        !regionBoundingBox ||
        !Number.isFinite(regionBoundingBox.x1) ||
        !Number.isFinite(regionBoundingBox.y1) ||
        !Number.isFinite(regionBoundingBox.x2) ||
        !Number.isFinite(regionBoundingBox.y2)
      ) {
        return { ...templateRegion };
      }

      const templateArea = templateRegion.width * templateRegion.height;
      const selectionWidth = Math.max(1, regionBoundingBox.x2 - regionBoundingBox.x1);
      const selectionHeight = Math.max(1, regionBoundingBox.y2 - regionBoundingBox.y1);
      const selectionArea = selectionWidth * selectionHeight;
      const padding = Math.max(8, Math.min(24, Math.max(templateRegion.width, templateRegion.height) * 0.12));
      const objectRegion = this._clampTemplateRegion(
        {
          x: Math.min(regionBoundingBox.x1, templateRegion.x) - padding,
          y: Math.min(regionBoundingBox.y1, templateRegion.y) - padding,
          width:
            Math.max(regionBoundingBox.x2, templateRegion.x + templateRegion.width) -
            Math.min(regionBoundingBox.x1, templateRegion.x) +
            padding * 2,
          height:
            Math.max(regionBoundingBox.y2, templateRegion.y + templateRegion.height) -
            Math.min(regionBoundingBox.y1, templateRegion.y) +
            padding * 2,
        },
        imageWidth,
        imageHeight,
      );

      if (selectionArea < templateArea * 1.2) {
        return { ...templateRegion };
      }

      return objectRegion;
    }

    return calculateTapLocalTemplateRegion(center, imageWidth, imageHeight, { scale: 1.5 });
  }

  _mergeTrackingKeypoints(templateKeypoints, objectKeypoints) {
    const normalizeKeypoint = (keypoint) =>
      keypoint.pt
        ? keypoint
        : {
            ...keypoint,
            pt: { x: keypoint.x, y: keypoint.y },
          };
    const minDistance = 7;
    const candidates = [
      ...templateKeypoints.map(normalizeKeypoint).map((keypoint) => ({
        ...keypoint,
        response: (keypoint.response || 1) + 0.25,
      })),
      ...objectKeypoints.map(normalizeKeypoint),
    ].sort((left, right) => (right.response || 0) - (left.response || 0));
    const merged = [];

    for (const keypoint of candidates) {
      if (merged.length >= MAX_INITIAL_TRACKING_KEYPOINTS) {
        break;
      }

      const overlaps = merged.some((existing) => pointDistance(existing.pt, keypoint.pt) < minDistance);
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
      y: this.currentPosition.y - offset.y,
    };
  }

  _shouldUseExpandedTrackingRegion() {
    return this.expandedObjectSupportRegion;
  }

  _getAnchoredTrackingRegion(grayImage, { allowExpansion = true } = {}) {
    const sourceRegion = allowExpansion ? this.trackingRegion || this.templateRegion : this.templateRegion;
    const center = this._getTemplateCenterFromAnchorPosition();
    return this._clampTemplateRegion(
      {
        x: center.x - sourceRegion.width / 2,
        y: center.y - sourceRegion.height / 2,
        width: sourceRegion.width,
        height: sourceRegion.height,
      },
      grayImage.cols,
      grayImage.rows,
    );
  }

  _getLocalRelocalizationSearchRegion(grayImage) {
    const region = this._getAnchoredTrackingRegion(grayImage, { allowExpansion: true });
    const padding = clamp(
      Math.max(region.width, region.height) * RELOCALIZATION_SEARCH_PADDING_RATIO,
      RELOCALIZATION_SEARCH_MIN_PADDING,
      RELOCALIZATION_SEARCH_MAX_PADDING,
    );
    return this._clampTemplateRegion(
      {
        x: region.x - padding,
        y: region.y - padding,
        width: region.width + padding * 2,
        height: region.height + padding * 2,
      },
      grayImage.cols,
      grayImage.rows,
    );
  }

  _selectGeometryRelocalizationSearchRegion(grayImage) {
    if (this._hasRigidPlanarTargetClass()) {
      return this._getLocalRelocalizationSearchRegion(grayImage);
    }

    if (
      this.trackingMode !== DIRECT_PHOTOMETRIC_POSE_MODEL ||
      !this._hasCurvedReconstructionTarget() ||
      !this._hasMugLikeTarget()
    ) {
      return null;
    }

    if (this._hasCollapsedTrackerReference()) {
      this.localizeCurvedRelocalizationSearch = true;
    }
    if (!this.localizeCurvedRelocalizationSearch) {
      return null;
    }

    const objectSupportMask = this._getCurrentObjectSupportMask();
    return objectSupportMask ? this._calculateObjectSupportTrackingRegion(objectSupportMask, null) : null;
  }

  _alignRelocalizationAnchorWithCurvedMotion(relocalization) {
    const anchorPoint = relocalization.anchorPoint;
    const sample = this.curvedMotionSample;
    if (
      relocalization.method !== 'orb-keyframe-relocalization' ||
      this.trackingMode !== DIRECT_PHOTOMETRIC_POSE_MODEL ||
      !this._hasCurvedReconstructionTarget() ||
      !this._hasMugLikeTarget() ||
      this.metrics.reconstructionReady !== true ||
      (this.metrics.reconstructionPoseInliers || 0) > 0 ||
      !this._hasCollapsedTrackerReference() ||
      !anchorPoint ||
      !sample ||
      sample.confidence < MIN_LOW_LAG_TRACKER_CONFIDENCE
    ) {
      return relocalization;
    }

    const speed = vectorMagnitude(sample.velocity);
    const predicted =
      speed >= MIN_CURVED_RELOCALIZATION_MOTION_SPEED ? this._predictCurvedMotionPosition(this.now()) : null;
    if (!predicted) {
      return relocalization;
    }

    const candidateMotion = {
      x: anchorPoint.x - sample.position.x,
      y: anchorPoint.y - sample.position.y,
    };
    const candidateDistance = vectorMagnitude(candidateMotion);
    const candidateAlignment =
      candidateDistance > 0
        ? (candidateMotion.x * sample.velocity.x + candidateMotion.y * sample.velocity.y) /
          (candidateDistance * speed)
        : -1;
    if (candidateAlignment > MAX_CURVED_RELOCALIZATION_CANDIDATE_ALIGNMENT) {
      return relocalization;
    }

    const correction = {
      x: predicted.x - anchorPoint.x,
      y: predicted.y - anchorPoint.y,
    };
    const correctionDistance = vectorMagnitude(correction);
    if (correctionDistance <= 0) {
      return relocalization;
    }

    const correctionScale = Math.min(1, CURVED_DROPOUT_MAX_STEP / correctionDistance);
    const adjustedAnchor = {
      x: anchorPoint.x + correction.x * correctionScale,
      y: anchorPoint.y + correction.y * correctionScale,
    };
    this.metrics.relocalizationAnchorAdjustment = 'curved-motion-prior';
    this.metrics.relocalizationAnchorAdjustmentDelta = correctionDistance;
    this.metrics.relocalizationAnchorAdjustmentStep = pointDistance(adjustedAnchor, anchorPoint);
    return {
      ...relocalization,
      anchorPoint: adjustedAnchor,
    };
  }

  _hasCollapsedTrackerReference() {
    const trackerCandidate = this.metrics.poseCandidates?.find((candidate) => candidate.role === 'tracker');
    return (
      (trackerCandidate?.confidence ?? Infinity) <= MAX_SEVERE_CURVED_REFERENCE_CONFIDENCE &&
      (trackerCandidate?.residual ?? -Infinity) >= MIN_SEVERE_CURVED_REFERENCE_RESIDUAL
    );
  }

  _calculateObjectSupportTrackingRegion(objectSupportMask, baseRegion) {
    const baseCenter = this.currentPosition ||
      objectSupportMask.referencePoint || {
        x: objectSupportMask.bbox.x + objectSupportMask.bbox.width / 2,
        y: objectSupportMask.bbox.y + objectSupportMask.bbox.height / 2,
      };
    const base = baseRegion
      ? this._clampTemplateRegion(
          {
            x: baseRegion.x ?? baseCenter.x - baseRegion.width / 2,
            y: baseRegion.y ?? baseCenter.y - baseRegion.height / 2,
            width: baseRegion.width,
            height: baseRegion.height,
          },
          objectSupportMask.width,
          objectSupportMask.height,
        )
      : null;
    const padding = clamp(
      Math.max(objectSupportMask.bbox.width, objectSupportMask.bbox.height) *
        OBJECT_SUPPORT_TRACKING_PADDING_RATIO,
      OBJECT_SUPPORT_TRACKING_MIN_PADDING,
      OBJECT_SUPPORT_TRACKING_MAX_PADDING,
    );
    const minX = base ? Math.min(objectSupportMask.bbox.x, base.x) : objectSupportMask.bbox.x;
    const minY = base ? Math.min(objectSupportMask.bbox.y, base.y) : objectSupportMask.bbox.y;
    const maxX = base
      ? Math.max(objectSupportMask.bbox.x + objectSupportMask.bbox.width, base.x + base.width)
      : objectSupportMask.bbox.x + objectSupportMask.bbox.width;
    const maxY = base
      ? Math.max(objectSupportMask.bbox.y + objectSupportMask.bbox.height, base.y + base.height)
      : objectSupportMask.bbox.y + objectSupportMask.bbox.height;
    const expanded = this._clampTemplateRegion(
      {
        x: minX - padding,
        y: minY - padding,
        width: maxX - minX + padding * 2,
        height: maxY - minY + padding * 2,
      },
      objectSupportMask.width,
      objectSupportMask.height,
    );

    if (!base) {
      return expanded;
    }

    return expanded.width * expanded.height >= base.width * base.height ? expanded : base;
  }

  _clampTemplateRegion(region, imageWidth, imageHeight) {
    const width = Math.min(region.width, imageWidth);
    const height = Math.min(region.height, imageHeight);

    return {
      x: Math.round(Math.max(0, Math.min(region.x, imageWidth - width))),
      y: Math.round(Math.max(0, Math.min(region.y, imageHeight - height))),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  _getPoseCorrespondenceOptions() {
    const templateSize = this.templateRegion
      ? Math.min(this.templateRegion.width, this.templateRegion.height)
      : 120;

    return {
      maxReferenceDistance: Math.max(42, Math.min(82, templateSize * 0.46)),
      minCount: 8,
      maxCount: 44,
    };
  }

  _getWidePoseCorrespondenceOptions() {
    const templateSize = this.templateRegion
      ? Math.min(this.templateRegion.width, this.templateRegion.height)
      : 120;

    return {
      maxReferenceDistance: Math.max(104, Math.min(150, templateSize * 0.82)),
      minCount: 12,
      maxCount: 72,
    };
  }

  _estimatePoseFromTracker() {
    const attempts = [this._getPoseCorrespondenceOptions(), this._getWidePoseCorrespondenceOptions()];
    let bestAttempt = null;

    for (const options of attempts) {
      const correspondences = this.keypointTracker.getCorrespondences(options);
      const poseResult =
        correspondences.length >= 8 ? this._estimatePoseFromCorrespondences(correspondences) : null;
      const attempt = {
        options,
        correspondences,
        poseResult,
      };

      if (!bestAttempt || this._scorePoseAttempt(attempt) > this._scorePoseAttempt(bestAttempt)) {
        bestAttempt = attempt;
      }
    }

    return (
      bestAttempt || {
        options: this._getPoseCorrespondenceOptions(),
        correspondences: [],
        poseResult: null,
      }
    );
  }

  _scorePoseAttempt(attempt) {
    const poseResult = attempt.poseResult;
    if (!poseResult?.success) {
      return attempt.correspondences.length / 1000;
    }

    const usableScore = this._isUsablePoseResult(poseResult, attempt.correspondences) ? 2 : 0;
    const inlierRatio =
      poseResult.inlierRatio ?? poseResult.inlierCount / Math.max(1, attempt.correspondences.length);
    const residualScore = clamp(1 - (poseResult.averageResidual ?? 0) / 5.5, 0, 1);
    const spread = poseResult.referenceSpread || this._measureReferenceSpread(attempt.correspondences);
    const spreadScore = clamp(spread.minAxis / 80, 0, 1);
    const coverageScore = clamp(Math.hypot(spread.width, spread.height) / 180, 0, 1);
    const countScore = clamp(attempt.correspondences.length / 36, 0, 1);

    return (
      usableScore +
      (poseResult.confidence ?? 0) * 0.34 +
      inlierRatio * 0.16 +
      residualScore * 0.2 +
      spreadScore * 0.08 +
      coverageScore * 0.16 +
      countScore * 0.06
    );
  }

  _estimatePoseFromCorrespondences(correspondences) {
    const homographyPose = this.homographyEstimator.estimatePose(
      this.cv,
      correspondences,
      this.keypointTracker.anchorOriginalPosition,
    );
    if (homographyPose?.success) {
      return { ...homographyPose, method: 'homography' };
    }

    return this.affinePoseEstimator.estimatePose(correspondences, {
      previousNormal: this.currentNormal,
    });
  }

  _estimateObjectPoseFromTracker() {
    return this.keypointTracker.getObjectPose({
      previousPose: this.currentNormal ? { normal: this.currentNormal } : null,
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
      y: anchorReference.y,
    });
    const basisY = transformHomographyPoint(poseResult.homographyMatrix, {
      x: anchorReference.x,
      y: anchorReference.y + basis,
    });
    const vectorX = {
      x: basisX.x - position2d.x,
      y: basisX.y - position2d.y,
    };
    const vectorY = {
      x: basisY.x - position2d.x,
      y: basisY.y - position2d.y,
    };
    const scale = Math.sqrt(Math.max(1e-9, vectorMagnitude(vectorX) * vectorMagnitude(vectorY))) / basis;
    const residualScore = clamp(1 - (poseResult.averageResidual || 0) / 8, 0, 1);
    const inlierRatio =
      poseResult.inlierRatio ?? poseResult.inlierCount / Math.max(1, correspondences.length);
    const confidence = clamp(
      (poseResult.confidence || 0) * 0.46 + inlierRatio * 0.36 + residualScore * 0.18,
      0,
      1,
    );

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
      pnpBranchSelection: poseResult.pnpBranchSelection || null,
      referenceSpread,
      homographyMatrix: poseResult.homographyMatrix,
      correspondences,
    };
  }

  _updateReconstructionPoseFromTracker(
    timestamp,
    grayImage,
    depthContext = {},
    updateTimings = null,
    imageData = null,
  ) {
    const stageStart = this._startUpdateTiming(updateTimings);
    if (!isReconstructionMode(this.trackingMode)) {
      this._recordReconstructionMetrics(this.reconstructor.getState());
      this._recordUpdateTiming(updateTimings, 'reconstructionUpdateMs', stageStart);
      return null;
    }

    const reconstructionContext = {
      ...depthContext,
      imageData,
      objectSupportMask: this.currentObjectSupportMask || this.objectSupportMask,
      templateRegion: this.trackingRegion || this.templateRegion,
      includePreview: false,
    };
    const trackedPoints = this.keypointTracker.trackedPoints;
    const reconstructionTrackedPoints = trackedPoints.every(isReconstructionEligibleLandmark)
      ? trackedPoints
      : trackedPoints.filter(isReconstructionEligibleLandmark);
    const hasPendingRecoveryValidation = trackedPoints.some(
      (point) =>
        point.status === 'active' &&
        point.recoveryOwnershipProbation === true &&
        !isReconstructionEligibleLandmark(point),
    );
    const existingReconstructionState = hasPendingRecoveryValidation ? this.reconstructor.getState() : null;
    const preserveReadyMap = existingReconstructionState?.ready === true;
    this.metrics.reconstructionMapHeldForRecoveryValidation = preserveReadyMap;
    let reconstructionState = existingReconstructionState;
    if (!preserveReadyMap) {
      reconstructionState =
        this.trackingMode === DEPTH_FUSION_POSE_MODEL || this.trackingMode === RECONSTRUCTION_POSE_MODEL
          ? this.reconstructor.addFrameFromTrackedPoints(
              reconstructionTrackedPoints,
              timestamp,
              reconstructionContext,
            )
          : this.reconstructor.addFrameFromTrackedPoints(
              reconstructionTrackedPoints,
              timestamp,
              grayImage,
              reconstructionContext,
            );
    }
    this._recordReconstructionMetrics(reconstructionState);

    const poseOptions = { includePreview: false };
    const pose =
      this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL
        ? this.reconstructor.estimatePoseFromTrackedPoints(
            reconstructionTrackedPoints,
            grayImage,
            poseOptions,
          )
        : this.reconstructor.estimatePoseFromTrackedPoints(reconstructionTrackedPoints, poseOptions);
    this._recordUpdateTiming(updateTimings, 'reconstructionUpdateMs', stageStart);
    if (!pose.success) {
      this.metrics.reconstructionPoseRejectedReason = pose.reason;
      return pose;
    }

    this.metrics.reconstructionPoseRejectedReason = null;
    return {
      ...pose,
      correspondences: reconstructionTrackedPoints
        .filter((point) => point.status === 'active')
        .map((point) => ({
          prev: { x: point.original.x, y: point.original.y },
          curr: { x: point.current.x, y: point.current.y },
        })),
    };
  }

  _shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences }) {
    const planarUsable = this._isUsablePoseResult(planarPose, correspondences);
    if (!planarUsable) {
      return false;
    }

    const reconstructionUsable = this._isUsablePoseResult(
      reconstructionPose,
      reconstructionPose?.correspondences || correspondences,
    );
    const reconstructionHasRealDepth =
      reconstructionUsable && this._hasStrongNonPlanarReconstruction(reconstructionPose);
    const planarStrong = this._hasStrongPlanarAttachmentPose(planarPose, correspondences);
    const planarAttachmentUsable =
      planarStrong ||
      (this._hasPlanarTargetClass() && this._hasPlanarAttachmentPose(planarPose, correspondences));

    if (this._hasRigidPlanarTargetClass()) {
      return planarAttachmentUsable;
    }

    if (this._canSelectedReconstructionOwnAttachment(reconstructionPose)) {
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

    return (
      planarAttachmentUsable &&
      planarPose.inlierCount >= reconstructionPose.inlierCount + 6 &&
      planarPose.confidence >= reconstructionPose.confidence - 0.08
    );
  }

  _hasPlanarAttachmentPose(planarPose, correspondences) {
    if (!planarPose?.success) {
      return false;
    }

    if (this._hasRigidPlanarRecoveryPose(planarPose, correspondences)) {
      return true;
    }

    return this._hasPlanarAttachmentTransform(planarPose, correspondences);
  }

  _hasPlanarAttachmentTransform(planarPose, correspondences) {
    if (!planarPose?.success) {
      return false;
    }

    const spread = planarPose.referenceSpread || this._measureReferenceSpread(correspondences);
    const inlierRatio =
      planarPose.inlierRatio ?? planarPose.inlierCount / Math.max(1, correspondences.length);
    const averageResidual = planarPose.averageResidual ?? Infinity;

    return (
      planarPose.inlierCount >= 10 &&
      inlierRatio >= 0.46 &&
      (planarPose.confidence ?? 0) >= 0.34 &&
      averageResidual <= 3.25 &&
      spread.minAxis >= 18
    );
  }

  _hasStrongPlanarAttachmentPose(planarPose, correspondences) {
    if (!planarPose?.success) {
      return false;
    }

    const spread = planarPose.referenceSpread || this._measureReferenceSpread(correspondences);
    const inlierRatio =
      planarPose.inlierRatio ?? planarPose.inlierCount / Math.max(1, correspondences.length);
    const averageResidual = planarPose.averageResidual ?? Infinity;

    return (
      planarPose.inlierCount >= MIN_PLANAR_ATTACHMENT_POSE_INLIERS &&
      inlierRatio >= 0.5 &&
      (planarPose.confidence ?? 0) >= 0.42 &&
      averageResidual <= 2.2 &&
      spread.minAxis >= 18
    );
  }

  _hasRigidPlanarRecoveryPose(planarPose, correspondences) {
    if (
      !planarPose?.success ||
      !this._hasRigidPlanarTargetClass() ||
      TEXTURED_PLANAR_RECOVERY_EXCLUSION_PATTERN.test(this.anchorTargetClass || '') ||
      this.planarDominanceScore < RIGID_PLANAR_RECOVERY_DOMINANCE_SCORE
    ) {
      return false;
    }

    const activeLandmarks =
      this.metrics.activeLandmarkCount || this.metrics.keypointCount || correspondences.length;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks ?? activeLandmarks;
    const objectOwnedRatio = objectOwnedLandmarks / Math.max(1, activeLandmarks);
    const silhouetteCoverage = this.metrics.silhouetteCoverage ?? 1;
    const contourFitResidual = this.metrics.contourFitResidual ?? 0;
    const spread = planarPose.referenceSpread || this._measureReferenceSpread(correspondences);
    const inlierRatio =
      planarPose.inlierRatio ?? planarPose.inlierCount / Math.max(1, correspondences.length);
    const averageResidual = planarPose.averageResidual ?? Infinity;

    return (
      planarPose.inlierCount >= 8 &&
      inlierRatio >= 0.2 &&
      (planarPose.confidence ?? 0) >= 0.32 &&
      averageResidual <= 9.5 &&
      spread.minAxis >= 18 &&
      objectOwnedRatio >= 0.72 &&
      silhouetteCoverage >= 0.5 &&
      contourFitResidual <= 5
    );
  }

  _selectPlanarAttachmentTransform({ planarPose, trackerAnchorPosition, correspondences }) {
    if (!trackerAnchorPosition || this._hasPlanarAttachmentTransform(planarPose, correspondences)) {
      return planarPose.planarTransform;
    }

    return {
      scale: trackerAnchorPosition.scale,
      rotation: trackerAnchorPosition.rotation,
      confidence: Math.min(
        planarPose.planarTransform?.confidence ?? planarPose.confidence ?? 0,
        trackerAnchorPosition.confidence ?? 0,
      ),
      inlierCount: trackerAnchorPosition.inlierCount,
      method: trackerAnchorPosition.method,
    };
  }

  _shouldUsePlanarPatchTransform({ planarPose, reconstructionPose, correspondences }) {
    if (!isReconstructionMode(this.trackingMode)) {
      return false;
    }

    if (this._canSelectedReconstructionOwnAttachment(reconstructionPose)) {
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

    return (
      this._hasStrongPlanarAttachmentPose(planarPose, correspondences) &&
      planarResidual <= Math.max(4.5, reconstructionResidual + 1.5) &&
      planarConfidence >= reconstructionConfidence - 0.22
    );
  }

  _resolveNormalPose({
    poseArbitration,
    reconstructionPose,
    planarPose,
    objectPose,
    poseResult,
    correspondences,
    preferPlanar,
  }) {
    const objectNormalAllowed = poseArbitration.byRole.object?.normalAllowed === true;
    const localNormalAllowed = poseArbitration.byRole.local?.normalAllowed === true;
    const objectTiltMagnitude = objectPose?.normal ? vectorMagnitude(objectPose.normal) : 0;
    const localTiltMagnitude = poseResult?.normal ? vectorMagnitude(poseResult.normal) : 0;
    const selection = selectPoseNormalOwner({
      arbitration: poseArbitration,
      policy: {
        exposeSelectedPlanarSurface: this._shouldExposeSelectedPlanarSurfacePose({
          reconstructionPose,
          planarPose,
        }),
        preferPlanar,
        preferForeshortenedObject:
          objectNormalAllowed &&
          objectPose.foreshortening < 0.92 &&
          objectTiltMagnitude > 0.18 &&
          (!localNormalAllowed || localTiltMagnitude < objectTiltMagnitude * 0.45),
        preferLocalPlanarByConfidence:
          localNormalAllowed &&
          poseResult.method === 'homography' &&
          poseResult.confidence > (objectPose?.confidence ?? 0) + 0.12,
      },
    });
    const poseByRole = {
      reconstruction: reconstructionPose
        ? { ...reconstructionPose, correspondences: reconstructionPose.correspondences || correspondences }
        : null,
      planar: planarPose
        ? { ...planarPose, correspondences: planarPose.correspondences || correspondences }
        : null,
      object: objectPose
        ? { ...objectPose, correspondences: objectPose.correspondences || correspondences }
        : null,
      local: poseResult
        ? {
            ...poseResult,
            method: poseResult.method === 'homography' ? 'planar-homography' : poseResult.method,
            correspondences,
          }
        : null,
    };

    return {
      selection,
      pose: selection ? poseByRole[selection.role] : null,
    };
  }

  _shouldExposeSelectedPlanarSurfacePose({ reconstructionPose, planarPose }) {
    if (
      !this._hasRigidPlanarTargetClass() ||
      this.trackingMode === RECONSTRUCTION_POSE_MODEL ||
      !this._hasSelectedReconstructionPose(reconstructionPose)
    ) {
      return false;
    }

    const selectedInliers = reconstructionPose.inlierCount || 0;
    const selectedResidual = reconstructionPose.averageResidual ?? Infinity;
    const selectedConfidence = reconstructionPose.confidence ?? 0;
    const mapConfidence =
      reconstructionPose.preview?.statistics?.mapConfidence ?? this.metrics.reconstructionMapConfidence ?? 0;
    const planarInliers = planarPose?.inlierCount || 0;
    const selectedVeryStable =
      selectedInliers >= 24 &&
      selectedConfidence >= 0.92 &&
      selectedResidual <= 2.4 &&
      mapConfidence >= 0.7 &&
      planarInliers < 26;

    return (selectedInliers >= 12 && selectedResidual <= 4.8 && planarInliers < 14) || selectedVeryStable;
  }

  _shouldTrustNormalPose(normalPose) {
    if (!normalPose?.success || !isReconstructionMode(normalPose.method)) {
      return false;
    }

    if (this._hasRigidPlanarTargetClass()) {
      return false;
    }

    if ((normalPose.normal?.z ?? 1) < MIN_RECONSTRUCTION_ATTACHMENT_FORESHORTENING) {
      return false;
    }

    if (this._hasIncompleteSelectedSurfacePrior(normalPose)) {
      return false;
    }

    if (this._shouldDistrustSparseMugSupportHeldNormal(normalPose)) {
      return false;
    }

    return (
      this._hasStrongNonPlanarReconstruction(normalPose) ||
      this._canSelectedReconstructionOwnAttachment(normalPose)
    );
  }

  _shouldDistrustSparseMugSupportHeldNormal(normalPose) {
    if (
      normalPose?.method !== RECONSTRUCTION_POSE_MODEL ||
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL ||
      !this._hasMugLikeTarget() ||
      this.metrics.positionFilterAdjustment !== 'sparse-mug-support-correction-hold'
    ) {
      return false;
    }

    const mapConfidence =
      normalPose.preview?.statistics?.mapConfidence ?? this.metrics.reconstructionMapConfidence ?? 0;
    const matureLandmarks =
      normalPose.preview?.statistics?.matureLandmarks ?? this.metrics.reconstructionMatureLandmarks ?? 0;
    const inliers = normalPose.inlierCount || 0;

    return (
      inliers <= SPARSE_MUG_SUPPORT_HELD_NORMAL_MAX_WEAK_INLIERS ||
      mapConfidence < SPARSE_MUG_SUPPORT_HELD_NORMAL_MIN_MAP_CONFIDENCE ||
      matureLandmarks < SPARSE_MUG_SUPPORT_HELD_NORMAL_MIN_MATURE_LANDMARKS
    );
  }

  _weakNormal(normalPose) {
    if (
      normalPose?.method !== RECONSTRUCTION_POSE_MODEL ||
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL ||
      !this._hasCurvedReconstructionTarget(normalPose) ||
      !this.metrics.reconstructionReady ||
      !this.currentNormal
    ) {
      return false;
    }

    return (
      normalPose.poseObs < MIN_SPARSE_NORMAL_OBSERVABILITY &&
      normalPose.inlierCount <= MAX_WEAKLY_OBSERVED_NORMAL_INLIERS &&
      angularDistanceBetweenNormals(normalPose.normal, this.currentNormal) >=
        MIN_WEAKLY_OBSERVED_NORMAL_INNOVATION
    );
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
    const matureReconstruction =
      this.metrics.reconstructionReady === true || (mapConfidence >= 0.58 && matureLandmarks >= 16);
    if (!matureReconstruction) {
      return false;
    }

    const overwhelmingPlanarEvidence =
      (candidatePose.inlierCount || 0) >= 30 &&
      (candidatePose.inlierRatio ?? 0) >= 0.82 &&
      (candidatePose.confidence ?? 0) >= 0.9 &&
      (candidatePose.averageResidual ?? Infinity) <= 1.2;

    return !overwhelmingPlanarEvidence;
  }

  _isPlanarNormalCandidate(pose) {
    return pose?.success && (pose.method === 'homography' || pose.method === 'planar-homography');
  }

  _recordPoseInlierMetrics(poseResult) {
    const inliers = poseResult.inlierCount || 0;

    this.metrics.poseInliers = inliers;

    if (poseResult.method === 'homography' || poseResult.method === 'planar-homography') {
      this.metrics.homographyInliers = inliers;
      this.metrics.affinePoseInliers = 0;
      this.metrics.planarPnpBranchSelection = poseResult.pnpBranchSelection || null;
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
      ? (planarPose.inlierRatio ?? planarPose.inlierCount / Math.max(1, correspondences.length))
      : 0;
    const strongPlanarEvidence =
      planarPose?.success &&
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
    return (
      isReconstructionMode(this.trackingMode) &&
      this._hasPlanarTargetClass() &&
      this._hasPlanarDominance() &&
      !planarPoseUsable &&
      !this._hasSelectedReconstructionPose(reconstructionPose)
    );
  }

  _isPosePositionConsistentWithTracker(pose, trackerAnchorPosition) {
    if (!pose?.success || !pose.position || !trackerAnchorPosition) {
      return false;
    }

    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    const maxDelta = clamp(templateSize * 0.1, 10, 18);
    const delta = pointDistance(pose.position, trackerAnchorPosition);

    this.metrics.reconstructionTrackerDelta = delta;
    this.metrics.reconstructionTrackerConsistent = delta <= maxDelta;
    return delta <= maxDelta;
  }

  _selectTrackerAnchorPosition({ trackerAnchorPosition, reconstructionPose }) {
    this.metrics.trackerAnchorAdjustment = null;
    if (this._shouldUseObjectOwnedCentroidPosition({ trackerAnchorPosition, reconstructionPose })) {
      const ownedCentroidPosition = this._objectOwnedCentroidTrackerPosition({
        trackerAnchorPosition,
        method: 'object-owned-centroid-position',
        adjustment: 'object-owned-centroid-position',
      });
      if (ownedCentroidPosition) return ownedCentroidPosition;
    }

    if (!this._shouldUseCurvedDropoutCentroidPosition({ trackerAnchorPosition, reconstructionPose })) {
      if (this._shouldUseMatureReconstructionDropoutCentroid({ trackerAnchorPosition, reconstructionPose })) {
        const matureCentroidPosition = this._objectOwnedCentroidTrackerPosition({
          trackerAnchorPosition,
          method: 'object-owned-centroid-position',
          adjustment: 'mature-reconstruction-dropout-centroid',
        });
        if (matureCentroidPosition) return matureCentroidPosition;
      }

      return trackerAnchorPosition;
    }

    const centroidPosition = this._objectOwnedCentroidTrackerPosition({
      trackerAnchorPosition,
      method: 'curved-centroid-position',
      adjustment: 'curved-dropout-centroid-position',
    });

    if (!centroidPosition) {
      return trackerAnchorPosition;
    }

    return centroidPosition;
  }

  _objectOwnedCentroidTrackerPosition({ trackerAnchorPosition, method, adjustment }) {
    const centroidPosition = this.keypointTracker.getCentroidAnchorPosition(this._objectOwnedActivePoints());
    if (!centroidPosition) {
      return null;
    }

    this.metrics.trackerAnchorAdjustment = adjustment;
    this.metrics.trackerAnchorRawResidual = trackerAnchorPosition.averageResidual ?? null;

    return {
      ...trackerAnchorPosition,
      x: centroidPosition.x,
      y: centroidPosition.y,
      confidence: Math.min(
        trackerAnchorPosition.confidence ?? centroidPosition.confidence ?? 0,
        centroidPosition.confidence ?? trackerAnchorPosition.confidence ?? 0,
      ),
      inlierCount: centroidPosition.inlierCount ?? trackerAnchorPosition.inlierCount,
      method,
      transformMethod: trackerAnchorPosition.method,
    };
  }

  _objectOwnedActivePoints() {
    const activePoints = (this.keypointTracker.trackedPoints || []).filter(
      (point) => point.status === 'active',
    );
    if (!this.objectSupportMask) {
      return activePoints;
    }

    return activePoints.filter((point) => point.objectOwned !== false);
  }

  _shouldUseObjectOwnedCentroidPosition({ trackerAnchorPosition, reconstructionPose }) {
    const reconstructionUsable = this._isUsablePoseResult(
      reconstructionPose,
      reconstructionPose?.correspondences || [],
    );
    if (
      !trackerAnchorPosition ||
      reconstructionUsable ||
      !this.objectSupportMask ||
      trackerAnchorPosition.method !== 'reference_similarity_transform'
    ) {
      return false;
    }

    if (this._hasMatureSparseCurvedMap()) {
      return false;
    }

    const activeLandmarks = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks || 0;
    const residual = trackerAnchorPosition.averageResidual ?? 0;
    const confidence = trackerAnchorPosition.confidence ?? 0;
    const ownedRatio = objectOwnedLandmarks / Math.max(1, activeLandmarks);
    const surfaceModel = this._targetSurfaceModel(reconstructionPose);
    const planarSurfaceModel = surfaceModel === SURFACE_MODEL_PLANE;
    const taperedSurfaceModel = surfaceModel === SURFACE_MODEL_TAPERED_CYLINDER;
    const cupLikeCoherentTarget =
      this._hasTaperedCylinderLikeTarget(reconstructionPose) && !this._hasMugLikeTarget();
    const supportsCoherentCentroid =
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      ((!this._hasPlanarTargetClass() && !planarSurfaceModel && !this._hasCurvedReconstructionTarget()) ||
        cupLikeCoherentTarget ||
        (taperedSurfaceModel && !this._hasMugLikeTarget()));
    const coherentCentroidMaxConfidence = cupLikeCoherentTarget || taperedSurfaceModel ? 1 : 0.14;
    const sparseCoherentObjectCluster =
      supportsCoherentCentroid &&
      ownedRatio >= 0.9 &&
      activeLandmarks <= 32 &&
      confidence <= coherentCentroidMaxConfidence &&
      ((activeLandmarks <= 18 && residual >= 16) || residual >= 28);
    const mixedObjectCluster =
      ownedRatio < 0.9 && activeLandmarks < 18 && confidence <= 0.12 && residual >= 28;

    return (
      activeLandmarks >= 8 && objectOwnedLandmarks >= 7 && (mixedObjectCluster || sparseCoherentObjectCluster)
    );
  }

  _shouldUseCurvedDropoutCentroidPosition({ trackerAnchorPosition, reconstructionPose }) {
    if (
      !trackerAnchorPosition ||
      reconstructionPose?.success ||
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL ||
      !isReconstructionMode(this.trackingMode) ||
      !this._hasCurvedReconstructionTarget(reconstructionPose)
    ) {
      return false;
    }

    if (this._hasMugLikeTarget()) {
      return false;
    }

    if (!this._hasMatureCurvedMap()) {
      return false;
    }

    const residual = trackerAnchorPosition.averageResidual ?? Infinity;
    const confidence = trackerAnchorPosition.confidence ?? 0;
    const activeLandmarks =
      this.metrics.activeLandmarkCount ||
      this.metrics.keypointCount ||
      this.metrics.activeLandmarks ||
      this._activeTrackedPointCount();

    return (
      trackerAnchorPosition.method === 'reference_similarity_transform' &&
      residual >= 18 &&
      confidence <= 0.12 &&
      activeLandmarks >= 32
    );
  }

  _shouldUseMatureReconstructionDropoutCentroid({ trackerAnchorPosition, reconstructionPose }) {
    if (
      !trackerAnchorPosition ||
      trackerAnchorPosition.method !== 'reference_similarity_transform' ||
      reconstructionPose?.success ||
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL ||
      !isReconstructionMode(this.trackingMode) ||
      !this._hasPlanarTargetClass() ||
      !this.currentPosition ||
      !this.objectSupportMask
    ) {
      return false;
    }

    const mapConfidence = this.metrics.reconstructionMapConfidence ?? 0;
    const matureLandmarks = this.metrics.reconstructionMatureLandmarks ?? 0;
    const activeLandmarks = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks ?? activeLandmarks;
    const ownedRatio = objectOwnedLandmarks / Math.max(1, activeLandmarks);
    const residual = trackerAnchorPosition.averageResidual ?? 0;

    return (
      this.metrics.reconstructionReady === true &&
      mapConfidence >= 0.62 &&
      matureLandmarks >= 16 &&
      activeLandmarks >= 8 &&
      activeLandmarks <= 18 &&
      residual >= 18 &&
      ownedRatio >= 0.65
    );
  }

  _selectTrackedAttachmentTransform({
    trackerAnchorPosition,
    reconstructionPose,
    useTrackedTransform = false,
  }) {
    if (useTrackedTransform) {
      return {
        scale: trackerAnchorPosition.scale,
        rotation: trackerAnchorPosition.rotation,
        confidence: trackerAnchorPosition.confidence,
        inlierCount: trackerAnchorPosition.inlierCount,
        method: trackerAnchorPosition.method,
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
      method: trackerAnchorPosition.method,
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
        trackerAnchorPosition.confidence ?? 0,
      ),
      inlierCount: Math.min(
        reconstructionPose.planarTransform.inlierCount ?? reconstructionPose.inlierCount ?? 0,
        trackerAnchorPosition.inlierCount ?? 0,
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
    const mapConfidence =
      reconstructionPose.preview?.statistics?.mapConfidence ??
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

    return (
      this._hasPreciseCurvedReconstructionPosition(reconstructionPose) ||
      this._hasTolerantCurvedReconstructionRecovery(reconstructionPose)
    );
  }

  _shouldHoldTrackerPositionForDepthFusion({
    trackerAnchorPosition,
    reconstructionPose,
    useArbiterReconstructionPosition = false,
  }) {
    const releaseForCurvedTarget =
      useArbiterReconstructionPosition && this._depthFusionOwnsCurvedPositionTarget(reconstructionPose);

    return (
      this.trackingMode === DEPTH_FUSION_POSE_MODEL &&
      !!trackerAnchorPosition &&
      this._hasSelectedReconstructionPose(reconstructionPose) &&
      !releaseForCurvedTarget
    );
  }

  _hasPreciseCurvedReconstructionPosition(reconstructionPose) {
    if (
      !this._hasCurvedReconstructionTarget(reconstructionPose) ||
      reconstructionPose.method !== this.trackingMode
    ) {
      return false;
    }

    return (
      (reconstructionPose.inlierCount || 0) >= 18 && (reconstructionPose.averageResidual ?? Infinity) <= 3.2
    );
  }

  _hasTolerantCurvedReconstructionRecovery(reconstructionPose) {
    if (
      !this._hasStrongNonPlanarReconstruction(reconstructionPose) ||
      this._hasPlanarTargetClass() ||
      !this._hasCurvedReconstructionTarget(reconstructionPose) ||
      reconstructionPose.method !== this.trackingMode
    ) {
      return false;
    }

    if (this._hasPreciseCurvedReconstructionPosition(reconstructionPose)) {
      return false;
    }

    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    const trackerDelta = this.metrics.reconstructionTrackerDelta || 0;
    const mapConfidence =
      reconstructionPose.preview?.statistics?.mapConfidence ??
      this.metrics.reconstructionMapConfidence ??
      reconstructionPose.confidence ??
      0;
    const inliers = reconstructionPose.inlierCount || 0;
    const averageResidual = reconstructionPose.averageResidual ?? Infinity;
    const moderateTrackerDivergence = trackerDelta >= clamp(templateSize * 0.1, 10, 18);
    const severeTrackerDivergence = trackerDelta >= clamp(templateSize * 0.28, 32, 48);
    if (severeTrackerDivergence) {
      return mapConfidence >= 0.82 && inliers >= 20 && averageResidual <= 5.2;
    }

    const matureCurvedRecovery =
      moderateTrackerDivergence && mapConfidence >= 0.72 && inliers >= 18 && averageResidual <= 10.5;

    return matureCurvedRecovery;
  }

  _hasModerateCurvedReconstructionRecovery({ reconstructionPose, trackerAnchorPosition }) {
    if (
      !reconstructionPose?.success ||
      this._hasPlanarTargetClass() ||
      !this._hasCurvedReconstructionTarget(reconstructionPose) ||
      reconstructionPose.method !== this.trackingMode ||
      !trackerAnchorPosition
    ) {
      return false;
    }

    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    const trackerDelta = this.metrics.reconstructionTrackerDelta || 0;
    const trackerResidual = trackerAnchorPosition.averageResidual ?? 0;
    const trackerConfidence = trackerAnchorPosition.confidence ?? 0;
    const mapConfidence =
      reconstructionPose.preview?.statistics?.mapConfidence ??
      this.metrics.reconstructionMapConfidence ??
      reconstructionPose.confidence ??
      0;
    const matureLandmarks = this.metrics.reconstructionMatureLandmarks || 0;
    const poseResidual = reconstructionPose.averageResidual ?? Infinity;
    const poseInliers = reconstructionPose.inlierCount || 0;
    const trackerIncoherent = trackerResidual >= 12 || trackerConfidence <= 0.18;
    const trackerDiverged = trackerDelta >= clamp(templateSize * 0.08, 8, 16);
    const strongPose = poseInliers >= 10 && poseResidual <= 3.6;
    const compactPose = poseInliers >= 8 && poseResidual <= 2.25 && mapConfidence >= 0.82;

    return (
      this.metrics.reconstructionReady === true &&
      mapConfidence >= 0.72 &&
      matureLandmarks >= 16 &&
      trackerIncoherent &&
      trackerDiverged &&
      (strongPose || compactPose)
    );
  }

  _shouldUseTrackedCurvedAttachmentTransform({ reconstructionPose, trackerAnchorPosition }) {
    return (
      !!trackerAnchorPosition &&
      this._hasCurvedReconstructionTarget(reconstructionPose) &&
      reconstructionPose?.success &&
      reconstructionPose.method === this.trackingMode &&
      reconstructionPose.planarTransform?.method === 'reference_similarity_transform'
    );
  }

  _shouldBlendTrackerScaleForSelectedCurvedTransform({ reconstructionPose, trackerAnchorPosition }) {
    if (
      !trackerAnchorPosition ||
      !this._hasCurvedReconstructionTarget(reconstructionPose) ||
      reconstructionPose?.method !== this.trackingMode ||
      !reconstructionPose?.planarTransform ||
      reconstructionPose.planarTransform.method === 'reference_similarity_transform'
    ) {
      return false;
    }

    const selectedScale = reconstructionPose.planarTransform.scale;
    const trackerScale = trackerAnchorPosition.scale;
    if (
      !Number.isFinite(selectedScale) ||
      !Number.isFinite(trackerScale) ||
      selectedScale <= 0 ||
      trackerScale <= 0
    ) {
      return false;
    }

    const trackerConfidence = trackerAnchorPosition.confidence ?? 0;
    const trackerResidual = trackerAnchorPosition.averageResidual ?? Infinity;
    const scaleRatio = selectedScale / trackerScale;

    return trackerConfidence >= 0.45 && trackerResidual <= 8 && (scaleRatio >= 1.28 || scaleRatio <= 0.78);
  }

  _shouldRejectPlanarNormalForCurvedTarget(reconstructionPose) {
    return (
      isReconstructionMode(this.trackingMode) &&
      this._hasCurvedReconstructionTarget(reconstructionPose) &&
      !this._hasSelectedReconstructionPose(reconstructionPose)
    );
  }

  _shouldRelaxStaleCurvedNormal() {
    if (!isReconstructionMode(this.trackingMode) || this._hasPlanarTargetClass()) {
      return false;
    }

    if (this.framesWithoutNormalPose < 3) {
      return false;
    }

    const currentTilt = vectorMagnitude(this.currentNormal);

    return this._hasCurvedReconstructionTarget() && currentTilt > 0.18;
  }

  _hasCurvedReconstructionTarget(reconstructionPose) {
    if (this._hasPlanarTargetClass()) {
      return false;
    }

    const surfaceModel = this._targetSurfaceModel(reconstructionPose);

    return (
      CURVED_SURFACE_MODELS.has(surfaceModel) ||
      /cup|mug|vase|can|bottle|jar|container|ball|sphere/i.test(this.anchorTargetClass || '')
    );
  }

  _targetSurfaceModel(reconstructionPose = null) {
    const supportMask = this.currentObjectSupportMask || this.objectSupportMask || null;
    const region = supportMask?.bbox || this.trackingRegion || this.templateRegion;
    if (this._hasGenericTargetClass()) {
      if (!region) {
        return null;
      }
      if (this._hasSparseGenericSupportMask(supportMask)) {
        return null;
      }

      return modelFromRegion(region, null);
    }

    if (NON_PRIMITIVE_TARGET_CLASS_PATTERN.test(this.anchorTargetClass || '')) {
      return null;
    }

    const previewModel =
      reconstructionPose?.preview?.surface?.model ||
      this.metrics.reconstructionPreview?.surface?.model ||
      null;
    if (previewModel) {
      return previewModel;
    }

    if (!region) {
      return null;
    }

    if (SURFACE_CLASS_HINT_PATTERN.test(this.anchorTargetClass || '')) {
      return modelFromRegion(region, this.anchorTargetClass);
    }

    return null;
  }

  _hasGenericTargetClass() {
    return GENERIC_TARGET_CLASS_PATTERN.test(this.anchorTargetClass || '');
  }

  _hasSparseGenericSupportMask(objectSupportMask) {
    const bboxArea = Math.max(
      1,
      (objectSupportMask?.bbox?.width || 0) * (objectSupportMask?.bbox?.height || 0),
    );
    if (!objectSupportMask || !Number.isFinite(objectSupportMask.pixelCount) || bboxArea <= 1) {
      return false;
    }

    return objectSupportMask.pixelCount / bboxArea < MIN_GENERIC_PRIMITIVE_MASK_FILL_RATIO;
  }

  _hasMugLikeTarget() {
    return MUG_TARGET_CLASS_PATTERN.test(this.anchorTargetClass || '');
  }

  _hasCylinderLikeTarget(reconstructionPose = null) {
    return (
      this._targetSurfaceModel(reconstructionPose) === SURFACE_MODEL_CYLINDER ||
      /can|bottle|jar|container/i.test(this.anchorTargetClass || '')
    );
  }

  _hasKnownDepthCylinderTargetClass() {
    return (
      /can|bottle|jar|container/i.test(this.anchorTargetClass || '') &&
      !this._hasMugLikeTarget() &&
      !/cup|vase/i.test(this.anchorTargetClass || '')
    );
  }

  _hasCanLikeTargetClass() {
    return (
      CAN_LIKE_TARGET_CLASS_PATTERN.test(this.anchorTargetClass || '') &&
      !/bottle|cup|mug|vase/i.test(this.anchorTargetClass || '')
    );
  }

  _shouldPreferObjectWideTrackerSimilarity() {
    const usesDenseReconstruction =
      this.trackingMode === DEPTH_FUSION_POSE_MODEL || this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL;

    return usesDenseReconstruction && this._hasMugLikeTarget() && this.metrics.reconstructionReady === true;
  }

  _depthFusionOwnsCurvedPositionTarget(reconstructionPose = null) {
    return (
      this._hasKnownDepthCylinderTargetClass() ||
      (this._hasTaperedCylinderLikeTarget(reconstructionPose) && !this._hasMugLikeTarget())
    );
  }

  _hasTaperedCylinderLikeTarget(reconstructionPose = null) {
    return (
      this._targetSurfaceModel(reconstructionPose) === SURFACE_MODEL_TAPERED_CYLINDER ||
      /cup|vase/i.test(this.anchorTargetClass || '')
    );
  }

  _hasPlanarTargetClass() {
    if (PLANAR_TARGET_CLASS_PATTERN.test(this.anchorTargetClass || '')) {
      return true;
    }

    return this._hasGenericTargetClass() && this._targetSurfaceModel() === SURFACE_MODEL_PLANE;
  }

  _hasRigidPlanarTargetClass() {
    if (RIGID_PLANAR_TARGET_CLASS_PATTERN.test(this.anchorTargetClass || '')) {
      return true;
    }

    return this._hasGenericTargetClass() && this._targetSurfaceModel() === SURFACE_MODEL_PLANE;
  }

  _shouldBoundRigidPlanarTrackingRegion() {
    return (
      this._hasRigidPlanarTargetClass() &&
      (this.trackingMode === PARAMETRIC_SURFACE_POSE_MODEL ||
        this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL)
    );
  }

  _hasSelectedReconstructionPose(reconstructionPose) {
    if (!reconstructionPose?.success || reconstructionPose.method !== this.trackingMode) {
      return false;
    }

    if (this.trackingMode === RECONSTRUCTION_POSE_MODEL) return false;

    const mapConfidence =
      reconstructionPose.preview?.statistics?.mapConfidence ??
      this.metrics.reconstructionMapConfidence ??
      reconstructionPose.confidence ??
      0;
    const minInliers =
      this.trackingMode === DEPTH_FUSION_POSE_MODEL &&
      this._hasTaperedCylinderLikeTarget(reconstructionPose) &&
      !this._hasMugLikeTarget()
        ? 9
        : 12;
    return mapConfidence >= 0.48 && (reconstructionPose.inlierCount || 0) >= minInliers;
  }

  _hasSelectedReconstructionPosition(reconstructionPose) {
    return (
      this._hasSelectedReconstructionPose(reconstructionPose) &&
      !this._shouldRejectDivergentCurvedPosition(reconstructionPose)
    );
  }

  _shouldRejectDivergentCurvedPosition(reconstructionPose) {
    if (
      !reconstructionPose?.success ||
      reconstructionPose.method !== this.trackingMode ||
      !this._hasCurvedReconstructionTarget(reconstructionPose)
    ) {
      return false;
    }

    const poseResidual = reconstructionPose.averageResidual ?? Infinity;
    const poseInliers = reconstructionPose.inlierCount || 0;
    if (this.trackingMode === RECONSTRUCTION_POSE_MODEL) {
      if (!this._hasMugLikeTarget()) {
        return false;
      }

      const sparseTemplateSize = this.templateRegion
        ? Math.max(this.templateRegion.width, this.templateRegion.height)
        : 120;
      const sparseTrackerDelta = this.metrics.reconstructionTrackerDelta || 0;
      const divergentSparsePose =
        sparseTrackerDelta >=
        clamp(
          sparseTemplateSize * SPARSE_MUG_DIVERGENCE_RATIO,
          SPARSE_MUG_DIVERGENCE_MIN_PX,
          SPARSE_MUG_DIVERGENCE_MAX_PX,
        );
      return (
        divergentSparsePose &&
        poseInliers <= SPARSE_MUG_DIVERGENCE_MAX_INLIERS &&
        poseResidual > SPARSE_MUG_DIVERGENCE_MIN_RESIDUAL
      );
    }

    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    const trackerDelta = this.metrics.reconstructionTrackerDelta || 0;
    const severeTrackerDivergence = trackerDelta >= clamp(templateSize * 0.28, 32, 48);
    if (!severeTrackerDivergence) {
      return false;
    }

    return poseResidual > MAX_OBJECT_ATTACHMENT_POSE_RESIDUAL && poseInliers < 18;
  }

  _hasIncompleteSelectedSurfacePrior(reconstructionPose) {
    return (
      reconstructionPose?.method === 'parametric-surface' &&
      this.trackingMode === 'parametric-surface' &&
      this._hasMugLikeTarget()
    );
  }

  _canSelectedReconstructionOwnAttachment(reconstructionPose) {
    return (
      this._hasSelectedReconstructionPosition(reconstructionPose) &&
      !this._hasIncompleteSelectedSurfacePrior(reconstructionPose)
    );
  }

  _shouldSkipPlanarPoseForSelectedReconstruction(reconstructionPose) {
    return (
      isReconstructionMode(this.trackingMode) &&
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL &&
      !this._hasPlanarTargetClass() &&
      this._canSelectedReconstructionOwnAttachment(reconstructionPose) &&
      this._hasStrongNonPlanarReconstruction(reconstructionPose) &&
      this._hasCurvedReconstructionTarget(reconstructionPose)
    );
  }

  _recordReconstructionMetrics(reconstructionState) {
    const statistics = reconstructionState.statistics || reconstructionState.preview?.statistics || null;
    this.metrics.reconstructionState = reconstructionState.state;
    this.metrics.reconstructionReady = reconstructionState.ready;
    this.metrics.reconstructionFrames = reconstructionState.frameCount;
    this.metrics.reconstructionLandmarks = reconstructionState.landmarkCount;
    this.metrics.reconstructionDepthQuality = reconstructionState.depthQuality;
    this.metrics.reconstructionFailureReason = reconstructionState.lastFailureReason;
    if ('preview' in reconstructionState) {
      this.metrics.reconstructionPreview = reconstructionState.preview || null;
    }
    this.metrics.reconstructionMapConfidence = statistics?.mapConfidence;
    this.metrics.reconstructionAverageSupport = statistics?.averageSupport;
    this.metrics.reconstructionAverageReliability = statistics?.averageReliability;
    this.metrics.reconstructionGeometricConsistency = statistics?.geometricConsistency;
    this.metrics.reconstructionMatureLandmarks = statistics?.matureLandmarks;
    this.metrics.reconstructionDepthStatus = reconstructionState.depthStatus;
    this.metrics.reconstructionDepthProvider = reconstructionState.depthProvider;
    this.metrics.reconstructionDepthInferenceTime = reconstructionState.depthInferenceTime;
    this.metrics.reconstructionDepthFrameTimestamp = reconstructionState.depthFrameTimestamp;
  }

  _recordReconstructionPoseMetrics(reconstructionPose, { active = true } = {}) {
    this.metrics.reconstructionPoseInliers = reconstructionPose.inlierCount || 0;
    this.metrics.reconstructionPoseNormal = reconstructionPose.normal || null;
    this.metrics.poseObs = reconstructionPose.poseObs ?? null;
    this.metrics.reconstructionPoseNormalDetached =
      this._hasIncompleteSelectedSurfacePrior(reconstructionPose);
    this.metrics.poseInliers = Math.max(this.metrics.poseInliers || 0, reconstructionPose.inlierCount || 0);
    if (active) {
      this.metrics.poseSource = reconstructionPose.method;
    }
    this.metrics.poseConfidence = reconstructionPose.confidence;
    this.metrics.poseAverageResidual = reconstructionPose.averageResidual;
    this.metrics.poseForeshortening = reconstructionPose.depthQuality;
    this.metrics.reconstructionPnpInliers = reconstructionPose.pnpInlierCount || 0;
    this.metrics.reconstructionPnpAverageResidual = reconstructionPose.pnpAverageResidual ?? null;
    this.metrics.reconstructionPreview =
      reconstructionPose.preview || this.metrics.reconstructionPreview || null;
    this.metrics.reconstructionMapConfidence =
      reconstructionPose.preview?.statistics?.mapConfidence ?? this.metrics.reconstructionMapConfidence;
    this.metrics.reconstructionAverageSupport =
      reconstructionPose.preview?.statistics?.averageSupport ?? this.metrics.reconstructionAverageSupport;
    this.metrics.reconstructionAverageReliability =
      reconstructionPose.preview?.statistics?.averageReliability ??
      this.metrics.reconstructionAverageReliability;
    this.metrics.reconstructionGeometricConsistency =
      reconstructionPose.preview?.statistics?.geometricConsistency ??
      this.metrics.reconstructionGeometricConsistency;
    this.metrics.reconstructionMatureLandmarks =
      reconstructionPose.preview?.statistics?.matureLandmarks ?? this.metrics.reconstructionMatureLandmarks;
  }

  _updatePlanarTransform(anchorPosition, timestamp = null, { absoluteRelocalization = false } = {}) {
    const previous = this.currentPlanarTransform || {
      scale: 1,
      rotation: 0,
      confidence: 0,
      inlierCount: 0,
      method: 'uninitialized',
    };

    const measuredScale = typeof anchorPosition.scale === 'number' ? anchorPosition.scale : previous.scale;
    const surfaceModel = this._targetSurfaceModel(anchorPosition) || '';
    const cylinderReferenceScale =
      anchorPosition.method === 'reference_similarity_transform' &&
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      surfaceModel === SURFACE_MODEL_CYLINDER;
    const cylinderReconstructionScale =
      anchorPosition.method === RECONSTRUCTION_POSE_MODEL &&
      this._hasCylinderLikeTarget(anchorPosition) &&
      (this.currentNormal?.z ?? 1) > 0.9;
    const rawScale = cylinderReferenceScale
      ? measuredScale * 1.015
      : cylinderReconstructionScale
        ? measuredScale * 1.03
        : measuredScale;
    let boundedScale =
      this.currentPlanarTransform && !absoluteRelocalization
        ? clamp(
            rawScale,
            previous.scale * Math.exp(-SCALE_STEP_LOG_LIMIT),
            previous.scale * Math.exp(SCALE_STEP_LOG_LIMIT),
          )
        : rawScale;
    const holdSparseMugReferenceScale =
      anchorPosition.method === 'reference_similarity_transform' &&
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasMugLikeTarget();
    const holdSparseMugCentroidScale =
      anchorPosition.method === 'curved-centroid-position' &&
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasMugLikeTarget();
    const holdSelectedCurvedReferenceScale = this._shouldHoldSelectedCurvedReferenceScale(anchorPosition);
    if (this.currentPlanarTransform && holdSparseMugReferenceScale) {
      boundedScale = Math.max(boundedScale, previous.scale * 0.985);
    }
    if (this.currentPlanarTransform && holdSparseMugCentroidScale) {
      boundedScale = Math.max(boundedScale, previous.scale);
    }
    if (this.currentPlanarTransform && holdSelectedCurvedReferenceScale) {
      boundedScale =
        this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL
          ? previous.scale + (1 - previous.scale) * DIRECT_CURVED_DROPOUT_SCALE_RELAXATION
          : previous.scale;
    }
    const useLowLagRigidPlanarScale = this._shouldUseLowLagRigidPlanarScale(anchorPosition);
    if (useLowLagRigidPlanarScale) {
      boundedScale = rawScale;
    }
    const rawRotation =
      typeof anchorPosition.rotation === 'number'
        ? unwrapAngle(anchorPosition.rotation, previous.rotation)
        : previous.rotation;
    if (absoluteRelocalization) {
      this.planarScaleFilter = createPlanarScaleFilter();
      this.curvedScaleFilter = createCurvedScaleFilter();
      this.planarRotationFilter = createPlanarRotationFilter();
    }
    const filteredScale = this._scaleFilterFor(anchorPosition).filter(boundedScale, timestamp);

    this.currentPlanarTransform = {
      scale: useLowLagRigidPlanarScale ? boundedScale : filteredScale,
      rotation: this.planarRotationFilter.filter(rawRotation, timestamp),
      confidence:
        typeof anchorPosition.confidence === 'number' ? anchorPosition.confidence : previous.confidence,
      inlierCount:
        typeof anchorPosition.inlierCount === 'number' ? anchorPosition.inlierCount : previous.inlierCount,
      method: anchorPosition.method || previous.method,
    };

    return this.currentPlanarTransform;
  }

  _scaleFilterFor(anchorPosition) {
    return this._hasCurvedReconstructionTarget(anchorPosition)
      ? this.curvedScaleFilter
      : this.planarScaleFilter;
  }

  _shouldUseLowLagRigidPlanarScale(anchorPosition) {
    return (
      anchorPosition.method === 'reference_similarity_transform' &&
      this._hasRigidPlanarTargetClass() &&
      this._hasPlanarDominance() &&
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      (anchorPosition.confidence ?? 0) >= 0.52 &&
      (anchorPosition.inlierCount ?? 0) >= 10 &&
      (anchorPosition.averageResidual ?? 0) <= 16
    );
  }

  _shouldHoldSelectedCurvedReferenceScale(anchorPosition) {
    if (
      anchorPosition.method !== 'reference_similarity_transform' ||
      this.trackingMode === RECONSTRUCTION_POSE_MODEL ||
      !isReconstructionMode(this.trackingMode) ||
      !this._hasCurvedReconstructionTarget(anchorPosition) ||
      !(this._hasMugLikeTarget() || this._hasTaperedCylinderLikeTarget(anchorPosition)) ||
      this.metrics.reconstructionReady !== true ||
      (this.metrics.reconstructionMapConfidence ?? 0) < 0.66 ||
      (this.metrics.reconstructionMatureLandmarks || 0) < 16 ||
      (this.metrics.reconstructionPoseInliers || 0) > 0
    ) {
      return false;
    }

    const confidence = anchorPosition.confidence ?? 0;
    const inliers = anchorPosition.inlierCount || 0;
    const residual = anchorPosition.averageResidual;
    const canReleaseScaleHold =
      this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL &&
      confidence >= MIN_SELECTED_CURVED_REFERENCE_SCALE_CONFIDENCE &&
      inliers >= MIN_SELECTED_CURVED_REFERENCE_SCALE_INLIERS &&
      (!Number.isFinite(residual) || residual <= MAX_CURVED_REFERENCE_BLEND_RESIDUAL);
    if (canReleaseScaleHold) {
      return false;
    }

    return confidence <= 0.24 || (residual ?? Infinity) >= MAX_CURVED_REFERENCE_BLEND_RESIDUAL;
  }

  _filterPositionCandidate(position, timestamp, method, { absoluteRelocalization = false } = {}) {
    if (absoluteRelocalization) {
      this.positionFilterX = createPositionFilter();
      this.positionFilterY = createPositionFilter();
      this.positionFilterX.filter(position.x, timestamp);
      this.positionFilterY.filter(position.y, timestamp);
      this.metrics.positionFilterAdjustment = 'absolute-relocalization';
      return { ...position, z: position.z ?? 0 };
    }

    const unreadyMugMotionPrediction = this._getUnreadyMugMotionPrediction(position, timestamp, method);
    if (unreadyMugMotionPrediction) {
      this.metrics.positionFilterAdjustment = 'unready-mug-motion-prediction';
      return this._limitStep(
        {
          ...position,
          x: unreadyMugMotionPrediction.x,
          y: unreadyMugMotionPrediction.y,
          z: 0,
          confidence: Math.min(position.confidence ?? 0, unreadyMugMotionPrediction.confidence),
        },
        method,
      );
    }

    const weakMugMotionPrediction = this._getWeakMugMotionBridge(position, timestamp, method);
    if (weakMugMotionPrediction) {
      this.metrics.positionFilterAdjustment = 'weak-mug-motion-bridge';
      return this._limitStep(
        {
          ...weakMugMotionPrediction,
          confidence: Math.min(position.confidence ?? 0, weakMugMotionPrediction.confidence),
          averageResidual: position.averageResidual,
          inlierCount: position.inlierCount,
        },
        method,
      );
    }

    if (this._shouldHoldSparseMugSupportBacktrack(position, method)) {
      this.metrics.positionFilterAdjustment = 'sparse-mug-support-correction-hold';
      return {
        ...position,
        x: this.currentPosition.x,
        y: this.currentPosition.y,
        z: 0,
      };
    }

    if (this._shouldUseCurvedMotionPrediction(position, method)) {
      const predicted = this._predictCurvedMotionPosition(timestamp);
      if (predicted) {
        const rawWeight = this._curvedReferencePredictionBlendWeight(position, method);
        if (rawWeight > 0 || this._shouldUseCurvedMotionHoldTarget()) {
          const predictedAdjustment =
            rawWeight > 0
              ? {
                  x: predicted.x + (position.x - predicted.x) * rawWeight,
                  y: predicted.y + (position.y - predicted.y) * rawWeight,
                  z: 0,
                }
              : predicted;
          this.metrics.positionFilterAdjustment =
            rawWeight > 0 ? 'curved-reference-prediction-blend' : 'curved-motion-hold';
          return this._limitStep(
            {
              ...predictedAdjustment,
              confidence: Math.min(position.confidence ?? 0, predicted.confidence),
              averageResidual: position.averageResidual,
              inlierCount: position.inlierCount,
            },
            method,
          );
        }
      }
    }

    const coherentTrackerPrediction = this._getCoherentCurvedTrackerMotionPrediction(
      position,
      timestamp,
      method,
    );
    if (this._shouldUseHighConfidenceTrackerStepPosition(position, method)) {
      this.metrics.positionFilterAdjustment = 'high-confidence-tracker-step-position';
      return this._limitStep(
        {
          x: position.x,
          y: position.y,
          z: position.z ?? 0,
          confidence: position.confidence,
          averageResidual: position.averageResidual,
          inlierCount: position.inlierCount,
        },
        method,
      );
    }

    const filtered = {
      ...position,
      x: this.positionFilterX.filter(position.x, timestamp),
      y: this.positionFilterY.filter(position.y, timestamp),
      z: 0,
    };

    let adjustment = null;
    let adjusted = filtered;

    if (coherentTrackerPrediction) {
      adjusted = {
        ...position,
        x: filtered.x + (position.x - filtered.x) * COHERENT_CURVED_TRACKER_RAW_WEIGHT,
        y: filtered.y + (position.y - filtered.y) * COHERENT_CURVED_TRACKER_RAW_WEIGHT,
        z: 0,
      };
      adjustment = 'coherent-curved-tracker-motion-blend';
    } else if (this._shouldUseStepOnlyBookPosition()) {
      adjusted = {
        ...position,
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
        inlierCount: position.inlierCount,
      };
      adjustment = 'post-hold-reference-recovery-step';
    } else if (this._shouldUseMatureCurvedRecoveryStep(method)) {
      adjusted = {
        ...position,
        x: position.x,
        y: position.y,
        z: 0,
      };
      adjustment = 'curved-recovery-step-position';
    } else if (this._shouldBlendPlanarPosePosition(method)) {
      adjusted = {
        ...filtered,
        x: filtered.x + (position.x - filtered.x) * PLANAR_POSE_POSITION_BLEND,
        y: filtered.y + (position.y - filtered.y) * PLANAR_POSE_POSITION_BLEND,
        z: 0,
      };
      adjustment = 'planar-pose-blend';
    }

    this.metrics.positionFilterAdjustment = adjustment;

    return this._limitStep(adjusted, method);
  }

  _getUnreadyMugMotionPrediction(position, timestamp, method) {
    const sample = this.curvedMotionSample;
    if (
      method !== 'reference_similarity_transform' ||
      !this._hasUnreadyHandledMugMotionRecoveryTarget() ||
      !sample ||
      sample.confidence < SUPPORT_RECOVERY_MOTION_MIN_CONFIDENCE ||
      (position.confidence ?? 0) > MAX_SEVERE_CURVED_REFERENCE_CONFIDENCE ||
      (position.averageResidual ?? 0) < MIN_SEVERE_CURVED_REFERENCE_RESIDUAL
    ) {
      return null;
    }

    const sampleAge = timestamp - sample.timestamp;
    const speed = vectorMagnitude(sample.velocity);
    const innovation = {
      x: position.x - this.currentPosition.x,
      y: position.y - this.currentPosition.y,
    };
    if (
      sampleAge <= 0 ||
      sampleAge > SUPPORT_RECOVERY_MOTION_MAX_AGE_MS ||
      speed < SUPPORT_RECOVERY_MOTION_MIN_SPEED ||
      innovation.x * sample.velocity.x + innovation.y * sample.velocity.y >= 0
    ) {
      return null;
    }

    return this._predictCurvedMotionPosition(timestamp);
  }

  _getWeakMugMotionBridge(position, timestamp, method) {
    const sample = this.curvedMotionSample;
    const trackerCandidate = this.metrics.poseCandidates?.find((candidate) => candidate.role === 'tracker');
    const trackerPositionWeak =
      trackerCandidate?.rejected === 'weak-geometry' ||
      trackerCandidate?.positionQualityRejected === 'weak-geometry';
    const methodOwnsReconstruction = method === this.trackingMode && isReconstructionMode(method);
    if (
      !sample ||
      this.trackingMode !== DIRECT_PHOTOMETRIC_POSE_MODEL ||
      !this._hasMugLikeTarget() ||
      this.metrics.reconstructionReady !== true ||
      (this.metrics.reconstructionMatureLandmarks || 0) < MIN_WEAK_MUG_MOTION_BRIDGE_MATURE_LANDMARKS ||
      (!methodOwnsReconstruction && method !== 'reference_similarity_transform') ||
      !trackerPositionWeak
    ) {
      return null;
    }

    const selectedPositionWeak =
      (position.averageResidual ?? Infinity) > MAX_DIRECT_CURVED_MOTION_SAMPLE_RESIDUAL ||
      (position.inlierCount || 0) <= MAX_WEAK_MUG_MOTION_BRIDGE_INLIERS;
    if (!selectedPositionWeak) {
      return null;
    }

    const sampleAge = timestamp - sample.timestamp;
    const speed = vectorMagnitude(sample.velocity);
    if (
      sampleAge <= 0 ||
      sampleAge > MAX_COHERENT_CURVED_TRACKER_SAMPLE_AGE_MS ||
      speed < MIN_CURVED_RELOCALIZATION_MOTION_SPEED
    ) {
      return null;
    }

    const candidateMotion = {
      x: position.x - sample.position.x,
      y: position.y - sample.position.y,
    };
    const candidateDistance = vectorMagnitude(candidateMotion);
    if (candidateDistance < MIN_WEAK_MUG_MOTION_BRIDGE_DELTA) {
      return null;
    }
    const candidateAlignment =
      (candidateMotion.x * sample.velocity.x + candidateMotion.y * sample.velocity.y) /
      (candidateDistance * speed);
    if (candidateAlignment > MAX_WEAK_MUG_MOTION_BRIDGE_ALIGNMENT) {
      return null;
    }

    return this._predictCurvedMotionPosition(timestamp);
  }

  _shouldHoldSparseMugSupportBacktrack(position, method) {
    if (
      method !== RECONSTRUCTION_POSE_MODEL ||
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL ||
      !this._hasMugLikeTarget() ||
      !this.currentPosition ||
      !this.objectSupportCorrectionHold
    ) {
      return false;
    }

    const elapsedFrames = this.frameIndex - this.objectSupportCorrectionHold.frameIndex;
    if (elapsedFrames <= 0 || elapsedFrames > SPARSE_MUG_SUPPORT_CORRECTION_HOLD_FRAMES) {
      return false;
    }

    const step = {
      x: position.x - this.currentPosition.x,
      y: position.y - this.currentPosition.y,
    };
    const stepMagnitude = vectorMagnitude(step);
    if (stepMagnitude < SPARSE_MUG_SUPPORT_CORRECTION_MIN_BACKTRACK_STEP) {
      return false;
    }

    const correction = this.objectSupportCorrectionHold;
    const alignment =
      (step.x * correction.direction.x + step.y * correction.direction.y) /
      (stepMagnitude * correction.magnitude);
    return alignment < -0.35;
  }

  _shouldUseHighConfidenceTrackerStepPosition(position, method) {
    return (
      method === 'reference_similarity_transform' &&
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL &&
      (position.confidence ?? 0) >= MIN_LOW_LAG_TRACKER_CONFIDENCE &&
      (position.averageResidual ?? Infinity) <= MAX_LOW_LAG_TRACKER_RESIDUAL
    );
  }

  _getCoherentCurvedTrackerMotionPrediction(position, timestamp, method) {
    const sample = this.curvedMotionSample;
    const activeLandmarks = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
    if (
      method !== 'reference_similarity_transform' ||
      this.trackingMode !== DIRECT_PHOTOMETRIC_POSE_MODEL ||
      !sample ||
      !this._hasCurvedReconstructionTarget(position) ||
      this._shouldUseHighConfidenceTrackerStepPosition(position, method) ||
      (position.confidence ?? 0) < MIN_COHERENT_CURVED_TRACKER_CONFIDENCE ||
      (position.averageResidual ?? Infinity) > MAX_COHERENT_CURVED_TRACKER_RESIDUAL ||
      (position.inlierCount || 0) < MIN_COHERENT_CURVED_TRACKER_INLIERS ||
      activeLandmarks < MIN_COHERENT_CURVED_TRACKER_LANDMARKS
    ) {
      return null;
    }

    const sampleAge = timestamp - sample.timestamp;
    const speed = vectorMagnitude(sample.velocity);
    if (
      sampleAge <= 0 ||
      sampleAge > MAX_COHERENT_CURVED_TRACKER_SAMPLE_AGE_MS ||
      speed < MIN_COHERENT_CURVED_TRACKER_SPEED
    ) {
      return null;
    }

    const predicted = this._predictCurvedMotionPosition(timestamp);
    if (!predicted || pointDistance(position, predicted) > MAX_COHERENT_CURVED_TRACKER_PREDICTION_DELTA) {
      return null;
    }

    const movementX = position.x - sample.position.x;
    const movementY = position.y - sample.position.y;
    const movementDistance = Math.hypot(movementX, movementY);
    const alignment =
      movementDistance > 0
        ? (movementX * sample.velocity.x + movementY * sample.velocity.y) / (movementDistance * speed)
        : -1;

    return alignment >= MIN_COHERENT_CURVED_TRACKER_ALIGNMENT ? predicted : null;
  }

  _shouldUseCurvedMotionHoldTarget() {
    return !/bottle|mug/i.test(this.anchorTargetClass || '');
  }

  _curvedReferencePredictionBlendWeight(position, method) {
    if (
      method !== 'reference_similarity_transform' ||
      this.trackingMode === RECONSTRUCTION_POSE_MODEL ||
      !isReconstructionMode(this.trackingMode)
    ) {
      return 0;
    }

    const confidence = position.confidence ?? 0;
    const residual = position.averageResidual ?? Infinity;
    const inliers = position.inlierCount || 0;
    if (
      confidence < MIN_CURVED_REFERENCE_BLEND_CONFIDENCE ||
      residual > MAX_CURVED_REFERENCE_BLEND_RESIDUAL ||
      inliers < MIN_CURVED_REFERENCE_BLEND_INLIERS
    ) {
      return 0;
    }

    return clamp(
      0.42 + confidence * 0.45 + (MAX_CURVED_REFERENCE_BLEND_RESIDUAL - residual) * 0.025,
      0.42,
      0.68,
    );
  }

  _shouldUseCurvedMotionPrediction(position, method) {
    if (
      method !== 'reference_similarity_transform' ||
      !this.curvedMotionSample ||
      !this._hasCurvedReconstructionTarget() ||
      this.metrics.reconstructionReady !== true
    ) {
      return false;
    }

    if (this._hasCoherentSelectedParametricPose()) {
      return false;
    }

    if (this._shouldUseSparseCurvedMotionPrediction()) {
      return true;
    }

    if (this.trackingMode === RECONSTRUCTION_POSE_MODEL) {
      return false;
    }

    const activeLandmarks = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
    const matureLandmarks = this.metrics.reconstructionMatureLandmarks || 0;
    const mapConfidence = this.metrics.reconstructionMapConfidence ?? 0;
    const confidence = position.confidence ?? 0;
    const residual = position.averageResidual ?? Infinity;
    const depthTaperedTarget =
      this.trackingMode === DEPTH_FUSION_POSE_MODEL &&
      this._hasTaperedCylinderLikeTarget() &&
      !this._hasMugLikeTarget();
    const selectedPoseDroppedOut =
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL && (this.metrics.reconstructionPoseInliers || 0) === 0;
    const severeReferenceSupport = depthTaperedTarget
      ? activeLandmarks > MAX_SEVERE_CURVED_REFERENCE_LANDMARKS
      : activeLandmarks <= MAX_SEVERE_CURVED_REFERENCE_LANDMARKS;
    const severeSelectedModeDrift =
      severeReferenceSupport &&
      confidence <= MAX_SEVERE_CURVED_REFERENCE_CONFIDENCE &&
      residual >= MIN_SEVERE_CURVED_REFERENCE_RESIDUAL &&
      (selectedPoseDroppedOut ||
        (this.metrics.reconstructionTrackerDelta || 0) >= MIN_SEVERE_CURVED_REFERENCE_TRACKER_DELTA);

    return (
      matureLandmarks >= 16 &&
      mapConfidence >= 0.6 &&
      (severeSelectedModeDrift ||
        (!depthTaperedTarget && activeLandmarks <= 20 && (confidence <= 0.32 || residual >= 9)))
    );
  }

  _shouldUseSparseCurvedMotionPrediction() {
    if (this.trackingMode !== RECONSTRUCTION_POSE_MODEL || !this._hasMatureSparseCurvedMap()) {
      return false;
    }

    const activeLandmarks = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
    const objectOwnedLandmarks = this.metrics.objectOwnedLandmarks ?? activeLandmarks;
    const ownedRatio = objectOwnedLandmarks / Math.max(1, activeLandmarks);
    const poseDroppedOut =
      (this.metrics.poseInliers || 0) === 0 && (this.metrics.reconstructionPoseInliers || 0) === 0;
    const mugLike = this._hasMugLikeTarget();
    const cylinderLike = this._hasCylinderLikeTarget();
    const handledCurvedObject =
      (mugLike && activeLandmarks <= SPARSE_MUG_MOTION_HOLD_MAX_ACTIVE_LANDMARKS) || cylinderLike;
    const maxActiveLandmarks =
      cylinderLike && !mugLike
        ? SPARSE_CYLINDER_MOTION_HOLD_MAX_ACTIVE_LANDMARKS
        : SPARSE_MUG_MOTION_HOLD_MAX_ACTIVE_LANDMARKS;
    const activeLandmarkRange = handledCurvedObject
      ? activeLandmarks >= 8 && activeLandmarks <= maxActiveLandmarks
      : activeLandmarks >= 24 && activeLandmarks <= 32;

    return activeLandmarkRange && ownedRatio >= 0.75 && poseDroppedOut;
  }

  _hasMatureSparseCurvedMap() {
    return this.trackingMode === RECONSTRUCTION_POSE_MODEL && this._hasMatureCurvedMap();
  }

  _hasMatureCurvedMap(minConfidence = 0.65) {
    return (
      this._hasCurvedReconstructionTarget() &&
      this.metrics.reconstructionReady === true &&
      (this.metrics.reconstructionMapConfidence ?? 0) >= minConfidence &&
      (this.metrics.reconstructionMatureLandmarks || 0) >= 16
    );
  }

  _predictCurvedMotionPosition(timestamp) {
    const sample = this.curvedMotionSample;
    const elapsed = Math.max(0, timestamp - sample.timestamp);
    const maxPredictionMs = this._curvedDropoutPredictionWindowMs();
    if (elapsed > maxPredictionMs) {
      return null;
    }

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
      confidence: sample.confidence * clamp(1 - elapsed / maxPredictionMs, 0.35, 1),
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

  _curvedDropoutPredictionWindowMs() {
    return this.trackingMode === 'parametric-surface' &&
      this._hasCylinderLikeTarget() &&
      !this._hasMugLikeTarget()
      ? PARAMETRIC_CYLINDER_DROPOUT_MAX_PREDICTION_MS
      : CURVED_DROPOUT_MAX_PREDICTION_MS;
  }

  _shouldUseStepOnlyBookPosition() {
    return /book/i.test(this.anchorTargetClass || '') && this._hasRigidPlanarTargetClass();
  }

  _shouldBlendPlanarPosePosition(method) {
    return (
      this._hasPlanarTargetClass() && this._hasPlanarDominance() && PLANAR_POSE_POSITION_METHODS.has(method)
    );
  }

  _limitStep(position, method = 'unknown') {
    if (!this.currentPosition || !this.metrics.lastUpdateResult) {
      return position;
    }

    const deltaX = position.x - this.currentPosition.x;
    const deltaY = position.y - this.currentPosition.y;
    const distance = Math.hypot(deltaX, deltaY);
    const maxStep = this._maxPositionStep(position, method);

    if (distance <= maxStep || distance === 0) {
      return position;
    }

    const scale = maxStep / distance;
    return {
      ...position,
      x: this.currentPosition.x + deltaX * scale,
      y: this.currentPosition.y + deltaY * scale,
      z: position.z ?? 0,
    };
  }

  _maxPositionStep(position, method = 'unknown') {
    const templateSize = this.templateRegion
      ? Math.max(this.templateRegion.width, this.templateRegion.height)
      : 120;
    let ratio = isReconstructionMode(this.trackingMode)
      ? RECONSTRUCTION_POSITION_STEP_RATIO
      : isReconstructionMode(method)
        ? 0.1
        : 0.14;
    const postHoldReferenceRecovery = this._shouldUsePostHoldReferenceRecoveryStep(position, method);
    if (this._shouldUseMatureCurvedRecoveryStep(method)) {
      ratio =
        this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL
          ? RECONSTRUCTION_POSITION_STEP_RATIO
          : MATURE_CURVED_RECOVERY_POSITION_STEP_RATIO;
    } else if (postHoldReferenceRecovery) {
      ratio = 0.16;
    }
    if (this._hasRigidPlanarTargetClass()) {
      ratio = /book/i.test(this.anchorTargetClass || '')
        ? RIGID_PLANAR_BOOK_POSITION_STEP_RATIO
        : RIGID_PLANAR_POSITION_STEP_RATIO;
    }
    if (
      isReconstructionMode(this.trackingMode) &&
      this._hasGenericTargetClass() &&
      !postHoldReferenceRecovery
    ) {
      ratio = GENERIC_RECONSTRUCTION_POSITION_STEP_RATIO;
    }
    let maxStep = postHoldReferenceRecovery
      ? clamp(templateSize * ratio, 12, 20)
      : isReconstructionMode(this.trackingMode)
        ? clamp(templateSize * ratio, 8, 12)
        : clamp(templateSize * ratio, 8, 24);
    if (this._shouldUseSparseCurvedReferenceStepLimit(method)) {
      maxStep = Math.min(maxStep, SPARSE_CURVED_REFERENCE_MAX_STEP);
    }
    return maxStep;
  }

  _shouldUseMatureCurvedRecoveryStep(method) {
    return (
      isReconstructionMode(method) &&
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL &&
      method === this.trackingMode &&
      this._hasMatureCurvedMap(0.66) &&
      (this.metrics.reconstructionTrackerDelta || 0) >= 8
    );
  }

  _shouldUseSparseCurvedReferenceStepLimit(method) {
    const activeLandmarks = this.metrics.activeLandmarkCount || this.metrics.keypointCount || 0;
    return (
      method === 'reference_similarity_transform' &&
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasMatureCurvedMap(0.6) &&
      this._hasTaperedCylinderLikeTarget() &&
      !this._hasMugLikeTarget() &&
      activeLandmarks <= 22
    );
  }

  _shouldUsePostHoldReferenceRecoveryStep(position, method) {
    return (
      method === 'reference_similarity_transform' &&
      isReconstructionMode(this.trackingMode) &&
      this.trackingMode !== RECONSTRUCTION_POSE_MODEL &&
      this._hasCurvedReconstructionTarget() &&
      this.metrics.lastUpdateMethod === 'held-last-pose' &&
      (position.confidence ?? 0) >= 0.55 &&
      (position.averageResidual ?? Infinity) <= 6
    );
  }

  _adjustSelectedCurvedPlanarTransform(planarTransform, reconstructionPose) {
    if (
      !planarTransform ||
      this.trackingMode === RECONSTRUCTION_POSE_MODEL ||
      reconstructionPose?.method !== this.trackingMode ||
      !this._hasCurvedReconstructionTarget(reconstructionPose)
    ) {
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

    const xs = correspondences.map((correspondence) => correspondence.prev.x);
    const ys = correspondences.map((correspondence) => correspondence.prev.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    return {
      width,
      height,
      minAxis: Math.min(width, height),
    };
  }

  _getPoseRejectionReason(poseResult, correspondences) {
    if (!poseResult?.success || !poseResult.normal) {
      return poseResult?.reason || 'Pose unavailable';
    }

    return this._getPoseGeometryRejectionReason(poseResult, correspondences);
  }

  _getPoseGeometryRejectionReason(poseResult, correspondences) {
    if (poseResult.inlierCount < 8) {
      return 'Insufficient pose inliers';
    }

    const method = poseResult.method || '';
    const isPlanarHomography = method === 'homography' || method === 'planar-homography';
    const isSelectedReconstruction = isReconstructionMode(method) && method === this.trackingMode;
    const averageResidual = poseResult.averageResidual ?? Infinity;
    const allowPlanarRecovery =
      isPlanarHomography &&
      this._hasPlanarDominance() &&
      poseResult.inlierCount >= 8 &&
      averageResidual <= 3.25;
    const allowRigidPlanarRecovery =
      isPlanarHomography && this._hasRigidPlanarRecoveryPose(poseResult, correspondences);
    const minInlierRatio = isSelectedReconstruction
      ? 0.24
      : allowRigidPlanarRecovery
        ? 0.2
        : allowPlanarRecovery
          ? 0.32
          : 0.5;
    const minConfidence = isSelectedReconstruction
      ? 0.22
      : allowRigidPlanarRecovery
        ? 0.32
        : allowPlanarRecovery
          ? 0.24
          : 0.32;
    const minSpread = isSelectedReconstruction
      ? 12
      : allowRigidPlanarRecovery
        ? 18
        : allowPlanarRecovery
          ? 14
          : 18;

    if ((poseResult.inlierRatio ?? 0) < minInlierRatio) {
      return 'Low pose inlier ratio';
    }
    if ((poseResult.confidence ?? 0) < minConfidence) {
      return 'Low pose confidence';
    }

    const maxResidual = isSelectedReconstruction
      ? 14
      : allowRigidPlanarRecovery
        ? 9.5
        : isPlanarHomography
          ? 5.5
          : 6;
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

  _getPoseTransformRejectionReason(poseResult, correspondences) {
    if (!poseResult?.success || !poseResult.position) {
      return poseResult?.reason || 'Pose unavailable';
    }
    if (this._shouldRejectStaleSparseCanPose(poseResult)) {
      return 'Stale sparse reconstruction pose';
    }

    return this._getPoseGeometryRejectionReason(poseResult, correspondences);
  }

  _shouldRejectStaleSparseCanPose(poseResult) {
    return (
      poseResult?.success &&
      poseResult.method === this.trackingMode &&
      this.trackingMode === RECONSTRUCTION_POSE_MODEL &&
      this._hasCanLikeTargetClass() &&
      this.framesWithoutNormalPose >= SPARSE_CAN_STALE_POSE_MIN_DROPOUT_FRAMES &&
      (this.metrics.reconstructionTrackerDelta ?? 0) >= SPARSE_CAN_STALE_POSE_MIN_TRACKER_DELTA &&
      (poseResult.inlierCount || 0) < MIN_RECONSTRUCTION_ATTACHMENT_POSE_INLIERS
    );
  }

  _calculatePoseConfidence(poseResult, correspondences) {
    const spread = this._measureReferenceSpread(correspondences);
    const spreadScore = Math.min(1, spread.minAxis / 42);
    const inlierRatio =
      poseResult.inlierRatio ?? poseResult.inlierCount / Math.max(1, correspondences.length);
    return Math.max(
      0.2,
      Math.min(1, (poseResult.confidence ?? 0.5) * 0.5 + inlierRatio * 0.3 + spreadScore * 0.2),
    );
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

  _selectTrackingState({ overallQuality, poseInliers }) {
    if (overallQuality >= 0.8 && poseInliers >= 25) {
      return 'stable';
    }

    if (overallQuality >= 0.4) {
      return 'tracking';
    }

    return 'degraded';
  }

  _getProgressiveBootstrapState(keypointCount, quality) {
    return keypointCount >= CANDIDATE_MIN_TRACKABLE_POINTS && quality >= this.minimumTemplateQuality
      ? 'mapping'
      : 'candidate';
  }

  _canResumeProgressiveBootstrap() {
    return (
      this.frameIndex === 1 &&
      !!this._getCurrentObjectSupportMask() &&
      (this.metrics.templateQuality ?? 0) < this.targetTemplateQuality
    );
  }

  _activeTrackedPointCount() {
    return (this.keypointTracker.trackedPoints || []).filter((point) => point.status === 'active').length;
  }

  _getProgressiveBootstrapRegion(grayImage) {
    return this._getAnchoredTrackingRegion(grayImage);
  }

  _extractObjectKeypoints(grayImage, region, objectSupportMask, { minKeypoints }) {
    return this.keypointDetector.extractKeypointsWithAdaptiveFallback(
      this.cv,
      grayImage,
      region,
      objectSupportMask,
      { minKeypoints },
    );
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
    const strongReconstructionPose =
      reconstructionReady && isReconstructionMode(poseSource) && poseSource === this.trackingMode;
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
    const attachmentReady =
      trackingReady && poseReady && surfaceReady && attachmentSourceReady && objectOwnershipReady;
    const faceReady = attachmentReady;
    const poseRecovery =
      reconstructionMode &&
      reconstructionReady &&
      (!posePathReady || !poseQualityReady || !attachmentSourceReady);
    const reason = faceReady
      ? 'Face overlay is ready'
      : poseRecovery
        ? FACE_READINESS_REASON_POSE_RECOVERY
        : FACE_READINESS_REASON_RECONSTRUCTION;

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

    if (poseSource === DEPTH_FUSION_POSE_MODEL && TRACKER_SPINE_POSITION_METHODS.has(positionSource)) {
      return true;
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
    const qualityMeasured =
      Number.isFinite(poseInliers) ||
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
      : planarPose
        ? MIN_PLANAR_ATTACHMENT_POSE_INLIERS
        : MIN_ATTACHMENT_POSE_INLIERS;
    const minConfidence = reconstructionPose
      ? MIN_RECONSTRUCTION_ATTACHMENT_POSE_CONFIDENCE
      : MIN_ATTACHMENT_POSE_CONFIDENCE;
    const maxResidual = reconstructionPose
      ? MAX_RECONSTRUCTION_ATTACHMENT_POSE_RESIDUAL
      : planarPose
        ? MAX_PLANAR_ATTACHMENT_POSE_RESIDUAL
        : MAX_OBJECT_ATTACHMENT_POSE_RESIDUAL;

    return (
      (!Number.isFinite(poseInliers) || poseInliers >= minInliers) &&
      (!Number.isFinite(poseConfidence) || poseConfidence >= minConfidence) &&
      (!Number.isFinite(poseAverageResidual) || poseAverageResidual <= maxResidual) &&
      (!reconstructionPose ||
        !Number.isFinite(poseForeshortening) ||
        poseForeshortening >= MIN_RECONSTRUCTION_ATTACHMENT_FORESHORTENING)
    );
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
      ? trackingKeypoints.filter((keypoint) =>
          isPointInsideObjectSupport(objectSupportMask, keypoint.pt || keypoint),
        ).length
      : trackingKeypoints.length;
    const activeTrackedPoints = trackedPoints
      ? trackedPoints.filter((point) => point.status === 'active')
      : [];
    const objectOwnedTrackedPoints = objectSupportMask
      ? activeTrackedPoints.filter((point) => isPointInsideObjectSupport(objectSupportMask, point.current))
          .length
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
        if (
          frameX >= 0 &&
          frameX < objectSupportMask.width &&
          objectSupportMask.data[frameY * objectSupportMask.width + frameX] > 0
        ) {
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
      lastUpdateResult: 'failed',
    };
  }

  _startUpdateTiming(updateTimings) {
    return updateTimings ? performance.now() : 0;
  }

  _recordUpdateTiming(updateTimings, name, startedAt) {
    if (!updateTimings) {
      return;
    }
    updateTimings[name] = (updateTimings[name] || 0) + performance.now() - startedAt;
  }

  _recordAnchorUpdateResult(result, processingTime, updateTimings = null) {
    this._recordCurvedMotionSample(result);
    this.metrics.processingTime = processingTime;
    this.metrics.updateTimings = updateTimings;
    this.metrics.lastUpdateResult = result.success ? 'success' : 'failed';
    this.metrics.lastUpdateMethod = result.method || null;
    this.metrics.lastUpdateConfidence = typeof result.confidence === 'number' ? result.confidence : null;
    this.metrics.targetPresent = result.targetPresent === true;
    this.metrics.keypointFailureCount = this.keypointFailureCount;
    const readiness =
      result.readiness ||
      this._createReadiness({
        state: this.anchorState,
        poseSource: this.metrics.poseSource,
        positionSource: result.method || this.metrics.lastUpdateMethod,
        reconstructionReady: this.metrics.reconstructionReady,
        poseInliers: this.metrics.poseInliers,
        poseConfidence: this.metrics.poseConfidence,
        poseAverageResidual: this.metrics.poseAverageResidual,
        poseForeshortening: this.metrics.poseForeshortening,
      });
    this.metrics.readiness = this.metrics.targetPresent
      ? readiness
      : {
          ...readiness,
          attachmentReady: false,
          faceReady: false,
          reason: 'Target is not visible; searching globally for the selected object',
        };

    if (!result.success) {
      this.metrics.lastFailureReason =
        result.reason || this.metrics.lastFailureReason || 'Anchor update failed';
      this.metrics.lastFailureStage = this.metrics.lastFailureStage || 'tracking';
    }
  }

  _resetFrameMetrics() {
    this.frameStartPosition = this.currentPosition ? { ...this.currentPosition } : null;
    this.metrics.objectSupportPositionCorrection = null;
    this.metrics.objectSupportPositionSource = null;
    this.metrics.objectSupportPositionDelta = null;
    this.metrics.objectSupportPositionStep = null;
    this.metrics.objectSupportFrameStepLimited = false;
    this.metrics.posePositionRole = null;
    this.metrics.posePositionReason = null;
    this.metrics.trackerReferenceScope = null;
    this.metrics.trackerLocalReferenceResidual = null;
    this.metrics.normalPoseRejectedCandidates = {};
    this.metrics.keypointReinitializationResult = null;
    this.metrics.keypointReinitializationReason = null;
    this.metrics.keypointReinitializationCandidateCount = null;
    this.metrics.keypointReinitializationGfttCallCount = null;
    this.metrics.keypointReinitializationGfttPixelCount = null;
    this.metrics.keypointReinitializationGfttPreparationCount = null;
    this.metrics.keypointReinitializationLandmarks = null;
    this.metrics.keypointReinitializationAnchorDelta = null;
    this.metrics.keypointReinitializationFrameStepLimited = false;
    this.metrics.partialOcclusionFlow = null;
    this.metrics.trackingAdmission = null;
    this.metrics.landmarkRefreshReason = null;
    this.metrics.landmarkRefreshAdded = 0;
    this.metrics.landmarkRefreshRecovered = 0;
    this.metrics.landmarkRefreshProbationary = 0;
    this.metrics.landmarkRefreshCoverageBefore = null;
    this.metrics.landmarkRefreshCoverageAfter = null;
    this.metrics.landmarkRefreshCoverageCellCount = null;
    this.metrics.landmarkRefreshOccupiedBefore = null;
    this.metrics.landmarkRefreshOccupiedAfter = null;
    this.metrics.landmarkOwnershipPromoted = 0;
    this.metrics.landmarkRefreshCandidateCount = null;
    this.metrics.landmarkRefreshGfttCallCount = null;
    this.metrics.landmarkRefreshGfttPixelCount = null;
    this.metrics.landmarkRefreshGfttPreparationCount = null;
    this.metrics.landmarkRefreshReferenceSource = null;
    this.metrics.recoveryReferencePositionSource = null;
    this.metrics.landmarkRefreshFailureReason = null;
    this.metrics.relocalizationAnchorAdjustment = null;
    this.metrics.relocalizationAnchorAdjustmentDelta = null;
    this.metrics.relocalizationAnchorAdjustmentStep = null;
    this.metrics.relocalizationKeyframeResult = null;
    this.metrics.relocalizationKeyframeReason = null;
    this.metrics.learnedRelocalizationAttempted = false;
    const refreshFrame = this.metrics.segmentationRefreshFrame;
    if (
      !isObjectSupportRefreshSignalActive({
        reason: this.metrics.segmentationRefreshReason ?? null,
        signalFrame: refreshFrame ?? null,
        currentFrame: this.frameIndex,
      })
    ) {
      this.metrics.segmentationRefreshReason = null;
      this.metrics.segmentationRefreshFrame = null;
    }
  }

  _recordCurvedMotionSample(result) {
    if (!this._shouldRecordCurvedMotionSample(result)) {
      return;
    }
    if (
      this.metrics.positionFilterAdjustment === 'curved-motion-hold' ||
      this.metrics.positionFilterAdjustment === 'weak-mug-motion-bridge'
    ) {
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
      confidence:
        result.positionConfidence ??
        result.position?.confidence ??
        result.confidence ??
        this.metrics.poseConfidence ??
        0.5,
    };
  }

  _shouldRecordCurvedMotionSample(result) {
    if (!result.success || !result.position || !this._hasCurvedReconstructionTarget()) {
      return false;
    }

    if (result.method === this.trackingMode && isReconstructionMode(result.method)) {
      if (
        this.trackingMode === DIRECT_PHOTOMETRIC_POSE_MODEL &&
        this._hasMugLikeTarget() &&
        Number.isFinite(result.positionAverageResidual) &&
        result.positionAverageResidual > MAX_DIRECT_CURVED_MOTION_SAMPLE_RESIDUAL
      ) {
        return false;
      }
      return !this._isReversingWeakParametricMotionSample(result);
    }

    const sparseHandledMugBootstrap =
      this.trackingMode === RECONSTRUCTION_POSE_MODEL && this._hasUnreadyHandledMugMotionRecoveryTarget();

    if (
      (this.trackingMode === RECONSTRUCTION_POSE_MODEL && !sparseHandledMugBootstrap) ||
      !isReconstructionMode(this.trackingMode)
    ) {
      return false;
    }

    const confidence = result.positionConfidence ?? result.position?.confidence ?? result.confidence ?? 0;
    const residual =
      result.positionAverageResidual ??
      result.position?.averageResidual ??
      result.averageResidual ??
      Infinity;
    const inliers = result.positionInlierCount ?? result.position?.inlierCount ?? result.inlierCount ?? 0;

    if (CURVED_BOOTSTRAP_MOTION_METHODS.has(result.method)) {
      return (
        (sparseHandledMugBootstrap ||
          (this.trackingMode !== RECONSTRUCTION_POSE_MODEL && this._hasMugLikeTarget())) &&
        confidence >= MIN_CURVED_BOOTSTRAP_MOTION_CONFIDENCE &&
        residual <= MAX_CURVED_BOOTSTRAP_MOTION_RESIDUAL &&
        inliers >= MIN_CURVED_BOOTSTRAP_MOTION_INLIERS
      );
    }

    if (result.method !== 'reference_similarity_transform') {
      return false;
    }

    return (
      confidence >= MIN_LOW_LAG_TRACKER_CONFIDENCE &&
      residual <= MAX_LOW_LAG_TRACKER_RESIDUAL &&
      inliers >= MIN_CURVED_REFERENCE_BLEND_INLIERS
    );
  }

  _isReversingWeakParametricMotionSample(result) {
    if (
      this.trackingMode !== 'parametric-surface' ||
      (result.inliers || 0) > MAX_REVERSING_PARAMETRIC_MOTION_INLIERS
    ) {
      return false;
    }

    return this._isReversingWeakParametricMotion(result.position);
  }

  _isReversingWeakParametricMotion(position) {
    const mugLikeTarget = this._hasMugLikeTarget();
    const maxMapConfidence = mugLikeTarget
      ? MAX_REVERSING_PARAMETRIC_MUG_MOTION_MAP_CONFIDENCE
      : MAX_REVERSING_PARAMETRIC_MOTION_MAP_CONFIDENCE;
    const minMotionDelta = mugLikeTarget
      ? MIN_REVERSING_PARAMETRIC_MUG_MOTION_DELTA
      : MIN_REVERSING_PARAMETRIC_MOTION_DELTA;

    if (
      !this.curvedMotionSample ||
      !this._hasCurvedReconstructionTarget() ||
      (this.metrics.reconstructionMapConfidence ?? 0) > maxMapConfidence
    ) {
      return false;
    }

    if (this._hasCoherentSelectedParametricPose()) {
      return false;
    }

    const deltaX = position.x - this.curvedMotionSample.position.x;
    const deltaY = position.y - this.curvedMotionSample.position.y;
    const distance = Math.hypot(deltaX, deltaY);
    const velocityDot =
      deltaX * this.curvedMotionSample.velocity.x + deltaY * this.curvedMotionSample.velocity.y;

    return distance >= minMotionDelta && velocityDot < 0;
  }

  _hasCoherentSelectedParametricPose() {
    return (
      this.trackingMode === 'parametric-surface' &&
      (this.metrics.activeLandmarkCount ?? 0) >= MIN_COHERENT_PARAMETRIC_RELEASE_ACTIVE_LANDMARKS &&
      (this.metrics.reconstructionMapConfidence ?? 0) >= MIN_COHERENT_PARAMETRIC_RELEASE_MAP_CONFIDENCE &&
      (this.metrics.reconstructionTrackerDelta ?? Infinity) <= MAX_COHERENT_PARAMETRIC_RELEASE_TRACKER_DELTA
    );
  }

  /**
   * Add event listener for anchor updates
   */
  addListener(listener) {
    const callback = typeof listener === 'function' ? listener : listener.onAnchorUpdate.bind(listener);
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
      metrics: { ...this.metrics },
    };

    this.listeners.forEach((listener) => {
      listener(state);
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
      this.frameStartPosition = null;
      this.currentNormal = null;
      this.currentPlanarTransform = null;
      this.curvedMotionSample = null;
      this.localizeCurvedRelocalizationSearch = false;
      this.objectSupportMask = null;
      this.currentObjectSupportMask = null;
      this.objectSupportProjectionCache = null;
      this.objectSupportAnchorUv = null;
      this.expandedObjectSupportRegion = false;
      this.planarDominanceScore = 0;
      this.templateRegion = null;
      this.trackingRegion = null;
      this.templateCenter = null;
      this.templateAnchorOffset = null;
      this.anchorTargetClass = null;
      this.rigidPlanarRecoveryEligible = false;
      this.framesSinceRefresh = 0;
      this.framesSinceRelocalizationKeyframe = 0;
      this.lastSuccessfulRelocalizationFrame = -Infinity;
      this.lastLearnedRelocalizationAttemptFrame = -Infinity;
      this.metrics.targetPresent = false;
      this.framesWithoutNormalPose = 0;
      this.lastNormalPoseSource = null;
      this.frameIndex = 0;
      this.lastKeypointReinitializationFrame = -Infinity;

      // Reset resilience counters
      this.keypointFailureCount = 0;

      // Reset filters
      this.positionFilterX = createPositionFilter();
      this.positionFilterY = createPositionFilter();
      this.planarScaleFilter = createPlanarScaleFilter();
      this.curvedScaleFilter = createCurvedScaleFilter();
      this.planarRotationFilter = createPlanarRotationFilter();
      this.normalStabilizer.reset();
      this.homographyEstimator.resetTracking();
      this.reconstructor.reset({ anchorReference: { x: 0, y: 0 } });
      this.relocalizer.clear();
      this.learnedRelocalizer?.clear();
      this.learnedReferencePromise = null;

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
      metrics: { ...this.metrics },
    };
  }

  dispose() {
    this.clearAnchor();
    this.reconstructor.dispose();

    if (this.keypointDetector) this.keypointDetector.dispose();
    if (this.keypointTracker) this.keypointTracker.dispose();
    if (this.homographyEstimator) this.homographyEstimator.dispose();
    if (this.persistenceSystem) this.persistenceSystem.dispose();
    if (this.relocalizer) this.relocalizer.dispose();
    if (this.learnedRelocalizer) this.learnedRelocalizer.dispose();

    this.listeners.clear();
    this.initialized = false;
  }
}
