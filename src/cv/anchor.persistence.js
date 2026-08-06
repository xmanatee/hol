import { logger } from '../utils/logger.js';

export class AnchorPersistenceSystem {
  constructor() {
    this.initialized = false;
    this.template = null;
    this.templateRegion = null;
    this.lastKnownPosition = null;
    this.anchorOffset = { x: 0, y: 0 };
    this.correlationThreshold = 0.7;
    this.maxSearchRadius = 100;
  }

  initialize(cv) {
    if (!cv) {
      throw new Error('OpenCV not available');
    }

    this.initialized = true;
    logger.info('AnchorPersistenceSystem', 'Initialized template matching system');
  }

  storeTemplate(cv, grayImage, region, position) {
    let templateRoi = null;
    try {
      const rect = new cv.Rect(region.x, region.y, region.width, region.height);
      templateRoi = grayImage.roi(rect);

      if (this.template) {
        this.template.delete();
      }
      this.template = templateRoi.clone();

      const templateCenter = this._getTemplateCenter(region);

      this.templateRegion = { ...region };
      this.lastKnownPosition = { ...position };
      this.anchorOffset = {
        x: position.x - templateCenter.x,
        y: position.y - templateCenter.y,
      };

      logger.info(
        'AnchorPersistenceSystem',
        `Stored template ${region.width}x${region.height} at (${position.x}, ${position.y})`,
      );
      return true;
    } finally {
      if (templateRoi) {
        templateRoi.delete();
      }
    }
  }

  attemptRecovery(cv, currentGray, searchCenter = null) {
    if (!this.initialized || !this.template) {
      return { success: false, reason: 'No template available' };
    }

    let searchRoi = null;
    try {
      const center = searchCenter || this.lastKnownPosition;
      searchRoi = this._extractSearchROI(cv, currentGray, center);

      if (!searchRoi.roi) {
        return { success: false, reason: 'Invalid search region' };
      }

      const matchResults = this._multiScaleTemplateMatch(cv, searchRoi.roi, this.template);

      if (matchResults.success) {
        const globalMatch = {
          ...this._matchLocationToAnchorPosition(matchResults.location, searchRoi.offset, matchResults.scale),
          confidence: matchResults.confidence,
          scale: matchResults.scale,
        };

        this.lastKnownPosition = {
          x: globalMatch.x,
          y: globalMatch.y,
        };

        logger.info(
          'AnchorPersistenceSystem',
          `Recovery successful at (${globalMatch.x.toFixed(1)}, ${globalMatch.y.toFixed(1)}) confidence: ${matchResults.confidence.toFixed(3)}`,
        );

        return {
          success: true,
          position: globalMatch,
          confidence: matchResults.confidence,
          scale: matchResults.scale,
          method: 'template_matching',
        };
      }
      return { success: false, reason: 'Template match below threshold' };
    } catch (error) {
      logger.error('AnchorPersistenceSystem', 'Recovery error:', error);
      return { success: false, reason: 'Recovery exception: ' + error.message };
    } finally {
      if (searchRoi?.roi) {
        searchRoi.roi.delete();
      }
    }
  }

  _multiScaleTemplateMatch(cv, searchImage, template, options = {}) {
    const scales = this._getTemplateScales(options);
    let bestMatch = { confidence: 0, location: null, scale: 1.0 };

    for (const scale of scales) {
      const scaledTemplate = new cv.Mat();
      let result = null;
      try {
        const newSize = new cv.Size(Math.round(template.cols * scale), Math.round(template.rows * scale));

        cv.resize(template, scaledTemplate, newSize, 0, 0, cv.INTER_LINEAR);

        if (scaledTemplate.cols > searchImage.cols || scaledTemplate.rows > searchImage.rows) {
          continue;
        }

        result = new cv.Mat();
        cv.matchTemplate(searchImage, scaledTemplate, result, cv.TM_CCOEFF_NORMED);

        const minMaxLoc = cv.minMaxLoc(result);
        const confidence = minMaxLoc.maxVal;

        if (confidence > bestMatch.confidence && confidence > this.correlationThreshold) {
          bestMatch = {
            confidence,
            location: minMaxLoc.maxLoc,
            scale,
          };
        }
      } finally {
        scaledTemplate.delete();
        if (result) {
          result.delete();
        }
      }
    }

    return {
      success: bestMatch.confidence > this.correlationThreshold,
      ...bestMatch,
    };
  }

  _getTemplateScales() {
    return [0.8, 0.9, 1.0, 1.1, 1.2];
  }

  _extractSearchROI(cv, image, center) {
    const searchRadius = Math.min(
      this.maxSearchRadius,
      Math.max(this.templateRegion.width, this.templateRegion.height) * 2,
    );

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
        roi,
        offset: { x: x1, y: y1 },
      };
    } catch (error) {
      logger.error('AnchorPersistenceSystem', 'Error extracting search ROI:', error);
      return { roi: null, offset: { x: 0, y: 0 } };
    }
  }

  _getTemplateCenter(region) {
    return {
      x: region.x + region.width / 2,
      y: region.y + region.height / 2,
    };
  }

  _matchLocationToAnchorPosition(matchLocation, searchOffset, scale = 1) {
    const matchCenter = {
      x: searchOffset.x + matchLocation.x + (this.templateRegion.width * scale) / 2,
      y: searchOffset.y + matchLocation.y + (this.templateRegion.height * scale) / 2,
    };

    return {
      x: matchCenter.x + this.anchorOffset.x * scale,
      y: matchCenter.y + this.anchorOffset.y * scale,
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
    this.initialized = false;

    logger.info('AnchorPersistenceSystem', 'Disposed');
  }
}
