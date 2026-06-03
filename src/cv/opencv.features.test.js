// OpenCV.js Feature Detection Test
// Tests what features are available in the current OpenCV.js build

import { logger } from '../utils/logger.js';

export const testOpenCVFeatures = () => {
  if (typeof window.cv === 'undefined') {
    return { available: false, error: 'OpenCV not loaded' };
  }

  const cv = window.cv;
  const results = {
    available: true,
    version: null,
    features: {},
    missing: [],
    errors: []
  };

  // Test basic features
  const basicFeatures = [
    'Mat',
    'Size',
    'Point',
    'Rect',
    'Scalar',
    'matFromImageData',
    'imshow',
    'imread'
  ];

  basicFeatures.forEach(feature => {
    try {
      results.features[feature] = typeof cv[feature] !== 'undefined';
      if (!results.features[feature]) {
        results.missing.push(feature);
      }
    } catch (error) {
      results.features[feature] = false;
      results.missing.push(feature);
      results.errors.push(`${feature}: ${error.message}`);
    }
  });

  // Test feature detection algorithms
  const featureDetectors = [
    'SIFT',
    'SURF',
    'FAST',
    'BRISK',
    'goodFeaturesToTrack'
  ];

  featureDetectors.forEach(detector => {
    try {
      if (typeof cv[detector] !== 'undefined') {
        if (typeof cv[detector].create === 'function') {
          // Actually try to create instance to verify it works
          try {
            const instance = cv[detector].create();
            results.features[detector] = true;
            instance.delete(); // Clean up
          } catch (createError) {
            // create() method exists but doesn't work
            results.features[detector] = false;
            results.missing.push(detector);
            results.errors.push(`${detector}.create() failed: ${createError.message}`);
          }
        } else {
          results.features[detector] = typeof cv[detector] === 'function';
        }
      } else {
        results.features[detector] = false;
        results.missing.push(detector);
      }
    } catch (error) {
      results.features[detector] = false;
      results.missing.push(detector);
      results.errors.push(`${detector}: ${error.message}`);
    }
  });

  // Test optical flow functions
  const opticalFlowFunctions = [
    'calcOpticalFlowPyrLK',
    'calcOpticalFlowFarneback',
    'goodFeaturesToTrack'
  ];

  opticalFlowFunctions.forEach(func => {
    try {
      results.features[func] = typeof cv[func] === 'function';
      if (!results.features[func]) {
        results.missing.push(func);
      }
    } catch (error) {
      results.features[func] = false;
      results.missing.push(func);
      results.errors.push(`${func}: ${error.message}`);
    }
  });

  // Test homography functions
  const homographyFunctions = [
    'findHomography',
    'perspectiveTransform',
    'warpPerspective',
    'decomposeHomographyMat'
  ];

  homographyFunctions.forEach(func => {
    try {
      results.features[func] = typeof cv[func] === 'function';
      if (!results.features[func]) {
        results.missing.push(func);
      }
    } catch (error) {
      results.features[func] = false;
      results.missing.push(func);
      results.errors.push(`${func}: ${error.message}`);
    }
  });

  // Test image processing functions needed for anchor system
  const imageProcessingFunctions = [
    'cvtColor',
    'Canny',
    'GaussianBlur',
    'findContours',
    'fitEllipse',
    'matchTemplate',
    'threshold',
    'dilate',
    'erode',
    'warpAffine'
  ];

  imageProcessingFunctions.forEach(func => {
    try {
      results.features[func] = typeof cv[func] === 'function';
      if (!results.features[func]) {
        results.missing.push(func);
      }
    } catch (error) {
      results.features[func] = false;
      results.missing.push(func);
      results.errors.push(`${func}: ${error.message}`);
    }
  });

  // Test constants needed
  const constants = [
    'COLOR_RGBA2GRAY',
    'COLOR_RGB2GRAY',
    'THRESH_BINARY',
    'RETR_EXTERNAL',
    'CHAIN_APPROX_SIMPLE',
    'RANSAC',
    'TM_CCORR_NORMED',
    'INTER_LINEAR'
  ];

  constants.forEach(constant => {
    try {
      results.features[constant] = typeof cv[constant] !== 'undefined';
      if (!results.features[constant]) {
        results.missing.push(constant);
      }
    } catch (error) {
      results.features[constant] = false;
      results.missing.push(constant);
      results.errors.push(`${constant}: ${error.message}`);
    }
  });

  // Try to get version if available
  try {
    if (cv.getBuildInformation) {
      results.version = 'Available via getBuildInformation()';
    } else {
      results.version = 'Version info not available';
    }
  } catch (error) {
    results.version = `Error getting version: ${error.message}`;
  }

  return results;
};

// Helper function to log results nicely
export const logOpenCVFeatures = () => {
  const results = testOpenCVFeatures();
  
  console.group('🔍 OpenCV.js Feature Detection');
  
  if (!results.available) {
    logger.error('OpenCVFeatureTest', '❌ OpenCV.js not available:', results.error);
    console.groupEnd();
    return results;
  }

  logger.info('OpenCVFeatureTest', '✅ OpenCV.js is loaded');
  logger.info('OpenCVFeatureTest', '📦 Version:', results.version);
  
  const available = Object.entries(results.features).filter(([, v]) => v === true);
  const missing = Object.entries(results.features).filter(([, v]) => v === false);
  
  logger.info('OpenCVFeatureTest', `✅ Available features (${available.length}):`, available.map(([k]) => k));
  
  if (missing.length > 0) {
    logger.warn('OpenCVFeatureTest', `⚠️  Missing features (${missing.length}):`, missing.map(([k]) => k));
  }
  
  if (results.errors.length > 0) {
    logger.error('OpenCVFeatureTest', '🚫 Errors during testing:', results.errors);
  }

  // Check critical features for image anchor system
  const criticalFeatures = ['goodFeaturesToTrack', 'calcOpticalFlowPyrLK', 'findHomography'];
  const missingCritical = criticalFeatures.filter(feat => !results.features[feat]);
  
  if (missingCritical.length > 0) {
    logger.error('OpenCVFeatureTest', '🚨 Missing CRITICAL features for image anchor system:', missingCritical);
    logger.error('OpenCVFeatureTest', '❌ Image anchor system will NOT work with current OpenCV.js build');
  } else {
    logger.info('OpenCVFeatureTest', '✅ All critical features available for image anchor system');
  }
  
  console.groupEnd();
  
  return results;
};

// Export test results for use in other modules
export const getRequiredFeatures = () => {
  return [
    'goodFeaturesToTrack',
    'calcOpticalFlowPyrLK',
    'findHomography',
    'matchTemplate',
    'warpAffine',
    'cvtColor',
    'Canny'
  ];
};

export const checkCriticalFeatures = () => {
  const results = testOpenCVFeatures();
  const required = getRequiredFeatures();
  if (!results.available) {
    return {
      allAvailable: false,
      available: [],
      missing: required,
      error: results.error || 'OpenCV.js not available'
    };
  }

  const missing = required.filter(feat => !results.features[feat]);
  
  return {
    allAvailable: missing.length === 0,
    available: required.filter(feat => results.features[feat]),
    missing: missing
  };
};
