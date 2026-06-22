export const REQUIRED_OPENCV_FEATURES = [
  'goodFeaturesToTrack',
  'calcOpticalFlowPyrLK',
  'findHomography',
  'matchTemplate',
  'warpAffine',
  'cvtColor',
  'Canny',
];

export const getRequiredFeatures = () => [...REQUIRED_OPENCV_FEATURES];

export const checkCriticalFeatures = (cv = globalThis.window?.cv) => {
  const required = getRequiredFeatures();

  if (!cv) {
    return {
      allAvailable: false,
      available: [],
      missing: required,
      error: 'OpenCV.js not available',
    };
  }

  const available = required.filter(feature => typeof cv[feature] !== 'undefined');
  const missing = required.filter(feature => typeof cv[feature] === 'undefined');

  return {
    allAvailable: missing.length === 0,
    available,
    missing,
  };
};
