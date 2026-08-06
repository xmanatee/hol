const requirePositiveInteger = (value, name, minimum = 1) => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be ${minimum === 1 ? 'positive' : `at least ${minimum}`}`);
  }
  return value;
};

export const decodeAnnotatedVisionRgbDeltaInPlace = (bytes, options) => {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('bytes must be a Uint8Array');
  }
  const frameByteLength = requirePositiveInteger(options?.frameByteLength, 'frameByteLength');
  const frameCount = requirePositiveInteger(options?.frameCount, 'frameCount', 2);
  const expectedByteLength = frameByteLength * frameCount;
  if (!Number.isSafeInteger(expectedByteLength)) {
    throw new TypeError('decoded RGB byte length must be a safe integer');
  }
  if (bytes.byteLength !== expectedByteLength) {
    throw new TypeError(`bytes must contain exactly ${expectedByteLength} bytes`);
  }

  for (let index = frameByteLength; index < bytes.byteLength; index++) {
    bytes[index] ^= bytes[index - frameByteLength];
  }
  return bytes;
};
