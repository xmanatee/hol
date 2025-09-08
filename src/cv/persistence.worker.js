/* global cv */

// Message-based logger for worker context - forwards to main thread
const log = {
  info: (tag, ...args) => postMessage({ type: 'log', level: 'info', tag, args }),
  error: (tag, ...args) => postMessage({ type: 'log', level: 'error', tag, args }),
  warn: (tag, ...args) => postMessage({ type: 'log', level: 'warn', tag, args })
};

let cvLoaded = false;

// Persistence-specific constants
const FLOW_POINTS_COUNT = 80;
const MIN_FLOW_POINTS = 35;
const MIN_ORB_INLIERS = 30;
const FLOW_ERROR_THRESHOLD = 10.0;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'initialize') {
    try {
      log.info('PersistenceWorker', 'Loading OpenCV.js');
      
      // Set up Module object BEFORE loading OpenCV.js
      self.Module = {
        onRuntimeInitialized: () => {
          cvLoaded = true;
          log.info('PersistenceWorker', 'OpenCV.js runtime initialized');
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
      log.error('PersistenceWorker', 'Initialization failed:', err);
      self.postMessage({ type: 'error', message: 'Initialization failed: ' + err.message });
    }
    return;
  }

  if (!cvLoaded || !cv) {
    self.postMessage({ type: 'error', message: 'OpenCV not loaded' });
    return;
  }

  try {
    switch (type) {
      case 'initializeROI':
        handleInitializeROI(e.data);
        break;
      case 'updateOpticalFlow':
        handleUpdateOpticalFlow(e.data);
        break;
      case 'extractTemplate':
        handleExtractTemplate(e.data);
        break;
      case 'attemptReacquisition':
        handleAttemptReacquisition(e.data);
        break;
      default:
        log.warn('PersistenceWorker', 'Unknown message type:', type);
    }
  } catch (err) {
    log.error('PersistenceWorker', 'Operation failed:', err);
    self.postMessage({ type: 'error', message: 'Operation failed: ' + err.message });
  }
};

function handleInitializeROI({ trackId, imageData, bbox }) {
  try {
    log.info('PersistenceWorker', 'Initializing ROI for track', trackId);
    
    const mat = cv.matFromImageData(convertImageData(imageData));
    const gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

    // Define ROI
    const roi = new cv.Rect(
      Math.max(0, Math.floor(bbox.x1)),
      Math.max(0, Math.floor(bbox.y1)),
      Math.min(mat.cols, Math.floor(bbox.x2 - bbox.x1)),
      Math.min(mat.rows, Math.floor(bbox.y2 - bbox.y1))
    );

    const roiGray = gray.roi(roi);
    
    // Detect Shi-Tomasi corners
    const corners = new cv.Mat();
    cv.goodFeaturesToTrack(
      roiGray,
      corners,
      FLOW_POINTS_COUNT,
      0.01,    // quality level
      10,      // min distance
      new cv.Mat(),
      3,       // block size
      false,   // use Harris detector
      0.04     // Harris parameter
    );

    // Convert to global coordinates
    const points = [];
    for (let i = 0; i < corners.rows; i++) {
      const point = corners.data32F.slice(i * 2, (i + 1) * 2);
      points.push([
        point[0] + roi.x,
        point[1] + roi.y
      ]);
    }

    log.info('PersistenceWorker', `Initialized ${points.length} flow points for track ${trackId}`);

    // Cleanup
    corners.delete();
    roiGray.delete();
    gray.delete();
    mat.delete();

    self.postMessage({
      type: 'roiInitialized',
      trackId,
      flowPoints: points,
      roiBounds: bbox
    });
  } catch (error) {
    log.error('PersistenceWorker', 'ROI initialization failed:', error);
    self.postMessage({ type: 'error', message: 'ROI initialization failed: ' + error.message });
  }
}

function handleUpdateOpticalFlow({ trackId, prevImageData, currImageData, flowPoints }) {
  try {
    log.info('PersistenceWorker', `Updating optical flow for track ${trackId} with ${flowPoints.length} points`);
    
    const prevMat = cv.matFromImageData(convertImageData(prevImageData));
    const currMat = cv.matFromImageData(convertImageData(currImageData));
    
    const prevGray = new cv.Mat();
    const currGray = new cv.Mat();
    
    cv.cvtColor(prevMat, prevGray, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(currMat, currGray, cv.COLOR_RGBA2GRAY);

    // Convert points to OpenCV format
    const prevPts = new cv.Mat(flowPoints.length, 1, cv.CV_32FC2);
    for (let i = 0; i < flowPoints.length; i++) {
      prevPts.data32F[i * 2] = flowPoints[i][0];
      prevPts.data32F[i * 2 + 1] = flowPoints[i][1];
    }

    const nextPts = new cv.Mat();
    const status = new cv.Mat();
    const error = new cv.Mat();

    // Calculate optical flow
    cv.calcOpticalFlowPyrLK(
      prevGray,
      currGray,
      prevPts,
      nextPts,
      status,
      error,
      new cv.Size(15, 15), // window size
      3,  // max pyramid level
      new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01)
    );

    // Filter good points
    const goodPoints = [];
    for (let i = 0; i < status.rows; i++) {
      if (status.data[i] === 1 && error.data32F[i] < FLOW_ERROR_THRESHOLD) {
        goodPoints.push([
          nextPts.data32F[i * 2],
          nextPts.data32F[i * 2 + 1]
        ]);
      }
    }

    log.info('PersistenceWorker', `Flow updated: ${goodPoints.length}/${flowPoints.length} points tracked`);

    // Cleanup
    prevPts.delete();
    nextPts.delete();
    status.delete();
    error.delete();
    prevGray.delete();
    currGray.delete();
    prevMat.delete();
    currMat.delete();

    self.postMessage({
      type: 'flowUpdated',
      trackId,
      flowPoints: goodPoints
    });
  } catch (error) {
    log.error('PersistenceWorker', 'Optical flow update failed:', error);
    self.postMessage({ type: 'error', message: 'Optical flow update failed: ' + error.message });
  }
}

function handleExtractTemplate({ trackId, imageData, bbox }) {
  try {
    log.info('PersistenceWorker', 'Extracting template for track', trackId);
    
    const mat = cv.matFromImageData(convertImageData(imageData));
    const gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

    // Extract template region
    const roi = new cv.Rect(
      Math.max(0, Math.floor(bbox.x1)),
      Math.max(0, Math.floor(bbox.y1)),
      Math.min(mat.cols, Math.floor(bbox.x2 - bbox.x1)),
      Math.min(mat.rows, Math.floor(bbox.y2 - bbox.y1))
    );

    const template = gray.roi(roi).clone();
    
    // Extract ORB features
    const orb = new cv.ORB();
    const keypoints = new cv.KeyPointVector();
    const descriptors = new cv.Mat();
    
    orb.detectAndCompute(template, new cv.Mat(), keypoints, descriptors);
    
    if (descriptors.rows > 0) {
      // Convert keypoints to serializable format
      const keypointData = [];
      for (let i = 0; i < keypoints.size(); i++) {
        const kp = keypoints.get(i);
        keypointData.push({ x: kp.pt.x, y: kp.pt.y });
      }

      // Convert descriptors to array
      const descriptorData = Array.from(descriptors.data);
      
      log.info('PersistenceWorker', `Extracted template with ${descriptors.rows} ORB features for track ${trackId}`);

      self.postMessage({
        type: 'templateExtracted',
        trackId,
        template: {
          keypoints: keypointData,
          descriptors: descriptorData,
          descriptorRows: descriptors.rows,
          descriptorCols: descriptors.cols,
          bbox: bbox
        }
      });
    } else {
      log.warn('PersistenceWorker', `No features found for template extraction of track ${trackId}`);
      self.postMessage({
        type: 'templateExtracted',
        trackId,
        template: null
      });
    }

    // Cleanup
    orb.delete();
    keypoints.delete();
    descriptors.delete();
    template.delete();
    gray.delete();
    mat.delete();
  } catch (error) {
    log.error('PersistenceWorker', 'Template extraction failed:', error);
    self.postMessage({ type: 'error', message: 'Template extraction failed: ' + error.message });
  }
}

function handleAttemptReacquisition({ trackId, currentImageData, template }) {
  try {
    log.info('PersistenceWorker', 'Attempting reacquisition for track', trackId);
    
    if (!template || !template.descriptors) {
      self.postMessage({ type: 'reacquisitionResult', trackId, result: null });
      return;
    }

    const mat = cv.matFromImageData(convertImageData(currentImageData));
    const gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

    // Extract ORB features from current frame
    const orb = new cv.ORB();
    const keypoints = new cv.KeyPointVector();
    const descriptors = new cv.Mat();
    
    orb.detectAndCompute(gray, new cv.Mat(), keypoints, descriptors);

    if (descriptors.rows < 10) {
      log.warn('PersistenceWorker', 'Not enough features in current frame for matching');
      orb.delete();
      keypoints.delete();
      descriptors.delete();
      gray.delete();
      mat.delete();
      self.postMessage({ type: 'reacquisitionResult', trackId, result: null });
      return;
    }

    // Reconstruct template descriptors
    const templateDescriptors = new cv.Mat(
      template.descriptorRows, 
      template.descriptorCols, 
      cv.CV_8U
    );
    templateDescriptors.data.set(new Uint8Array(template.descriptors));

    // Match descriptors
    const matcher = new cv.BFMatcher(cv.NORM_HAMMING, true);
    const matches = new cv.DMatchVector();
    matcher.match(templateDescriptors, descriptors, matches);

    if (matches.size() < MIN_ORB_INLIERS) {
      log.warn('PersistenceWorker', `Not enough matches: ${matches.size()}/${MIN_ORB_INLIERS}`);
      matcher.delete();
      matches.delete();
      templateDescriptors.delete();
      orb.delete();
      keypoints.delete();
      descriptors.delete();
      gray.delete();
      mat.delete();
      self.postMessage({ type: 'reacquisitionResult', trackId, result: null });
      return;
    }

    // Extract good matches and compute homography
    const srcPoints = [];
    const dstPoints = [];
    
    for (let i = 0; i < matches.size(); i++) {
      const match = matches.get(i);
      if (match.distance < 50) { // Distance threshold for good matches
        srcPoints.push([
          template.keypoints[match.queryIdx].x,
          template.keypoints[match.queryIdx].y
        ]);
        
        const kp = keypoints.get(match.trainIdx);
        dstPoints.push([kp.pt.x, kp.pt.y]);
      }
    }

    if (srcPoints.length < MIN_ORB_INLIERS) {
      log.warn('PersistenceWorker', `Not enough good matches: ${srcPoints.length}/${MIN_ORB_INLIERS}`);
      // Cleanup and return null
      matcher.delete();
      matches.delete();
      templateDescriptors.delete();
      orb.delete();
      keypoints.delete();
      descriptors.delete();
      gray.delete();
      mat.delete();
      self.postMessage({ type: 'reacquisitionResult', trackId, result: null });
      return;
    }

    // Compute homography
    const srcMat = cv.matFromArray(srcPoints.length, 1, cv.CV_32FC2, srcPoints.flat());
    const dstMat = cv.matFromArray(dstPoints.length, 1, cv.CV_32FC2, dstPoints.flat());
    
    const homography = cv.findHomography(srcMat, dstMat, cv.RANSAC, 3.0);
    
    if (homography.empty()) {
      log.warn('PersistenceWorker', 'Could not compute homography');
      // Cleanup and return null
      srcMat.delete();
      dstMat.delete();
      homography.delete();
      matcher.delete();
      matches.delete();
      templateDescriptors.delete();
      orb.delete();
      keypoints.delete();
      descriptors.delete();
      gray.delete();
      mat.delete();
      self.postMessage({ type: 'reacquisitionResult', trackId, result: null });
      return;
    }

    // Transform template bbox to current frame
    const templateBbox = template.bbox;
    const corners = [
      [0, 0], // Relative to template
      [templateBbox.x2 - templateBbox.x1, 0],
      [templateBbox.x2 - templateBbox.x1, templateBbox.y2 - templateBbox.y1],
      [0, templateBbox.y2 - templateBbox.y1]
    ];

    const cornersMat = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
    const transformedCorners = new cv.Mat();
    
    cv.perspectiveTransform(cornersMat, transformedCorners, homography);

    // Extract transformed bbox
    const transformedPoints = [];
    for (let i = 0; i < 4; i++) {
      transformedPoints.push([
        transformedCorners.data32F[i * 2],
        transformedCorners.data32F[i * 2 + 1]
      ]);
    }

    const newBbox = {
      x1: Math.min(...transformedPoints.map(p => p[0])),
      y1: Math.min(...transformedPoints.map(p => p[1])),
      x2: Math.max(...transformedPoints.map(p => p[0])),
      y2: Math.max(...transformedPoints.map(p => p[1]))
    };

    log.info('PersistenceWorker', `ORB reacquisition successful for track ${trackId}, inliers: ${srcPoints.length}`);

    // Cleanup
    srcMat.delete();
    dstMat.delete();
    homography.delete();
    cornersMat.delete();
    transformedCorners.delete();
    matcher.delete();
    matches.delete();
    templateDescriptors.delete();
    orb.delete();
    keypoints.delete();
    descriptors.delete();
    gray.delete();
    mat.delete();

    self.postMessage({
      type: 'reacquisitionResult',
      trackId,
      result: {
        ...newBbox,
        confidence: Math.min(0.8, srcPoints.length / 50), // Scale confidence based on matches
        inliers: srcPoints.length
      }
    });
  } catch (error) {
    log.error('PersistenceWorker', 'Reacquisition failed:', error);
    self.postMessage({ type: 'error', message: 'Reacquisition failed: ' + error.message });
  }
}

function convertImageData(imageDataObj) {
  return new ImageData(
    new Uint8ClampedArray(imageDataObj.data),
    imageDataObj.width,
    imageDataObj.height
  );
}