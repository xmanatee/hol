/**
 * Lucas-Kanade Optical Flow Tracking for Keypoints
 * Tracks template keypoints frame-to-frame with outlier detection
 */

import { logger } from '../utils/logger.js';
import { ObjectPoseEstimator } from './anchor.objectPose.js';
import {
  isConfirmedObjectOwnedLandmark,
  LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES,
  ownershipEvidenceFramesFor,
} from './landmarkOwnership.js';
import { orderKeypointsByMaskCoverage, summarizeLandmarkMaskCoverage } from './landmarkSpatialCoverage.js';
import {
  createHomographyWorkspace,
  disposeHomographyWorkspace,
  prepareHomographyWorkspace,
} from './anchor.homographyWorkspace.js';
import { isPointInsideObjectSupport } from './objectSupportMask.js';
import { seedHomographyRansac } from './opencvRng.js';
import {
  createLucasKanadeWorkspace,
  disposeLucasKanadeWorkspace,
  prepareLucasKanadeWorkspace,
} from './anchor.lkWorkspace.js';

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const LANDMARK_SUPPORT_QUALITY_WINDOW = 0.2;
const LANDMARK_SUPPORT_MIN_RELIABLE_RATIO = 0.6;
const LANDMARK_SUPPORT_MAX_RELIABLE_SHARE = 0.75;
const RECOVERY_PRIOR_MIN_CONSENSUS = 8;
const RECOVERY_PRIOR_MAX_MEDIAN_RESIDUAL = 6.5;
const RECOVERY_PRIOR_MIN_REFERENCE_SPAN = 16;
const PARTIAL_OCCLUSION_MIN_FLOW_POINTS = 10;
const PARTIAL_OCCLUSION_MIN_INLIER_RATIO = 0.7;
const PARTIAL_OCCLUSION_MIN_CONFIDENCE = 0.4;
const PARTIAL_OCCLUSION_MAX_AVERAGE_RESIDUAL = 8;
const PARTIAL_OCCLUSION_MIN_REFERENCE_SPAN = 20;
const PARTIAL_OCCLUSION_MIN_SCALE = 0.75;
const PARTIAL_OCCLUSION_MAX_SCALE = 1.35;
const PARTIAL_OCCLUSION_MAX_ROTATION = 0.35;
const POSE_TRACKING_MIN_POINTS = 8;
export const CANDIDATE_TRACKING_MIN_POINTS = 6;
const OBJECT_WIDE_RECOVERY_MAX_ACTIVE_LANDMARKS = 45;
const OBJECT_WIDE_RECOVERY_MIN_INLIERS = 7;
const LOCAL_REFERENCE_DEFORMATION_MIN_RESIDUAL = 24;
const KEYPOINT_CANDIDATE_ORDERS = new Set(['response-ranked', 'mask-coverage']);
const disposeGrayFrameSlots = (slots) => {
  for (const frame of slots || []) {
    frame.delete();
  }
};
const medianValue = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export class KeypointTracker {
  constructor() {
    this.initialized = false;
    this.trackedPoints = [];
    this.previousGray = null;
    this.grayFrameSlots = null;
    this.grayFrameGeneration = 0;
    this.nextPointId = 0;
    this.relocalizationReference = null;
    this.lkWorkspace = null;
    this.referenceHomographyWorkspace = null;
    this.refreshPlanFrames = new WeakMap();
    this.consumedRefreshPlans = new WeakSet();
    this.objectPoseEstimator = new ObjectPoseEstimator();

    // Adaptive tracking parameters
    this.trackingAttempts = 0;
    this.initialLeniencyFrames = 5; // More lenient for first 5 frames
  }

  initialize(cv) {
    if (!cv) {
      throw new Error('OpenCV not available');
    }

    if (this.lkWorkspace) {
      disposeLucasKanadeWorkspace(this.lkWorkspace);
    }
    if (this.referenceHomographyWorkspace) {
      disposeHomographyWorkspace(this.referenceHomographyWorkspace);
    }
    disposeGrayFrameSlots(this.grayFrameSlots);
    this.lkWorkspace = createLucasKanadeWorkspace(cv);
    this.referenceHomographyWorkspace = createHomographyWorkspace(cv);
    this.grayFrameSlots = [new cv.Mat(), new cv.Mat()];
    this.previousGray = null;
    this.grayFrameGeneration = 0;

    // Lucas-Kanade parameters
    this.lkParams = {
      winSize: new cv.Size(15, 15),
      maxLevel: 3,
      criteria: new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01),
    };

    this.initialized = true;
    logger.info('KeypointTracker', 'Initialized Lucas-Kanade tracker');
  }

  _prepareLucasKanadeWorkspace(cv, pointCount) {
    return prepareLucasKanadeWorkspace(this.lkWorkspace, cv, pointCount);
  }

  acquireGrayFrame(cv) {
    if (!this.grayFrameSlots) {
      this.grayFrameSlots = [new cv.Mat(), new cv.Mat()];
    }
    return this.grayFrameSlots[0] === this.previousGray ? this.grayFrameSlots[1] : this.grayFrameSlots[0];
  }

  /**
   * Initialize tracking with template keypoints
   * @param {Array} keypoints - Array of keypoint objects {x, y, ...}
   * @param {cv.Mat} grayImage - Initial grayscale image
   * @param {Object} options - Tap position and landmark-admission policy
   */
  initializeTracking(cv, keypoints, grayImage, { tapPosition, admission = 'trusted-selection' }) {
    if (!this.initialized) {
      throw new Error('KeypointTracker not initialized');
    }

    // Select strongest keypoints for tracking (limit to 80 for quality)
    const sortedKeypoints = [...keypoints].sort((a, b) => b.response - a.response).slice(0, 80);

    this.trackedPoints = sortedKeypoints.map((kp, index) => {
      const point = this._createTrackedPoint(
        index,
        { x: kp.pt.x, y: kp.pt.y },
        { x: kp.pt.x, y: kp.pt.y },
        kp.response,
        kp.bootstrapOnly === true,
      );
      if (admission === 'recovery-probation') {
        this._startObjectOwnershipProbation(point, {
          ownership: 'supported',
          recovery: true,
        });
      }
      return point;
    });
    this.nextPointId = this.trackedPoints.length;
    this.relocalizationReference = null;

    // Calculate actual keypoint centroid (not geometric template center)
    const xSum = this.trackedPoints.reduce((sum, pt) => sum + pt.original.x, 0);
    const ySum = this.trackedPoints.reduce((sum, pt) => sum + pt.original.y, 0);
    this.keypointCentroid = {
      x: xSum / this.trackedPoints.length,
      y: ySum / this.trackedPoints.length,
    };

    // Calculate and store offset between tap position and keypoint centroid
    if (tapPosition) {
      this.tapOffset = {
        x: tapPosition.x - this.keypointCentroid.x,
        y: tapPosition.y - this.keypointCentroid.y,
      };
      this.anchorOriginalPosition = { x: tapPosition.x, y: tapPosition.y };
    } else {
      // No offset if no tap position provided
      this.tapOffset = { x: 0, y: 0 };
      this.anchorOriginalPosition = { ...this.keypointCentroid };
    }

    this._replacePreviousGray(grayImage);

    // Reset adaptive tracking state
    this.trackingAttempts = 0;

    logger.info('KeypointTracker', `Initialized tracking with ${this.trackedPoints.length} keypoints`);
    logger.info(
      'KeypointTracker',
      `Keypoint centroid: (${this.keypointCentroid.x.toFixed(1)}, ${this.keypointCentroid.y.toFixed(1)})`,
    );
    logger.info(
      'KeypointTracker',
      `Tap offset: (${this.tapOffset.x.toFixed(1)}, ${this.tapOffset.y.toFixed(1)})`,
    );
  }

  _replacePreviousGray(grayImage) {
    if (!this.grayFrameSlots?.includes(grayImage)) {
      throw new Error('Retained grayscale frame must belong to the tracker workspace');
    }
    this.previousGray = grayImage;
    this.grayFrameGeneration++;
  }

  /**
   * Track keypoints to next frame
   * @param {cv.Mat} currentGray - Current grayscale frame
   * @returns {Object} - Tracking result
   */
  trackFrame(cv, currentGray) {
    return this._track(cv, currentGray, POSE_TRACKING_MIN_POINTS);
  }

  /** Track a provisional selection without admitting it as pose geometry. */
  trackCandidate(cv, currentGray) {
    return this._track(cv, currentGray, CANDIDATE_TRACKING_MIN_POINTS);
  }

  _track(cv, currentGray, minimumActivePoints) {
    const debugTracking = logger.isTagEnabled('KeypointTracker');
    if (debugTracking) {
      logger.debugEvery(
        'KeypointTracker',
        'track-to-frame-start',
        1000,
        'Tracking frame - checking initialization',
        {
          initialized: this.initialized,
          hasPreviousGray: !!this.previousGray,
          totalTrackedPoints: this.trackedPoints.length,
        },
      );
    }

    if (!this.initialized) {
      return { success: false, reason: 'KeypointTracker not initialized with OpenCV' };
    }

    if (!this.previousGray) {
      return { success: false, reason: 'No previous frame available for tracking' };
    }

    if (this.trackedPoints.length === 0) {
      return { success: false, reason: 'No tracked points available' };
    }

    const activePoints = this.trackedPoints.filter((pt) => pt.status === 'active');
    if (debugTracking) {
      logger.debugEvery('KeypointTracker', 'active-points-check', 1000, 'Active points check:', {
        totalPoints: this.trackedPoints.length,
        activePoints: activePoints.length,
        minRequired: minimumActivePoints,
      });
    }

    if (activePoints.length < minimumActivePoints) {
      return {
        success: false,
        reason: `Too few active points: ${activePoints.length} (need at least ${minimumActivePoints})`,
        activePointCount: activePoints.length,
        successRate: 0,
        averageError: 999,
      };
    }

    try {
      const {
        previousPoints: prevPoints,
        nextPoints,
        status,
        flowError,
      } = this._prepareLucasKanadeWorkspace(cv, activePoints.length);
      for (let i = 0; i < activePoints.length; i++) {
        const pt = activePoints[i];
        prevPoints.data32F[i * 2] = pt.current.x;
        prevPoints.data32F[i * 2 + 1] = pt.current.y;
      }

      if (debugTracking) {
        logger.debugEvery('KeypointTracker', 'matrix-initialization', 1000, 'Matrix initialization:', {
          prevPointsSize: `${prevPoints.rows}x${prevPoints.cols}`,
          nextPointsSize: `${nextPoints.rows}x${nextPoints.cols}`,
          statusSize: `${status.rows}x${status.cols}`,
          errorSize: `${flowError.rows}x${flowError.cols}`,
        });
      }

      // Perform Lucas-Kanade tracking
      cv.calcOpticalFlowPyrLK(
        this.previousGray,
        currentGray,
        prevPoints,
        nextPoints,
        status,
        flowError,
        this.lkParams.winSize,
        this.lkParams.maxLevel,
        this.lkParams.criteria,
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
      const flowCandidates = isInitialTracking
        ? activePoints.map((point, i) => {
            const trackingStatus = status.data[i];
            const trackingError = flowError.data32F[i];
            const nextX = nextPoints.data32F[i * 2];
            const nextY = nextPoints.data32F[i * 2 + 1];
            const effectiveThreshold = point.isStable ? keepThreshold : loseThreshold;
            const hasValidCoordinates = Number.isFinite(nextX) && Number.isFinite(nextY);
            return {
              point,
              trackingStatus,
              trackingError,
              nextX,
              nextY,
              effectiveThreshold,
              acceptedByLK:
                trackingStatus === 1 &&
                Number.isFinite(trackingError) &&
                trackingError < effectiveThreshold &&
                hasValidCoordinates,
            };
          })
        : null;
      const motionConsensusRejections = isInitialTracking
        ? this._motionConsensusRejectedPointIds(flowCandidates)
        : null;

      for (let i = 0; i < activePoints.length; i++) {
        const point = activePoints[i];
        const candidate = flowCandidates?.[i];
        const trackingStatus = candidate?.trackingStatus ?? status.data[i];
        const trackingError = candidate?.trackingError ?? flowError.data32F[i];
        const nextX = candidate?.nextX ?? nextPoints.data32F[i * 2];
        const nextY = candidate?.nextY ?? nextPoints.data32F[i * 2 + 1];
        const effectiveThreshold =
          candidate?.effectiveThreshold ?? (point.isStable ? keepThreshold : loseThreshold);
        const acceptedByLK =
          candidate?.acceptedByLK ??
          (trackingStatus === 1 &&
            Number.isFinite(trackingError) &&
            trackingError < effectiveThreshold &&
            Number.isFinite(nextX) &&
            Number.isFinite(nextY));
        const rejectedByMotionConsensus = motionConsensusRejections?.has(point.id) === true;

        if (acceptedByLK && !rejectedByMotionConsensus) {
          // Successful tracking with valid coordinates
          point.current.x = nextX;
          point.current.y = nextY;
          point.lastFlowResidual = trackingError;
          point.errorHistory.push(trackingError);
          point.age++;
          point.status = 'active';
          point.inactiveAge = 0;
          point.recentDropout = false;
          point.lastSeenAttempt = this.trackingAttempts;
          point.observations = (point.observations || 0) + 1;

          // Update stability tracking
          point.successfulTrackingStreak++;
          point.totalSuccessfulFrames++;

          // Calculate stability score (weighted by streak and total success)
          const streakFactor = Math.min(1.0, point.successfulTrackingStreak / 30); // 30 frames = max streak bonus
          const totalFactor = Math.min(1.0, point.totalSuccessfulFrames / 100); // 100 frames = max total bonus
          const errorFactor = Math.max(0, 1.0 - trackingError / effectiveThreshold); // Lower error = higher score
          point.stabilityScore = streakFactor * 0.4 + totalFactor * 0.4 + errorFactor * 0.2;

          // Mark as stable if high stability score and long tracking history
          point.isStable = point.stabilityScore > 0.7 && point.totalSuccessfulFrames > 20;
          this.updateLandmarkQuality(point);

          successCount++;
          totalError += trackingError;
        } else {
          // Tracking failed or invalid coordinates
          point.status = 'lost';
          point.errorHistory.push(999); // High error for failed tracking
          point.recentDropout = true;

          // Reset tracking streak but preserve total successful frames
          point.successfulTrackingStreak = 0;
          point.stabilityScore = Math.max(0, point.stabilityScore - 0.1); // Gradual decay
          point.isStable = false; // Lose stable status on tracking failure
          this.updateLandmarkQuality(point);
        }

        // Limit error history
        if (point.errorHistory.length > 10) {
          point.errorHistory.shift();
        }
      }

      // Log detailed results (sample of first 5 points to avoid spam)
      if (debugTracking) {
        logger.debugEvery('KeypointTracker', 'lucas-kanade-results', 1000, 'Lucas-Kanade tracking results:', {
          attempt: this.trackingAttempts,
          isInitialTracking,
          loseThreshold,
          keepThreshold,
          successCount,
          totalPoints: activePoints.length,
          successRate: `${((successCount / activePoints.length) * 100).toFixed(1)}%`,
          avgError: successCount > 0 ? (totalError / successCount).toFixed(2) : 'N/A',
        });
      }

      // Filter outliers using RANSAC-style consensus (skip during initial tracking)
      if (!isInitialTracking) {
        this._filterOutliers(cv);
      } else if (debugTracking) {
        logger.debugEvery(
          'KeypointTracker',
          'outlier-filter-initial-skip',
          1000,
          'Skipping outlier filtering during initial tracking phase',
        );
      }

      this._replacePreviousGray(currentGray);

      // Calculate success metrics
      const successRate = successCount / activePoints.length;
      const avgError = successCount > 0 ? totalError / successCount : 999;

      const finalActiveCount = this.trackedPoints.filter((pt) => pt.status === 'active').length;
      if (finalActiveCount < 12) {
        this._recoverOutlierPoints();
      }

      this._cleanupInactiveKeypoints();

      const success = successRate >= 0.5;
      const partialFlow = success ? null : this._partialFlowConsensus(activePoints, prevPoints, nextPoints);
      return {
        success,
        reason: success ? null : `Lucas-Kanade retained ${successCount}/${activePoints.length} points`,
        successRate,
        activePointCount: this.trackedPoints.filter((pt) => pt.status === 'active').length,
        averageError: avgError,
        partialFlow,
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
    const activePoints = this.trackedPoints.filter((pt) => pt.status === 'active');
    const debugTracking = logger.isTagEnabled('KeypointTracker');

    if (activePoints.length < 15) {
      return;
    }

    const confirmedPoints = activePoints.filter(isConfirmedObjectOwnedLandmark);
    const useConfirmedReference = confirmedPoints.length >= 3;
    const referencePoints = useConfirmedReference ? confirmedPoints : activePoints;
    const transformation = this._estimateReferenceTransformation(referencePoints);
    if (!transformation) {
      return;
    }

    const residuals = new Array(activePoints.length);
    const sortedResiduals = [];
    for (let index = 0; index < activePoints.length; index++) {
      const point = activePoints[index];
      const residual = this._transformationResidual(point, transformation);
      residuals[index] = residual;
      if (!useConfirmedReference || isConfirmedObjectOwnedLandmark(point)) {
        sortedResiduals.push(residual);
      }
    }
    sortedResiduals.sort((a, b) => a - b);
    const medianResidual = sortedResiduals[Math.floor(sortedResiduals.length / 2)];

    // Filter outliers with stability consideration
    const baseThreshold = 5.0; // Base MAD threshold multiplier
    let outlierCount = 0;
    let protectedCount = 0;

    if (debugTracking) {
      logger.debugEvery(
        'KeypointTracker',
        'outlier-filter-motion-analysis',
        1000,
        'Outlier filtering - motion analysis:',
        {
          rotation: `${((transformation.rotation * 180) / Math.PI).toFixed(1)}deg`,
          scale: transformation.scale.toFixed(3),
          medianResidual: medianResidual.toFixed(2),
          baseThreshold,
        },
      );
    }

    for (let index = 0; index < activePoints.length; index++) {
      const point = activePoints[index];
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

      if (residuals[index] > effectiveThreshold) {
        // Only mark as outlier if not highly stable
        if (!point.isStable || point.stabilityScore < 0.8) {
          point.status = 'outlier';
          outlierCount++;
        } else if (debugTracking) {
          // Highly stable points keep active status despite motion deviation
          logger.debugEvery(
            'KeypointTracker',
            'outlier-filter-protected-stable',
            1000,
            `Protected stable keypoint ${point.id} from outlier filtering`,
          );
        }
      }
    }

    const remainingActive = activePoints.length - outlierCount;

    if (debugTracking) {
      logger.debugEvery('KeypointTracker', 'outlier-filter-results', 1000, 'Outlier filtering results:', {
        originalActive: activePoints.length,
        outliers: outlierCount,
        remainingActive,
        protectedStable: protectedCount,
        outlierRate: `${((outlierCount / activePoints.length) * 100).toFixed(1)}%`,
      });
    }
  }

  /**
   * Attempt to recover outlier points when active count is too low
   */
  _recoverOutlierPoints() {
    const outlierPoints = this.trackedPoints.filter((pt) => pt.status === 'outlier');

    if (outlierPoints.length === 0) return;
    const activePoints = this.trackedPoints.filter(
      (pt) => pt.status === 'active' && isConfirmedObjectOwnedLandmark(pt),
    );
    const transformation =
      activePoints.length >= 3 ? this._estimateReferenceTransformation(activePoints) : null;

    logger.debugEvery(
      'KeypointTracker',
      'recover-outlier-points',
      1000,
      'Attempting to recover outlier points:',
      {
        outlierCount: outlierPoints.length,
        activeCount: this.trackedPoints.filter((pt) => pt.status === 'active').length,
      },
    );

    if (transformation) {
      let recoveredByGeometry = 0;
      outlierPoints.forEach((point) => {
        const residual = this._transformationResidual(point, transformation);
        if (residual < 10) {
          point.status = 'active';
          point.stabilityScore = Math.max(point.stabilityScore, 0.45);
          this._restoreEstablishedObjectOwnership(point);
          recoveredByGeometry++;
        }
      });

      if (recoveredByGeometry > 0) {
        logger.info(
          'KeypointTracker',
          `Recovered ${recoveredByGeometry} outlier points from similarity transform`,
        );
        return;
      }
    }

    // Recover up to 5 outlier points that have the best error history
    const recoverablePoints = outlierPoints
      .filter((pt) => pt.errorHistory.length > 0)
      .sort((a, b) => {
        const avgErrorA = a.errorHistory.reduce((sum, err) => sum + err, 0) / a.errorHistory.length;
        const avgErrorB = b.errorHistory.reduce((sum, err) => sum + err, 0) / b.errorHistory.length;
        const qualityDelta = this.getLandmarkQuality(b) - this.getLandmarkQuality(a);
        return Math.abs(qualityDelta) > 1e-6 ? qualityDelta : avgErrorA - avgErrorB;
      })
      .slice(0, 5);

    let recoveredCount = 0;
    for (const point of recoverablePoints) {
      // Only recover points with reasonable error history
      const avgError = point.errorHistory.reduce((sum, err) => sum + err, 0) / point.errorHistory.length;
      if (avgError < 60) {
        // More lenient than normal threshold
        point.status = 'active';
        point.recoveryCount = (point.recoveryCount || 0) + 1;
        point.recentDropout = false;
        this._restoreEstablishedObjectOwnership(point);
        this.updateLandmarkQuality(point);
        recoveredCount++;
      }
    }

    if (recoveredCount > 0) {
      logger.info('KeypointTracker', `Recovered ${recoveredCount} outlier points back to active`);
    }
  }

  /**
   * Evaluate anchor evidence for the current tracked-point snapshot.
   * The result can be resolved once with OpenCV unless the tracker mutates its points.
   */
  createAnchorPositionEvaluation() {
    const trackedActivePoints = this.trackedPoints.filter((pt) => pt.status === 'active');
    if (trackedActivePoints.length === 0) {
      return { position: null, attachmentEvidence: null };
    }

    const relocalizationTransformation =
      this._estimateRelocalizationReferenceTransformation(trackedActivePoints);
    if (relocalizationTransformation) {
      const anchorPosition = this._applyReferenceTransformation(
        this.relocalizationReference.anchorPoint,
        relocalizationTransformation,
      );
      return {
        position: {
          x: anchorPosition.x,
          y: anchorPosition.y,
          confidence: relocalizationTransformation.confidence,
          method: 'reference_similarity_transform',
          referenceFrame: 'orb-keyframe',
          rotation: relocalizationTransformation.rotation,
          scale: relocalizationTransformation.scale,
          inlierCount: relocalizationTransformation.inlierCount,
          averageResidual: relocalizationTransformation.averageResidual,
        },
        attachmentEvidence: null,
      };
    }

    const activePoints = trackedActivePoints.filter(isConfirmedObjectOwnedLandmark);
    if (activePoints.length === 0) {
      return { position: null, attachmentEvidence: null };
    }

    const attachmentEvidence = this._createReferenceTransformationEvidence(activePoints);

    return {
      position: this._resolveAttachmentAnchorPosition(null, attachmentEvidence, {
        preferObjectWideSimilarity: false,
      }),
      attachmentEvidence,
    };
  }

  resolveAnchorPositionEvaluation(cv, evaluation, { preferObjectWideSimilarity }) {
    if (!evaluation.attachmentEvidence) {
      return evaluation.position;
    }
    return this._resolveAttachmentAnchorPosition(cv, evaluation.attachmentEvidence, {
      preferObjectWideSimilarity,
    });
  }

  /** Resolve an anchor position in one call for consumers without a two-stage update. */
  getAnchorPosition(cv = null) {
    const evaluation = this.createAnchorPositionEvaluation();
    return cv
      ? this.resolveAnchorPositionEvaluation(cv, evaluation, { preferObjectWideSimilarity: false })
      : evaluation.position;
  }

  _resolveAttachmentAnchorPosition(cv, attachmentEvidence, { preferObjectWideSimilarity }) {
    const { activePoints } = attachmentEvidence;
    const transformation = this._selectAttachmentReferenceTransformation(cv, attachmentEvidence, {
      preferObjectWideSimilarity,
    });

    if (transformation) {
      const anchorOriginal = this.anchorOriginalPosition || {
        x: this.keypointCentroid.x + this.tapOffset.x,
        y: this.keypointCentroid.y + this.tapOffset.y,
      };
      const anchorPosition = this._applyReferenceTransformation(anchorOriginal, transformation);
      const localTransform = this._referenceLocalTransform(anchorOriginal, transformation);

      return {
        x: anchorPosition.x,
        y: anchorPosition.y,
        confidence: transformation.confidence,
        method:
          transformation.type === 'homography' ? 'reference_homography' : 'reference_similarity_transform',
        rotation: localTransform.rotation,
        scale: localTransform.scale,
        inlierCount: transformation.inlierCount,
        averageResidual: transformation.averageResidual,
        referenceScope: transformation.referenceScope,
        localReferenceResidual: transformation.localReferenceResidual,
      };
    }

    return this.getCentroidAnchorPosition(activePoints);
  }

  getCentroidAnchorPosition(
    activePoints = this.trackedPoints.filter(
      (pt) => pt.status === 'active' && isConfirmedObjectOwnedLandmark(pt),
    ),
  ) {
    if (activePoints.length === 0) return null;

    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;

    for (const pt of activePoints) {
      // Weight based on tracking quality (inverse of average error) and age
      const avgError =
        pt.errorHistory.length > 0
          ? pt.errorHistory.reduce((sum, err) => sum + err, 0) / pt.errorHistory.length
          : 10;
      const weight = Math.max(0.1, (1 / (1 + avgError)) * Math.min(pt.age, 10));

      weightedX += pt.current.x * weight;
      weightedY += pt.current.y * weight;
      totalWeight += weight;
    }

    const currentCentroid = {
      x: weightedX / totalWeight,
      y: weightedY / totalWeight,
    };

    // Apply tap offset to get anchor position
    return {
      x: currentCentroid.x + this.tapOffset.x,
      y: currentCentroid.y + this.tapOffset.y,
      confidence: activePoints.length / this.trackedPoints.length,
      method: 'weighted_centroid_with_offset',
      inlierCount: activePoints.length,
    };
  }

  _selectAttachmentReferenceTransformation(cv, attachmentEvidence, { preferObjectWideSimilarity }) {
    this._completeReferenceHomographyEvidence(cv, attachmentEvidence);
    const {
      activePoints,
      similarityCandidates: attachmentSimilarityCandidates,
      homographyCandidate,
    } = attachmentEvidence;
    const localSimilarity = attachmentSimilarityCandidates.find(
      (candidate) => candidate.localAnchorTransform,
    );
    const objectWideSimilarity = attachmentSimilarityCandidates.find(
      (candidate) => !candidate.localAnchorTransform,
    );
    const recoverWithObjectWideSimilarity =
      preferObjectWideSimilarity &&
      activePoints.length <= OBJECT_WIDE_RECOVERY_MAX_ACTIVE_LANDMARKS &&
      (localSimilarity?.averageResidual ?? 0) >= LOCAL_REFERENCE_DEFORMATION_MIN_RESIDUAL &&
      (objectWideSimilarity?.inlierCount || 0) >= OBJECT_WIDE_RECOVERY_MIN_INLIERS;
    const candidates = [homographyCandidate, ...attachmentSimilarityCandidates].filter(Boolean);
    const selected = recoverWithObjectWideSimilarity
      ? objectWideSimilarity
      : candidates
          .map((candidate) => ({
            transform: candidate,
            score: this._attachmentTransformationScore(candidate, activePoints.length),
          }))
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score)[0]?.transform || null;

    return selected
      ? {
          ...selected,
          referenceScope: selected.localAnchorTransform ? 'tap-local' : 'object-wide',
          localReferenceResidual: localSimilarity?.averageResidual ?? null,
        }
      : null;
  }

  _createReferenceTransformationEvidence(activePoints) {
    return {
      activePoints,
      similarityCandidates: [
        this._estimateLocalReferenceTransformation(activePoints),
        this._estimateReferenceTransformation(activePoints),
      ].filter(Boolean),
      homographyCandidate: null,
      homographyEvaluated: false,
    };
  }

  _completeReferenceHomographyEvidence(cv, evidence) {
    if (!cv || evidence.activePoints.length < 8 || evidence.homographyEvaluated) {
      return;
    }
    evidence.homographyCandidate = this._estimateReferenceHomography(cv, evidence.activePoints);
    evidence.homographyEvaluated = true;
  }

  _estimateRelocalizationReferenceTransformation(activePoints) {
    if (!this.relocalizationReference) {
      return null;
    }

    const observations = activePoints
      .filter((point) => this.relocalizationReference.pointsById.has(point.id))
      .map((point) => ({
        ...point,
        original: this.relocalizationReference.pointsById.get(point.id),
      }));
    if (observations.length < 5) {
      return null;
    }

    const transformation = this._estimateReferenceTransformation(observations);
    if (
      !transformation ||
      transformation.confidence < 0.3 ||
      transformation.inlierCount < 5 ||
      transformation.averageResidual > 8
    ) {
      return null;
    }

    return transformation;
  }

  _attachmentTransformationScore(transform, activeCount) {
    const residual = transform.averageResidual ?? Infinity;
    const confidence = transform.confidence ?? 0;
    const supportCount = transform.supportCount || activeCount;
    const inlierRatio = (transform.inlierCount || 0) / Math.max(supportCount, 1);

    if (transform.scale <= 0.001) {
      return 0;
    }

    if (transform.type === 'homography') {
      if (!Number.isFinite(residual)) {
        return 0;
      }
      if (confidence < 0.38 || residual > 4.5 || inlierRatio < 0.55) {
        return 0;
      }
      return confidence * 2.4 + inlierRatio + Math.max(0, 1 - residual / 4.5) + 0.24;
    }

    const residualScore = Number.isFinite(residual) ? Math.max(0, 1 - residual / 12) : 0;
    const localBoost = transform.localAnchorTransform ? 0.38 : 0;
    return 0.01 + confidence * 2 + inlierRatio * 0.7 + residualScore + localBoost;
  }

  _referenceLocalTransform(anchorOriginal, transformation) {
    if (transformation.type !== 'homography') {
      return {
        rotation: transformation.rotation,
        scale: transformation.scale,
      };
    }

    const center = this._applyReferenceTransformation(anchorOriginal, transformation);
    const xAxis = this._applyReferenceTransformation(
      {
        x: anchorOriginal.x + 1,
        y: anchorOriginal.y,
      },
      transformation,
    );
    const yAxis = this._applyReferenceTransformation(
      {
        x: anchorOriginal.x,
        y: anchorOriginal.y + 1,
      },
      transformation,
    );
    const xScale = Math.hypot(xAxis.x - center.x, xAxis.y - center.y);
    const yScale = Math.hypot(yAxis.x - center.x, yAxis.y - center.y);

    return {
      rotation: Math.atan2(xAxis.y - center.y, xAxis.x - center.x),
      scale: (xScale + yScale) / 2,
    };
  }

  /**
   * Estimate transformation from original template to current tracked points
   * Uses robust RANSAC-style consensus to handle outliers
   */
  _estimateReferenceTransformation(activePoints) {
    if (activePoints.length < 3) return null;

    const initialTransform = this._fitSimilarityTransform(activePoints);
    const residuals = new Array(activePoints.length);
    for (let index = 0; index < activePoints.length; index++) {
      residuals[index] = this._transformationResidual(activePoints[index], initialTransform);
    }
    const sortedResiduals = [...residuals].sort((a, b) => a - b);
    const medianResidual = sortedResiduals[Math.floor(sortedResiduals.length / 2)];
    const threshold = Math.max(8, medianResidual * 2.5);
    const inliers = [];
    for (let index = 0; index < activePoints.length; index++) {
      if (residuals[index] <= threshold) {
        inliers.push(activePoints[index]);
      }
    }

    if (inliers.length < 3 || inliers.length / activePoints.length < 0.45) {
      return null;
    }

    const refinedTransform = this._fitSimilarityTransform(inliers);
    let residualSum = 0;
    for (const point of inliers) {
      residualSum += this._transformationResidual(point, refinedTransform);
    }
    const averageResidual = residualSum / inliers.length;
    const residualConfidence = Math.max(0, 1 - averageResidual / 16);

    return {
      ...refinedTransform,
      confidence: (inliers.length / activePoints.length) * residualConfidence,
      inlierCount: inliers.length,
      averageResidual,
    };
  }

  _estimateLocalReferenceTransformation(activePoints) {
    if (activePoints.length < 9) {
      return null;
    }

    const anchorReference = this.anchorOriginalPosition || this.keypointCentroid;
    if (!anchorReference) {
      return null;
    }

    const selected = this._selectLandmarkSupport(activePoints, {
      anchorReference,
      maxReferenceDistance: 72,
      minCount: 9,
      maxCount: 18,
    });

    if (selected.length < 9) {
      return null;
    }

    const transform = this._estimateReferenceTransformation(selected);
    const minLocalInliers = Math.max(5, Math.ceil(selected.length * 0.58));
    if (
      !transform ||
      transform.inlierCount < minLocalInliers ||
      (transform.averageResidual ?? Infinity) > 34
    ) {
      return null;
    }

    return transform
      ? {
          ...transform,
          supportCount: selected.length,
          localAnchorTransform: true,
        }
      : null;
  }

  _fitSimilarityTransform(points) {
    let sourceCentroidX = 0;
    let sourceCentroidY = 0;
    let targetCentroidX = 0;
    let targetCentroidY = 0;
    for (const point of points) {
      sourceCentroidX += point.original.x;
      sourceCentroidY += point.original.y;
      targetCentroidX += point.current.x;
      targetCentroidY += point.current.y;
    }
    sourceCentroidX /= points.length;
    sourceCentroidY /= points.length;
    targetCentroidX /= points.length;
    targetCentroidY /= points.length;

    let a = 0;
    let b = 0;
    let denominator = 0;
    for (const point of points) {
      const sourceX = point.original.x - sourceCentroidX;
      const sourceY = point.original.y - sourceCentroidY;
      const targetX = point.current.x - targetCentroidX;
      const targetY = point.current.y - targetCentroidY;

      a += sourceX * targetX + sourceY * targetY;
      b += sourceX * targetY - sourceY * targetX;
      denominator += sourceX * sourceX + sourceY * sourceY;
    }

    const scale = Math.hypot(a, b) / Math.max(denominator, 1e-6);
    const rotation = Math.atan2(b, a);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const tx = targetCentroidX - scale * (cos * sourceCentroidX - sin * sourceCentroidY);
    const ty = targetCentroidY - scale * (sin * sourceCentroidX + cos * sourceCentroidY);

    return { tx, ty, scale, rotation };
  }

  _applyReferenceTransformation(point, transformation) {
    if (transformation.type === 'homography') {
      return this._transformHomographyPoint(point, transformation.matrix);
    }
    if (transformation.type === 'affine') {
      return {
        x: transformation.rowX[0] * point.x + transformation.rowX[1] * point.y + transformation.rowX[2],
        y: transformation.rowY[0] * point.x + transformation.rowY[1] * point.y + transformation.rowY[2],
      };
    }

    const cos = Math.cos(transformation.rotation);
    const sin = Math.sin(transformation.rotation);
    return {
      x: transformation.tx + transformation.scale * (cos * point.x - sin * point.y),
      y: transformation.ty + transformation.scale * (sin * point.x + cos * point.y),
    };
  }

  _selectLandmarkSupport(points, { anchorReference, maxReferenceDistance = Infinity, minCount, maxCount }) {
    const scoredPoints = points.map((point) => ({
      point,
      distance: anchorReference
        ? Math.hypot(point.original.x - anchorReference.x, point.original.y - anchorReference.y)
        : 0,
      quality: this.getLandmarkQuality(point),
    }));
    const locallySupported = Number.isFinite(maxReferenceDistance)
      ? scoredPoints.filter((item) => item.distance <= maxReferenceDistance)
      : scoredPoints;
    const candidates =
      locallySupported.length >= minCount
        ? locallySupported
        : [...scoredPoints]
            .sort((left, right) => left.distance - right.distance || right.quality - left.quality)
            .slice(0, Math.min(scoredPoints.length, minCount));
    const hasExplicitObjectOwnership = candidates.some((item) => item.point.objectOwned === true);
    const stableOrder =
      Number.isFinite(maxReferenceDistance) || !hasExplicitObjectOwnership
        ? (left, right) => left.distance - right.distance || right.quality - left.quality
        : (left, right) => right.quality - left.quality || left.distance - right.distance;

    if (!Number.isFinite(maxCount) || candidates.length <= maxCount) {
      return candidates.sort(stableOrder).map((item) => item.point);
    }

    const qualityFloor =
      Math.max(...candidates.map((item) => item.quality)) - LANDMARK_SUPPORT_QUALITY_WINDOW;
    const reliable = candidates.filter((item) => item.quality >= qualityFloor);
    const minimumReliable = Math.max(minCount, Math.ceil(maxCount * LANDMARK_SUPPORT_MIN_RELIABLE_RATIO));
    const maximumReliable = Math.floor(candidates.length * LANDMARK_SUPPORT_MAX_RELIABLE_SHARE);
    const hasDistinctReliableTier = reliable.length >= minimumReliable && reliable.length <= maximumReliable;
    const selectionPool = hasDistinctReliableTier ? reliable : candidates;
    return selectionPool
      .sort(stableOrder)
      .slice(0, maxCount)
      .map((item) => item.point);
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
    const [a, b, c, d, e, f, g, h, i] = matrix;
    const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);

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

    let homography = null;

    try {
      prepareHomographyWorkspace(cv, this.referenceHomographyWorkspace, activePoints.length);
      const sourceValues = this.referenceHomographyWorkspace.sourcePoints.data32F;
      const destinationValues = this.referenceHomographyWorkspace.destinationPoints.data32F;
      for (let index = 0; index < activePoints.length; index++) {
        const point = activePoints[index];
        const offset = index * 2;
        sourceValues[offset] = point.original.x;
        sourceValues[offset + 1] = point.original.y;
        destinationValues[offset] = point.current.x;
        destinationValues[offset + 1] = point.current.y;
      }
      seedHomographyRansac(cv);
      homography = cv.findHomography(
        this.referenceHomographyWorkspace.sourcePoints,
        this.referenceHomographyWorkspace.destinationPoints,
        cv.RANSAC,
        3,
        this.referenceHomographyWorkspace.inlierMask,
        1000,
        0.99,
      );

      const inlierMask = this.referenceHomographyWorkspace.inlierMask;
      const inlierMaskValues = inlierMask.data;
      let inlierCount = 0;
      for (let index = 0; index < inlierMask.rows; index++) {
        if (inlierMaskValues[index] === 1) inlierCount++;
      }

      const matrix = homography.empty() ? null : Array.from(homography.data64F);
      const inverseMatrix = matrix ? this._invertHomographyMatrix(matrix) : null;

      if (!matrix || !inverseMatrix || inlierCount < 8 || inlierCount / activePoints.length < 0.5) {
        return null;
      }

      let residualTotal = 0;
      for (const point of activePoints) {
        const projected = this._transformHomographyPoint(point.original, matrix);
        residualTotal += Math.hypot(projected.x - point.current.x, projected.y - point.current.y);
      }
      const averageResidual = residualTotal / activePoints.length;

      return {
        type: 'homography',
        matrix,
        inverseMatrix,
        scale: 1,
        rotation: 0,
        confidence: Math.max(
          0,
          Math.min(1, (inlierCount / activePoints.length) * (1 - Math.min(1, averageResidual / 12))),
        ),
        inlierCount,
        averageResidual,
      };
    } finally {
      if (homography) {
        homography.delete();
      }
    }
  }

  _mergeTrackingPointsPreservingReference({
    keypoints,
    currentGray,
    transformation,
    objectSupportMask,
    admission,
    candidateOrder,
    reactivateReferenceMatches = false,
  }) {
    const coverageEnabled =
      candidateOrder === 'mask-coverage' && objectSupportMask?.bbox && !reactivateReferenceMatches;
    const coveragePointsBefore = coverageEnabled
      ? this.trackedPoints
          .filter((point) => point.status === 'active' && point.objectOwned !== false)
          .map((point) => point.current)
      : [];
    const coverageBefore = coverageEnabled
      ? summarizeLandmarkMaskCoverage({
          objectSupportMask,
          points: coveragePointsBefore,
        })
      : null;
    const sortedKeypoints = coverageEnabled
      ? orderKeypointsByMaskCoverage({
          keypoints,
          existingPoints: coveragePointsBefore,
          objectSupportMask,
        })
      : [...keypoints].sort((a, b) => b.response - a.response);
    const maxTrackedPoints = 96;
    const minCurrentDistance = 8;
    const minReferenceDistance = 8;
    const recoveryMatches = [];
    const matchedRecoveryIds = new Set();
    let added = 0;
    let recovered = 0;
    let rejectedByMask = 0;

    for (const kp of sortedKeypoints) {
      if (this.trackedPoints.length >= maxTrackedPoints && !reactivateReferenceMatches) {
        break;
      }

      const current = { x: kp.pt.x, y: kp.pt.y };
      if (objectSupportMask && !isPointInsideObjectSupport(objectSupportMask, current)) {
        rejectedByMask++;
        continue;
      }

      const original = this._invertReferenceTransformation(current, transformation);
      let nearestReferenceMatch = null;
      let overlappingCurrentPoint = null;
      for (const point of this.trackedPoints) {
        const referenceDistance = Math.hypot(point.original.x - original.x, point.original.y - original.y);
        if (
          referenceDistance < minReferenceDistance &&
          (!nearestReferenceMatch || referenceDistance < nearestReferenceMatch.distance)
        ) {
          nearestReferenceMatch = { point, distance: referenceDistance };
        }
        if (
          !overlappingCurrentPoint &&
          point.status === 'active' &&
          Math.hypot(point.current.x - current.x, point.current.y - current.y) < minCurrentDistance
        ) {
          overlappingCurrentPoint = point;
        }
      }

      if (reactivateReferenceMatches) {
        const recoveryPoint = nearestReferenceMatch?.point;
        if (
          recoveryPoint &&
          recoveryPoint.status !== 'active' &&
          isConfirmedObjectOwnedLandmark(recoveryPoint) &&
          recoveryPoint.recoveryOwnershipProbation !== true &&
          !matchedRecoveryIds.has(recoveryPoint.id)
        ) {
          recoveryMatches.push({
            point: recoveryPoint,
            current,
            response: kp.response,
            referenceResidual: nearestReferenceMatch.distance,
          });
          matchedRecoveryIds.add(recoveryPoint.id);
        }
        continue;
      }

      if (nearestReferenceMatch || overlappingCurrentPoint) {
        continue;
      }

      if (this.trackedPoints.length >= maxTrackedPoints) {
        continue;
      }

      const id = this.nextPointId ?? Math.max(-1, ...this.trackedPoints.map((point) => point.id)) + 1;
      const trackedPoint = this._createTrackedPoint(
        id,
        original,
        current,
        kp.response,
        kp.bootstrapOnly === true,
      );
      if (admission === 'recovery-probation') {
        this._startObjectOwnershipProbation(trackedPoint, {
          ownership: objectSupportMask ? 'supported' : 'unsupported',
          recovery: true,
        });
      } else if (objectSupportMask) {
        trackedPoint.objectOwned = true;
      }
      this.trackedPoints.push(trackedPoint);
      this.nextPointId = id + 1;
      added++;
    }

    const recoveryConsensus = reactivateReferenceMatches
      ? this._validateRecoveryPriorMatches(recoveryMatches)
      : null;
    if (recoveryConsensus?.accepted) {
      recoveryMatches.forEach((match) => {
        this._reactivateReferenceMatchedPoint(match.point, match.current, match.response, objectSupportMask);
      });
      recovered = recoveryMatches.length;
    }

    this._pruneLandmarkMap(maxTrackedPoints);
    this._recalculateReferenceCentroid();

    if (!reactivateReferenceMatches || recovered > 0) {
      this._replacePreviousGray(currentGray);
    }
    this.trackingAttempts = 0;
    const coverageAfter = coverageEnabled
      ? summarizeLandmarkMaskCoverage({
          objectSupportMask,
          points: this.trackedPoints
            .filter((point) => point.status === 'active' && point.objectOwned !== false)
            .map((point) => point.current),
        })
      : null;
    return {
      changed: added + recovered > 0,
      added,
      recovered,
      recoveryCandidateMatches: recoveryMatches.length,
      recoveryMedianReferenceResidual: recoveryConsensus?.medianResidual ?? null,
      recoveryReferenceSpan: recoveryConsensus?.referenceSpan ?? null,
      probationaryAdded: admission === 'recovery-probation' ? added : 0,
      rejectedByMask,
      total: this.trackedPoints.length,
      active: this.trackedPoints.filter((point) => point.status === 'active').length,
      ...(coverageAfter
        ? {
            coverageCellCount: coverageAfter.cellCount,
            coverageOccupiedBefore: coverageBefore.occupiedCells,
            coverageOccupiedAfter: coverageAfter.occupiedCells,
            coverageBefore: coverageBefore.coverage,
            coverageAfter: coverageAfter.coverage,
          }
        : {}),
    };
  }

  _validateRecoveryPriorMatches(matches) {
    const medianResidual = matches.length
      ? medianValue(matches.map((match) => match.referenceResidual))
      : Infinity;
    const referenceBounds = matches.reduce(
      (bounds, match) => ({
        minX: Math.min(bounds.minX, match.point.original.x),
        minY: Math.min(bounds.minY, match.point.original.y),
        maxX: Math.max(bounds.maxX, match.point.original.x),
        maxY: Math.max(bounds.maxY, match.point.original.y),
      }),
      {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
      },
    );
    const referenceSpan = matches.length
      ? {
          x: referenceBounds.maxX - referenceBounds.minX,
          y: referenceBounds.maxY - referenceBounds.minY,
        }
      : { x: 0, y: 0 };

    return {
      accepted:
        matches.length >= RECOVERY_PRIOR_MIN_CONSENSUS &&
        medianResidual <= RECOVERY_PRIOR_MAX_MEDIAN_RESIDUAL &&
        referenceSpan.x >= RECOVERY_PRIOR_MIN_REFERENCE_SPAN &&
        referenceSpan.y >= RECOVERY_PRIOR_MIN_REFERENCE_SPAN,
      medianResidual,
      referenceSpan,
    };
  }

  _reactivateReferenceMatchedPoint(point, current, response, objectSupportMask) {
    point.current = current;
    point.response = Math.max(point.response || 0, response || 0);
    point.status = 'active';
    point.inactiveAge = 0;
    point.lastSeenAttempt = this.trackingAttempts;
    point.age = (point.age || 0) + 1;
    point.observations = (point.observations || 0) + 1;
    point.successfulTrackingStreak = Math.max(1, point.successfulTrackingStreak || 0);
    point.totalSuccessfulFrames = (point.totalSuccessfulFrames || 0) + 1;
    point.recoveryCount = (point.recoveryCount || 0) + 1;
    point.recentDropout = false;
    this._restoreEstablishedObjectOwnership(point, {
      markSupported: !!objectSupportMask,
    });
    this.updateLandmarkQuality(point);
  }

  restoreFromRelocalizationMatches(currentGray, inlierMatches, relocalization = {}) {
    const matchesById = new Map(inlierMatches.map((match) => [match.id, match]));
    let restored = 0;

    const applyMatch = (point, match) => {
      point.current = { x: match.point.x, y: match.point.y };
      point.status = 'active';
      this._restoreEstablishedObjectOwnership(point, { markSupported: true });
      point.inactiveAge = 0;
      point.lastSeenAttempt = this.trackingAttempts;
      point.age = (point.age || 0) + 1;
      point.observations = (point.observations || 0) + 1;
      point.successfulTrackingStreak = Math.max(point.successfulTrackingStreak || 0, 1);
      point.totalSuccessfulFrames = (point.totalSuccessfulFrames || 0) + 1;
      point.stabilityScore = Math.max(point.stabilityScore || 0, relocalization.confidence || 0.5);
      point.errorHistory = [...(point.errorHistory || []), relocalization.averageResidual || 0].slice(-10);
      point.lastFlowResidual = relocalization.averageResidual || 0;
      point.recoveryCount = (point.recoveryCount || 0) + 1;
      point.recentDropout = false;
      this.updateLandmarkQuality(point);
      restored++;
    };

    this.trackedPoints.forEach((point) => {
      const match = matchesById.get(point.id);
      if (!match) {
        if (point.status === 'active') {
          if (point.objectOwned !== true) {
            point.status = 'lost';
            point.recentDropout = true;
            point.successfulTrackingStreak = 0;
            point.isStable = false;
            this.updateLandmarkQuality(point);
          }
        }
        return;
      }

      applyMatch(point, match);
    });

    const trackedIds = new Set(this.trackedPoints.map((point) => point.id));
    for (const match of inlierMatches) {
      if (trackedIds.has(match.id)) continue;
      const point = this._createTrackedPoint(
        match.id,
        { x: match.reference.x, y: match.reference.y },
        { x: match.point.x, y: match.point.y },
        match.response || 0.5,
      );
      applyMatch(point, match);
      this.trackedPoints.push(point);
      trackedIds.add(match.id);
      this.nextPointId = Math.max(this.nextPointId || 0, match.id + 1);
    }

    this._pruneLandmarkMap(96);
    this._recalculateReferenceCentroid();
    this.relocalizationReference = {
      anchorPoint: { ...relocalization.anchorPoint },
      pointsById: new Map(inlierMatches.map((match) => [match.id, { ...match.point }])),
    };

    this._replacePreviousGray(currentGray);
    this.trackingAttempts = 0;
    const active = this.trackedPoints.filter((point) => point.status === 'active').length;

    return {
      restored,
      total: this.trackedPoints.length,
      active,
    };
  }

  _createTrackedPoint(id, original, current, response, bootstrapOnly = false) {
    return {
      id,
      original,
      current,
      response,
      bootstrapOnly,
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
      outsideObjectFrames: 0,
      recoveryCount: 0,
      recentDropout: false,
      landmarkQuality: 0,
      objectOwnedStreak: LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES,
      recoveryOwnershipProbation: false,
    };
  }

  _startObjectOwnershipProbation(point, { ownership, recovery }) {
    point.objectOwned = ownership === 'supported';
    point.objectOwnedStreak = 0;
    point.recoveryOwnershipProbation = recovery;
  }

  _restoreEstablishedObjectOwnership(point, { markSupported = false } = {}) {
    if (markSupported) {
      point.objectOwned = true;
    }
    if (point.objectOwned === false) {
      point.objectOwnedStreak = 0;
      point.recoveryOwnershipProbation = false;
      return;
    }
    point.objectOwnedStreak = LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES;
    point.recoveryOwnershipProbation = false;
  }

  updateObjectOwnership(objectSupportMask) {
    let rejected = 0;
    let promoted = 0;
    let probationary = 0;
    let confirmed = 0;

    for (const point of this.trackedPoints) {
      if (point.status !== 'active') continue;

      if (isPointInsideObjectSupport(objectSupportMask, point.current)) {
        const previousStreak = point.objectOwnedStreak;
        point.outsideObjectFrames = 0;
        point.objectOwned = true;
        const requiredFrames = ownershipEvidenceFramesFor(point);
        point.objectOwnedStreak =
          point.recoveryOwnershipProbation === true
            ? Math.min(requiredFrames, previousStreak + 1)
            : LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES;
        if (
          previousStreak < LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES &&
          point.objectOwnedStreak === LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES
        ) {
          promoted++;
        }
        if (point.recoveryOwnershipProbation === true && point.objectOwnedStreak === requiredFrames) {
          point.recoveryOwnershipProbation = false;
        }
        if (isConfirmedObjectOwnedLandmark(point)) {
          confirmed++;
        } else {
          probationary++;
        }
        this.updateLandmarkQuality(point);
        continue;
      }

      point.outsideObjectFrames = (point.outsideObjectFrames || 0) + 1;
      point.objectOwnedStreak = 0;
      if (point.objectOwned !== false) {
        point.objectOwned = false;
        rejected++;
      }
      this.updateLandmarkQuality(point);

      if (point.outsideObjectFrames >= 2 || point.landmarkQuality < 0.52) {
        point.status = 'outlier';
      }
    }

    return {
      rejected,
      promoted,
      probationary,
      confirmed,
    };
  }

  _pruneLandmarkMap(maxTrackedPoints) {
    if (this.trackedPoints.length <= maxTrackedPoints) {
      return;
    }

    this.trackedPoints = [...this.trackedPoints]
      .sort((a, b) => {
        const qualityDelta = this.getLandmarkQuality(b) - this.getLandmarkQuality(a);
        const activeDelta = (b.status === 'active') - (a.status === 'active');
        if (Math.abs(qualityDelta) <= 0.12 && activeDelta !== 0) return activeDelta;
        if (Math.abs(qualityDelta) > 1e-6) return qualityDelta;
        if (activeDelta !== 0) return activeDelta;
        return (b.totalSuccessfulFrames || 0) - (a.totalSuccessfulFrames || 0);
      })
      .slice(0, maxTrackedPoints);
  }

  _recalculateReferenceCentroid() {
    const referencePoints = this.trackedPoints.filter(
      (point) =>
        point.status === 'active' ||
        point.isStable ||
        (point.inactiveAge || 0) < 30 ||
        (point.totalSuccessfulFrames || 0) >= 45,
    );
    const pointsForCentroid = referencePoints.length > 0 ? referencePoints : this.trackedPoints;

    if (pointsForCentroid.length === 0) {
      return;
    }

    const xSum = pointsForCentroid.reduce((sum, pt) => sum + pt.original.x, 0);
    const ySum = pointsForCentroid.reduce((sum, pt) => sum + pt.original.y, 0);
    this.keypointCentroid = {
      x: xSum / pointsForCentroid.length,
      y: ySum / pointsForCentroid.length,
    };

    if (this.anchorOriginalPosition) {
      this.tapOffset = {
        x: this.anchorOriginalPosition.x - this.keypointCentroid.x,
        y: this.anchorOriginalPosition.y - this.keypointCentroid.y,
      };
    }
  }

  _transformationResidual(point, transformation) {
    const projected = this._applyReferenceTransformation(point.original, transformation);
    return Math.hypot(projected.x - point.current.x, projected.y - point.current.y);
  }

  _motionConsensusRejectedPointIds(flowCandidates) {
    const acceptedCandidates = flowCandidates.filter((candidate) => candidate.acceptedByLK);
    if (acceptedCandidates.length < 12) {
      return new Set();
    }

    const candidatePoints = acceptedCandidates.map((candidate) => ({
      original: candidate.point.original,
      current: { x: candidate.nextX, y: candidate.nextY },
    }));
    const minInliers = Math.max(8, Math.ceil(acceptedCandidates.length * 0.7));
    const transformation = this._selectFlowConsensusTransformation(candidatePoints, minInliers);
    if (!transformation) {
      return new Set();
    }

    const residuals = acceptedCandidates.map((candidate) => {
      const projected = this._applyReferenceTransformation(candidate.point.original, transformation);
      return {
        id: candidate.point.id,
        residual: Math.hypot(projected.x - candidate.nextX, projected.y - candidate.nextY),
      };
    });
    const residualValues = residuals.map((item) => item.residual);
    const medianResidual = medianValue(residualValues);
    const residualMad = medianValue(residualValues.map((residual) => Math.abs(residual - medianResidual)));
    const threshold = Math.max(
      16,
      medianResidual + Math.max(8, residualMad * 4),
      (transformation.averageResidual || 0) * 3,
    );
    const rejected = new Set();

    residuals.forEach((item) => {
      if (item.residual > threshold && item.residual > 48) {
        rejected.add(item.id);
      }
    });

    if (rejected.size > acceptedCandidates.length * 0.35) {
      return new Set();
    }

    return rejected;
  }

  _partialFlowConsensus(activePoints, previousPoints, nextPoints) {
    const candidates = [];
    for (let index = 0; index < activePoints.length; index++) {
      const point = activePoints[index];
      if (
        point.status !== 'active' ||
        point.lastSeenAttempt !== this.trackingAttempts ||
        !isConfirmedObjectOwnedLandmark(point)
      ) {
        continue;
      }
      candidates.push({
        original: {
          x: previousPoints.data32F[index * 2],
          y: previousPoints.data32F[index * 2 + 1],
        },
        current: {
          x: nextPoints.data32F[index * 2],
          y: nextPoints.data32F[index * 2 + 1],
        },
      });
    }

    if (candidates.length < PARTIAL_OCCLUSION_MIN_FLOW_POINTS) {
      return null;
    }

    const referenceXs = candidates.map((candidate) => candidate.original.x);
    const referenceYs = candidates.map((candidate) => candidate.original.y);
    const referenceSpanX = Math.max(...referenceXs) - Math.min(...referenceXs);
    const referenceSpanY = Math.max(...referenceYs) - Math.min(...referenceYs);
    if (
      referenceSpanX < PARTIAL_OCCLUSION_MIN_REFERENCE_SPAN ||
      referenceSpanY < PARTIAL_OCCLUSION_MIN_REFERENCE_SPAN
    ) {
      return null;
    }

    const transform = this._estimateReferenceTransformation(candidates);
    const minInliers = Math.max(8, Math.ceil(candidates.length * PARTIAL_OCCLUSION_MIN_INLIER_RATIO));
    if (
      !transform ||
      transform.inlierCount < minInliers ||
      transform.confidence < PARTIAL_OCCLUSION_MIN_CONFIDENCE ||
      transform.averageResidual > PARTIAL_OCCLUSION_MAX_AVERAGE_RESIDUAL ||
      transform.scale < PARTIAL_OCCLUSION_MIN_SCALE ||
      transform.scale > PARTIAL_OCCLUSION_MAX_SCALE ||
      Math.abs(transform.rotation) > PARTIAL_OCCLUSION_MAX_ROTATION
    ) {
      return null;
    }

    return transform;
  }

  _selectFlowConsensusTransformation(candidatePoints, minInliers) {
    const directTransform = this._estimateReferenceTransformation(candidatePoints);
    if (
      directTransform &&
      directTransform.confidence >= 0.55 &&
      directTransform.inlierCount >= minInliers &&
      directTransform.averageResidual <= 10
    ) {
      return directTransform;
    }

    return this._estimatePairwiseFlowConsensusTransformation(candidatePoints, minInliers);
  }

  _estimatePairwiseFlowConsensusTransformation(candidatePoints, minInliers) {
    let best = null;
    for (let left = 0; left < candidatePoints.length - 1; left++) {
      for (let right = left + 1; right < candidatePoints.length; right++) {
        const seedTransform = this._fitSimilarityTransformFromPair(
          candidatePoints[left],
          candidatePoints[right],
        );
        if (!seedTransform) {
          continue;
        }

        const inliers = candidatePoints.filter(
          (point) => this._transformationResidual(point, seedTransform) <= 8,
        );
        if (inliers.length < minInliers) {
          continue;
        }

        const refinedTransform = this._fitSimilarityTransform(inliers);
        const refinedResiduals = inliers.map((point) =>
          this._transformationResidual(point, refinedTransform),
        );
        const averageResidual =
          refinedResiduals.reduce((sum, residual) => sum + residual, 0) / refinedResiduals.length;
        const confidence = (inliers.length / candidatePoints.length) * Math.max(0, 1 - averageResidual / 12);
        const candidate = {
          ...refinedTransform,
          confidence,
          inlierCount: inliers.length,
          averageResidual,
        };
        const score = candidate.inlierCount * 4 + candidate.confidence * 3 - candidate.averageResidual;
        if (!best || score > best.score) {
          best = { ...candidate, score };
        }
      }
    }

    if (!best || best.confidence < 0.55 || best.averageResidual > 8) {
      return null;
    }

    const transform = { ...best };
    delete transform.score;
    return transform;
  }

  _fitSimilarityTransformFromPair(first, second) {
    const sourceDx = second.original.x - first.original.x;
    const sourceDy = second.original.y - first.original.y;
    const targetDx = second.current.x - first.current.x;
    const targetDy = second.current.y - first.current.y;
    const sourceDistance = Math.hypot(sourceDx, sourceDy);
    const targetDistance = Math.hypot(targetDx, targetDy);
    if (sourceDistance < 12 || targetDistance < 1) {
      return null;
    }

    const scale = targetDistance / sourceDistance;
    const rotation = Math.atan2(targetDy, targetDx) - Math.atan2(sourceDy, sourceDx);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const tx = first.current.x - scale * (cos * first.original.x - sin * first.original.y);
    const ty = first.current.y - scale * (sin * first.original.x + cos * first.original.y);

    return { tx, ty, scale, rotation };
  }

  getLandmarkQuality(point) {
    if (!point) return 0;

    const errors = point.errorHistory || [];
    let usableErrorCount = 0;
    let usableErrorTotal = 0;
    for (const error of errors) {
      if (Number.isFinite(error) && error < 900) {
        usableErrorCount++;
        usableErrorTotal += error;
      }
    }
    const avgError = usableErrorCount > 0 ? usableErrorTotal / usableErrorCount : 12;
    const ownershipMaturity = clamp01(point.objectOwnedStreak / LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES);
    const ownershipScore =
      point.objectOwned === true ? ownershipMaturity : point.objectOwned === false ? 0 : 0.35;
    const ageScore = clamp01((point.age || 0) / 45);
    const observationScore = clamp01((point.totalSuccessfulFrames || point.observations || 0) / 60);
    const residualScore = clamp01(1 - avgError / 22);
    const descriptorScore = clamp01(point.stabilityScore || 0);
    const responseScore = clamp01(point.response || 0);
    const activeScore = point.status === 'active' ? 1 : point.isStable ? 0.72 : 0.25;
    const dropoutPenalty = clamp01(
      (point.outsideObjectFrames || 0) * 0.18 + (point.recentDropout ? 0.16 : 0),
    );

    return clamp01(
      ownershipScore * 0.24 +
        ageScore * 0.16 +
        observationScore * 0.2 +
        residualScore * 0.18 +
        descriptorScore * 0.13 +
        responseScore * 0.04 +
        activeScore * 0.05 -
        dropoutPenalty,
    );
  }

  updateLandmarkQuality(point) {
    point.landmarkQuality = this.getLandmarkQuality(point);
    return point.landmarkQuality;
  }

  getLandmarkQualityStats() {
    const points = this.trackedPoints || [];
    let activeCount = 0;
    let total = 0;
    let highQuality = 0;
    let poseEligible = 0;
    for (const point of points) {
      if (point.status !== 'active') continue;
      const quality = this.getLandmarkQuality(point);
      activeCount++;
      total += quality;
      if (quality >= 0.7) highQuality++;
      if (quality >= 0.52) poseEligible++;
    }

    if (activeCount === 0) {
      return {
        average: 0,
        highQuality: 0,
        poseEligible: 0,
      };
    }

    return {
      average: total / activeCount,
      highQuality,
      poseEligible,
    };
  }

  /**
   * Get keypoint correspondences for homography estimation
   * @returns {Array} Array of {prev: {x,y}, curr: {x,y}} point pairs
   */
  getCorrespondences(options = {}) {
    const activePoints = this.trackedPoints.filter(
      (pt) =>
        pt.status === 'active' &&
        isConfirmedObjectOwnedLandmark(pt) &&
        (!pt.bootstrapOnly || pt.age >= 3 || pt.totalSuccessfulFrames >= 3),
    );
    const { maxReferenceDistance = Infinity, minCount = 8, maxCount = Infinity } = options;

    const selected = this._selectLandmarkSupport(activePoints, {
      anchorReference: this.anchorOriginalPosition || this.keypointCentroid,
      maxReferenceDistance,
      minCount,
      maxCount,
    });

    return selected.map((point) => ({
      id: point.id,
      prev: { x: point.original.x, y: point.original.y },
      curr: { x: point.current.x, y: point.current.y },
      response: point.response,
      age: point.age,
      landmarkQuality: this.getLandmarkQuality(point),
    }));
  }

  getObjectPose(options = {}) {
    const anchorReference = options.anchorReference ?? this.anchorOriginalPosition ?? this.keypointCentroid;
    const maxReferenceDistance = options.maxReferenceDistance ?? Infinity;
    const minCount = options.minCount ?? 8;
    const maxCount = options.maxCount ?? 80;
    if (!(maxReferenceDistance > 0)) {
      throw new RangeError('Object pose maxReferenceDistance must be positive');
    }
    if (!Number.isInteger(minCount) || minCount < 1) {
      throw new RangeError('Object pose minCount must be a positive integer');
    }
    if ((!Number.isInteger(maxCount) && maxCount !== Infinity) || maxCount < minCount) {
      throw new RangeError('Object pose maxCount must be an integer greater than or equal to minCount');
    }
    const correspondences = this.getCorrespondences({
      maxReferenceDistance,
      minCount,
      maxCount,
    });

    return this.objectPoseEstimator.estimate({
      correspondences,
      anchorReference,
      previousPose: options.previousPose ?? null,
    });
  }

  planKeypointRefresh(cv, { recoveryReferenceTransform = null, attachmentEvidence = null } = {}) {
    const evidence =
      attachmentEvidence ||
      this._createReferenceTransformationEvidence(
        this.trackedPoints.filter(
          (point) => point.status === 'active' && isConfirmedObjectOwnedLandmark(point),
        ),
      );
    const { activePoints } = evidence;
    const trackedReferenceTransformation = this._selectRefreshReferenceTransformation(cv, evidence);
    const referenceTransformation = trackedReferenceTransformation || recoveryReferenceTransform;

    const plan = !referenceTransformation
      ? {
          kind: 'no-reference',
          activeCount: activePoints.length,
          total: this.trackedPoints.length,
        }
      : {
          kind: 'reference',
          transform: referenceTransformation,
          source: trackedReferenceTransformation ? 'tracked-landmarks' : 'recovery-prior',
          activeCount: activePoints.length,
          total: this.trackedPoints.length,
        };
    this.refreshPlanFrames.set(plan, this.grayFrameGeneration);
    return plan;
  }

  refreshKeypoints({
    cv,
    plan,
    currentGray,
    keypointDetector,
    region,
    objectSupportMask,
    minNewKeypoints = 15,
    adaptive = false,
    admission = 'routine-refresh',
    candidateOrder = 'response-ranked',
  }) {
    if (plan?.kind !== 'reference' && plan?.kind !== 'no-reference') {
      throw new Error('Keypoint refresh requires a frame-local reference plan');
    }
    if (
      !this.refreshPlanFrames.has(plan) ||
      this.refreshPlanFrames.get(plan) !== this.grayFrameGeneration ||
      this.consumedRefreshPlans.has(plan)
    ) {
      throw new Error('Keypoint refresh plan is stale or already consumed');
    }
    this.consumedRefreshPlans.add(plan);
    if (!KEYPOINT_CANDIDATE_ORDERS.has(candidateOrder)) {
      throw new Error(`Unknown keypoint candidate order: ${candidateOrder}`);
    }

    const baseOutcome = {
      success: false,
      status: 'failed',
      added: 0,
      recovered: 0,
      probationaryAdded: 0,
      rejectedByMask: 0,
      total: plan.total,
      active: plan.activeCount,
      candidateCount: null,
      gfttCallCount: 0,
      gfttPixelCount: 0,
      gfttPreparationCount: 0,
      minNewKeypoints,
      referenceTransformSource: plan.kind === 'reference' ? plan.source : null,
    };

    if (!cv || !currentGray || !keypointDetector || !region) {
      const invalidInputOutcome = {
        ...baseOutcome,
        reason: 'invalid-input',
      };
      logger.warn('KeypointTracker', 'Invalid inputs for refreshKeypoints');
      return invalidInputOutcome;
    }

    if (currentGray.empty() || currentGray.cols === 0 || currentGray.rows === 0) {
      const invalidImageOutcome = {
        ...baseOutcome,
        reason: 'invalid-image',
      };
      logger.warn('KeypointTracker', 'Invalid image for keypoint refresh');
      return invalidImageOutcome;
    }

    if (
      region.x < 0 ||
      region.y < 0 ||
      region.x + region.width > currentGray.cols ||
      region.y + region.height > currentGray.rows
    ) {
      const outOfBoundsOutcome = {
        ...baseOutcome,
        reason: 'region-out-of-bounds',
      };
      logger.warn('KeypointTracker', 'Region out of bounds for keypoint refresh');
      return outOfBoundsOutcome;
    }

    const newKeypoints = adaptive
      ? keypointDetector.extractAdaptiveKeypoints(cv, currentGray, region, objectSupportMask, {
          minKeypoints: minNewKeypoints,
        })
      : keypointDetector.extractKeypoints(cv, currentGray, region, objectSupportMask);
    const candidateCount = newKeypoints.keypoints.length;
    const extractionOutcome = {
      ...baseOutcome,
      candidateCount,
      gfttCallCount: newKeypoints.gfttCallCount,
      gfttPixelCount: newKeypoints.gfttPixelCount,
      gfttPreparationCount: newKeypoints.gfttPreparationCount,
    };

    if (candidateCount < minNewKeypoints) {
      const insufficientCandidateOutcome = {
        ...extractionOutcome,
        reason: 'insufficient-candidates',
      };
      logger.debug('KeypointTracker', `Insufficient new keypoints for refresh: ${candidateCount}`);
      return insufficientCandidateOutcome;
    }

    if (plan.kind === 'no-reference') {
      return {
        ...extractionOutcome,
        reason: 'no-reference-transform',
      };
    }

    const merge = this._mergeTrackingPointsPreservingReference({
      keypoints: newKeypoints.keypoints,
      currentGray,
      transformation: plan.transform,
      objectSupportMask,
      admission,
      candidateOrder,
      reactivateReferenceMatches: plan.source === 'recovery-prior',
    });
    const refreshSucceeded = plan.source === 'recovery-prior' ? merge.changed : true;
    const outcome = {
      ...extractionOutcome,
      ...merge,
      success: refreshSucceeded,
      status: refreshSucceeded ? 'refreshed' : 'failed',
      reason: refreshSucceeded ? null : 'no-recoverable-landmarks',
    };
    if (refreshSucceeded) {
      logger.info(
        'KeypointTracker',
        `Refreshed tracking with ${this.trackedPoints.length} current-frame keypoints`,
      );
    }
    return outcome;
  }

  _selectRefreshReferenceTransformation(cv, evidence) {
    const { activePoints, similarityCandidates } = evidence;
    if (activePoints.length < 3) {
      return null;
    }

    this._completeReferenceHomographyEvidence(cv, evidence);
    const localCandidate = similarityCandidates.find((candidate) => candidate.localAnchorTransform);
    const objectWideSimilarity = similarityCandidates.find((candidate) => !candidate.localAnchorTransform);

    const broadCandidates = [evidence.homographyCandidate, objectWideSimilarity].filter(Boolean);
    const selectBestCandidate = (candidates) =>
      candidates
        .map((candidate) => ({
          transform: candidate,
          score: this._refreshTransformationScore(candidate, activePoints.length),
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score)[0]?.transform || null;

    return (
      selectBestCandidate(broadCandidates) || selectBestCandidate(localCandidate ? [localCandidate] : [])
    );
  }

  _refreshTransformationScore(transform, activeCount) {
    const residual = transform.averageResidual ?? Infinity;
    const confidence = transform.confidence ?? 0;
    const supportCount = transform.supportCount || activeCount;
    const inlierRatio = (transform.inlierCount || 0) / Math.max(supportCount, 1);

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
    this.trackedPoints.forEach((point) => {
      if (point.status === 'lost' || point.status === 'outlier') {
        point.inactiveAge = (point.inactiveAge || 0) + 1;
      } else {
        point.inactiveAge = 0;
      }
    });

    this.trackedPoints = this.trackedPoints.filter((point) => {
      if (point.status === 'active') {
        return true;
      }

      const stableEnough =
        point.isStable || this.getLandmarkQuality(point) >= 0.62 || (point.totalSuccessfulFrames || 0) >= 45;
      const maxInactiveAge = stableEnough ? 120 : 45;
      return (point.inactiveAge || 0) <= maxInactiveAge;
    });

    const removed = before - this.trackedPoints.length;
    if (removed > 0) {
      logger.info('KeypointTracker', `Retired ${removed} stale landmarks from tracking map`);
    }
  }

  dispose() {
    if (this.referenceHomographyWorkspace) {
      disposeHomographyWorkspace(this.referenceHomographyWorkspace);
      this.referenceHomographyWorkspace = null;
    }
    if (this.lkWorkspace) {
      disposeLucasKanadeWorkspace(this.lkWorkspace);
      this.lkWorkspace = null;
    }
    disposeGrayFrameSlots(this.grayFrameSlots);
    this.grayFrameSlots = null;
    this.previousGray = null;
    this.grayFrameGeneration = 0;
    this.trackedPoints = [];
    this.keypointCentroid = null;
    this.tapOffset = null;
    this.nextPointId = 0;
    this.relocalizationReference = null;
    this.refreshPlanFrames = new WeakMap();
    this.consumedRefreshPlans = new WeakSet();
    this.initialized = false;
  }
}
