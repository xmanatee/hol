import {
  constrainObjectSupportMaskToTapLocalCircle,
  createObjectSupportMask,
  keepConnectedComponentContainingPoint,
  OBJECT_SUPPORT_MASK_SOURCES,
} from './objectSupportMask.js';

export const createInteractiveObjectSupportMask = ({
  confidenceData,
  maskWidth,
  maskHeight,
  frameWidth,
  frameHeight,
  threshold,
  referencePoint,
  createdAtFrame,
  maxRadius = null,
}) => {
  const data = new Uint8Array(frameWidth * frameHeight);
  let confidenceSum = 0;
  let supportPixels = 0;

  for (let y = 0; y < frameHeight; y++) {
    const sourceY = Math.min(maskHeight - 1, Math.floor(y * maskHeight / frameHeight));
    for (let x = 0; x < frameWidth; x++) {
      const sourceX = Math.min(maskWidth - 1, Math.floor(x * maskWidth / frameWidth));
      const confidence = confidenceData[sourceY * maskWidth + sourceX];
      if (confidence >= threshold) {
        data[y * frameWidth + x] = 255;
        confidenceSum += confidence;
        supportPixels++;
      }
    }
  }

  const connectedData = keepConnectedComponentContainingPoint({
    width: frameWidth,
    height: frameHeight,
    data,
    point: referencePoint,
  });

  const connectedMask = createObjectSupportMask({
    width: frameWidth,
    height: frameHeight,
    data: connectedData,
    source: OBJECT_SUPPORT_MASK_SOURCES.INTERACTIVE_SEGMENTER,
    confidence: supportPixels > 0 ? confidenceSum / supportPixels : 0,
    referencePoint,
    createdAtFrame,
    updatedAtFrame: createdAtFrame,
  });

  if (!Number.isFinite(maxRadius)) {
    return connectedMask;
  }

  return constrainObjectSupportMaskToTapLocalCircle({
    objectSupportMask: connectedMask,
    referencePoint,
    radius: maxRadius,
  });
};
