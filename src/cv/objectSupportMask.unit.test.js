import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDetectionBoxObjectSupportMask,
  createObjectSupportMask,
  createRegionOpenCvMask,
  getObjectSupportBounds,
  isPointInsideObjectSupport,
  keepConnectedComponentContainingPoint,
  warpObjectSupportMask,
} from './objectSupportMask.js';

test('object support bounds are derived from positive mask pixels', () => {
  const data = new Uint8Array(12 * 10);
  for (let y = 3; y <= 6; y++) {
    for (let x = 4; x <= 8; x++) {
      data[y * 12 + x] = 255;
    }
  }

  const mask = createObjectSupportMask({
    width: 12,
    height: 10,
    data,
    source: 'interactive-segmenter',
    confidence: 0.82,
    referencePoint: { x: 6, y: 5 },
    createdAtFrame: 3,
    updatedAtFrame: 4,
  });

  assert.deepEqual(mask.bbox, { x: 4, y: 3, width: 5, height: 4 });
  assert.deepEqual(getObjectSupportBounds(mask), { x: 4, y: 3, width: 5, height: 4 });
  assert.equal(isPointInsideObjectSupport(mask, { x: 6, y: 5 }), true);
  assert.equal(isPointInsideObjectSupport(mask, { x: 3, y: 5 }), false);
});

test('object support mask warps from reference point to current anchor transform', () => {
  const data = new Uint8Array(40 * 30);
  for (let y = 12; y < 16; y++) {
    for (let x = 18; x < 22; x++) {
      data[y * 40 + x] = 255;
    }
  }

  const referenceMask = createObjectSupportMask({
    width: 40,
    height: 30,
    data,
    source: 'interactive-segmenter',
    confidence: 0.8,
    referencePoint: { x: 20, y: 14 },
    createdAtFrame: 1,
    updatedAtFrame: 1,
  });

  const warped = warpObjectSupportMask(referenceMask, {
    position: { x: 26, y: 16 },
    scale: 1,
    rotation: 0,
    updatedAtFrame: 8,
  });

  assert.equal(warped.source, 'warped-mask');
  assert.equal(warped.createdAtFrame, 1);
  assert.equal(warped.updatedAtFrame, 8);
  assert.equal(isPointInsideObjectSupport(warped, { x: 26, y: 16 }), true);
  assert.equal(isPointInsideObjectSupport(warped, { x: 20, y: 14 }), false);
  assert.deepEqual(warped.referencePoint, { x: 26, y: 16 });
});

test('object support mask supports right-angle turns without losing filled interior support', () => {
  const data = new Uint8Array(50 * 50);
  for (let y = 18; y <= 22; y++) {
    for (let x = 24; x <= 26; x++) {
      data[y * 50 + x] = 255;
    }
  }

  const referenceMask = createObjectSupportMask({
    width: 50,
    height: 50,
    data,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 25, y: 20 },
    createdAtFrame: 2,
    updatedAtFrame: 2,
  });

  const warped = warpObjectSupportMask(referenceMask, {
    position: { x: 25, y: 25 },
    scale: 1,
    rotation: Math.PI / 2,
    updatedAtFrame: 10,
  });

  assert.equal(isPointInsideObjectSupport(warped, { x: 25, y: 25 }), true);
  assert.equal(isPointInsideObjectSupport(warped, { x: 23, y: 25 }), true);
  assert.equal(isPointInsideObjectSupport(warped, { x: 27, y: 25 }), true);
  assert.equal(isPointInsideObjectSupport(warped, { x: 25, y: 22 }), false);
});

test('object support mask fills scaled-up support instead of leaving sparse forward-warp holes', () => {
  const data = new Uint8Array(40 * 40);
  for (let y = 9; y <= 11; y++) {
    for (let x = 9; x <= 11; x++) {
      data[y * 40 + x] = 255;
    }
  }

  const referenceMask = createObjectSupportMask({
    width: 40,
    height: 40,
    data,
    source: 'interactive-segmenter',
    confidence: 0.86,
    referencePoint: { x: 10, y: 10 },
    createdAtFrame: 4,
    updatedAtFrame: 4,
  });

  const warped = warpObjectSupportMask(referenceMask, {
    position: { x: 20, y: 20 },
    scale: 2,
    rotation: 0,
    updatedAtFrame: 12,
  });

  assert.equal(isPointInsideObjectSupport(warped, { x: 20, y: 20 }), true);
  assert.equal(isPointInsideObjectSupport(warped, { x: 21, y: 20 }), true);
  assert.equal(isPointInsideObjectSupport(warped, { x: 20, y: 21 }), true);
  assert.ok(getObjectSupportBounds(warped).width > referenceMask.bbox.width);
  assert.ok(getObjectSupportBounds(warped).height > referenceMask.bbox.height);
});

test('object support mask keeps only the connected component containing the tap point', () => {
  const data = new Uint8Array(12 * 8);
  for (let y = 1; y <= 3; y++) {
    for (let x = 1; x <= 3; x++) {
      data[y * 12 + x] = 255;
    }
  }
  for (let y = 4; y <= 6; y++) {
    for (let x = 8; x <= 10; x++) {
      data[y * 12 + x] = 255;
    }
  }

  const filtered = keepConnectedComponentContainingPoint({
    width: 12,
    height: 8,
    data,
    point: { x: 2, y: 2 },
  });

  assert.equal(filtered[2 * 12 + 2], 255);
  assert.equal(filtered[5 * 12 + 9], 0);
});

test('detection-box support mask clamps to the selected detection and frame bounds', () => {
  const mask = createDetectionBoxObjectSupportMask({
    width: 10,
    height: 8,
    detection: {
      x1: -2.4,
      y1: 2.2,
      x2: 5.1,
      y2: 10.6,
    },
    referencePoint: { x: 4, y: 5 },
    createdAtFrame: 3,
  });

  assert.equal(mask.source, 'detection-box');
  assert.deepEqual(mask.bbox, { x: 0, y: 2, width: 7, height: 6 });
  assert.equal(isPointInsideObjectSupport(mask, { x: 0, y: 2 }), true);
  assert.equal(isPointInsideObjectSupport(mask, { x: 6, y: 7 }), true);
  assert.equal(isPointInsideObjectSupport(mask, { x: 7, y: 7 }), false);
});

test('region OpenCV mask clamps frame-edge and narrow support lookups', () => {
  const data = new Uint8Array(8 * 6);
  data[0] = 255;
  data[5 * 8 + 7] = 255;
  const mask = createObjectSupportMask({
    width: 8,
    height: 6,
    data,
    source: 'interactive-segmenter',
    confidence: 0.8,
    referencePoint: { x: 0, y: 0 },
    createdAtFrame: 1,
    updatedAtFrame: 1,
  });
  class FakeMask {
    constructor(width, height) {
      this.cols = width;
      this.rows = height;
      this.data = new Uint8Array(width * height);
    }
  }
  const cv = {
    CV_8UC1: 0,
    Mat: {
      zeros: (height, width) => new FakeMask(width, height),
    },
  };

  const regionMask = createRegionOpenCvMask(cv, mask, {
    x: -1,
    y: -1,
    width: 10,
    height: 8,
  });

  assert.equal(regionMask.data[1 * 10 + 1], 255);
  assert.equal(regionMask.data[6 * 10 + 8], 255);
  assert.equal(regionMask.data[0], 0);
  assert.equal(regionMask.data[7 * 10 + 9], 0);
});
