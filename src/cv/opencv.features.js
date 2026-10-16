export const REQUIRED_OPENCV_FEATURES = [
  'goodFeaturesToTrack',
  'calcOpticalFlowPyrLK',
  'findHomography',
  'exceptionFromPtr',
  'matchTemplate',
  'warpAffine',
  'cvtColor',
  'Canny',
  'ORB',
  'KeyPointVector',
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

  const available = required.filter((feature) => typeof cv[feature] === 'function');
  const missing = required.filter((feature) => typeof cv[feature] !== 'function');

  return {
    allAvailable: missing.length === 0,
    available,
    missing,
  };
};
