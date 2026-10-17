import { ImageAnchorService } from './ImageAnchorService.js';
import { InteractiveSegmenterService } from './InteractiveSegmenterService.js';
import { HomographyEstimator } from '../cv/anchor.homography.js';
import { calculateTapLocalRadius, isPointInsideObjectSupport } from '../cv/objectSupportMask.js';
import {
  CURVED_OBJECT_RECOVERY_REASON,
  needsCurvedObjectRecovery,
  shouldDeferSparseMugPoseDropoutRecovery,
} from '../cv/curvedObjectRecovery.js';
import { hasPosePositionDropout } from '../cv/poseDropoutRecovery.js';
import { logger } from '../utils/logger.js';
import { isFaceObservationReady } from '../utils/overlayVisibility.js';

const TAP_SEGMENTATION_TIMEOUT_MS = 6000;
const RECOVERY_SEGMENTATION_TIMEOUT_MS = 1400;
const createSegmentationRefreshState = () => ({
  status: 'idle',
  trigger: null,
  outcomeReason: null,
  maskSource: null,
  errorMessage: null,
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
    this.segmentationRefreshTask = Promise.resolve();
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
    this.cameraParams = HomographyEstimator.createCameraMatrix(fov, viewportWidth, viewportHeight);
    await this._settleImageAnchorInitialization(this.imageAnchorService.initialize(cv, this.cameraParams));
    this.imageAnchorService.addListener(this._onAnchorUpdate.bind(this));
    this.initialized = true;
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
  async prepareObjectAtPoint(tapPosition, imageData) {
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

    const objectSupportMask = segmentationResult.objectSupportMask;
    if (!this._isAcceptableTapObjectSupportMask(objectSupportMask, tapPosition, imageData)) {
      return {
        success: false,
        reason: 'No distinct object at the focus point',
        objectSupportSelection: { outcome: segmentationResult.outcomeReason || 'segmenter-mask-rejected' },
      };
    }
    const objectSupportSelection = { outcome: 'segmenter-mask' };
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
        readiness: creationResult.readiness,
        overlaySceneReady: isFaceObservationReady(this.anchorState),
        evidence: creationResult.evidence,
        objectSupportMaskSource: creationResult.objectSupportMaskSource,
        objectSupportSelection,
        selectionRegion,
        createdAt: Date.now(),
      };

      this._notifyUpdate();
    }

    return creationResult;
  }

  containsSourcePoint(point) {
    const mask = this.imageAnchorService._getCurrentObjectSupportMask();
    return Boolean(mask && isPointInsideObjectSupport(mask, point));
  }

  async processFrame(imageData, { update, refreshSegmentation, depthContext }) {
    const updateResult = update ? await this.updateAnchor(imageData, depthContext) : null;
    if (refreshSegmentation && this.refreshSegmentationIfNeeded(imageData)) {
      await this.segmentationRefreshTask;
    }
    return { updateResult };
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

    this.segmentationRefreshTask = this._segmentTapObject({
      imageData,
      tapPosition: position,
      maxRadius: refreshRadius,
      createdAtFrame: this.imageAnchorService.frameIndex,
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
        if (!evaluation.accepted) {
          this._setSegmentationRefresh({
            status: 'rejected',
            trigger,
            outcomeReason: evaluation.reason,
            maskSource: null,
            errorMessage: segmentationResult.errorMessage,
          });
          return;
        }

        const applied = this.imageAnchorService.updateObjectSupportMask(objectSupportMask, {
          reason: trigger,
        });
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
          this.activeAnchor.objectSupportMaskSource = objectSupportMask.source;
          if (this.activeAnchor.selectionRegion) {
            this.activeAnchor.selectionRegion.objectSupportMask = objectSupportMask;
          }
        }
        this._setSegmentationRefresh({
          status: 'accepted',
          trigger,
          outcomeReason: evaluation.reason,
          maskSource: objectSupportMask.source,
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
          errorMessage: error.message,
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
    const objectSupportMask = await this.interactiveSegmenterService.segmentTap({
      imageData,
      tapPosition,
      maxRadius,
      createdAtFrame,
      timeoutMs,
    });
    const usable = this._hasUsableObjectSupportMask(objectSupportMask);
    return {
      objectSupportMask: usable ? objectSupportMask : null,
      outcomeReason: usable ? null : 'empty-mask',
      errorMessage: null,
    };
  }

  _hasUsableObjectSupportMask(objectSupportMask) {
    return objectSupportMask?.bbox?.width > 0 && objectSupportMask?.bbox?.height > 0;
  }

  _isAcceptableTapObjectSupportMask(objectSupportMask, tapPosition, imageData) {
    if (
      !this._hasUsableObjectSupportMask(objectSupportMask) ||
      objectSupportMask.source !== 'interactive-segmenter' ||
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
    const trackingMode = this.imageAnchorService.trackingMode;
    return hasPosePositionDropout(metrics, { targetClass, trackingMode });
  }

  _needsCurvedObjectRecovery() {
    const metrics = this.anchorState?.metrics || {};
    const targetClass = this.activeAnchor?.selectionRegion?.surfaceHint || metrics.targetClass;
    return needsCurvedObjectRecovery(metrics, targetClass);
  }

  _shouldDeferObjectSupportRefresh() {
    const metrics = this.anchorState?.metrics || {};
    const targetClass = this.activeAnchor?.selectionRegion?.surfaceHint || metrics.targetClass;
    const trackingMode = this.imageAnchorService.trackingMode;
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
    this.segmentationRefresh = { ...createSegmentationRefreshState(), ...segmentationRefresh };
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
      activeAnchor: this.activeAnchor
        ? { ...this.activeAnchor, trackingMode: this.imageAnchorService.trackingMode }
        : null,
      anchorState: this.anchorState,
      segmentationRefresh: this.segmentationRefresh,
      trackingMode: this.imageAnchorService.trackingMode,
      initialized: this.initialized,
    };
  }

  async setTrackingMode(mode) {
    this._assertNotDisposedDuring('tracking mode change');
    await this.imageAnchorService.setTrackingMode(mode);
    this._releaseLateImageAnchorWorkIfDisposed('tracking mode change');
  }

  /**
   * Handle anchor service updates
   * @private
   */
  _onAnchorUpdate(anchorServiceState) {
    if (this.disposed) {
      return;
    }

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
      this.activeAnchor.readiness = metrics.readiness ?? null;
      if (isFaceObservationReady(anchorServiceState)) {
        this.activeAnchor.overlaySceneReady = true;
      }
      this.activeAnchor.diagnostics = createActiveAnchorDiagnostics(metrics, this.activeAnchor.readiness);
    }

    if (previousState !== anchorServiceState.state) {
      logger.info('AnchorManager', `Anchor state changed: ${previousState} -> ${anchorServiceState.state}`);
    }

    // Return to selection after the underlying tracker clears the anchor.
    if (this.mode === 'anchor' && !anchorServiceState.anchored) {
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
  }
}
