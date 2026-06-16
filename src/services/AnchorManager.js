import { ImageAnchorService } from './ImageAnchorService.js';
import { InteractiveSegmenterService } from './InteractiveSegmenterService.js';
import { HomographyEstimator } from '../cv/anchor.homography.js';
import { RECONSTRUCTION_POSE_MODEL } from '../cv/anchor.reconstructionModes.js';
import {
  calculateTapLocalRadius,
  createTapLocalObjectSupportMask,
  isPointInsideObjectSupport,
} from '../cv/objectSupportMask.js';
import { logger } from '../utils/logger.js';

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
    this.segmentationRefreshIntervalMs = 500;
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
  updateAnchor(imageData) {
    if (!this.initialized || this.mode !== 'anchor') {
      return { success: false, reason: 'Not in anchor mode' };
    }

    const result = this.imageAnchorService.updateAnchor(imageData);

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
    const due = now - this.lastSegmentationRefreshAt >= this.segmentationRefreshIntervalMs;
    const stableEnough = ['mapping', 'tracking', 'stable', 'degraded'].includes(this.anchorState.state);
    if (!stableEnough || (!due && !lowObjectOwnership)) {
      return false;
    }

    const position = this.anchorState.position || this.activeAnchor.position;
    const continuityRadius = this._getSegmentationRefreshRadius(imageData);

    this.segmentationRefreshInFlight = true;
    this.lastSegmentationRefreshAt = now;

    this._segmentTapObject({
      imageData,
      tapPosition: position,
      createdAtFrame: this.anchorState.metrics?.segmentationRefreshFrame || 0,
    }).then(objectSupportMask => {
      if (objectSupportMask && this._isAcceptableSegmentationRefresh(objectSupportMask, position, continuityRadius)) {
        const applied = this.imageAnchorService.updateObjectSupportMask(objectSupportMask, {
          reason: lowObjectOwnership ? 'object-ownership-recovery' : 'periodic-segmentation-refresh',
        });
        if (applied && this.activeAnchor) {
          this.activeAnchor.objectSupportMaskSource = objectSupportMask.source;
        }
      }
    }).catch(error => {
      logger.warn('AnchorManager', `Segmentation refresh unavailable: ${error.message}`);
    }).finally(() => {
      this.segmentationRefreshInFlight = false;
    });

    return true;
  }

  async _segmentTapObject({ imageData, tapPosition, maxRadius, createdAtFrame }) {
    try {
      const objectSupportMask = await this.interactiveSegmenterService.segmentTap({
        imageData,
        tapPosition,
        maxRadius,
        createdAtFrame,
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
    return maskArea >= 16 && maskArea <= frameArea * 0.72;
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
    if (!this._hasUsableObjectSupportMask(objectSupportMask) ||
        !isPointInsideObjectSupport(objectSupportMask, position)) {
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
      return true;
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
    return overlapArea / Math.max(1, smallerArea) >= 0.18 ||
      Math.hypot(center.x - previousCenter.x, center.y - previousCenter.y) <= continuityRadius;
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
