export const OBJECT_SUPPORT_MASK_SOURCES = Object.freeze({
  INTERACTIVE_SEGMENTER: 'interactive-segmenter',
  DETECTION_BOX: 'detection-box',
  WARPED_MASK: 'warped-mask',
});

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
  };

  mask.bbox = getObjectSupportBounds(mask);
  return mask;
};

export const createDetectionBoxObjectSupportMask = ({
  width,
  height,
  detection,
  referencePoint,
  createdAtFrame,
}) => {
  const data = new Uint8Array(width * height);
  const minX = Math.max(0, Math.floor(detection.x1));
  const minY = Math.max(0, Math.floor(detection.y1));
  const maxX = Math.min(width - 1, Math.ceil(detection.x2));
  const maxY = Math.min(height - 1, Math.ceil(detection.y2));

  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * width;
    for (let x = minX; x <= maxX; x++) {
      data[rowOffset + x] = 255;
    }
  }

  return createObjectSupportMask({
    width,
    height,
    data,
    source: OBJECT_SUPPORT_MASK_SOURCES.DETECTION_BOX,
    confidence: 0.35,
    referencePoint,
    createdAtFrame,
    updatedAtFrame: createdAtFrame,
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
