import { createLaminatedCardSequence } from './visionFixtures.js';
import { applyLinearMotionBlur } from './captureDegradation.js';

const ABSENT_START_FRAME = 10;
const DECOY_START_FRAME = 14;
const REENTRY_FRAME = 22;
const REENTRY_TRANSLATION = Object.freeze({ x: 180, y: 15 });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const cloneImageData = (imageData) => ({
  width: imageData.width,
  height: imageData.height,
  data: new Uint8ClampedArray(imageData.data),
});

const deterministicBackground = (x, y, frameIndex) => {
  const texture = (x * 17 + y * 11 + frameIndex * 23) % 37;
  return [74 + texture, 79 + texture, 88 + texture, 255];
};

const writePixel = (imageData, x, y, pixel) => {
  const offset = (y * imageData.width + x) * 4;
  imageData.data[offset] = pixel[0];
  imageData.data[offset + 1] = pixel[1];
  imageData.data[offset + 2] = pixel[2];
  imageData.data[offset + 3] = pixel[3];
};

const eraseTarget = (imageData, boundingBox, frameIndex) => {
  const output = cloneImageData(imageData);
  const x1 = clamp(Math.floor(boundingBox.x1) - 8, 0, imageData.width - 1);
  const y1 = clamp(Math.floor(boundingBox.y1) - 8, 0, imageData.height - 1);
  const x2 = clamp(Math.ceil(boundingBox.x2) + 8, 0, imageData.width - 1);
  const y2 = clamp(Math.ceil(boundingBox.y2) + 8, 0, imageData.height - 1);
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      writePixel(output, x, y, deterministicBackground(x, y, frameIndex));
    }
  }
  return output;
};

const decoyPixel = (x, y, width, height) => {
  const border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
  if (border) return [24, 30, 39, 255];

  const logo = x > width * 0.1 && x < width * 0.43 && y > height * 0.18 && y < height * 0.78;
  if (logo) {
    const diagonal = (x + y * 2) % 19 < 6;
    return diagonal ? [191, 54, 72, 255] : [245, 177, 63, 255];
  }

  const textLine = x > width * 0.52 && x < width * 0.9 && y > height * 0.2 && y < height * 0.8 && y % 13 < 4;
  if (textLine) return [38, 67, 93, 255];

  const paperTexture = (x * 11 + y * 17) % 23;
  return [205 + paperTexture, 218 + Math.floor(paperTexture / 2), 229, 255];
};

const pasteDecoy = ({ imageData, sourceBox }) => {
  const output = cloneImageData(imageData);
  const width = Math.ceil(sourceBox.width);
  const height = Math.ceil(sourceBox.height);
  const destinationX = 212;
  const destinationY = 132;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const toX = destinationX + x;
      const toY = destinationY + y;
      if (toX >= output.width || toY >= output.height) continue;
      writePixel(output, toX, toY, decoyPixel(x, y, width, height));
    }
  }

  return {
    imageData: output,
    boundingBox: {
      x: destinationX,
      y: destinationY,
      width,
      height,
      x1: destinationX,
      y1: destinationY,
      x2: destinationX + width,
      y2: destinationY + height,
    },
  };
};

const translatePoint = (point) => ({
  x: point.x + REENTRY_TRANSLATION.x,
  y: point.y + REENTRY_TRANSLATION.y,
});

const translateBoundingBox = (boundingBox) => ({
  ...boundingBox,
  x: boundingBox.x + REENTRY_TRANSLATION.x,
  y: boundingBox.y + REENTRY_TRANSLATION.y,
  x1: boundingBox.x1 + REENTRY_TRANSLATION.x,
  y1: boundingBox.y1 + REENTRY_TRANSLATION.y,
  x2: boundingBox.x2 + REENTRY_TRANSLATION.x,
  y2: boundingBox.y2 + REENTRY_TRANSLATION.y,
});

const translateImageData = (imageData, frameIndex) => {
  const output = cloneImageData(imageData);
  for (let y = 0; y < imageData.height; y++) {
    for (let x = 0; x < imageData.width; x++) {
      const sourceX = x - REENTRY_TRANSLATION.x;
      const sourceY = y - REENTRY_TRANSLATION.y;
      if (sourceX < 0 || sourceY < 0 || sourceX >= imageData.width || sourceY >= imageData.height) {
        writePixel(output, x, y, deterministicBackground(x, y, frameIndex));
        continue;
      }
      const sourceOffset = (sourceY * imageData.width + sourceX) * 4;
      writePixel(output, x, y, imageData.data.subarray(sourceOffset, sourceOffset + 4));
    }
  }
  return output;
};

const hiddenFrame = ({ frame, sourceFrame, frameIndex, width, height }) => {
  const erased = eraseTarget(frame.imageData, frame.boundingBox, frameIndex);
  const decoy =
    frameIndex >= DECOY_START_FRAME
      ? pasteDecoy({
          imageData: erased,
          sourceBox: sourceFrame.boundingBox,
        })
      : null;
  return {
    ...frame,
    imageData: decoy?.imageData || erased,
    objectMask: { data: new Uint8Array(width * height) },
    corners: [],
    occluded: true,
    targetVisible: false,
    ...(decoy ? { decoyBoundingBox: decoy.boundingBox } : {}),
    groundTruth: { ...frame.groundTruth, occluded: true },
  };
};

const reentryFrame = (frame, frameIndex) => {
  let imageData = translateImageData(frame.imageData, frameIndex);
  if (frameIndex < REENTRY_FRAME + 2) {
    imageData = applyLinearMotionBlur(imageData, { x: 12, y: 4 });
  }
  return {
    ...frame,
    imageData,
    corners: frame.corners.map(translatePoint),
    boundingBox: translateBoundingBox(frame.boundingBox),
    ...(frame.maskProbePoints
      ? {
          maskProbePoints: Object.fromEntries(
            Object.entries(frame.maskProbePoints).map(([name, point]) => [name, translatePoint(point)]),
          ),
        }
      : {}),
    targetVisible: true,
    occluded: false,
    groundTruth: {
      ...frame.groundTruth,
      anchor: translatePoint(frame.groundTruth.anchor),
      occluded: false,
    },
  };
};

export const createFullLossReentrySequence = ({ frameCount, backgroundVariant, backgroundSeed }) => {
  const source = createLaminatedCardSequence({
    frameCount,
    occlusionFrames: [],
    backgroundVariant,
    backgroundSeed,
  });
  const frames = source.frames.map((frame, frameIndex) => {
    if (frameIndex >= ABSENT_START_FRAME && frameIndex < REENTRY_FRAME) {
      return hiddenFrame({
        frame,
        sourceFrame: source.frames[0],
        frameIndex,
        width: source.width,
        height: source.height,
      });
    }
    if (frameIndex >= REENTRY_FRAME) return reentryFrame(frame, frameIndex);
    return { ...frame, targetVisible: true };
  });

  return {
    ...source,
    kind: 'laminated-card-full-loss',
    frames,
    metadata: {
      ...source.metadata,
      targetLoss: {
        absentStartFrame: ABSENT_START_FRAME,
        decoyStartFrame: DECOY_START_FRAME,
        reentryFrame: REENTRY_FRAME,
        reentryTranslation: { ...REENTRY_TRANSLATION },
      },
    },
  };
};
