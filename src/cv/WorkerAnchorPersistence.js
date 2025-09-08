/**
 * Worker-based Anchor Persistence System - Full OpenCV Implementation
 * Uses persistence.worker.js for heavy OpenCV operations with parallel processing
 */

import { SimpleAnchorPersistence } from './SimpleAnchorPersistence.js';
import { logger } from '../utils/logger.js';

export class WorkerAnchorPersistence {
  constructor() {
    this.anchors = new Map(); // trackId -> WorkerAnchorState
    this.worker = null;
    this.isReady = false;
    this.lastFrame = null;
    this.pendingOperations = new Map(); // operationId -> Promise resolver
    this.operationCounter = 0;
    
    // Fallback to simple implementation if worker fails
    this.fallback = new SimpleAnchorPersistence();
    this.useFallback = false;
    
    // Constants
    this.FLOW_POINTS_COUNT = 80;
    this.MIN_FLOW_POINTS = 35;
    this.MAX_DETECTOR_MISSES = 10;
    this.MIN_ORB_INLIERS = 30;
    this.MIN_IOU_THRESHOLD = 0.3;
    this.FLOW_ERROR_THRESHOLD = 10.0;
  }

  async initialize() {
    try {
      logger.info('WorkerAnchorPersistence', 'Initializing worker...');
      
      // Initialize worker
      this.worker = new Worker(new URL('./persistence.worker.js', import.meta.url), {
        type: 'module'
      });

      this.worker.onmessage = (event) => {
        this._handleWorkerMessage(event.data);
      };

      this.worker.onerror = (error) => {
        logger.error('WorkerAnchorPersistence', 'Worker error:', error);
        this._enableFallback();
      };

      // Wait for worker to be ready
      const initPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('WorkerAnchorPersistence', 'Worker initialization timeout, using fallback');
          this._enableFallback();
          resolve(true);
        }, 10000);

        const checkReady = () => {
          if (this.isReady) {
            clearTimeout(timeout);
            resolve(true);
          }
        };

        this.readyCallback = checkReady;
        
        // Initialize worker
        this.worker.postMessage({ type: 'initialize' });
      });

      const result = await initPromise;
      
      if (!this.isReady) {
        // Worker failed, initialize fallback
        await this.fallback.initialize();
        this.useFallback = true;
      }
      
      logger.info('WorkerAnchorPersistence', `Initialized successfully (worker: ${this.isReady}, fallback: ${this.useFallback})`);
      return result;
    } catch (error) {
      logger.error('WorkerAnchorPersistence', 'Initialization failed:', error);
      await this._enableFallback();
      return true;
    }
  }

  async _enableFallback() {
    logger.info('WorkerAnchorPersistence', 'Enabling fallback to SimpleAnchorPersistence');
    this.useFallback = true;
    await this.fallback.initialize();
  }

  /**
   * Create or update an anchor for a track
   */
  updateAnchor(trackId, bbox, frame, state) {
    if (this.useFallback) {
      return this.fallback.updateAnchor(trackId, bbox, frame, state);
    }

    let anchor = this.anchors.get(trackId);
    
    if (!anchor) {
      // Create new anchor
      anchor = new WorkerAnchorState(trackId, bbox);
      this.anchors.set(trackId, anchor);
      logger.info('WorkerAnchorPersistence', `Created anchor for track ${trackId}`);
    }

    // Update anchor state
    anchor.lastDetection = { bbox, timestamp: Date.now() };
    anchor.state = state;
    anchor.missCount = 0;
    
    // Initialize ROI tracking for stable anchors
    if (state === 'stable' && this.isReady) {
      this._initializeROITracking(anchor, frame, bbox);
      this._extractTemplate(anchor, frame, bbox);
    }

    this.lastFrame = frame;
  }

  /**
   * Process frame when detector has results
   */
  async processWithDetections(detections, frame) {
    if (this.useFallback) {
      return this.fallback.processWithDetections(detections, frame);
    }

    const currentFrame = frame;
    
    // Update optical flow for all anchors if we have a previous frame
    if (this.lastFrame && this.isReady) {
      for (const [, anchor] of this.anchors) {
        if (anchor.flowPoints && anchor.flowPoints.length > 0) {
          this._updateOpticalFlow(anchor, this.lastFrame, currentFrame);
        }
      }
    }

    // Match detections to existing anchors
    const matchedTracks = new Set();
    const enhancedDetections = [];

    for (const detection of detections) {
      let bestMatch = null;
      let bestIoU = 0;

      // Find best matching anchor
      for (const [trackId, anchor] of this.anchors) {
        if (matchedTracks.has(trackId)) continue;
        
        const iou = this._calculateIoU(detection, anchor.lastDetection.bbox);
        if (iou > bestIoU && iou > this.MIN_IOU_THRESHOLD) {
          bestIoU = iou;
          bestMatch = { trackId, anchor };
        }
      }

      if (bestMatch) {
        matchedTracks.add(bestMatch.trackId);
        enhancedDetections.push({
          ...detection,
          trackId: bestMatch.trackId,
          anchorState: bestMatch.anchor.state,
          persistent: true
        });
      } else {
        enhancedDetections.push({
          ...detection,
          persistent: false
        });
      }
    }

    // Handle unmatched anchors (potential losses)
    for (const [trackId, anchor] of this.anchors) {
      if (!matchedTracks.has(trackId)) {
        anchor.missCount++;
        logger.info('WorkerAnchorPersistence', `Track ${trackId} missed detection (${anchor.missCount}/${this.MAX_DETECTOR_MISSES})`);
        
        // Check if flow tracking can keep it alive
        if (anchor.flowPoints && anchor.flowPoints.length >= this.MIN_FLOW_POINTS) {
          logger.info('WorkerAnchorPersistence', `Track ${trackId} kept alive by optical flow (${anchor.flowPoints.length} points)`);
          
          // Create synthetic detection from flow
          const flowBbox = this._estimateBboxFromFlow(anchor);
          if (flowBbox) {
            enhancedDetections.push({
              ...anchor.lastDetection,
              ...flowBbox,
              trackId: trackId,
              anchorState: anchor.state,
              persistent: true,
              synthetic: true,
              confidence: Math.max(0.3, anchor.lastDetection.confidence * 0.9)
            });
          }
        }
      }
    }

    this.lastFrame = currentFrame;
    return enhancedDetections;
  }

  /**
   * Process frame when detector has no results
   */
  async processWithoutDetections(frame) {
    if (this.useFallback) {
      return this.fallback.processWithoutDetections(frame);
    }

    const currentFrame = frame;
    const timestamp = Date.now();
    const reacquiredDetections = [];

    // Update optical flow for all anchors
    if (this.lastFrame && this.isReady) {
      for (const [, anchor] of this.anchors) {
        if (anchor.flowPoints && anchor.flowPoints.length > 0) {
          this._updateOpticalFlow(anchor, this.lastFrame, currentFrame);
        }
      }
    }

    // Check for re-acquisition candidates using ORB matching
    for (const [trackId, anchor] of this.anchors) {
      anchor.missCount++;
      
      // Check if flow can keep it alive
      if (anchor.flowPoints && anchor.flowPoints.length >= this.MIN_FLOW_POINTS) {
        const flowBbox = this._estimateBboxFromFlow(anchor);
        if (flowBbox) {
          logger.info('WorkerAnchorPersistence', `Track ${trackId} maintained by flow (${anchor.flowPoints.length} points)`);
          reacquiredDetections.push({
            ...anchor.lastDetection,
            ...flowBbox,
            trackId: trackId,
            anchorState: anchor.state,
            persistent: true,
            synthetic: true,
            confidence: Math.max(0.2, anchor.lastDetection.confidence * 0.8)
          });
          continue;
        }
      }

      // If flow fails and we have a template, try ORB matching
      if (anchor.missCount > 5 && anchor.template && this.isReady) {
        try {
          const reacquisition = await this._attemptReacquisition(anchor, currentFrame);
          if (reacquisition) {
            logger.info('WorkerAnchorPersistence', `Track ${trackId} re-acquired via ORB matching!`);
            reacquiredDetections.push({
              ...reacquisition,
              trackId: trackId,
              anchorState: 'tracking', // Reset to tracking state
              persistent: true,
              reacquired: true
            });
            
            // Reset anchor state
            anchor.missCount = 0;
            anchor.lastDetection = { bbox: reacquisition, timestamp };
            this._initializeROITracking(anchor, currentFrame, reacquisition);
          }
        } catch (error) {
          logger.error('WorkerAnchorPersistence', `Reacquisition failed for track ${trackId}:`, error);
        }
      }

      // Clean up anchors that are lost for too long
      if (anchor.missCount > this.MAX_DETECTOR_MISSES * 2) {
        logger.info('WorkerAnchorPersistence', `Removing lost anchor ${trackId}`);
        this.removeAnchor(trackId);
      }
    }

    this.lastFrame = currentFrame;
    return reacquiredDetections;
  }

  /**
   * Initialize ROI tracking with worker
   */
  _initializeROITracking(anchor, frame, bbox) {
    if (!this.isReady || !this.worker) return;

    this.worker.postMessage({
      type: 'initializeROI',
      trackId: anchor.trackId,
      imageData: {
        data: Array.from(frame.data),
        width: frame.width,
        height: frame.height
      },
      bbox
    });
  }

  /**
   * Update optical flow with worker
   */
  _updateOpticalFlow(anchor, prevFrame, currFrame) {
    if (!this.isReady || !this.worker || !anchor.flowPoints) return;

    this.worker.postMessage({
      type: 'updateOpticalFlow',
      trackId: anchor.trackId,
      prevImageData: {
        data: Array.from(prevFrame.data),
        width: prevFrame.width,
        height: prevFrame.height
      },
      currImageData: {
        data: Array.from(currFrame.data),
        width: currFrame.width,
        height: currFrame.height
      },
      flowPoints: anchor.flowPoints
    });
  }

  /**
   * Extract template with worker
   */
  _extractTemplate(anchor, frame, bbox) {
    if (!this.isReady || !this.worker) return;

    this.worker.postMessage({
      type: 'extractTemplate',
      trackId: anchor.trackId,
      imageData: {
        data: Array.from(frame.data),
        width: frame.width,
        height: frame.height
      },
      bbox
    });
  }

  /**
   * Attempt reacquisition with worker
   */
  async _attemptReacquisition(anchor, currentFrame) {
    if (!this.isReady || !this.worker || !anchor.template) return null;

    return new Promise((resolve, reject) => {
      const operationId = `reacq_${++this.operationCounter}`;
      
      const timeout = setTimeout(() => {
        this.pendingOperations.delete(operationId);
        resolve(null); // Timeout, return null instead of rejecting
      }, 5000);

      this.pendingOperations.set(operationId, { resolve, reject, timeout });

      this.worker.postMessage({
        type: 'attemptReacquisition',
        operationId,
        trackId: anchor.trackId,
        currentImageData: {
          data: Array.from(currentFrame.data),
          width: currentFrame.width,
          height: currentFrame.height
        },
        template: anchor.template
      });
    });
  }

  /**
   * Estimate bbox from optical flow points
   */
  _estimateBboxFromFlow(anchor) {
    if (!anchor.flowPoints || anchor.flowPoints.length < 4) {
      return null;
    }

    const xs = anchor.flowPoints.map(p => p[0]);
    const ys = anchor.flowPoints.map(p => p[1]);
    
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    
    // Add some padding based on original bbox size
    const originalBbox = anchor.roiBounds;
    if (!originalBbox) return null;
    
    const padding = Math.min(
      (originalBbox.x2 - originalBbox.x1) * 0.2,
      (originalBbox.y2 - originalBbox.y1) * 0.2
    );
    
    return {
      x1: minX - padding,
      y1: minY - padding,
      x2: maxX + padding,
      y2: maxY + padding
    };
  }

  /**
   * Calculate IoU between two bboxes
   */
  _calculateIoU(box1, box2) {
    const x1 = Math.max(box1.x1, box2.x1);
    const y1 = Math.max(box1.y1, box2.y1);
    const x2 = Math.min(box1.x2, box2.x2);
    const y2 = Math.min(box1.y2, box2.y2);

    if (x2 <= x1 || y2 <= y1) return 0;

    const intersection = (x2 - x1) * (y2 - y1);
    const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
    const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
    const union = area1 + area2 - intersection;

    return union > 0 ? intersection / union : 0;
  }

  /**
   * Remove anchor
   */
  removeAnchor(trackId) {
    if (this.useFallback) {
      return this.fallback.removeAnchor(trackId);
    }

    const anchor = this.anchors.get(trackId);
    if (anchor) {
      logger.info('WorkerAnchorPersistence', `Removing anchor ${trackId}`);
    }
    this.anchors.delete(trackId);
  }

  /**
   * Get anchor statistics for debugging
   */
  getAnchorStats() {
    if (this.useFallback) {
      return this.fallback.getAnchorStats();
    }

    const stats = [];
    for (const [trackId, anchor] of this.anchors) {
      stats.push({
        trackId,
        state: anchor.state,
        missCount: anchor.missCount,
        flowPoints: anchor.flowPoints?.length || 0,
        hasTemplate: !!anchor.template,
        age: Date.now() - (anchor.lastDetection?.timestamp || Date.now())
      });
    }
    return stats;
  }

  /**
   * Handle messages from worker
   */
  _handleWorkerMessage({ type, ...data }) {
    switch (type) {
      case 'ready':
        this.isReady = true;
        logger.info('WorkerAnchorPersistence', 'Worker ready');
        if (this.readyCallback) {
          this.readyCallback();
        }
        break;

      case 'roiInitialized': {
        const roiAnchor = this.anchors.get(data.trackId);
        if (roiAnchor) {
          roiAnchor.flowPoints = data.flowPoints;
          roiAnchor.roiBounds = data.roiBounds;
          logger.info('WorkerAnchorPersistence', `ROI initialized for track ${data.trackId} with ${data.flowPoints.length} points`);
        }
        break;
      }

      case 'flowUpdated': {
        const flowAnchor = this.anchors.get(data.trackId);
        if (flowAnchor) {
          flowAnchor.flowPoints = data.flowPoints;
        }
        break;
      }

      case 'templateExtracted': {
        const templateAnchor = this.anchors.get(data.trackId);
        if (templateAnchor) {
          templateAnchor.template = data.template;
          logger.info('WorkerAnchorPersistence', `Template extracted for track ${data.trackId}:`, !!data.template);
        }
        break;
      }

      case 'reacquisitionResult': {
        const { operationId } = data;
        if (operationId && this.pendingOperations.has(operationId)) {
          const { resolve, timeout } = this.pendingOperations.get(operationId);
          clearTimeout(timeout);
          this.pendingOperations.delete(operationId);
          resolve(data.result);
        }
        break;
      }

      case 'log':
        // Forward worker logs to main logger with tag filtering
        if (data.level && data.tag && data.args) {
          logger[data.level](data.tag, ...data.args);
        }
        break;

      case 'error':
        logger.error('WorkerAnchorPersistence', 'Worker error:', data.message);
        // Don't switch to fallback on individual operation errors
        break;

      default:
        logger.warn('WorkerAnchorPersistence', 'Unknown worker message type:', type);
    }
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    
    // Clear pending operations
    for (const [, { reject, timeout }] of this.pendingOperations) {
      clearTimeout(timeout);
      reject(new Error('WorkerAnchorPersistence disposed'));
    }
    this.pendingOperations.clear();
    
    this.anchors.clear();
    this.isReady = false;
    this.lastFrame = null;
    
    if (this.fallback) {
      this.fallback.dispose();
    }
    
    logger.info('WorkerAnchorPersistence', 'Disposed');
  }
}

/**
 * Internal class to maintain state for each anchor (worker version)
 */
class WorkerAnchorState {
  constructor(trackId, bbox) {
    this.trackId = trackId;
    this.lastDetection = { bbox, timestamp: Date.now() };
    this.state = 'tracking'; // 'tracking' or 'stable'
    this.missCount = 0;
    this.flowPoints = null; // Array of [x, y] points for optical flow
    this.roiBounds = null; // Original ROI bounds
    this.template = null; // {keypoints, descriptors, bbox} for ORB matching
  }
}