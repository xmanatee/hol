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
import { hasPosePositionDropout } from '../cv/poseDropoutRecovery.js';
import { logger } from '../utils/logger.js';

const TAP_SEGMENTATION_TIMEOUT_MS = 6000;
const RECOVERY_SEGMENTATION_TIMEOUT_MS = 1400;
const createSegmentationRefreshState = () => ({
  status: 'idle',
  trigger: null,
  outcomeReason: null,
  maskSource: null,
});

const createActiveAnchorDiagnostics = (metrics, readiness) => ({
  readiness,
  targetPresent: metrics.targetPresent === true,
  qualityState: metrics.qualityState ?? null,
  maskCoverage: metrics.maskCoverage ?? null,
  maskConfidence: metrics.maskConfidence ?? null,
  keypointDensity: metrics.keypointDensity ?? null,
  backgroundRejected: metrics.backgroundRejected ?? 0,
  objectSupportMaskPreview:
    metrics.currentObjectSupportMaskPreview ?? metrics.objectSupportMaskPreview ?? null,
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

    this.mode = 'selection';
    this.activeAnchor = null;
    this.anchorState = null;
    this.listeners = new Set();
    this.initialized = false;
    this.disposed = false;
    this.initializationPromise = null;

    // Camera parameters for homography estimation
    this.cameraParams = null;
    this.segmentationRefreshInFlight = false;
    this.lastSegmentationRefreshAt = 0;
    this.lastRecoveryRefreshAt = 0;
    this.segmentationRefreshIntervalMs = 500;
    this.recoveryRefreshIntervalMs = 180;
    this.segmentationRefresh = createSegmentationRefreshState();
    this.segmentationRefreshRequestId = 0;
  }

  initialize(cv, viewportWidth, viewportHeight, fov = 63) {
    if (this.disposed) {
      return Promise.reject(new Error('Anchor manager is disposed'));
    }
    if (this.initialized) {
      return Promise.resolve();
    }
    if (!this.initializationPromise) {
      const initializationPromise = this._initialize(cv, viewportWidth, viewportHeight, fov).finally(() => {
        if (this.initializationPromise === initializationPromise) {
          this.initializationPromise = null;
        }
      });
      this.initializationPromise = initializationPromise;
    }

    return this.initializationPromise;
  }

  async _initialize(cv, viewportWidth, viewportHeight, fov) {
    logger.info('AnchorManager', 'Starting initialization...');
    this.cameraParams = HomographyEstimator.createCameraMatrix(fov, viewportWidth, viewportHeight);
    await this._settleImageAnchorInitialization(this.imageAnchorService.initialize(cv, this.cameraParams));
    this.imageAnchorService.addListener(this._onAnchorUpdate.bind(this));
    this.initialized = true;
    logger.info('AnchorManager', 'Successfully initialized image-based anchor system');
  }

  addListener(listener) {
    const callback = typeof listener === 'function' ? listener : listener.onAnchorUpdate.bind(listener);
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Handle anchor updates in anchor mode
   * @param {ImageData} imageData - Current frame
   * @returns {Object} Update result
   */
  async updateAnchor(imageData, depthContext = {}) {
    if (this.disposed) {
      throw new Error('Anchor manager is disposed');
    }
    if (!this.initialized || this.mode !== 'anchor') {
      return { success: false, reason: 'Not in anchor mode' };
    }

    const result = await this.imageAnchorService.updateAnchor(imageData, depthContext);
    this._releaseLateImageAnchorWorkIfDisposed('anchor update');

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
    if (this.disposed) {
      throw new Error('Anchor manager is disposed');
    }
    if (!this.initialized || this.mode !== 'selection') {
      throw new Error('Can only create an anchor in selection mode');
    }

    const segmentationResult = await this._segmentTapObject({
      imageData,
      tapPosition,
      createdAtFrame: 0,
      timeoutMs: TAP_SEGMENTATION_TIMEOUT_MS,
    });
    this._assertNotDisposedDuring('anchor creation');

    const { objectSupportMask, objectSupportSelection } = this._selectTapObjectSupportMask({
      segmentationResult,
      imageData,
      tapPosition,
    });
    const selectionRegion = {
      ...this._createSelectionRegion(objectSupportMask),
      objectSupportMask,
    };

    const result = await this.imageAnchorService.createAnchor(imageData, tapPosition, selectionRegion);
    this._releaseLateImageAnchorWorkIfDisposed('anchor creation');
    const creationResult = {
      ...result,
      objectSupportSelection,
    };

    if (creationResult.success) {
      this.mode = 'anchor';
      this.activeAnchor = {
        position: creationResult.position,
        keypoints: creationResult.keypoints,
        quality: creationResult.quality,
        method: creationResult.method,
        state: creationResult.state,
        trackingMode: this.trackingMode,
        readiness: creationResult.readiness,
        overlaySceneReady: creationResult.readiness?.faceReady === true,
        evidence: creationResult.evidence,
        objectSupportMaskSource: creationResult.objectSupportMaskSource,
        objectSupportSelection,
        selectionRegion,
        createdAt: Date.now(),
      };

      logger.info(
        'AnchorManager',
        `Created anchor with ${creationResult.keypoints} keypoints (quality: ${creationResult.quality.toFixed(2)})`,
      );
      this._notifyUpdate();
    }

    return creationResult;
  }

  refreshSegmentationIfNeeded(imageData) {
    if (
      !this.initialized ||
      this.mode !== 'anchor' ||
      !this.activeAnchor ||
      !this.anchorState ||
      this.segmentationRefreshInFlight
    ) {
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
    const trigger = poseDropout
      ? 'pose-dropout-recovery'
      : curvedObjectRecovery
        ? CURVED_OBJECT_RECOVERY_REASON
        : lowObjectOwnership
          ? 'object-ownership-recovery'
          : 'periodic-segmentation-refresh';
    const due = now - this.lastSegmentationRefreshAt >= this.segmentationRefreshIntervalMs;
    const recoveryDue =
      this.lastRecoveryRefreshAt === 0 || now - this.lastRecoveryRefreshAt >= this.recoveryRefreshIntervalMs;
    const stableEnough = ['mapping', 'tracking', 'stable', 'degraded'].includes(this.anchorState.state);
    if (!stableEnough || (!due && !lowObjectOwnership && !(recovery && recoveryDue))) {
      return false;
    }

    const position = this.anchorState.position || this.activeAnchor.position;
    const refreshRadius = this._getSegmentationRefreshRadius(imageData);

    this.segmentationRefreshInFlight = true;
    const requestId = ++this.segmentationRefreshRequestId;
    this.lastSegmentationRefreshAt = now;
    this._setSegmentationRefresh({
      status: 'pending',
      trigger,
      outcomeReason: null,
      maskSource: null,
    });

    this._segmentTapObject({
      imageData,
      tapPosition: position,
      maxRadius: refreshRadius,
      createdAtFrame: this.anchorState.metrics?.segmentationRefreshFrame || 0,
      timeoutMs: RECOVERY_SEGMENTATION_TIMEOUT_MS,
    })
      .then((segmentationResult) => {
        if (!this._isCurrentSegmentationRefresh(requestId)) {
          return;
        }

        const { objectSupportMask, outcomeReason } = segmentationResult;
        const evaluation = outcomeReason
          ? { accepted: false, reason: outcomeReason }
          : this._evaluateSegmentationRefresh(objectSupportMask, position, refreshRadius);
        const acceptedMask = evaluation.accepted
          ? objectSupportMask
          : this._createTapLocalGrowthMask({ imageData, position, radius: refreshRadius });
        if (!acceptedMask) {
          this._setSegmentationRefresh({
            status: 'rejected',
            trigger,
            outcomeReason: evaluation.reason,
            maskSource: null,
          });
          return;
        }

        const reason = evaluation.accepted ? trigger : 'tap-local-support-growth';
        const applied = this.imageAnchorService.updateObjectSupportMask(acceptedMask, { reason });
        if (!applied) {
          this._setSegmentationRefresh({
            status: 'rejected',
            trigger,
            outcomeReason: 'service-rejected-mask',
            maskSource: null,
          });
          return;
        }
        if (this.activeAnchor) {
          this.activeAnchor.objectSupportMaskSource = acceptedMask.source;
          if (this.activeAnchor.selectionRegion) {
            this.activeAnchor.selectionRegion.objectSupportMask = acceptedMask;
          }
        }
        this._setSegmentationRefresh({
          status: evaluation.accepted ? 'accepted' : 'fallback',
          trigger,
          outcomeReason: evaluation.reason,
          maskSource: acceptedMask.source,
        });
      })
      .catch((error) => {
        if (!this._isCurrentSegmentationRefresh(requestId)) {
          return;
        }

        logger.warn('AnchorManager', `Segmentation refresh unavailable: ${error.message}`);
        this._setSegmentationRefresh({
          status: 'rejected',
          trigger,
          outcomeReason: 'refresh-error',
          maskSource: null,
        });
      })
      .finally(() => {
        if (requestId === this.segmentationRefreshRequestId) {
          this.segmentationRefreshInFlight = false;
        }
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
        return {
          objectSupportMask,
          outcomeReason: null,
          errorMessage: null,
        };
      }
    } catch (error) {
      logger.warn('AnchorManager', `Tap segmentation unavailable; using tap-local support: ${error.message}`);
      return {
        objectSupportMask: null,
        outcomeReason: 'segmenter-unavailable',
        errorMessage: error.message,
      };
    }

    return {
      objectSupportMask: null,
      outcomeReason: 'empty-mask',
      errorMessage: null,
    };
  }

  _selectTapObjectSupportMask({ segmentationResult, imageData, tapPosition }) {
    if (
      this._isAcceptableTapObjectSupportMask(segmentationResult.objectSupportMask, tapPosition, imageData)
    ) {
      return {
        objectSupportMask: segmentationResult.objectSupportMask,
        objectSupportSelection: { outcome: 'segmenter-mask' },
      };
    }

    const outcome = segmentationResult.outcomeReason || 'segmenter-mask-rejected';
    const objectSupportSelection = segmentationResult.errorMessage
      ? { outcome, error: segmentationResult.errorMessage }
      : { outcome };

    return {
      objectSupportMask: createTapLocalObjectSupportMask({
        width: imageData.width,
        height: imageData.height,
        referencePoint: tapPosition,
        createdAtFrame: 0,
      }),
      objectSupportSelection,
    };
  }

  _hasUsableObjectSupportMask(objectSupportMask) {
    return objectSupportMask?.bbox?.width > 0 && objectSupportMask?.bbox?.height > 0;
  }

  _isAcceptableTapObjectSupportMask(objectSupportMask, tapPosition, imageData) {
    if (
      !this._hasUsableObjectSupportMask(objectSupportMask) ||
      !isPointInsideObjectSupport(objectSupportMask, tapPosition)
    ) {
      return false;
    }

    const frameArea = imageData.width * imageData.height;
    const maskArea = objectSupportMask.bbox.width * objectSupportMask.bbox.height;
    const oversizedAxis =
      objectSupportMask.bbox.width > imageData.width * 0.95 ||
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
    const targetClass = this.activeAnchor?.selectionRegion?.surfaceHint || metrics.targetClass || '';
    const trackingMode = this.activeAnchor?.trackingMode || this.trackingMode || metrics.trackingMode;
    return hasPosePositionDropout(metrics, { targetClass, trackingMode });
  }

  _needsCurvedObjectRecovery() {
    const metrics = this.anchorState?.metrics || {};
    const targetClass = this.activeAnchor?.selectionRegion?.surfaceHint || metrics.targetClass;
    return needsCurvedObjectRecovery(metrics, targetClass);
  }

  _shouldDeferObjectSupportRefresh() {
    const metrics = this.anchorState?.metrics || {};
    return this._shouldDeferSparseMugPoseDropoutRecovery(metrics);
  }

  _shouldDeferSparseMugPoseDropoutRecovery(metrics) {
    const targetClass = this.activeAnchor?.selectionRegion?.surfaceHint || metrics.targetClass;
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

    return Math.min(baseRadius * growthScale, Math.hypot(imageData.width, imageData.height) * 0.28);
  }

  _evaluateSegmentationRefresh(objectSupportMask, position, continuityRadius) {
    if (!this._hasUsableObjectSupportMask(objectSupportMask)) {
      return { accepted: false, reason: 'empty-mask' };
    }

    const frameArea = objectSupportMask.width * objectSupportMask.height;
    const maskArea = objectSupportMask.bbox.width * objectSupportMask.bbox.height;
    if (maskArea < 16) {
      return { accepted: false, reason: 'undersized-mask' };
    }
    if (maskArea > frameArea * 0.72) {
      return { accepted: false, reason: 'oversized-mask' };
    }

    const currentBounds =
      this.anchorState?.metrics?.currentObjectSupportMaskBounds ||
      this.anchorState?.metrics?.objectSupportMaskBounds ||
      this.activeAnchor?.selectionRegion?.objectSupportMask?.bbox ||
      null;
    if (!currentBounds) {
      return isPointInsideObjectSupport(objectSupportMask, position)
        ? { accepted: true, reason: 'anchor-contained' }
        : { accepted: false, reason: 'discontinuous-mask' };
    }

    const center = {
      x: objectSupportMask.bbox.x + objectSupportMask.bbox.width / 2,
      y: objectSupportMask.bbox.y + objectSupportMask.bbox.height / 2,
    };
    const previousCenter = {
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height / 2,
    };
    const overlapX = Math.max(
      0,
      Math.min(
        objectSupportMask.bbox.x + objectSupportMask.bbox.width,
        currentBounds.x + currentBounds.width,
      ) - Math.max(objectSupportMask.bbox.x, currentBounds.x),
    );
    const overlapY = Math.max(
      0,
      Math.min(
        objectSupportMask.bbox.y + objectSupportMask.bbox.height,
        currentBounds.y + currentBounds.height,
      ) - Math.max(objectSupportMask.bbox.y, currentBounds.y),
    );
    const overlapArea = overlapX * overlapY;
    const smallerArea = Math.min(maskArea, currentBounds.width * currentBounds.height);
    if (isPointInsideObjectSupport(objectSupportMask, position)) {
      return { accepted: true, reason: 'anchor-contained' };
    }
    if (overlapArea / Math.max(1, smallerArea) >= 0.18) {
      return { accepted: true, reason: 'mask-overlap' };
    }
    if (Math.hypot(center.x - previousCenter.x, center.y - previousCenter.y) <= continuityRadius) {
      return { accepted: true, reason: 'center-continuity' };
    }
    return { accepted: false, reason: 'discontinuous-mask' };
  }

  _setSegmentationRefresh(segmentationRefresh) {
    this.segmentationRefresh = segmentationRefresh;
    this._notifyUpdate();
  }

  _isCurrentSegmentationRefresh(requestId) {
    return (
      requestId === this.segmentationRefreshRequestId && this.mode === 'anchor' && this.activeAnchor != null
    );
  }

  _resetSegmentationRefresh() {
    this.segmentationRefreshRequestId += 1;
    this.segmentationRefreshInFlight = false;
    this.segmentationRefresh = createSegmentationRefreshState();
  }

  _createTapLocalGrowthMask({ imageData, position, radius }) {
    const metrics = this.anchorState?.metrics || {};
    const currentMask = this.activeAnchor?.selectionRegion?.objectSupportMask || null;
    const currentSource =
      currentMask?.source || metrics.objectSupportMaskSource || this.activeAnchor?.objectSupportMaskSource;
    if (currentSource !== 'tap-local') {
      return null;
    }

    const currentBounds =
      metrics.currentObjectSupportMaskBounds || metrics.objectSupportMaskBounds || currentMask?.bbox || null;
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

  _createSelectionRegion(objectSupportMask) {
    const { bbox } = objectSupportMask;
    return {
      x1: bbox.x,
      y1: bbox.y,
      x2: bbox.x + bbox.width,
      y2: bbox.y + bbox.height,
      confidence: objectSupportMask.confidence,
    };
  }

  /** Clear the current anchor and return to tap selection. */
  clearAnchor() {
    if (this.mode === 'anchor') {
      this.imageAnchorService.clearAnchor();
      this.mode = 'selection';
      this.activeAnchor = null;
      this.anchorState = null;
      this._resetSegmentationRefresh();

      logger.info('AnchorManager', 'Cleared anchor, returned to selection mode');
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
      activeAnchor: this.activeAnchor,
      anchorState: this.anchorState,
      segmentationRefresh: this.segmentationRefresh,
      trackingMode: this.trackingMode,
      initialized: this.initialized,
    };
  }

  setTrackingMode(mode) {
    if (this.trackingMode === mode) {
      return;
    }

    this.trackingMode = mode;
    this.imageAnchorService.setTrackingMode(mode);
    this._notifyUpdate();
  }

  /**
   * Handle anchor service updates
   * @private
   */
  _onAnchorUpdate(anchorServiceState) {
    if (this.disposed) {
      return;
    }

    logger.debugEvery(
      'AnchorManager',
      'anchor-service-state-update',
      1000,
      'Received anchor service state update:',
      {
        anchored: anchorServiceState.anchored,
        state: anchorServiceState.state,
        position: anchorServiceState.position,
        hasMetrics: !!anchorServiceState.metrics,
      },
    );

    const previousState = this.anchorState?.state;
    this.anchorState = anchorServiceState;

    if (this.activeAnchor && anchorServiceState.position) {
      const metrics = anchorServiceState.metrics || {};
      this.activeAnchor.position = {
        x: anchorServiceState.position.x,
        y: anchorServiceState.position.y,
        z: anchorServiceState.position.z ?? 0,
      };
      this.activeAnchor.planarTransform =
        anchorServiceState.planarTransform ?? this.activeAnchor.planarTransform ?? null;
      this.activeAnchor.state = anchorServiceState.state;
      this.activeAnchor.keypoints = metrics.keypointCount ?? this.activeAnchor.keypoints;
      this.activeAnchor.quality = metrics.templateQuality ?? this.activeAnchor.quality;
      this.activeAnchor.readiness = metrics.readiness ?? this.activeAnchor.readiness ?? null;
      if (this.activeAnchor.readiness?.faceReady === true) {
        this.activeAnchor.overlaySceneReady = true;
      }
      this.activeAnchor.diagnostics = createActiveAnchorDiagnostics(metrics, this.activeAnchor.readiness);
      logger.debugEvery(
        'AnchorManager',
        'active-anchor-position',
        1000,
        'Updated activeAnchor position:',
        this.activeAnchor.position,
      );
    }

    if (previousState !== anchorServiceState.state) {
      logger.info('AnchorManager', `Anchor state changed: ${previousState} -> ${anchorServiceState.state}`);
    }

    // Return to selection after the underlying tracker clears the anchor.
    if (this.mode === 'anchor' && !anchorServiceState.anchored) {
      logger.info('AnchorManager', 'Anchor cleared - transitioning to selection mode');
      this.mode = 'selection';
      this.activeAnchor = null;
      this.anchorState = null;
      this._resetSegmentationRefresh();
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

    this.listeners.forEach((listener) => {
      listener(state);
    });
  }

  _assertNotDisposedDuring(operation) {
    if (this.disposed) {
      throw new Error(`Anchor manager disposed during ${operation}`);
    }
  }

  _settleImageAnchorInitialization(initialization) {
    return Promise.resolve(initialization).then(
      (result) => {
        this._releaseLateImageAnchorWorkIfDisposed('initialization');
        return result;
      },
      (error) => {
        if (!this.disposed) {
          throw error;
        }
        this.imageAnchorService.dispose();
        throw new Error('Anchor manager disposed during initialization', { cause: error });
      },
    );
  }

  _releaseLateImageAnchorWorkIfDisposed(operation) {
    if (this.disposed) {
      this.imageAnchorService.dispose();
      throw new Error(`Anchor manager disposed during ${operation}`);
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.initializationPromise = null;
    if (this.imageAnchorService) {
      this.imageAnchorService.dispose();
    }
    if (this.interactiveSegmenterService) {
      this.interactiveSegmenterService.dispose();
    }

    this.listeners.clear();
    this.mode = 'selection';
    this.activeAnchor = null;
    this.anchorState = null;
    this.cameraParams = null;
    this._resetSegmentationRefresh();
    this.initialized = false;

    logger.info('AnchorManager', 'Disposed');
  }
}
