import { ImageAnchorService } from './ImageAnchorService.js';
import { InteractiveSegmenterService } from './InteractiveSegmenterService.js';
import { HomographyEstimator } from '../cv/anchor.homography.js';
import { RECONSTRUCTION_POSE_MODEL } from '../cv/anchor.reconstructionModes.js';
import {
  calculateTapLocalRadius,
  createTapLocalObjectSupportMask,
  isPointInsideObjectSupport,
} from '../cv/objectSupportMask.js';
import {
  CURVED_OBJECT_RECOVERY_REASON,
  needsCurvedObjectRecovery,
  shouldDeferSparseMugPoseDropoutRecovery,
} from '../cv/curvedObjectRecovery.js';
import { logger } from '../utils/logger.js';

const MAX_POSE_DROPOUT_INLIERS = 12;
const BASE_POSE_DROPOUT_INLIERS = 8;
const TAP_SEGMENTATION_TIMEOUT_MS = 6000;
const RECOVERY_SEGMENTATION_TIMEOUT_MS = 1400;

const createActiveAnchorDiagnostics = (metrics, readiness) => ({
  readiness,
  qualityState: metrics.qualityState ?? null,
  maskCoverage: metrics.maskCoverage ?? null,
  maskConfidence: metrics.maskConfidence ?? null,
  keypointDensity: metrics.keypointDensity ?? null,
  backgroundRejected: metrics.backgroundRejected ?? 0,
  objectSupportMaskPreview: metrics.currentObjectSupportMaskPreview ?? metrics.objectSupportMaskPreview ?? null,
  activeLandmarks: metrics.activeLandmarks ?? metrics.activeLandmarkCount ?? 0,
  objectOwnedLandmarks: metrics.objectOwnedLandmarks ?? 0,
  trackingSuccessRate: metrics.trackingSuccessRate ?? null,
  homographyInliers: metrics.homographyInliers ?? 0,
  affinePoseInliers: metrics.affinePoseInliers ?? 0,
  objectPoseInliers: metrics.objectPoseInliers ?? 0,
  reconstructionPoseInliers: metrics.reconstructionPoseInliers ?? 0,
  poseInliers: metrics.poseInliers ?? 0,
  poseModel: metrics.poseModel ?? null,
  poseSource: metrics.poseSource ?? null,
  targetClass: metrics.targetClass ?? null,
  poseAverageResidual: metrics.poseAverageResidual ?? null,
  poseForeshortening: metrics.poseForeshortening ?? null,
  reconstructionState: metrics.reconstructionState ?? null,
  reconstructionReady: metrics.reconstructionReady ?? false,
  reconstructionFrames: metrics.reconstructionFrames ?? 0,
  reconstructionLandmarks: metrics.reconstructionLandmarks ?? 0,
  reconstructionDepthQuality: metrics.reconstructionDepthQuality ?? 0,
  reconstructionDepthStatus: metrics.reconstructionDepthStatus ?? null,
  reconstructionDepthProvider: metrics.reconstructionDepthProvider ?? null,
  reconstructionDepthInferenceTime: metrics.reconstructionDepthInferenceTime ?? 0,
  reconstructionDepthFrameTimestamp: metrics.reconstructionDepthFrameTimestamp ?? null,
  reconstructionPreview: metrics.reconstructionPreview ?? null,
  reconstructionFailureReason: metrics.reconstructionFailureReason ?? null,
  recoveryAttempts: metrics.recoveryAttempts ?? 0,
  lostFrameCount: metrics.lostFrameCount ?? 0,
  lastFailureReason: metrics.lastFailureReason ?? null,
});

export class AnchorManager {
  constructor({
    imageAnchorService = new ImageAnchorService(),
    interactiveSegmenterService = new InteractiveSegmenterService(),
  } = {}) {
    this.imageAnchorService = imageAnchorService;
    this.interactiveSegmenterService = interactiveSegmenterService;
    this.trackingMode = RECONSTRUCTION_POSE_MODEL;
    this.imageAnchorService.setTrackingMode(this.trackingMode);

    this.mode = 'detection';
    this.detections = [];
    this.activeAnchor = null;
    this.anchorState = null;
    this.listeners = new Set();
    this.initialized = false;

    // Camera parameters for homography estimation
    this.cameraParams = null;
    this.segmentationRefreshInFlight = false;
    this.lastSegmentationRefreshAt = 0;
    this.lastRecoveryRefreshAt = 0;
    this.segmentationRefreshIntervalMs = 500;
    this.recoveryRefreshIntervalMs = 180;
  }

  async initialize(cv, viewportWidth, viewportHeight, fov = 63) {
    if (!this.initialized) {
      logger.info('AnchorManager', 'Starting initialization...');
      this.cameraParams = HomographyEstimator.createCameraMatrix(fov, viewportWidth, viewportHeight);
      await this.imageAnchorService.initialize(cv, this.cameraParams);
      this.imageAnchorService.addListener(this._onAnchorUpdate.bind(this));
      this.initialized = true;
      logger.info('AnchorManager', 'Successfully initialized image-based anchor system');
    }
  }

  addListener(listener) {
    const callback = typeof listener === 'function'
      ? listener
      : listener.onAnchorUpdate.bind(listener);
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Process optional debug detections.
   * @param {Array} detections - Detection results
   * @param {ImageData} imageData - Current frame
   * @returns {Array} Processed detections for UI display
   */
  processDetections(detections) {
    if (!this.initialized || this.mode !== 'detection') {
      return [];
    }

    this.detections = detections.map(detection => ({
      ...detection,
      id: `${detection.class}-${Math.round(detection.x1)}-${Math.round(detection.y1)}-${Math.round(detection.x2)}-${Math.round(detection.y2)}`
    }));

    const detectionSignature = this.detections
      .map(detection => detection.class)
      .sort()
      .join('|');
    logger.debugChanged(
      'AnchorManager',
      'detection-mode-summary',
      `${this.detections.length}:${detectionSignature}`,
      `Processed ${this.detections.length} detections in detection mode`
    );
    this._notifyUpdate();
    return this.detections;
  }

  /**
   * Handle anchor updates in anchor mode
   * @param {ImageData} imageData - Current frame
   * @returns {Object} Update result
   */
  updateAnchor(imageData, depthContext = {}) {
    if (!this.initialized || this.mode !== 'anchor') {
      return { success: false, reason: 'Not in anchor mode' };
    }

    const result = this.imageAnchorService.updateAnchor(imageData, depthContext);

    // The anchor service will notify via _onAnchorUpdate callback
    return result;
  }

  /**
   * Create an image anchor from a tap.
   * @param {Object} tapPosition - {x, y} coordinates
   * @param {ImageData} imageData - Current frame
   * @returns {Object} Creation result
   */
  async createAnchorFromTap(tapPosition, imageData) {
    if (!this.initialized || this.mode !== 'detection') {
      throw new Error('Can only create anchor in detection mode');
    }

    const selectedDetection = this.findDetectionAtPosition(tapPosition);
    const segmentedObjectSupportMask = await this._segmentTapObject({
      imageData,
      tapPosition,
      createdAtFrame: 0,
      timeoutMs: TAP_SEGMENTATION_TIMEOUT_MS,
    });

    const objectSupportMask = this._selectTapObjectSupportMask({
      segmentedObjectSupportMask,
      imageData,
      tapPosition,
    });
    const selectedObject = selectedDetection || this._createFreeTapDetection(objectSupportMask);
    const supportedDetection = {
      ...selectedObject,
      objectSupportMask,
    };

    const result = await this.imageAnchorService.createAnchor(
      imageData,
      tapPosition,
      supportedDetection
    );

    if (result.success) {
      this.mode = 'anchor';
      this.detections = [];
      this.activeAnchor = {
        position: result.position,
        keypoints: result.keypoints,
        quality: result.quality,
        method: result.method,
        state: result.state,
        trackingMode: this.trackingMode,
        readiness: result.readiness,
        evidence: result.evidence,
        objectSupportMaskSource: result.objectSupportMaskSource,
        sourceDetection: supportedDetection,
        createdAt: Date.now()
      };

      logger.info('AnchorManager', `Created anchor with ${result.keypoints} keypoints (quality: ${result.quality.toFixed(2)})`);
      this._notifyUpdate();
    }

    return result;
  }

  refreshSegmentationIfNeeded(imageData) {
    if (!this.initialized ||
        this.mode !== 'anchor' ||
        !this.activeAnchor ||
        !this.anchorState ||
        this.segmentationRefreshInFlight) {
      return false;
    }

    const now = performance.now();
    const lowObjectOwnership = this._hasLowObjectOwnership();
    if (this._shouldDeferObjectSupportRefresh() && !lowObjectOwnership) {
      return false;
    }

    const poseDropout = this._hasPoseDropout();
    const curvedObjectRecovery = this._needsCurvedObjectRecovery();
    const recovery = poseDropout || curvedObjectRecovery;
    const due = now - this.lastSegmentationRefreshAt >= this.segmentationRefreshIntervalMs;
    const recoveryDue = this.lastRecoveryRefreshAt === 0 ||
      now - this.lastRecoveryRefreshAt >= this.recoveryRefreshIntervalMs;
    const stableEnough = ['mapping', 'tracking', 'stable', 'degraded'].includes(this.anchorState.state);
    if (!stableEnough || (!due && !lowObjectOwnership && !(recovery && recoveryDue))) {
      return false;
    }

    const position = this.anchorState.position || this.activeAnchor.position;
    const refreshRadius = this._getSegmentationRefreshRadius(imageData);

    this.segmentationRefreshInFlight = true;
    this.lastSegmentationRefreshAt = now;

    this._segmentTapObject({
      imageData,
      tapPosition: position,
      maxRadius: refreshRadius,
      createdAtFrame: this.anchorState.metrics?.segmentationRefreshFrame || 0,
      timeoutMs: RECOVERY_SEGMENTATION_TIMEOUT_MS,
    }).then(objectSupportMask => {
      const acceptedMask = objectSupportMask && this._isAcceptableSegmentationRefresh(objectSupportMask, position, refreshRadius)
        ? objectSupportMask
        : this._createTapLocalGrowthMask({ imageData, position, radius: refreshRadius });
      if (!acceptedMask) {
        return;
      }

      const reason = acceptedMask === objectSupportMask
        ? poseDropout
          ? 'pose-dropout-recovery'
          : curvedObjectRecovery
            ? CURVED_OBJECT_RECOVERY_REASON
            : lowObjectOwnership
              ? 'object-ownership-recovery'
              : 'periodic-segmentation-refresh'
        : 'tap-local-support-growth';
      const applied = this.imageAnchorService.updateObjectSupportMask(acceptedMask, { reason });
      if (applied && this.activeAnchor) {
        this.activeAnchor.objectSupportMaskSource = acceptedMask.source;
        if (this.activeAnchor.sourceDetection) {
          this.activeAnchor.sourceDetection.objectSupportMask = acceptedMask;
        }
      }
    }).catch(error => {
      logger.warn('AnchorManager', `Segmentation refresh unavailable: ${error.message}`);
    }).finally(() => {
      this.segmentationRefreshInFlight = false;
    });

    if (recovery) {
      this.lastRecoveryRefreshAt = now;
    }

    return true;
  }

  async _segmentTapObject({ imageData, tapPosition, maxRadius, createdAtFrame, timeoutMs }) {
    try {
      const objectSupportMask = await this.interactiveSegmenterService.segmentTap({
        imageData,
        tapPosition,
        maxRadius,
        createdAtFrame,
        timeoutMs,
      });

      if (this._hasUsableObjectSupportMask(objectSupportMask)) {
        return objectSupportMask;
      }
    } catch (error) {
      logger.warn('AnchorManager', `Tap segmentation unavailable; using tap-local support: ${error.message}`);
    }

    return null;
  }

  _selectTapObjectSupportMask({
    segmentedObjectSupportMask,
    imageData,
    tapPosition,
  }) {
    if (this._isAcceptableTapObjectSupportMask(segmentedObjectSupportMask, tapPosition, imageData)) {
      return segmentedObjectSupportMask;
    }

    return createTapLocalObjectSupportMask({
      width: imageData.width,
      height: imageData.height,
      referencePoint: tapPosition,
      createdAtFrame: 0,
    });
  }

  _hasUsableObjectSupportMask(objectSupportMask) {
    return objectSupportMask?.bbox?.width > 0 && objectSupportMask?.bbox?.height > 0;
  }

  _isAcceptableTapObjectSupportMask(objectSupportMask, tapPosition, imageData) {
    if (!this._hasUsableObjectSupportMask(objectSupportMask) ||
        !isPointInsideObjectSupport(objectSupportMask, tapPosition)) {
      return false;
    }

    const frameArea = imageData.width * imageData.height;
    const maskArea = objectSupportMask.bbox.width * objectSupportMask.bbox.height;
    const oversizedAxis = objectSupportMask.bbox.width > imageData.width * 0.95 ||
      objectSupportMask.bbox.height > imageData.height * 0.95;
    return maskArea >= 16 && maskArea <= frameArea * 0.72 && !oversizedAxis;
  }

  _hasLowObjectOwnership() {
    const metrics = this.anchorState?.metrics || {};
    const active = metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0;
    if (active < 8) {
      return true;
    }

    const owned = metrics.objectOwnedLandmarks ?? active;
    return owned / Math.max(1, active) < 0.65;
  }

  _hasPoseDropout() {
    const metrics = this.anchorState?.metrics || {};
    if (this._shouldDeferSparseMugPoseDropoutRecovery(metrics)) {
      return false;
    }

    const active = metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0;
    const trackingRate = metrics.trackingSuccessRate ?? 0;
    const poseInliers = metrics.poseInliers ?? 0;
    const targetClass = this.activeAnchor?.sourceDetection?.class || metrics.targetClass || '';
    const dropoutInlierLimit = metrics.trackingMode === 'depth-fusion' && !/mug/i.test(targetClass)
      ? MAX_POSE_DROPOUT_INLIERS
      : BASE_POSE_DROPOUT_INLIERS;

    return active >= 8 &&
      trackingRate >= 0.55 &&
      poseInliers < dropoutInlierLimit &&
      metrics.poseSource == null;
  }

  _needsCurvedObjectRecovery() {
    const metrics = this.anchorState?.metrics || {};
    const targetClass = this.activeAnchor?.sourceDetection?.class || metrics.targetClass;
    return needsCurvedObjectRecovery(metrics, targetClass);
  }

  _shouldDeferObjectSupportRefresh() {
    const metrics = this.anchorState?.metrics || {};
    return this._shouldDeferSparseMugPoseDropoutRecovery(metrics);
  }

  _shouldDeferSparseMugPoseDropoutRecovery(metrics) {
    const targetClass = this.activeAnchor?.sourceDetection?.class || metrics.targetClass;
    const trackingMode = this.activeAnchor?.trackingMode || this.trackingMode || metrics.trackingMode;
    return shouldDeferSparseMugPoseDropoutRecovery(metrics, targetClass, trackingMode);
  }

  _getSegmentationRefreshRadius(imageData) {
    const baseRadius = calculateTapLocalRadius({
      width: imageData.width,
      height: imageData.height,
    });
    const metrics = this.anchorState?.metrics || {};
    const active = metrics.activeLandmarkCount ?? metrics.keypointCount ?? 0;
    const owned = metrics.objectOwnedLandmarks ?? active;
    const ownershipRatio = owned / Math.max(1, active);
    const state = this.anchorState?.state;
    const growthScale = this._hasLowObjectOwnership()
      ? 1.75
      : this._hasPoseDropout()
        ? 3.25
        : state === 'stable' || metrics.reconstructionReady
          ? 3.25
          : active >= 24 && ownershipRatio >= 0.7
            ? 2.75
            : active >= 12 && ownershipRatio >= 0.65
              ? 2.25
              : 1.5;

    return Math.min(
      baseRadius * growthScale,
      Math.hypot(imageData.width, imageData.height) * 0.28
    );
  }

  _isAcceptableSegmentationRefresh(objectSupportMask, position, continuityRadius) {
    if (!this._hasUsableObjectSupportMask(objectSupportMask)) {
      return false;
    }

    const frameArea = objectSupportMask.width * objectSupportMask.height;
    const maskArea = objectSupportMask.bbox.width * objectSupportMask.bbox.height;
    if (maskArea < 16 || maskArea > frameArea * 0.72) {
      return false;
    }

    const currentBounds = this.anchorState?.metrics?.currentObjectSupportMaskBounds ||
        this.anchorState?.metrics?.objectSupportMaskBounds ||
      this.activeAnchor?.sourceDetection?.objectSupportMask?.bbox ||
      null;
    if (!currentBounds) {
      return isPointInsideObjectSupport(objectSupportMask, position);
    }

    const center = {
      x: objectSupportMask.bbox.x + objectSupportMask.bbox.width / 2,
      y: objectSupportMask.bbox.y + objectSupportMask.bbox.height / 2,
    };
    const previousCenter = {
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height / 2,
    };
    const overlapX = Math.max(0, Math.min(objectSupportMask.bbox.x + objectSupportMask.bbox.width, currentBounds.x + currentBounds.width) -
      Math.max(objectSupportMask.bbox.x, currentBounds.x));
    const overlapY = Math.max(0, Math.min(objectSupportMask.bbox.y + objectSupportMask.bbox.height, currentBounds.y + currentBounds.height) -
      Math.max(objectSupportMask.bbox.y, currentBounds.y));
    const overlapArea = overlapX * overlapY;
    const smallerArea = Math.min(maskArea, currentBounds.width * currentBounds.height);
    return isPointInsideObjectSupport(objectSupportMask, position) ||
      overlapArea / Math.max(1, smallerArea) >= 0.18 ||
      Math.hypot(center.x - previousCenter.x, center.y - previousCenter.y) <= continuityRadius;
  }

  _createTapLocalGrowthMask({ imageData, position, radius }) {
    const metrics = this.anchorState?.metrics || {};
    const currentMask = this.activeAnchor?.sourceDetection?.objectSupportMask || null;
    const currentSource = currentMask?.source ||
      metrics.objectSupportMaskSource ||
      this.activeAnchor?.objectSupportMaskSource;
    if (currentSource !== 'tap-local') {
      return null;
    }

    const currentBounds = metrics.currentObjectSupportMaskBounds ||
      metrics.objectSupportMaskBounds ||
      currentMask?.bbox ||
      null;
    if (currentBounds && radius * 2 <= Math.max(currentBounds.width, currentBounds.height) + 2) {
      return null;
    }

    return createTapLocalObjectSupportMask({
      width: imageData.width,
      height: imageData.height,
      referencePoint: position,
      radius,
      createdAtFrame: metrics.segmentationRefreshFrame || 0,
      confidence: Math.min(0.48, (currentMask?.confidence ?? 0.32) + 0.08),
    });
  }

  _createFreeTapDetection(objectSupportMask) {
    const { bbox } = objectSupportMask;
    return {
      x1: bbox.x,
      y1: bbox.y,
      x2: bbox.x + bbox.width,
      y2: bbox.y + bbox.height,
      class: 'segmented-object',
      className: 'segmented object',
      confidence: objectSupportMask.confidence,
    };
  }

  /**
   * Find detection at tap position
   * @param {Object} position - {x, y} coordinates
   * @returns {Object|null} Detection or null
   */
  findDetectionAtPosition(position) {
    let bestDetection = null;
    let bestScore = 0;

    for (const detection of this.detections) {
      const { x1, y1, x2, y2 } = detection;
      const isInside = position.x >= x1 && position.x <= x2 &&
                      position.y >= y1 && position.y <= y2;

      if (isInside && detection.confidence > bestScore) {
        bestDetection = detection;
        bestScore = detection.confidence;
      }
    }

    return bestDetection;
  }

  /**
   * Clear current anchor and return to detection mode
   */
  clearAnchor() {
    if (this.mode === 'anchor') {
      this.imageAnchorService.clearAnchor();
      this.mode = 'detection';
      this.activeAnchor = null;
      this.anchorState = null;

      logger.info('AnchorManager', 'Cleared anchor, returned to detection mode');
      this._notifyUpdate();
    }
  }

  /**
   * Get current system state
   * @returns {Object} Current state
   */
  getState() {
    return {
      mode: this.mode,
      detections: this.detections,
      activeAnchor: this.activeAnchor,
      anchorState: this.anchorState,
      trackingMode: this.trackingMode,
      initialized: this.initialized
    };
  }

  setTrackingMode(mode) {
    this.trackingMode = mode;
    this.imageAnchorService.setTrackingMode(mode);
    this._notifyUpdate();
  }

  /**
   * Handle anchor service updates
   * @private
   */
  _onAnchorUpdate(anchorServiceState) {
    logger.debugEvery('AnchorManager', 'anchor-service-state-update', 1000, 'Received anchor service state update:', {
      anchored: anchorServiceState.anchored,
      state: anchorServiceState.state,
      position: anchorServiceState.position,
      hasMetrics: !!anchorServiceState.metrics
    });

    const previousState = this.anchorState?.state;
    this.anchorState = anchorServiceState;

    if (this.activeAnchor && anchorServiceState.position) {
      const metrics = anchorServiceState.metrics || {};
      this.activeAnchor.position = {
        x: anchorServiceState.position.x,
        y: anchorServiceState.position.y,
        z: anchorServiceState.position.z ?? 0
      };
      this.activeAnchor.planarTransform = anchorServiceState.planarTransform ?? this.activeAnchor.planarTransform ?? null;
      this.activeAnchor.state = anchorServiceState.state;
      this.activeAnchor.keypoints = metrics.keypointCount ?? this.activeAnchor.keypoints;
      this.activeAnchor.quality = metrics.templateQuality ?? this.activeAnchor.quality;
      this.activeAnchor.readiness = metrics.readiness ?? this.activeAnchor.readiness ?? null;
      this.activeAnchor.diagnostics = createActiveAnchorDiagnostics(metrics, this.activeAnchor.readiness);
      logger.debugEvery('AnchorManager', 'active-anchor-position', 1000, 'Updated activeAnchor position:', this.activeAnchor.position);
    }

    if (previousState !== anchorServiceState.state) {
      logger.info('AnchorManager', `Anchor state changed: ${previousState} -> ${anchorServiceState.state}`);
    }

    // Handle anchor state transitions to detection mode
    if (this.mode === 'anchor' && !anchorServiceState.anchored) {
      logger.info('AnchorManager', 'Anchor cleared - transitioning to detection mode');
      this.mode = 'detection';
      this.activeAnchor = null;
      this.anchorState = null;
      this._notifyUpdate();
      return;
    }

    this._notifyUpdate();
  }

  /**
   * Notify all listeners of state changes
   * @private
   */
  _notifyUpdate() {
    const state = this.getState();

    this.listeners.forEach(listener => listener(state));
  }

  dispose() {
    if (this.imageAnchorService) {
      this.imageAnchorService.dispose();
    }

    this.listeners.clear();
    this.detections = [];
    this.activeAnchor = null;
    this.anchorState = null;
    this.initialized = false;

    logger.info('AnchorManager', 'Disposed');
  }
}
