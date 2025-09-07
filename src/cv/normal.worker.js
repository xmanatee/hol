/* global importScripts, cv */

let cvLoaded = false;

// Load the normal estimation functions directly in the worker
// Since we can't import ES modules, we'll inline the essential functions

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'load') {
    try {
      // Load OpenCV.js from local file (more reliable than CDN)
      console.log('[NormalWorker] Loading OpenCV.js from local file');
      importScripts('/opencv.js');
      
      // Wait for OpenCV to initialize
      if (typeof cv !== 'undefined') {
        cv.onRuntimeInitialized = () => {
          cvLoaded = true;
          self.postMessage({ type: 'loaded' });
        };
      } else {
        // Wait for cv to be available
        const checkCV = () => {
          if (typeof cv !== 'undefined') {
            cv.onRuntimeInitialized = () => {
              cvLoaded = true;
              self.postMessage({ type: 'loaded' });
            };
          } else {
            setTimeout(checkCV, 100);
          }
        };
        checkCV();
      }
      
    } catch (err) {
      console.error('[NormalWorker] OpenCV loading failed:', err);
      self.postMessage({ type: 'error', message: 'Failed to load OpenCV: ' + err.message });
    }
    return;
  }

  if (type === 'estimate') {
    if (!cvLoaded || !cv) {
      self.postMessage({ type: 'error', message: 'OpenCV not loaded' });
      return;
    }
    
    try {
      // Convert array back to ImageData-like object
      const imageData = {
        data: new Uint8ClampedArray(payload.imageData.data),
        width: payload.imageData.width,
        height: payload.imageData.height
      };
      
      console.log('[NormalWorker] Starting normal estimation for bbox:', payload.bbox);
      const result = estimateNormalSimple(imageData, payload.bbox, payload.cameraMatrix);
      
      if (result) {
        console.log('[NormalWorker] Normal estimation successful:', result);
        self.postMessage({ type: 'result', payload: result });
      } else {
        console.log('[NormalWorker] No normal estimation result');
        self.postMessage({ type: 'no_result' });
      }
    } catch (err) {
      console.error('[NormalWorker] Normal estimation error:', err);
      self.postMessage({ type: 'error', message: 'Normal estimation failed: ' + err.message });
    }
  }
};

// Simplified normal estimation function (inlined to avoid ES module issues)
function estimateNormalSimple(imageData, bbox, cameraMatrix) {
  try {
    // Extract ROI with 15% inflation
    const roi = getROI(imageData, bbox);
    if (!roi) return null;

    const gray = new cv.Mat();
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);

    // Try cylindrical approach (simpler and more reliable)
    const result = estimateCylindricalNormalSimple(gray);
    
    gray.delete();
    roi.delete();
    
    if (result) {
      return {
        position_px: { 
          x: bbox.x1 + (bbox.x2 - bbox.x1) / 2, 
          y: bbox.y1 + (bbox.y2 - bbox.y1) / 2 
        },
        normal_camSpace: result.normal,
        confidence: result.score,
      };
    }
    
    return null;
  } catch (err) {
    console.error('[NormalWorker] Normal estimation error:', err);
    return null;
  }
}

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
  const rect = new cv.Rect(
    inflatedBbox.x1, 
    inflatedBbox.y1, 
    inflatedBbox.x2 - inflatedBbox.x1, 
    inflatedBbox.y2 - inflatedBbox.y1
  );
  const roi = src.roi(rect);
  src.delete();
  return roi;
}

function estimateCylindricalNormalSimple(gray) {
  try {
    const canny = new cv.Mat();
    cv.Canny(gray, canny, 50, 100);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(canny, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestResult = null;
    let maxScore = 0;

    for (let i = 0; i < contours.size(); ++i) {
      const contour = contours.get(i);
      if (contour.rows < 5) {
        contour.delete();
        continue;
      }

      const rotatedRect = cv.fitEllipse(contour);
      const ellipseArea = Math.PI * (rotatedRect.size.width / 2) * (rotatedRect.size.height / 2);
      const roiArea = gray.rows * gray.cols;

      const minorMajorRatio = Math.min(rotatedRect.size.width, rotatedRect.size.height) / 
                             Math.max(rotatedRect.size.width, rotatedRect.size.height);
      const areaRatio = ellipseArea / roiArea;

      if (minorMajorRatio >= 0.35 && areaRatio >= 0.015 && areaRatio <= 0.25) {
        const score = minorMajorRatio * areaRatio;

        if (score > maxScore) {
          maxScore = score;
          const tilt = Math.acos(minorMajorRatio);
          const inPlaneAngle = rotatedRect.angle * (Math.PI / 180);
          
          bestResult = {
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

    return bestResult;
  } catch (err) {
    console.error('[NormalWorker] Cylindrical estimation error:', err);
    return null;
  }
}
