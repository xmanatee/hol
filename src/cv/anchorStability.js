/**
 * Anchor Stability Tracker
 * Maintains rolling statistics for locked tracks to determine when they're stable enough for 3D anchoring
 */

import { logger } from '../utils/logger.js';

export class AnchorStabilityTracker {
  constructor(windowDurationMs = 1000, unstableThresholdMs = 300) {
    this.windowDurationMs = windowDurationMs;
    this.unstableThresholdMs = unstableThresholdMs;
    this.trackStats = new Map(); // trackId -> StabilityStats
  }

  /**
   * Update stability stats for a track
   * @param {number} trackId - Track identifier
   * @param {Object} bbox - Bounding box {x1, y1, x2, y2}
   * @param {number} confidence - Detection confidence
   * @param {number} timestamp - Current timestamp
   */
  updateTrack(trackId, bbox, confidence, timestamp) {
    if (!this.trackStats.has(trackId)) {
      this.trackStats.set(trackId, new StabilityStats(this.windowDurationMs));
    }

    const stats = this.trackStats.get(trackId);
    stats.addSample(bbox, confidence, timestamp);
    
    return this.evaluateStability(trackId, timestamp);
  }

  /**
   * Remove tracking for a specific track
   * @param {number} trackId - Track identifier
   */
  removeTrack(trackId) {
    this.trackStats.delete(trackId);
  }

  /**
   * Get current anchor state for a track
   * @param {number} trackId - Track identifier
   * @param {number} timestamp - Current timestamp
   * @returns {'stable'|'tracking'|null} Current anchor state
   */
  getAnchorState(trackId, timestamp) {
    const stats = this.trackStats.get(trackId);
    if (!stats) return null;

    return this.evaluateStability(trackId, timestamp);
  }

  /**
   * Evaluate if a track meets stability criteria
   * @param {number} trackId - Track identifier
   * @param {number} timestamp - Current timestamp
   * @returns {'stable'|'tracking'} Stability state
   */
  evaluateStability(trackId, timestamp) {
    const stats = this.trackStats.get(trackId);
    if (!stats) return 'tracking';

    const metrics = stats.getStabilityMetrics(timestamp);
    
    // Check if we have enough samples in the window
    if (metrics.sampleCount < 5) {
      logger.info('Stability', `Track ${trackId}: Not enough samples (${metrics.sampleCount}/5)`);
      return 'tracking';
    }

    // Stability criteria
    const isVelocityStable = metrics.centerVelocity < 30; // px/s
    const isAreaStable = metrics.areaChangePercent < 10; // %
    const isConfidenceStable = metrics.confidenceRate >= 0.75; // 75% of frames

    const meetsStabilityCriteria = isVelocityStable && isAreaStable && isConfidenceStable;

    logger.info('Stability', `Track ${trackId}:`, {
      samples: metrics.sampleCount,
      velocity: metrics.centerVelocity.toFixed(1),
      areaChange: metrics.areaChangePercent.toFixed(1),
      confidence: (metrics.confidenceRate * 100).toFixed(1) + '%',
      velocityOK: isVelocityStable,
      areaOK: isAreaStable,
      confidenceOK: isConfidenceStable,
      meetsCriteria: meetsStabilityCriteria,
      currentState: stats.currentState
    });

    // State transitions
    if (stats.currentState === 'stable') {
      // Check if we've been unstable for too long
      if (!meetsStabilityCriteria) {
        if (!stats.unstableStartTime) {
          stats.unstableStartTime = timestamp;
          logger.info('Stability', `Track ${trackId}: Started unstable timer`);
        } else if (timestamp - stats.unstableStartTime > this.unstableThresholdMs) {
          logger.info('Stability', `Track ${trackId}: STABLE → TRACKING (unstable for ${timestamp - stats.unstableStartTime}ms)`);
          stats.currentState = 'tracking';
          stats.unstableStartTime = null;
          stats.stableStartTime = null;
        }
      } else {
        // Reset unstable timer if we're stable again
        stats.unstableStartTime = null;
      }
    } else {
      // Currently tracking, check for stability
      if (meetsStabilityCriteria) {
        if (!stats.stableStartTime) {
          stats.stableStartTime = timestamp;
        } else {
          const stableFor = timestamp - stats.stableStartTime;
          if (stableFor >= this.windowDurationMs) {
            stats.currentState = 'stable';
            stats.unstableStartTime = null;
          }
        }
      } else {
        // Reset stability timer
        stats.stableStartTime = null;
        stats.unstableStartTime = null;
      }
    }

    return stats.currentState;
  }

  /**
   * Get stability metrics for debugging
   * @param {number} trackId - Track identifier
   * @param {number} timestamp - Current timestamp
   * @returns {Object|null} Stability metrics
   */
  getStabilityMetrics(trackId, timestamp) {
    const stats = this.trackStats.get(trackId);
    if (!stats) return null;

    return stats.getStabilityMetrics(timestamp);
  }
}

/**
 * Internal class to track stability statistics for a single track
 */
class StabilityStats {
  constructor(windowDurationMs) {
    this.windowDurationMs = windowDurationMs;
    this.samples = []; // Array of {bbox, confidence, timestamp, center, area}
    this.currentState = 'tracking';
    this.stableStartTime = null;
    this.unstableStartTime = null;
    this.ema = { centerX: null, centerY: null, area: null }; // Exponential moving averages
    this.emaAlpha = 0.3; // Smoothing factor for EMA
  }

  addSample(bbox, confidence, timestamp) {
    const center = {
      x: (bbox.x1 + bbox.x2) / 2,
      y: (bbox.y1 + bbox.y2) / 2
    };
    const area = (bbox.x2 - bbox.x1) * (bbox.y2 - bbox.y1);

    // Update EMA
    if (this.ema.centerX === null) {
      this.ema.centerX = center.x;
      this.ema.centerY = center.y;
      this.ema.area = area;
    } else {
      this.ema.centerX = this.emaAlpha * center.x + (1 - this.emaAlpha) * this.ema.centerX;
      this.ema.centerY = this.emaAlpha * center.y + (1 - this.emaAlpha) * this.ema.centerY;
      this.ema.area = this.emaAlpha * area + (1 - this.emaAlpha) * this.ema.area;
    }

    this.samples.push({
      bbox,
      confidence,
      timestamp,
      center,
      area
    });

    // Keep only samples within the window
    const cutoffTime = timestamp - this.windowDurationMs;
    this.samples = this.samples.filter(sample => sample.timestamp >= cutoffTime);
  }

  getStabilityMetrics(timestamp) {
    const cutoffTime = timestamp - this.windowDurationMs;
    const windowSamples = this.samples.filter(sample => sample.timestamp >= cutoffTime);

    if (windowSamples.length < 2) {
      return {
        sampleCount: windowSamples.length,
        centerVelocity: 0,
        areaChangePercent: 0,
        confidenceRate: 0,
        bboxIoU: 0
      };
    }

    // Calculate center velocity (px/s)
    const velocities = [];
    for (let i = 1; i < windowSamples.length; i++) {
      const prev = windowSamples[i - 1];
      const curr = windowSamples[i];
      const dt = (curr.timestamp - prev.timestamp) / 1000; // Convert to seconds
      
      if (dt > 0) {
        const dx = curr.center.x - prev.center.x;
        const dy = curr.center.y - prev.center.y;
        const velocity = Math.sqrt(dx * dx + dy * dy) / dt;
        velocities.push(velocity);
      }
    }
    const avgVelocity = velocities.length > 0 ? 
      velocities.reduce((sum, v) => sum + v, 0) / velocities.length : 0;

    // Calculate area change percentage
    const areas = windowSamples.map(s => s.area);
    const minArea = Math.min(...areas);
    const maxArea = Math.max(...areas);
    const areaChangePercent = maxArea > 0 ? ((maxArea - minArea) / maxArea) * 100 : 0;

    // Calculate confidence rate (percentage of frames with confidence > 0.5)
    const highConfidenceFrames = windowSamples.filter(s => s.confidence > 0.5).length;
    const confidenceRate = windowSamples.length > 0 ? highConfidenceFrames / windowSamples.length : 0;

    // Calculate bbox IoU to EMA
    let avgIoU = 0;
    if (windowSamples.length > 0 && this.ema.centerX !== null) {
      const emaBbox = this.createBboxFromEMA();
      const ious = windowSamples.map(s => this.calculateIoU(s.bbox, emaBbox));
      avgIoU = ious.reduce((sum, iou) => sum + iou, 0) / ious.length;
    }

    return {
      sampleCount: windowSamples.length,
      centerVelocity: avgVelocity,
      areaChangePercent,
      confidenceRate,
      bboxIoU: avgIoU
    };
  }

  createBboxFromEMA() {
    if (this.ema.centerX === null) return { x1: 0, y1: 0, x2: 0, y2: 0 };
    
    const width = Math.sqrt(this.ema.area * 1.5); // Assume aspect ratio ~1.5
    const height = this.ema.area / width;
    
    return {
      x1: this.ema.centerX - width / 2,
      y1: this.ema.centerY - height / 2,
      x2: this.ema.centerX + width / 2,
      y2: this.ema.centerY + height / 2
    };
  }

  calculateIoU(bbox1, bbox2) {
    const x1 = Math.max(bbox1.x1, bbox2.x1);
    const y1 = Math.max(bbox1.y1, bbox2.y1);
    const x2 = Math.min(bbox1.x2, bbox2.x2);
    const y2 = Math.min(bbox1.y2, bbox2.y2);

    if (x2 <= x1 || y2 <= y1) return 0;

    const intersection = (x2 - x1) * (y2 - y1);
    const area1 = (bbox1.x2 - bbox1.x1) * (bbox1.y2 - bbox1.y1);
    const area2 = (bbox2.x2 - bbox2.x1) * (bbox2.y2 - bbox2.y1);
    const union = area1 + area2 - intersection;

    return union > 0 ? intersection / union : 0;
  }
}