const BACKENDS = Object.freeze({
  'mediapipe-wasm': Object.freeze({
    id: 'mediapipe-wasm',
    delegate: 'CPU',
    execution: 'wasm',
    temporalMemory: false,
  }),
  'mediapipe-webgl': Object.freeze({
    id: 'mediapipe-webgl',
    delegate: 'GPU',
    execution: 'webgl',
    temporalMemory: false,
  }),
});

export const listSegmentationBackends = () => Object.values(BACKENDS);

export const getSegmentationBackend = (id) => {
  if (typeof id !== 'string' || !Object.hasOwn(BACKENDS, id))
    throw new RangeError('Unsupported segmentation backend ID');
  return BACKENDS[id];
};

// The exact same point-prompt boundary applies to every execution backend.
export const assertSegmentationInput = ({ imageData, tapPosition, createdAtFrame }) => {
  const { width, height, data } = imageData;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 4_194_304
  ) {
    throw new RangeError('Segmentation raster must contain 1–4194304 pixels');
  }
  if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new TypeError('Segmentation requires a complete RGBA Uint8ClampedArray');
  }
  if (
    !Number.isFinite(tapPosition.x) ||
    !Number.isFinite(tapPosition.y) ||
    tapPosition.x < 0 ||
    tapPosition.y < 0 ||
    tapPosition.x >= width ||
    tapPosition.y >= height
  ) {
    throw new RangeError('Segmentation point must be inside the source raster');
  }
  if (!Number.isSafeInteger(createdAtFrame) || createdAtFrame < 0)
    throw new RangeError('Segmentation frame ID must be a non-negative integer');
};
