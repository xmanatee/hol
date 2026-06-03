/**
 * Template Matching and Anchor Persistence System
 * Handles fallback tracking and recovery when keypoint tracking fails
 */

import { logger } from '../utils/logger.js';

export class AnchorPersistenceSystem {
  constructor() {
    this.initialized = false;
    this.template = null;
    this.templateRegion = null;
    this.lastKnownPosition = null;
    this.anchorOffset = { x: 0, y: 0 };
    this.searchRegion = null;
    this.correlationThreshold = 0.7;
    this.maxSearchRadius = 100;
    this.recoveryAttempts = 0;
    this.maxRecoveryAttempts = 5;
  }

  async initialize(cv) {
    if (!cv) {
      throw new Error('OpenCV not available');
    }
    
    this.initialized = true;
    logger.info('AnchorPersistenceSystem', 'Initialized template matching system');
  }

  /**
   * Store template for later matching
   * @param {cv.Mat} grayImage - Grayscale image
   * @param {Object} region - {x, y, width, height}
   * @param {Object} position - Current anchor position
   */
  storeTemplate(cv, grayImage, region, position) {
    try {
      // Extract template region
      const rect = new cv.Rect(region.x, region.y, region.width, region.height);
      const templateRoi = grayImage.roi(rect);
      
      // Store template copy
      if (this.template) {
        this.template.delete();
      }
      this.template = templateRoi.clone();
      
      templateRoi.delete();
      
      const templateCenter = this._getTemplateCenter(region);

      // Store template info
      this.templateRegion = { ...region };
      this.lastKnownPosition = { ...position };
      this.anchorOffset = {
        x: position.x - templateCenter.x,
        y: position.y - templateCenter.y
      };
      this.searchRegion = this._calculateSearchRegion(position, grayImage.cols, grayImage.rows);
      
      logger.info('AnchorPersistenceSystem', `Stored template ${region.width}x${region.height} at (${position.x}, ${position.y})`);
      return true;
      
    } catch (error) {
      logger.error('AnchorPersistenceSystem', 'Error storing template:', error);
      return false;
    }
  }

  /**
   * Attempt to recover anchor using template matching
   * @param {cv.Mat} currentGray - Current grayscale frame
   * @param {Object} searchCenter - Optional search center, defaults to last known position
   * @returns {Object} Recovery result
   */
  attemptRecovery(cv, currentGray, searchCenter = null) {
    if (!this.initialized || !this.template) {
      return { success: false, reason: 'No template available' };
    }

    this.recoveryAttempts++;
    
    if (this.recoveryAttempts > this.maxRecoveryAttempts) {
      return { success: false, reason: 'Max recovery attempts reached' };
    }

    try {
      const center = searchCenter || this.lastKnownPosition;
      const searchRoi = this._extractSearchROI(cv, currentGray, center);
      
      if (!searchRoi.roi) {
        return { success: false, reason: 'Invalid search region' };
      }

      // Multi-scale template matching
      const matchResults = this._multiScaleTemplateMatch(cv, searchRoi.roi, this.template);
      
      searchRoi.roi.delete();

      if (matchResults.success) {
        const globalMatch = {
          ...this._matchLocationToAnchorPosition(
            matchResults.location,
            searchRoi.offset,
            matchResults.scale
          ),
          confidence: matchResults.confidence,
          scale: matchResults.scale
        };

        // Update last known position
        this.lastKnownPosition = {
          x: globalMatch.x,
          y: globalMatch.y
        };

        // Reset recovery attempts on success
        this.recoveryAttempts = 0;

        logger.info('AnchorPersistenceSystem', `Recovery successful at (${globalMatch.x.toFixed(1)}, ${globalMatch.y.toFixed(1)}) confidence: ${matchResults.confidence.toFixed(3)}`);

        return {
          success: true,
          position: globalMatch,
          confidence: matchResults.confidence,
          scale: matchResults.scale,
          method: 'template_matching'
        };
      } else {
        return { success: false, reason: 'Template match below threshold' };
      }

    } catch (error) {
      logger.error('AnchorPersistenceSystem', 'Recovery error:', error);
      return { success: false, reason: 'Recovery exception: ' + error.message };
    }
  }

  /**
   * Perform multi-scale template matching
   * @param {cv.Mat} searchImage - Image to search in
   * @param {cv.Mat} template - Template to find
   * @returns {Object} Match result
   */
  _multiScaleTemplateMatch(cv, searchImage, template) {
    const scales = [0.8, 0.9, 1.0, 1.1, 1.2]; // Scale factors to try
    let bestMatch = { confidence: 0, location: null, scale: 1.0 };

    for (const scale of scales) {
      try {
        // Scale template
        const scaledTemplate = new cv.Mat();
        const newSize = new cv.Size(
          Math.round(template.cols * scale),
          Math.round(template.rows * scale)
        );
        
        cv.resize(template, scaledTemplate, newSize, 0, 0, cv.INTER_LINEAR);

        // Skip if scaled template is larger than search image
        if (scaledTemplate.cols > searchImage.cols || scaledTemplate.rows > searchImage.rows) {
          scaledTemplate.delete();
          continue;
        }

        // Perform template matching
        const result = new cv.Mat();
        cv.matchTemplate(searchImage, scaledTemplate, result, cv.TM_CCOEFF_NORMED);

        // Find best match
        const minMaxLoc = cv.minMaxLoc(result);
        const confidence = minMaxLoc.maxVal;

        if (confidence > bestMatch.confidence && confidence > this.correlationThreshold) {
          bestMatch = {
            confidence: confidence,
            location: minMaxLoc.maxLoc,
            scale: scale
          };
        }

        // Cleanup
        scaledTemplate.delete();
        result.delete();

      } catch (error) {
        logger.warn('AnchorPersistenceSystem', `Error at scale ${scale}:`, error);
      }
    }

    return {
      success: bestMatch.confidence > this.correlationThreshold,
      ...bestMatch
    };
  }

  /**
   * Extract region of interest for searching
   * @param {cv.Mat} image - Full image
   * @param {Object} center - Search center {x, y}
   * @returns {Object} - {roi: cv.Mat, offset: {x, y}}
   */
  _extractSearchROI(cv, image, center) {
    const searchRadius = Math.min(this.maxSearchRadius, 
      Math.max(this.templateRegion.width, this.templateRegion.height) * 2);

    const x1 = Math.max(0, Math.round(center.x - searchRadius));
    const y1 = Math.max(0, Math.round(center.y - searchRadius));
    const x2 = Math.min(image.cols, Math.round(center.x + searchRadius));
    const y2 = Math.min(image.rows, Math.round(center.y + searchRadius));

    const width = x2 - x1;
    const height = y2 - y1;

    if (width <= 0 || height <= 0) {
      return { roi: null, offset: { x: 0, y: 0 } };
    }

    try {
      const rect = new cv.Rect(x1, y1, width, height);
      const roi = image.roi(rect);
      
      return {
        roi: roi,
        offset: { x: x1, y: y1 }
      };
    } catch (error) {
      logger.error('AnchorPersistenceSystem', 'Error extracting search ROI:', error);
      return { roi: null, offset: { x: 0, y: 0 } };
    }
  }

  /**
   * Calculate initial search region based on anchor position
   */
  _calculateSearchRegion(position, imageWidth, imageHeight) {
    const margin = 50;
    return {
      x: Math.max(0, position.x - margin),
      y: Math.max(0, position.y - margin),
      width: Math.min(imageWidth - Math.max(0, position.x - margin), margin * 2),
      height: Math.min(imageHeight - Math.max(0, position.y - margin), margin * 2)
    };
  }

  _getTemplateCenter(region) {
    return {
      x: region.x + region.width / 2,
      y: region.y + region.height / 2
    };
  }

  _matchLocationToAnchorPosition(matchLocation, searchOffset, scale = 1) {
    const matchCenter = {
      x: searchOffset.x + matchLocation.x + (this.templateRegion.width * scale) / 2,
      y: searchOffset.y + matchLocation.y + (this.templateRegion.height * scale) / 2
    };

    return {
      x: matchCenter.x + this.anchorOffset.x * scale,
      y: matchCenter.y + this.anchorOffset.y * scale
    };
  }

  /**
   * Update template with new successful match
   * @param {cv.Mat} grayImage - Current frame
   * @param {Object} position - New anchor position
   * @param {Object} region - New template region
   */
  updateTemplate(cv, grayImage, position, region) {
    try {
      // Only update if we have a good quality match
      const rect = new cv.Rect(region.x, region.y, region.width, region.height);
      const newTemplateRoi = grayImage.roi(rect);
      
      // Calculate correlation with current template for quality check
      if (this.template) {
        const result = new cv.Mat();
        cv.matchTemplate(newTemplateRoi, this.template, result, cv.TM_CCOEFF_NORMED);
        const minMaxLoc = cv.minMaxLoc(result);
        const correlation = minMaxLoc.maxVal;
        result.delete();
        
        // Only update if correlation is reasonable (not too different)
        if (correlation > 0.6) {
          this.template.delete();
          this.template = newTemplateRoi.clone();
          this.templateRegion = { ...region };
          this.lastKnownPosition = { ...position };
          const templateCenter = this._getTemplateCenter(region);
          this.anchorOffset = {
            x: position.x - templateCenter.x,
            y: position.y - templateCenter.y
          };
          logger.info('AnchorPersistenceSystem', `Template updated with correlation ${correlation.toFixed(3)}`);
        }
      }
      
      newTemplateRoi.delete();
      
    } catch (error) {
      logger.error('AnchorPersistenceSystem', 'Error updating template:', error);
    }
  }

  /**
   * Perform full-frame search when anchor is completely lost
   * @param {cv.Mat} currentGray - Current frame
   * @returns {Object} Search result
   */
  fullFrameSearch(cv, currentGray) {
    if (!this.template) {
      return { success: false, reason: 'No template available' };
    }

    logger.info('AnchorPersistenceSystem', 'Performing full-frame search...');

    try {
      // Use only 1.0 scale for full-frame search to avoid performance issues
      const result = new cv.Mat();
      cv.matchTemplate(currentGray, this.template, result, cv.TM_CCOEFF_NORMED);

      const minMaxLoc = cv.minMaxLoc(result);
      const confidence = minMaxLoc.maxVal;

      result.delete();

      if (confidence > this.correlationThreshold) {
        const matchCenter = this._matchLocationToAnchorPosition(
          minMaxLoc.maxLoc,
          { x: 0, y: 0 },
          1
        );

        this.lastKnownPosition = matchCenter;
        this.recoveryAttempts = 0;

        logger.info('AnchorPersistenceSystem', `Full-frame search successful at (${matchCenter.x.toFixed(1)}, ${matchCenter.y.toFixed(1)})`);

        return {
          success: true,
          position: matchCenter,
          confidence: confidence,
          scale: 1.0,
          method: 'full_frame_search'
        };
      } else {
        return { success: false, reason: `Low confidence: ${confidence.toFixed(3)}` };
      }

    } catch (error) {
      logger.error('AnchorPersistenceSystem', 'Full-frame search error:', error);
      return { success: false, reason: 'Search exception: ' + error.message };
    }
  }

  /**
   * Reset recovery state
   */
  resetRecovery() {
    this.recoveryAttempts = 0;
    logger.info('AnchorPersistenceSystem', 'Recovery state reset');
  }

  /**
   * Check if template is still valid
   */
  hasValidTemplate() {
    return this.template !== null && !this.template.empty();
  }

  /**
   * Get template information
   */
  getTemplateInfo() {
    if (!this.hasValidTemplate()) {
      return null;
    }

    return {
      size: {
        width: this.templateRegion.width,
        height: this.templateRegion.height
      },
      lastPosition: this.lastKnownPosition,
      anchorOffset: this.anchorOffset,
      recoveryAttempts: this.recoveryAttempts,
      correlationThreshold: this.correlationThreshold
    };
  }

  dispose() {
    if (this.template) {
      this.template.delete();
      this.template = null;
    }
    
    this.templateRegion = null;
    this.lastKnownPosition = null;
    this.anchorOffset = { x: 0, y: 0 };
    this.searchRegion = null;
    this.recoveryAttempts = 0;
    this.initialized = false;
    
    logger.info('AnchorPersistenceSystem', 'Disposed');
  }
}
