/* global cv */

// Message-based logger for worker context - forwards to main thread
const log = {
  info: (tag, ...args) => postMessage({ type: 'log', level: 'info', tag, args }),
  error: (tag, ...args) => postMessage({ type: 'log', level: 'error', tag, args }),
  warn: (tag, ...args) => postMessage({ type: 'log', level: 'warn', tag, args })
};

let cvLoaded = false;

// Load the normal estimation functions directly in the worker
// Since we can't import ES modules, we'll inline the essential functions

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'initialize' || type === 'load') {
    try {
      log.info('NormalWorker', 'Loading OpenCV.js');
      
      // Set up Module object BEFORE loading OpenCV.js
      self.Module = {
        onRuntimeInitialized: () => {
          cvLoaded = true;
          log.info('NormalWorker', 'OpenCV.js runtime initialized');
          self.postMessage({ type: 'ready' });
        }
      };
      
      // Load OpenCV.js with proper error handling
      const response = await fetch('/opencv.js');
      const code = await response.text();
      
      // Create a function to evaluate the code with proper scope
      const loadOpenCV = new Function('Module', code);
      loadOpenCV(self.Module);
      
    } catch (err) {
      log.error('NormalWorker', 'Initialization failed:', err);
      self.postMessage({ type: 'error', message: 'Initialization failed: ' + err.message });
    }
    return;
  }

  if (type === 'estimateNormal') {
    if (!cvLoaded || !cv) {
      self.postMessage({ type: 'error', message: 'OpenCV not loaded' });
      return;
    }
    
    try {
      const imageData = {
        data: new Uint8ClampedArray(e.data.imageData.data),
        width: e.data.imageData.width,
        height: e.data.imageData.height
      };
      
      log.info('NormalWorker', 'Starting normal estimation for bbox:', e.data.bbox);
      const result = estimateNormal(imageData, e.data.bbox);
      
      if (result) {
        log.info('NormalWorker', 'Normal estimation successful:', result);
        self.postMessage({ 
          type: 'normal', 
          normal: result.normal_camSpace,
          confidence: result.confidence,
          method: result.method
        });
      } else {
        log.info('NormalWorker', 'No normal estimation result');
        self.postMessage({ type: 'no_result' });
      }
    } catch (err) {
      log.error('NormalWorker', 'Normal estimation error:', err);
      self.postMessage({ type: 'error', message: 'Normal estimation failed: ' + err.message });
    }
  }
};

function estimateNormal(imageData, bbox) {
  try {
    const roi = extractROI(imageData, bbox);
    if (!roi) return null;

    const gray = new cv.Mat();
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);

    // Try cylindrical approach for bottles/cans
    const result = estimateCylindricalNormal(gray);
    
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
        method: 'cylindrical'
      };
    }
    
    return null;
  } catch (err) {
    console.error('[NormalWorker] Normal estimation error:', err);
    return null;
  }
}

function extractROI(imageData, bbox) {
  const width = imageData.width;
  const height = imageData.height;
  const inflation = 0.15;
  
  const roiWidth = bbox.x2 - bbox.x1;
  const roiHeight = bbox.y2 - bbox.y1;
  
  const inflatedBbox = {
    x1: Math.max(0, bbox.x1 - roiWidth * inflation),
    y1: Math.max(0, bbox.y1 - roiHeight * inflation),
    x2: Math.min(width, bbox.x2 + roiWidth * inflation),
    y2: Math.min(height, bbox.y2 + roiHeight * inflation)
  };
  
  if (inflatedBbox.x1 >= inflatedBbox.x2 || inflatedBbox.y1 >= inflatedBbox.y2) {
    return null;
  }
  
  const mat = cv.matFromImageData(imageData);
  const rect = new cv.Rect(inflatedBbox.x1, inflatedBbox.y1, 
                          inflatedBbox.x2 - inflatedBbox.x1, 
                          inflatedBbox.y2 - inflatedBbox.y1);
  const roi = mat.roi(rect);
  mat.delete();
  
  return roi;
}

function estimateCylindricalNormal(grayMat) {
  try {
    const edges = new cv.Mat();
    cv.Canny(grayMat, edges, 50, 100);
    
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    
    let bestResult = null;
    let bestScore = 0;
    
    for (let i = 0; i < contours.size(); ++i) {
      const contour = contours.get(i);
      
      if (contour.rows < 5) {
        contour.delete();
        continue;
      }
      
      const ellipse = cv.fitEllipse(contour);
      const area = Math.PI * (ellipse.size.width / 2) * (ellipse.size.height / 2);
      const imageArea = grayMat.rows * grayMat.cols;
      const areaRatio = area / imageArea;
      const aspectRatio = Math.min(ellipse.size.width, ellipse.size.height) / 
                         Math.max(ellipse.size.width, ellipse.size.height);
      
      if (aspectRatio >= 0.35 && areaRatio >= 0.015 && areaRatio <= 0.25) {
        const score = aspectRatio * areaRatio;
        if (score > bestScore) {
          bestScore = score;
          
          const tilt = Math.acos(aspectRatio);
          const angle = ellipse.angle * (Math.PI / 180);
          
          bestResult = {
            normal: {
              x: Math.sin(tilt) * Math.cos(angle),
              y: Math.sin(tilt) * Math.sin(angle), 
              z: Math.cos(tilt)
            },
            score: score
          };
        }
      }
      
      contour.delete();
    }
    
    edges.delete();
    contours.delete();
    hierarchy.delete();
    
    return bestResult;
  } catch (err) {
    log.error('NormalWorker', 'Cylindrical estimation error:', err);
    return null;
  }
}