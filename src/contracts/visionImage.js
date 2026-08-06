export const VISION_CROP_PADDING_RATIO = 0.15;
export const VISION_CROP_MAX_EDGE = 896;
export const VISION_CROP_MIME_TYPE = 'image/jpeg';
export const VISION_CROP_JPEG_QUALITY = 0.82;
export const VISION_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const CROP_KEYS = Object.freeze(['x', 'y', 'width', 'height']);

const assertPositiveSafeInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
};

const assertFiniteNumber = (value, label) => {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
};

const assertCrop = (crop) => {
  if (!crop || typeof crop !== 'object' || Array.isArray(crop)) {
    throw new TypeError('Vision crop must be an object');
  }
  const unsupportedKey = Object.keys(crop).find((key) => !CROP_KEYS.includes(key));
  if (unsupportedKey) {
    throw new TypeError(`Vision crop contains unsupported field: ${unsupportedKey}`);
  }
  const missingKey = CROP_KEYS.find((key) => !Object.hasOwn(crop, key));
  if (missingKey) {
    throw new TypeError(`Vision crop is missing required field: ${missingKey}`);
  }

  assertFiniteNumber(crop.x, 'Vision crop x');
  assertFiniteNumber(crop.y, 'Vision crop y');
  assertFiniteNumber(crop.width, 'Vision crop width');
  assertFiniteNumber(crop.height, 'Vision crop height');
  if (crop.width <= 0) {
    throw new RangeError('Vision crop width must be a positive finite number');
  }
  if (crop.height <= 0) {
    throw new RangeError('Vision crop height must be a positive finite number');
  }
};

export const assertVisionImageData = (imageData) => {
  if (!imageData || typeof imageData !== 'object' || Array.isArray(imageData)) {
    throw new TypeError('Vision source image must be an ImageData object');
  }
  assertPositiveSafeInteger(imageData.width, 'Vision source image width');
  assertPositiveSafeInteger(imageData.height, 'Vision source image height');
  if (!(imageData.data instanceof Uint8ClampedArray)) {
    throw new TypeError('Vision source image data must be a Uint8ClampedArray');
  }
  const expectedLength = imageData.width * imageData.height * 4;
  if (!Number.isSafeInteger(expectedLength) || imageData.data.length !== expectedLength) {
    throw new RangeError(`Vision source image data must contain exactly ${expectedLength} bytes`);
  }
  return imageData;
};

export const resolveVisionCrop = (crop, imageWidth, imageHeight) => {
  assertPositiveSafeInteger(imageWidth, 'Vision crop image width');
  assertPositiveSafeInteger(imageHeight, 'Vision crop image height');
  assertCrop(crop);

  const horizontalPadding = crop.width * VISION_CROP_PADDING_RATIO * 0.5;
  const verticalPadding = crop.height * VISION_CROP_PADDING_RATIO * 0.5;
  const paddedLeft = crop.x - horizontalPadding;
  const paddedTop = crop.y - verticalPadding;
  const paddedRight = crop.x + crop.width + horizontalPadding;
  const paddedBottom = crop.y + crop.height + verticalPadding;
  if (![paddedLeft, paddedTop, paddedRight, paddedBottom].every(Number.isFinite)) {
    throw new RangeError('Vision crop padded bounds must be finite');
  }

  const sourceX = Math.max(0, Math.floor(paddedLeft));
  const sourceY = Math.max(0, Math.floor(paddedTop));
  const sourceRight = Math.min(imageWidth, Math.ceil(paddedRight));
  const sourceBottom = Math.min(imageHeight, Math.ceil(paddedBottom));
  const sourceWidth = sourceRight - sourceX;
  const sourceHeight = sourceBottom - sourceY;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new RangeError('Vision crop must intersect the image');
  }

  const resizeScale = Math.min(1, VISION_CROP_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  return Object.freeze({
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    outputWidth: Math.max(1, Math.round(sourceWidth * resizeScale)),
    outputHeight: Math.max(1, Math.round(sourceHeight * resizeScale)),
  });
};

export const assertVisionImageBlob = (blob) => {
  if (!(blob instanceof Blob)) {
    throw new TypeError('Vision image must be a Blob');
  }
  if (blob.size === 0) {
    throw new RangeError('Vision image must not be empty');
  }
  if (blob.type !== VISION_CROP_MIME_TYPE) {
    throw new TypeError(`Vision image must use ${VISION_CROP_MIME_TYPE}`);
  }
  if (blob.size > VISION_IMAGE_MAX_BYTES) {
    throw new RangeError(`Vision image size ${blob.size} exceeds the ${VISION_IMAGE_MAX_BYTES}-byte limit`);
  }
  return blob;
};
