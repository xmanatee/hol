export const OBJECT_SUPPORT_MASK_SOURCES = Object.freeze({
  INTERACTIVE_SEGMENTER: 'interactive-segmenter',
  TAP_LOCAL: 'tap-local',
  WARPED_MASK: 'warped-mask',
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const calculateTapLocalRadius = ({ width, height }) => (
  clamp(Math.min(width, height) * 0.055, 28, 64)
);

export const getObjectSupportBounds = objectSupportMask => {
  let minX = objectSupportMask.width;
  let minY = objectSupportMask.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < objectSupportMask.height; y++) {
    for (let x = 0; x < objectSupportMask.width; x++) {
      if (objectSupportMask.data[y * objectSupportMask.width + x] > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
};

const findNearestPositivePixel = ({ width, height, data, point }) => {
  const targetX = Math.trunc(point.x);
  const targetY = Math.trunc(point.y);
  let best = null;
  let bestDistance = Infinity;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (data[rowOffset + x] === 0) {
        continue;
      }

      const distance = Math.abs(x - targetX) + Math.abs(y - targetY);
      if (distance < bestDistance) {
        best = { x, y };
        bestDistance = distance;
      }
    }
  }

  return best;
};

export const keepConnectedComponentContainingPoint = ({ width, height, data, point }) => {
  const output = new Uint8Array(width * height);
  const start = findNearestPositivePixel({ width, height, data, point });
  if (!start) {
    return output;
  }

  const visited = new Uint8Array(width * height);
  const queue = [start];
  visited[start.y * width + start.x] = 1;

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const currentIndex = current.y * width + current.x;
    output[currentIndex] = 255;

    const neighbors = [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ];

    for (const neighbor of neighbors) {
      if (neighbor.x < 0 || neighbor.y < 0 || neighbor.x >= width || neighbor.y >= height) {
        continue;
      }

      const neighborIndex = neighbor.y * width + neighbor.x;
      if (visited[neighborIndex] || data[neighborIndex] === 0) {
        continue;
      }

      visited[neighborIndex] = 1;
      queue.push(neighbor);
    }
  }

  return output;
};

export const createObjectSupportMask = ({
  width,
  height,
  data,
  source,
  confidence,
  referencePoint,
  createdAtFrame,
  updatedAtFrame,
}) => {
  const mask = {
    width,
    height,
    data: new Uint8Array(data),
    source,
    confidence,
    referencePoint: { ...referencePoint },
    createdAtFrame,
    updatedAtFrame,
    bbox: { x: 0, y: 0, width: 0, height: 0 },
    pixelCount: 0,
  };

  mask.bbox = getObjectSupportBounds(mask);
  for (const value of mask.data) {
    if (value > 0) {
      mask.pixelCount++;
    }
  }
  return mask;
};

const hasMaskPixel = (objectSupportMask, x, y) => (
  x >= 0 &&
  y >= 0 &&
  x < objectSupportMask.width &&
  y < objectSupportMask.height &&
  objectSupportMask.data[y * objectSupportMask.width + x] > 0
);

const isBoundaryPixel = (objectSupportMask, x, y) => (
  hasMaskPixel(objectSupportMask, x, y) &&
  (!hasMaskPixel(objectSupportMask, x - 1, y) ||
    !hasMaskPixel(objectSupportMask, x + 1, y) ||
    !hasMaskPixel(objectSupportMask, x, y - 1) ||
    !hasMaskPixel(objectSupportMask, x, y + 1))
);

export const createObjectSupportMaskPreview = (objectSupportMask, { maxPoints = 180 } = {}) => {
  const { bbox } = objectSupportMask;
  if (bbox.width <= 0 || bbox.height <= 0) {
    return {
      source: objectSupportMask.source,
      confidence: objectSupportMask.confidence,
      bbox: { ...bbox },
      sampleStride: 1,
      points: [],
    };
  }

  const sampleStride = Math.max(1, Math.floor(Math.sqrt((bbox.width * bbox.height) / maxPoints)));
  const points = [];

  for (let y = bbox.y; y < bbox.y + bbox.height; y += sampleStride) {
    for (let x = bbox.x; x < bbox.x + bbox.width; x += sampleStride) {
      if (isBoundaryPixel(objectSupportMask, x, y)) {
        points.push({ x, y });
      }
    }
  }

  return {
    source: objectSupportMask.source,
    confidence: objectSupportMask.confidence,
    bbox: { ...bbox },
    sampleStride,
    points: points.slice(0, maxPoints),
  };
};

export const createTapLocalObjectSupportMask = ({
  width,
  height,
  referencePoint,
  createdAtFrame,
  radius = calculateTapLocalRadius({ width, height }),
  source = OBJECT_SUPPORT_MASK_SOURCES.TAP_LOCAL,
  confidence = 0.32,
}) => {
  const data = new Uint8Array(width * height);
  const centerX = Math.round(clamp(referencePoint.x, 0, width - 1));
  const centerY = Math.round(clamp(referencePoint.y, 0, height - 1));
  const localRadius = Math.round(clamp(radius, 1, Math.min(width, height)));
  const radiusSquared = localRadius * localRadius;

  for (let y = Math.max(0, centerY - localRadius); y <= Math.min(height - 1, centerY + localRadius); y++) {
    const rowOffset = y * width;
    for (let x = Math.max(0, centerX - localRadius); x <= Math.min(width - 1, centerX + localRadius); x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= radiusSquared) {
        data[rowOffset + x] = 255;
      }
    }
  }

  return createObjectSupportMask({
    width,
    height,
    data,
    source,
    confidence,
    referencePoint: { x: centerX, y: centerY },
    createdAtFrame,
    updatedAtFrame: createdAtFrame,
  });
};

export const constrainObjectSupportMaskToTapLocalCircle = ({
  objectSupportMask,
  referencePoint,
  radius = calculateTapLocalRadius(objectSupportMask),
  source = objectSupportMask.source,
  confidence = objectSupportMask.confidence,
  updatedAtFrame = objectSupportMask.updatedAtFrame,
}) => {
  const data = new Uint8Array(objectSupportMask.width * objectSupportMask.height);
  const centerX = Math.round(clamp(referencePoint.x, 0, objectSupportMask.width - 1));
  const centerY = Math.round(clamp(referencePoint.y, 0, objectSupportMask.height - 1));
  const localRadius = Math.round(clamp(radius, 1, Math.min(objectSupportMask.width, objectSupportMask.height)));
  const radiusSquared = localRadius * localRadius;

  for (let y = Math.max(0, centerY - localRadius); y <= Math.min(objectSupportMask.height - 1, centerY + localRadius); y++) {
    const rowOffset = y * objectSupportMask.width;
    for (let x = Math.max(0, centerX - localRadius); x <= Math.min(objectSupportMask.width - 1, centerX + localRadius); x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= radiusSquared &&
          objectSupportMask.data[rowOffset + x] > 0) {
        data[rowOffset + x] = 255;
      }
    }
  }

  return createObjectSupportMask({
    width: objectSupportMask.width,
    height: objectSupportMask.height,
    data,
    source,
    confidence,
    referencePoint: { x: centerX, y: centerY },
    createdAtFrame: objectSupportMask.createdAtFrame,
    updatedAtFrame,
  });
};

export const isPointInsideObjectSupport = (objectSupportMask, point) => {
  const x = Math.trunc(point.x);
  const y = Math.trunc(point.y);
  if (x < 0 || y < 0 || x >= objectSupportMask.width || y >= objectSupportMask.height) {
    return false;
  }

  return objectSupportMask.data[y * objectSupportMask.width + x] > 0;
};

export const createRegionOpenCvMask = (cv, objectSupportMask, region) => {
  const mask = cv.Mat.zeros(region.height, region.width, cv.CV_8UC1);
  for (let y = 0; y < region.height; y++) {
    const frameY = region.y + y;
    const maskRowOffset = y * region.width;

    for (let x = 0; x < region.width; x++) {
      const frameX = region.x + x;
      if (frameX < 0 ||
          frameY < 0 ||
          frameX >= objectSupportMask.width ||
          frameY >= objectSupportMask.height) {
        mask.data[maskRowOffset + x] = 0;
      } else {
        mask.data[maskRowOffset + x] = objectSupportMask.data[frameY * objectSupportMask.width + frameX] > 0 ? 255 : 0;
      }
    }
  }

  return mask;
};

export const warpObjectSupportMask = (objectSupportMask, {
  position,
  scale,
  rotation,
  updatedAtFrame,
}) => {
  const data = new Uint8Array(objectSupportMask.width * objectSupportMask.height);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  for (let y = 0; y < objectSupportMask.height; y++) {
    for (let x = 0; x < objectSupportMask.width; x++) {
      const dx = (x - position.x) / scale;
      const dy = (y - position.y) / scale;
      const sourceX = Math.round(objectSupportMask.referencePoint.x + cos * dx + sin * dy);
      const sourceY = Math.round(objectSupportMask.referencePoint.y - sin * dx + cos * dy);

      if (sourceX >= 0 &&
          sourceY >= 0 &&
          sourceX < objectSupportMask.width &&
          sourceY < objectSupportMask.height &&
          objectSupportMask.data[sourceY * objectSupportMask.width + sourceX] > 0) {
        data[y * objectSupportMask.width + x] = 255;
      }
    }
  }

  return createObjectSupportMask({
    width: objectSupportMask.width,
    height: objectSupportMask.height,
    data,
    source: OBJECT_SUPPORT_MASK_SOURCES.WARPED_MASK,
    confidence: objectSupportMask.confidence,
    referencePoint: { x: position.x, y: position.y },
    createdAtFrame: objectSupportMask.createdAtFrame,
    updatedAtFrame,
  });
};
