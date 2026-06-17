export const DEPTH_MODEL_DEFAULT_INPUT_SIZE = 322;

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const sourceDataForImage = imageData => (
  imageData.data instanceof Uint8ClampedArray
    ? imageData.data
    : new Uint8ClampedArray(imageData.data)
);

export const preprocessDepthImageData = (
  imageData,
  { inputSize = DEPTH_MODEL_DEFAULT_INPUT_SIZE } = {}
) => {
  const source = sourceDataForImage(imageData);
  const sourceWidth = imageData.width;
  const sourceHeight = imageData.height;
  const scale = inputSize / Math.max(sourceWidth, sourceHeight);
  const resizedWidth = Math.max(1, Math.round(sourceWidth * scale));
  const resizedHeight = Math.max(1, Math.round(sourceHeight * scale));
  const padX = Math.floor((inputSize - resizedWidth) / 2);
  const padY = Math.floor((inputSize - resizedHeight) / 2);
  const tensor = new Float32Array(3 * inputSize * inputSize);

  for (let y = 0; y < inputSize; y++) {
    for (let x = 0; x < inputSize; x++) {
      const inImage = x >= padX &&
        x < padX + resizedWidth &&
        y >= padY &&
        y < padY + resizedHeight;
      const srcX = inImage
        ? clamp(Math.floor((x - padX) / scale), 0, sourceWidth - 1)
        : 0;
      const srcY = inImage
        ? clamp(Math.floor((y - padY) / scale), 0, sourceHeight - 1)
        : 0;
      const sourceOffset = (srcY * sourceWidth + srcX) * 4;
      const targetOffset = y * inputSize + x;
      const r = inImage ? source[sourceOffset] / 255 : IMAGENET_MEAN[0];
      const g = inImage ? source[sourceOffset + 1] / 255 : IMAGENET_MEAN[1];
      const b = inImage ? source[sourceOffset + 2] / 255 : IMAGENET_MEAN[2];

      tensor[targetOffset] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
      tensor[inputSize * inputSize + targetOffset] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
      tensor[2 * inputSize * inputSize + targetOffset] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    }
  }

  return {
    tensor,
    dims: [1, 3, inputSize, inputSize],
    inputSize,
    originalWidth: sourceWidth,
    originalHeight: sourceHeight,
    resizedWidth,
    resizedHeight,
    padX,
    padY,
    scale,
  };
};

const outputShapeForTensor = tensor => {
  const dims = tensor.dims || [];
  if (dims.length === 4) {
    return { width: dims[3], height: dims[2] };
  }
  if (dims.length === 3) {
    return { width: dims[2], height: dims[1] };
  }
  if (dims.length === 2) {
    return { width: dims[1], height: dims[0] };
  }

  const side = Math.sqrt(tensor.data.length);
  if (!Number.isInteger(side)) {
    throw new Error(`Unsupported depth output shape: ${dims.join('x') || tensor.data.length}`);
  }

  return { width: side, height: side };
};

const sampleBilinear = ({ data, width, height, x, y }) => {
  const x0 = clamp(Math.floor(x), 0, width - 1);
  const y0 = clamp(Math.floor(y), 0, height - 1);
  const x1 = clamp(x0 + 1, 0, width - 1);
  const y1 = clamp(y0 + 1, 0, height - 1);
  const tx = clamp(x - x0, 0, 1);
  const ty = clamp(y - y0, 0, 1);
  const top = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx;
  const bottom = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
};

export const normalizeDepthValues = values => {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  const range = Math.max(max - min, 1e-6);
  return Float32Array.from(values, value => (
    Number.isFinite(value) ? (value - min) / range : 0
  ));
};

export const postprocessDepthTensor = (tensor, preprocessInfo) => {
  const { width: outputWidth, height: outputHeight } = outputShapeForTensor(tensor);
  const outputData = normalizeDepthValues(tensor.data);
  const depth = new Float32Array(preprocessInfo.originalWidth * preprocessInfo.originalHeight);

  for (let y = 0; y < preprocessInfo.originalHeight; y++) {
    for (let x = 0; x < preprocessInfo.originalWidth; x++) {
      const modelX = x * preprocessInfo.scale + preprocessInfo.padX;
      const modelY = y * preprocessInfo.scale + preprocessInfo.padY;
      const outputX = modelX / Math.max(preprocessInfo.inputSize - 1, 1) * Math.max(outputWidth - 1, 1);
      const outputY = modelY / Math.max(preprocessInfo.inputSize - 1, 1) * Math.max(outputHeight - 1, 1);
      depth[y * preprocessInfo.originalWidth + x] = sampleBilinear({
        data: outputData,
        width: outputWidth,
        height: outputHeight,
        x: outputX,
        y: outputY,
      });
    }
  }

  return {
    width: preprocessInfo.originalWidth,
    height: preprocessInfo.originalHeight,
    data: depth,
  };
};
