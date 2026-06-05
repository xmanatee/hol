import { ImageAnchorService } from './ImageAnchorService.js';
import { HomographyEstimator } from '../cv/anchor.homography.js';
import { RECONSTRUCTION_POSE_MODEL } from '../cv/anchor.reconstructionModes.js';
import { logger } from '../utils/logger.js';

export class AnchorManager {
  constructor() {
    this.imageAnchorService = new ImageAnchorService();
    this.trackingMode = RECONSTRUCTION_POSE_MODEL;
    this.imageAnchorService.setTrackingMode(this.trackingMode);
    
    // State management
    this.mode = 'detection'; // 'detection' or 'anchor'
    this.detections = []; // Store last detections for tap selection
    this.activeAnchor = null;
    this.anchorState = null;
    this.listeners = new Set();
    this.initialized = false;
    
    // Camera parameters for homography estimation
    this.cameraParams = null;
  }

  async initialize(cv, viewportWidth, viewportHeight, fov = 63) {
    if (!this.initialized) {
      logger.info('AnchorManager', 'Starting initialization...');
      try {
        // Calculate camera parameters from viewport and FOV
        this.cameraParams = HomographyEstimator.createCameraMatrix(fov, viewportWidth, viewportHeight);
        
        // Initialize image anchor service
        await this.imageAnchorService.initialize(cv, this.cameraParams);
        
        // Listen to anchor updates
        this.imageAnchorService.addListener(this._onAnchorUpdate.bind(this));
        
        this.initialized = true;
        logger.info('AnchorManager', 'Successfully initialized image-based anchor system');
      } catch (error) {
        logger.error('AnchorManager', 'Initialization failed:', error);
        throw error;
      }
    }
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Process detections from YOLO (only used in detection mode)
   * @param {Array} detections - Detection results
   * @param {ImageData} imageData - Current frame
   * @returns {Array} Processed detections for UI display
   */
  processDetections(detections) {
    if (!this.initialized || this.mode !== 'detection') {
      return [];
    }

    // Store detections for potential tap selection
    this.detections = detections.map(detection => ({
      ...detection,
      id: `${detection.class}-${Math.round(detection.x1)}-${Math.round(detection.y1)}-${Math.round(detection.x2)}-${Math.round(detection.y2)}`
    }));

    logger.info('AnchorManager', `Processed ${detections.length} detections in detection mode`);
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
   * Select detection and create image-based anchor
   * @param {Object} tapPosition - {x, y} coordinates
   * @param {ImageData} imageData - Current frame
   * @returns {Object} Creation result
   */
  async createAnchorFromTap(tapPosition, imageData) {
    if (!this.initialized || this.mode !== 'detection') {
      throw new Error('Can only create anchor in detection mode');
    }

    // Find detection at tap position
    const selectedDetection = this.findDetectionAtPosition(tapPosition);
    
    const result = await this.imageAnchorService.createAnchor(
      imageData, 
      tapPosition, 
      selectedDetection
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
        sourceDetection: selectedDetection,
        createdAt: Date.now()
      };
      
      logger.info('AnchorManager', `Created anchor with ${result.keypoints} keypoints (quality: ${result.quality.toFixed(2)})`);
      this._notifyUpdate();
    }

    return result;
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
    logger.debug('AnchorManager', 'Received anchor service state update:', {
      anchored: anchorServiceState.anchored,
      state: anchorServiceState.state,
      position: anchorServiceState.position,
      hasMetrics: !!anchorServiceState.metrics
    });
    
    const previousState = this.anchorState?.state;
    this.anchorState = anchorServiceState;
    
    // CRITICAL FIX: Synchronize activeAnchor position with live tracking
    if (this.activeAnchor && anchorServiceState.position) {
      this.activeAnchor.position = {
        x: anchorServiceState.position.x,
        y: anchorServiceState.position.y,
        z: anchorServiceState.position.z || 0
      };
      this.activeAnchor.planarTransform = anchorServiceState.planarTransform || this.activeAnchor.planarTransform || null;
      this.activeAnchor.state = anchorServiceState.state;
      this.activeAnchor.keypoints = anchorServiceState.metrics?.keypointCount ?? this.activeAnchor.keypoints;
      this.activeAnchor.quality = anchorServiceState.metrics?.templateQuality ?? this.activeAnchor.quality;
      this.activeAnchor.diagnostics = {
        qualityState: anchorServiceState.metrics?.qualityState || null,
        trackingSuccessRate: anchorServiceState.metrics?.trackingSuccessRate ?? null,
        homographyInliers: anchorServiceState.metrics?.homographyInliers ?? 0,
        affinePoseInliers: anchorServiceState.metrics?.affinePoseInliers ?? 0,
        objectPoseInliers: anchorServiceState.metrics?.objectPoseInliers ?? 0,
        reconstructionPoseInliers: anchorServiceState.metrics?.reconstructionPoseInliers ?? 0,
        poseInliers: anchorServiceState.metrics?.poseInliers ?? 0,
        poseModel: anchorServiceState.metrics?.poseModel || null,
        poseSource: anchorServiceState.metrics?.poseSource || null,
        targetClass: anchorServiceState.metrics?.targetClass || null,
        poseAverageResidual: anchorServiceState.metrics?.poseAverageResidual ?? null,
        poseForeshortening: anchorServiceState.metrics?.poseForeshortening ?? null,
        reconstructionState: anchorServiceState.metrics?.reconstructionState || null,
        reconstructionReady: anchorServiceState.metrics?.reconstructionReady ?? false,
        reconstructionFrames: anchorServiceState.metrics?.reconstructionFrames ?? 0,
        reconstructionLandmarks: anchorServiceState.metrics?.reconstructionLandmarks ?? 0,
        reconstructionDepthQuality: anchorServiceState.metrics?.reconstructionDepthQuality ?? 0,
        reconstructionPreview: anchorServiceState.metrics?.reconstructionPreview || null,
        reconstructionFailureReason: anchorServiceState.metrics?.reconstructionFailureReason || null,
        recoveryAttempts: anchorServiceState.metrics?.recoveryAttempts ?? 0,
        lostFrameCount: anchorServiceState.metrics?.lostFrameCount ?? 0,
        lastFailureReason: anchorServiceState.metrics?.lastFailureReason || null
      };
      logger.debug('AnchorManager', 'Updated activeAnchor position:', this.activeAnchor.position);
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
    
    this.listeners.forEach(listener => {
      try {
        if (typeof listener === 'function') {
          listener(state);
        } else if (listener.onAnchorUpdate) {
          listener.onAnchorUpdate(state);
        }
      } catch (error) {
        logger.error('AnchorManager', 'Listener error:', error);
      }
    });
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
