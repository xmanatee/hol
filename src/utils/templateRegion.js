import { calculateTapLocalRadius } from '../cv/objectSupportMask.js';

const MIN_TEMPLATE_SIZE = 80;
const MAX_TEMPLATE_SIZE = 180;
const FALLBACK_TEMPLATE_SIZE = 160;

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const clampRegion = (region, imageWidth, imageHeight) => {
  const width = Math.round(Math.min(region.width, imageWidth));
  const height = Math.round(Math.min(region.height, imageHeight));

  return {
    x: Math.round(clamp(region.x, 0, imageWidth - width)),
    y: Math.round(clamp(region.y, 0, imageHeight - height)),
    width,
    height,
  };
};

const clampRegionToSelection = (region, boundingBox) => {
  const bboxWidth = boundingBox.x2 - boundingBox.x1;
  const bboxHeight = boundingBox.y2 - boundingBox.y1;

  return {
    ...region,
    x: bboxWidth >= region.width ? clamp(region.x, boundingBox.x1, boundingBox.x2 - region.width) : region.x,
    y:
      bboxHeight >= region.height
        ? clamp(region.y, boundingBox.y1, boundingBox.y2 - region.height)
        : region.y,
  };
};

const calculateSelectionTemplateSize = (boundingBox, imageWidth, imageHeight) => {
  const bboxWidth = boundingBox.x2 - boundingBox.x1;
  const bboxHeight = boundingBox.y2 - boundingBox.y1;
  const maxImageSize = Math.min(MAX_TEMPLATE_SIZE, Math.min(imageWidth, imageHeight) * 0.25);
  const longSide = Math.max(bboxWidth, bboxHeight);
  const shortSide = Math.min(bboxWidth, bboxHeight);
  const objectLocalSize = Math.max(shortSide * 0.9, longSide * 0.32);

  return clamp(objectLocalSize, MIN_TEMPLATE_SIZE, maxImageSize);
};

export const calculateTemplateRegion = (tapPosition, boundingBox, imageWidth, imageHeight) => {
  if (boundingBox) {
    const selectionSize = calculateSelectionTemplateSize(boundingBox, imageWidth, imageHeight);
    const tapCenteredRegion = {
      x: tapPosition.x - selectionSize / 2,
      y: tapPosition.y - selectionSize / 2,
      width: selectionSize,
      height: selectionSize,
    };

    return clampRegion(clampRegionToSelection(tapCenteredRegion, boundingBox), imageWidth, imageHeight);
  }

  const size = clamp(Math.min(imageWidth, imageHeight) * 0.22, 96, FALLBACK_TEMPLATE_SIZE);
  return clampRegion(
    {
      x: tapPosition.x - size / 2,
      y: tapPosition.y - size / 2,
      width: size,
      height: size,
    },
    imageWidth,
    imageHeight,
  );
};

export const calculateTapLocalTemplateRegion = (tapPosition, imageWidth, imageHeight, { scale = 1 } = {}) => {
  const radius = calculateTapLocalRadius({ width: imageWidth, height: imageHeight }) * scale;
  const size = Math.max(scale > 1 ? 180 : 140, radius * 2);
  return clampRegion(
    {
      x: tapPosition.x - size / 2,
      y: tapPosition.y - size / 2,
      width: size,
      height: size,
    },
    imageWidth,
    imageHeight,
  );
};
