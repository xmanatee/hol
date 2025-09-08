/**
 * Simple Anchor Persistence System - Phase 1-6 Compatible
 * Lightweight implementation using basic algorithms without OpenCV
 */

import { logger } from '../utils/logger.js';

export class SimpleAnchorPersistence {
  constructor() {
    this.anchors = new Map(); // trackId -> AnchorState
    this.lastFrame = null;
    
    // Constants
    this.MAX_DETECTOR_MISSES = 10;
    this.MIN_IOU_THRESHOLD = 0.3;
  }

  async initialize() {
    logger.info('SimpleAnchorPersistence', 'Initialized (basic mode - no OpenCV dependency)');
    return true;
  }

  /**
   * Create or update an anchor for a track
   * @param {number} trackId - Track identifier
   * @param {Object} bbox - Bounding box {x1, y1, x2, y2}
   * @param {ImageData} frame - Current frame
   * @param {string} state - Current state ('tracking' or 'stable')
   */
  updateAnchor(trackId, bbox, frame, state) {
    let anchor = this.anchors.get(trackId);
    
    if (!anchor) {
      // Create new anchor
      anchor = new SimpleAnchorState(trackId, bbox);
      this.anchors.set(trackId, anchor);
      logger.info('SimpleAnchorPersistence', `Created anchor for track ${trackId}`);
    }

    // Update anchor state
    anchor.lastDetection = { bbox, timestamp: Date.now() };
    anchor.state = state;
    anchor.missCount = 0;
    
    // Basic anchor tracking
    if (state === 'stable') {
      anchor.roiBounds = bbox;
      logger.info('SimpleAnchorPersistence', `Updated stable anchor ${trackId}`);
    }

    // Store frame reference for basic processing
    this.lastFrame = frame;
  }

  /**
   * Process frame when detector has results
   * @param {Array} detections - Array of detection objects
   * @param {ImageData} frame - Current frame
   * @returns {Array} Updated detections with persistence info
   */
  processWithDetections(detections, frame) {
    // Basic persistence processing without OpenCV
    const matchedTracks = new Set();
    const enhancedDetections = [];

    for (const detection of detections) {
      let bestMatch = null;
      let bestIoU = 0;

      // Find best matching anchor
      for (const [trackId, anchor] of this.anchors) {
        if (matchedTracks.has(trackId)) continue;
        
        const iou = this.calculateIoU(detection, anchor.lastDetection.bbox);
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

    // Handle unmatched anchors (basic miss tracking)
    for (const [trackId, anchor] of this.anchors) {
      if (!matchedTracks.has(trackId)) {
        anchor.missCount++;
        logger.info('SimpleAnchorPersistence', `Track ${trackId} missed detection (${anchor.missCount}/${this.MAX_DETECTOR_MISSES})`);
        
        // Simple prediction based on last bbox
        if (anchor.missCount <= 5) { // Keep alive for 5 frames
          logger.info('SimpleAnchorPersistence', `Track ${trackId} kept alive by prediction`);
          enhancedDetections.push({
            ...anchor.lastDetection,
            trackId: trackId,
            anchorState: anchor.state,
            persistent: true,
            synthetic: true,
            confidence: Math.max(0.2, anchor.lastDetection.confidence * 0.8)
          });
        }
      }
    }

    this.lastFrame = frame;
    return enhancedDetections;
  }

  /**
   * Process frame when detector has no results
   * @param {ImageData} frame - Current frame
   * @returns {Array} Potential re-acquired detections
   */
  processWithoutDetections(frame) {
    // Basic processing without OpenCV for Phase 1-6
    const reacquiredDetections = [];

    // Check for basic persistence of anchors
    for (const [trackId, anchor] of this.anchors) {
      anchor.missCount++;
      
      // Simple prediction-based persistence
      if (anchor.missCount <= 3) { // Keep alive for 3 frames without detections
        console.log(`[SimpleAnchorPersistence] Track ${trackId} maintained by prediction (${anchor.missCount} misses)`);
        reacquiredDetections.push({
          ...anchor.lastDetection,
          trackId: trackId,
          anchorState: anchor.state,
          persistent: true,
          synthetic: true,
          confidence: Math.max(0.1, anchor.lastDetection.confidence * 0.7)
        });
        continue;
      }

      // Clean up anchors that are lost for too long
      if (anchor.missCount > this.MAX_DETECTOR_MISSES) {
        console.log(`[SimpleAnchorPersistence] Removing lost anchor ${trackId}`);
        this.removeAnchor(trackId);
      }
    }

    this.lastFrame = frame;
    return reacquiredDetections;
  }

  /**
   * Remove anchor
   */
  removeAnchor(trackId) {
    const anchor = this.anchors.get(trackId);
    if (anchor) {
      console.log(`[SimpleAnchorPersistence] Removing anchor ${trackId}`);
    }
    this.anchors.delete(trackId);
  }

  /**
   * Calculate IoU between two bboxes
   */
  calculateIoU(box1, box2) {
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
   * Get anchor statistics for debugging
   */
  getAnchorStats() {
    const stats = [];
    for (const [trackId, anchor] of this.anchors) {
      stats.push({
        trackId,
        state: anchor.state,
        missCount: anchor.missCount,
        flowPoints: 0, // No flow points in simple mode
        hasTemplate: false, // No templates in simple mode
        age: Date.now() - (anchor.lastDetection?.timestamp || Date.now())
      });
    }
    return stats;
  }

  dispose() {
    this.anchors.clear();
    this.lastFrame = null;
    console.log('[SimpleAnchorPersistence] Disposed');
  }
}

/**
 * Internal class to maintain state for each anchor (simple version)
 */
class SimpleAnchorState {
  constructor(trackId, bbox) {
    this.trackId = trackId;
    this.lastDetection = { bbox, timestamp: Date.now() };
    this.state = 'tracking'; // 'tracking' or 'stable'
    this.missCount = 0;
    this.roiBounds = null; // Basic ROI bounds
  }
}