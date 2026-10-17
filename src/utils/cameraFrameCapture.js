import { isSelectedObjectObservationFresh } from './cvScheduling.js';

export const shouldCaptureCameraFrame = ({
  mode,
  shouldUpdateAnchor,
  shouldRefreshSegmentation,
  canProcess,
}) =>
  (mode === 'anchor' || mode === 'selection') &&
  canProcess &&
  (shouldUpdateAnchor || shouldRefreshSegmentation);

export const captureCameraFrame = ({ video, canvas, context }) => {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width <= 0 || height <= 0) {
    throw new Error('Camera frame dimensions are not ready');
  }

  let captureContext = context;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    captureContext = null;
  }
  if (!captureContext) {
    captureContext = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!captureContext) {
    throw new Error('Camera frame capture requires a 2D canvas context');
  }

  captureContext.setTransform(1, 0, 0, 1, 0, 0);
  captureContext.drawImage(video, 0, 0, width, height);

  return {
    context: captureContext,
    imageData: captureContext.getImageData(0, 0, width, height),
  };
};
export const getCurrentObjectCaptureRegion = (state, now) => {
  if (!isSelectedObjectObservationFresh(state, now) || state.anchorState?.metrics?.targetPresent !== true) {
    throw new Error('Waiting for fresh tracking. Keep the selected object visible.');
  }
  const bounds = state.anchorState.metrics.currentObjectSupportMaskBounds;
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error('The current object outline is unavailable. Keep the selected object visible.');
  }
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
};
