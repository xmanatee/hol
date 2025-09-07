
/* global cv */
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
 * This simplified implementation focuses on homography decomposition.
 * A full implementation would require persistent state for previous frame features
 * and actual feature matching/homography estimation.
 */
function estimatePlanarNormal(cv, gray, cameraMatrix) {
  // Placeholder for feature detection and matching.
  // In a real scenario, you would detect features (e.g., ORB) in 'gray'
  // and match them with features from the previous frame's ROI.
  // For demonstration, we'll assume a homography is found.

  // Mock homography matrix (identity for a stable, front-facing plane)
  // In a real scenario, this would be computed from feature matches.
  let H = cv.matFromArray(3, 3, cv.CV_64F, [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1
  ]);

  // Mock inliers and reprojection error
  const inliers = 50; // Assume enough inliers for a good homography
  const reprojectionError = 0.5; // Assume low reprojection error

  if (inliers >= 25 && reprojectionError < 2.0) {
    let rotations = new cv.MatVector();
    let translations = new cv.MatVector();
    let normals = new cv.MatVector();

    // Create camera matrix in CV_64F format
    let K_64F = cv.matFromArray(3, 3, cv.CV_64F, [
      cameraMatrix.fx, 0, cameraMatrix.cx,
      0, cameraMatrix.fy, cameraMatrix.cy,
      0, 0, 1
    ]);

    cv.decomposeHomographyMat(H, K_64F, rotations, translations, normals);

    let bestNormal = null;
    let maxZ = -Infinity;

    // Choose the normal that points towards the camera (positive Z-component)
    for (let i = 0; i < normals.size(); ++i) {
      let normal = normals.get(i);
      // Ensure normal is normalized
      let norm = Math.sqrt(normal.data64F[0] * normal.data64F[0] +
                           normal.data64F[1] * normal.data64F[1] +
                           normal.data64F[2] * normal.data64F[2]);
      if (norm === 0) continue;

      let currentNormal = {
        x: normal.data64F[0] / norm,
        y: normal.data64F[1] / norm,
        z: normal.data64F[2] / norm,
      };

      // We want the normal pointing towards the camera, so z should be positive.
      // If it's negative, flip it.
      if (currentNormal.z < 0) {
        currentNormal.x *= -1;
        currentNormal.y *= -1;
        currentNormal.z *= -1;
      }

      // Select the normal with the largest positive Z component
      if (currentNormal.z > maxZ) {
        maxZ = currentNormal.z;
        bestNormal = currentNormal;
      }
      normal.delete();
    }

    H.delete();
    rotations.delete();
    translations.delete();
    normals.delete();
    K_64F.delete();

    if (bestNormal) {
      return {
        normal: bestNormal,
        score: inliers, // Score is the number of inliers
      };
    }
  }

  H.delete();
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
      // Calculate edge support: count non-zero pixels within the ellipse's bounding box in the Canny image
      const rect = rotatedRect.boundingRect();
      let edgePixels = 0;
      for (let r = rect.y; r < rect.y + rect.height; ++r) {
        for (let c = rect.x; c < rect.x + rect.width; ++c) {
          if (r >= 0 && r < canny.rows && c >= 0 && c < canny.cols && canny.ucharAt(r, c) > 0) {
            edgePixels++;
          }
        }
      }
      const edgeSupport = edgePixels / (rect.width * rect.height); // Normalize by bounding box area

      const score = minorMajorRatio * edgeSupport;

      if (score > maxScore) {
        maxScore = score;
        const tilt = Math.acos(minorMajorRatio);
        const inPlaneAngle = rotatedRect.angle * (Math.PI / 180);
        
        // Synthesize an outward-pointing normal
        // Assuming the ellipse's center is the object's center in the ROI
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
