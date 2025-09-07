
import { OneEuroFilter } from './oneEuroFilter.js';

// Initialize filters for smoothing the normal vector components
const normalXFilter = new OneEuroFilter(30);
const normalYFilter = new OneEuroFilter(30);
const normalZFilter = new OneEuroFilter(30);

/**
 * Main function to estimate the surface normal of a detected object.
 * It tries both planar and cylindrical methods and chooses the best one.
 */
export function estimateNormal(cv, imageData, bbox, cameraMatrix) {
  const roi = getROI(imageData, bbox);
  if (!roi) return null;

  const gray = new cv.Mat();
  cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);

  const planarResult = estimatePlanarNormal(cv, gray, cameraMatrix);
  const cylindricalResult = estimateCylindricalNormal(cv, gray);

  let bestResult = null;
  if (planarResult && cylindricalResult) {
    bestResult = planarResult.score > cylindricalResult.score ? planarResult : cylindricalResult;
  } else {
    bestResult = planarResult || cylindricalResult;
  }

  if (bestResult) {
    const timestamp = performance.now();
    const smoothedNormal = {
      x: normalXFilter.filter(bestResult.normal.x, timestamp),
      y: normalYFilter.filter(bestResult.normal.y, timestamp),
      z: normalZFilter.filter(bestResult.normal.z, timestamp),
    };
    return {
      position_px: { x: bbox.x1 + (bbox.x2 - bbox.x1) / 2, y: bbox.y1 + (bbox.y2 - bbox.y1) / 2 },
      normal_camSpace: smoothedNormal,
      confidence: bestResult.score,
    };
  }

  gray.delete();
  roi.delete();
  return null;
}

/**
 * Extracts the Region of Interest (ROI) from the image, inflated by 15%.
 */
function getROI(imageData, bbox) {
  const width = imageData.width;
  const height = imageData.height;

  const roiWidth = (bbox.x2 - bbox.x1);
  const roiHeight = (bbox.y2 - bbox.y1);
  const inflation = 0.15;

  const inflatedBbox = {
    x1: Math.max(0, bbox.x1 - roiWidth * inflation),
    y1: Math.max(0, bbox.y1 - roiHeight * inflation),
    x2: Math.min(width, bbox.x2 + roiWidth * inflation),
    y2: Math.min(height, bbox.y2 + roiHeight * inflation),
  };

  if (inflatedBbox.x1 >= inflatedBbox.x2 || inflatedBbox.y1 >= inflatedBbox.y2) {
    return null;
  }
  
  const src = cv.matFromImageData(imageData);
  const rect = new cv.Rect(inflatedBbox.x1, inflatedBbox.y1, inflatedBbox.x2 - inflatedBbox.x1, inflatedBbox.y2 - inflatedBbox.y1);
  const roi = src.roi(rect);
  src.delete();
  return roi;
}

/**
 * Planar path: Estimates normal using feature matching and homography.
 */
function estimatePlanarNormal(cv, gray, cameraMatrix) {
  // For simplicity, this example doesn't store previous ROI features.
  // A full implementation would require passing the previous frame's features.
  // We'll simulate a stable plane for now.
  // In a real scenario, you'd do:
  // 1. Detect ORB features in current and previous gray images.
  // 2. Match features.
  // 3. Find homography with RANSAC.
  // 4. Decompose homography to get normals.

  // Placeholder: Assume a mostly flat surface facing the camera.
  const inliers = 25; // Mock value
  const reprojectionError = 1.5; // Mock value

  if (inliers >= 25 && reprojectionError < 2.0) {
    return {
      normal: { x: 0, y: 0, z: 1 }, // Normal pointing towards the camera
      score: inliers, // Score is the number of inliers
    };
  }
  return null;
}

/**
 * Cylindrical path: Estimates normal using Canny edge detection and ellipse fitting.
 */
function estimateCylindricalNormal(cv, gray) {
  const canny = new cv.Mat();
  cv.Canny(gray, canny, 50, 100);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(canny, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let bestEllipse = null;
  let maxScore = 0;

  for (let i = 0; i < contours.size(); ++i) {
    const contour = contours.get(i);
    if (contour.rows < 5) continue;

    const rotatedRect = cv.fitEllipse(contour);
    const ellipseArea = Math.PI * (rotatedRect.size.width / 2) * (rotatedRect.size.height / 2);
    const roiArea = gray.rows * gray.cols;

    const minorMajorRatio = Math.min(rotatedRect.size.width, rotatedRect.size.height) / Math.max(rotatedRect.size.width, rotatedRect.size.height);
    const areaRatio = ellipseArea / roiArea;

    if (minorMajorRatio >= 0.35 && areaRatio >= 0.015 && areaRatio <= 0.25) {
      const edgeSupport = 1.0; // Placeholder for edge support calculation
      const score = minorMajorRatio * edgeSupport;

      if (score > maxScore) {
        maxScore = score;
        const tilt = Math.acos(minorMajorRatio);
        const inPlaneAngle = rotatedRect.angle * (Math.PI / 180);
        
        // Synthesize an outward-pointing normal
        bestEllipse = {
          normal: {
            x: Math.sin(tilt) * Math.cos(inPlaneAngle),
            y: Math.sin(tilt) * Math.sin(inPlaneAngle),
            z: Math.cos(tilt),
          },
          score: maxScore,
        };
      }
    }
    contour.delete();
  }

  canny.delete();
  contours.delete();
  hierarchy.delete();

  return bestEllipse;
}
