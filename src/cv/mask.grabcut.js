
// src/cv/mask.grabcut.js

import { logger } from '../utils/logger.js';

class MaskService {
  constructor() {
    this.isCvReady = false;
    this.mask = null; // OpenCV Mat for the mask
    this.bgdModel = null; // OpenCV Mat for background model
    this.fgdModel = null; // OpenCV Mat for foreground model
    this.prevBox = null; // Previous bounding box for affine transform
    this.prevMask = null; // Previous mask for IoU calculation and warping

    // Check if OpenCV.js is already loaded
    if (typeof cv !== 'undefined' && cv.Mat) {
      this.isCvReady = true;
    } else {
      // If not, assume it will be loaded globally later.
      // In a real app, you might want a more robust loading mechanism.
      logger.warn('MaskService', 'OpenCV.js (cv) not found. MaskService will wait for it.');
    }
  }

  /**
   * Initializes GrabCut with an initial bounding box and ROI.
   * @param {cv.Mat} image The source image (e.g., from camera feed).
   * @param {object} box The bounding box {x, y, width, height} of the detected object.
   * @returns {boolean} True if initialization was successful.
   */
  initGrabCut(image, box) {
    if (!this.isCvReady) {
      logger.error('MaskService', 'OpenCV.js is not ready.');
      return false;
    }

    this.disposeMats(); // Dispose previous mats if any

    const rect = new cv.Rect(box.x, box.y, box.width, box.height);
    this.mask = new cv.Mat(image.rows, image.cols, cv.CV_8UC1, new cv.Scalar(cv.GC_BGD));
    this.bgdModel = new cv.Mat();
    this.fgdModel = new cv.Mat();

    // Define initial foreground (inner 70% of ROI) and background (outside ROI)
    // For simplicity, let's use GC_INIT_WITH_RECT for initial setup.
    // A more advanced approach would involve drawing initial foreground/background.
    try {
      cv.grabCut(image, this.mask, rect, this.bgdModel, this.fgdModel, 1, cv.GC_INIT_WITH_RECT);
      this.prevBox = { ...box };
      this.prevMask = this.mask.clone(); // Store initial mask for warping
      return true;
    } catch (e) {
      logger.error('MaskService', 'Error initializing GrabCut:', e);
      this.disposeMats();
      return false;
    }
  }

  /**
   * Refines the GrabCut mask for the current frame.
   * @param {cv.Mat} image The current frame image.
   * @param {object} currentBox The current bounding box.
   * @returns {cv.Mat|null} The refined mask or null if an error occurs.
   */
  refineGrabCut(image, currentBox) {
    if (!this.isCvReady || !this.mask || !this.bgdModel || !this.fgdModel) {
      logger.error('MaskService', 'GrabCut not initialized or OpenCV.js not ready.');
      return null;
    }

    try {
      // Calculate affine transform from prevBox to currentBox
      // This is a simplified affine transform (translation + scale)
      let M = cv.Mat.zeros(2, 3, cv.CV_64FC1);
      if (this.prevBox) {
        const scaleX = currentBox.width / this.prevBox.width;
        const scaleY = currentBox.height / this.prevBox.height;
        const translateX = currentBox.x - this.prevBox.x * scaleX;
        const translateY = currentBox.y - this.prevBox.y * scaleY;

        M.data64F[0] = scaleX;
        M.data64F[1] = 0;
        M.data64F[2] = translateX;
        M.data64F[3] = 0;
        M.data64F[4] = scaleY;
        M.data64F[5] = translateY;

        // Warp previous mask
        let warpedMask = new cv.Mat();
        cv.warpAffine(this.prevMask, warpedMask, M, image.size(), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
        this.mask.delete(); // Dispose old mask
        this.mask = warpedMask; // Use warped mask as initial for refinement
      }

      const rect = new cv.Rect(currentBox.x, currentBox.y, currentBox.width, currentBox.height);
      cv.grabCut(image, this.mask, rect, this.bgdModel, this.fgdModel, 1, cv.GC_EVAL);

      // Update prevBox and prevMask for next frame
      this.prevBox = { ...currentBox };
      this.prevMask = this.mask.clone();

      return this.mask;
    } catch (e) {
      logger.error('MaskService', 'Error refining GrabCut:', e);
      return null;
    }
  }

  /**
   * Creates a feathered alpha mask from the GrabCut result.
   * @param {cv.Mat} grabCutMask The mask obtained from GrabCut (CV_8UC1).
   * @param {number} width The desired width of the output mask.
   * @param {number} height The desired height of the output mask.
   * @returns {HTMLCanvasElement|null} A canvas containing the feathered alpha mask.
   */
  createFeatheredMask(grabCutMask, width, height) {
    if (!this.isCvReady || !grabCutMask) {
      logger.error('MaskService', 'OpenCV.js not ready or grabCutMask is null.');
      return null;
    }

    let displayMask = new cv.Mat();
    // Convert GC_FGD and GC_PR_FGD to 255 (foreground), others to 0 (background)
    cv.compare(grabCutMask, cv.GC_FGD, displayMask, cv.CMP_EQ);
    let prFgdMask = new cv.Mat();
    cv.compare(grabCutMask, cv.GC_PR_FGD, prFgdMask, cv.CMP_EQ);
    cv.bitwise_or(displayMask, prFgdMask, displayMask);
    prFgdMask.delete();

    // Dilate and blur for feathering
    let kernel = cv.Mat.ones(5, 5, cv.CV_8U); // 5x5 kernel for dilation
    cv.dilate(displayMask, displayMask, kernel);
    cv.GaussianBlur(displayMask, displayMask, new cv.Size(15, 15), 0, 0, cv.BORDER_DEFAULT); // Adjust kernel size for desired blur

    // Resize to desired output dimensions
    let resizedMask = new cv.Mat();
    cv.resize(displayMask, resizedMask, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      logger.error('MaskService', 'Could not get 2D context for canvas.');
      displayMask.delete();
      resizedMask.delete();
      kernel.delete();
      return null;
    }

    // Create an ImageData object with alpha channel
    let imgData = ctx.createImageData(width, height);
    for (let i = 0; i < resizedMask.rows; ++i) {
      for (let j = 0; j < resizedMask.cols; ++j) {
        // Use the single channel mask value as the alpha value
        let pixelValue = resizedMask.ucharAt(i, j);
        let idx = (i * resizedMask.cols + j) * 4;
        imgData.data[idx + 0] = 0; // Red (can be anything, won't be visible)
        imgData.data[idx + 1] = 0; // Green
        imgData.data[idx + 2] = 0; // Blue
        imgData.data[idx + 3] = pixelValue; // Alpha channel from mask
      }
    }
    ctx.putImageData(imgData, 0, 0);

    displayMask.delete();
    resizedMask.delete();
    kernel.delete();

    return canvas;
  }

  /**
   * Generates an elliptical SDF mask as a fallback.
   * @param {object} box The bounding box {x, y, width, height}.
   * @param {number} outputWidth The desired width of the output mask.
   * @param {number} outputHeight The desired height of the output mask.
   * @returns {HTMLCanvasElement} A canvas containing the elliptical SDF mask.
   */
  createEllipticalSDFMask(box, outputWidth, outputHeight) {
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      logger.error('MaskService', 'Could not get 2D context for canvas.');
      return canvas; // Return empty canvas
    }

    ctx.clearRect(0, 0, outputWidth, outputHeight);

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const radiusX = box.width / 2;
    const radiusY = box.height / 2;

    // Create a gradient that simulates SDF
    const gradient = ctx.createRadialGradient(
      centerX, centerY, Math.min(radiusX, radiusY) * 0.7, // Inner radius for solid part
      centerX, centerY, Math.max(radiusX, radiusY) * 1.1 // Outer radius for fade
    );
    gradient.addColorStop(0, 'rgba(0, 0, 0, 1)'); // Solid inside
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)'); // Transparent outside

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI);
    ctx.fill();

    return canvas;
  }

  /**
   * Calculates the Intersection over Union (IoU) between two masks.
   * @param {cv.Mat} mask1 The first mask (CV_8UC1).
   * @param {cv.Mat} mask2 The second mask (CV_8UC1).
   * @returns {number} The IoU value (0 to 1).
   */
  calculateIoU(mask1, mask2) {
    if (!this.isCvReady || !mask1 || !mask2 || mask1.empty() || mask2.empty()) {
      logger.error('MaskService', 'OpenCV.js not ready or masks are invalid for IoU calculation.');
      return 0;
    }

    let intersection = new cv.Mat();
    let union = new cv.Mat();

    // Ensure masks are binary (0 or 255) for IoU calculation
    let binaryMask1 = new cv.Mat();
    let binaryMask2 = new cv.Mat();
    cv.threshold(mask1, binaryMask1, 1, 255, cv.THRESH_BINARY);
    cv.threshold(mask2, binaryMask2, 1, 255, cv.THRESH_BINARY);

    cv.bitwise_and(binaryMask1, binaryMask2, intersection);
    cv.bitwise_or(binaryMask1, binaryMask2, union);

    const intersectionArea = cv.countNonZero(intersection);
    const unionArea = cv.countNonZero(union);

    intersection.delete();
    union.delete();
    binaryMask1.delete();
    binaryMask2.delete();

    if (unionArea === 0) {
      return 1; // Both masks are empty, consider it 100% overlap
    }
    return intersectionArea / unionArea;
  }

  /**
   * Disposes of OpenCV Mat objects to prevent memory leaks.
   */
  disposeMats() {
    if (this.mask) {
      this.mask.delete();
      this.mask = null;
    }
    if (this.bgdModel) {
      this.bgdModel.delete();
      this.bgdModel = null;
    }
    if (this.fgdModel) {
      this.fgdModel.delete();
      this.fgdModel = null;
    }
    if (this.prevMask) {
      this.prevMask.delete();
      this.prevMask = null;
    }
  }

  /**
   * Sets the OpenCV.js ready state. Call this after opencv.js is loaded.
   */
  setCvReady() {
    this.isCvReady = true;
    logger.info('MaskService', 'OpenCV.js is now ready for MaskService.');
  }
}

// Export an instance of the service
export const maskService = new MaskService();

// Listen for opencv.js load event if it's loaded asynchronously
// This assumes opencv.js sets a global 'cv' object and potentially dispatches an event.
// A more robust solution might involve a promise-based loader.
document.addEventListener('opencv_ready', () => {
  maskService.setCvReady();
});

// Fallback for when opencv.js is already loaded before the event listener is attached
if (typeof cv !== 'undefined' && cv.Mat && !maskService.isCvReady) {
  maskService.setCvReady();
}
