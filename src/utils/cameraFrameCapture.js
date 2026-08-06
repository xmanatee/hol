export const shouldCaptureCameraFrame = ({
  mode,
  shouldUpdateAnchor,
  shouldRefreshSegmentation,
  canProcess,
}) => mode === 'anchor' && canProcess && (shouldUpdateAnchor || shouldRefreshSegmentation);

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
