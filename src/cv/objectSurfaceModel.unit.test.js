import test from 'node:test';
import assert from 'node:assert/strict';

import { ObjectSurfaceModel } from './objectSurfaceModel.js';
import { createObjectSupportMask } from './objectSupportMask.js';

const createMask = ({ width = 160, height = 120, bbox = { x: 20, y: 20, width: 100, height: 80 } } = {}) => {
  const data = new Uint8Array(width * height);
  for (let y = bbox.y; y < bbox.y + bbox.height; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.width; x++) {
      data[y * width + x] = 255;
    }
  }

  return createObjectSupportMask({
    width,
    height,
    data,
    source: 'interactive-segmenter',
    confidence: 0.78,
    referencePoint: { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
};

const point = ({
  id,
  x,
  y,
  quality = 0.76,
  status = 'active',
  objectOwned = true,
  residual = 1.2,
  age = 20,
}) => ({
  id,
  original: { x, y },
  current: { x: x + 2, y: y + 1 },
  status,
  objectOwned,
  landmarkQuality: quality,
  totalSuccessfulFrames: age,
  age,
  errorHistory: [residual],
});

test('object surface model tracks mask-cell coverage and locked landmarks', () => {
  const model = new ObjectSurfaceModel({ cellSize: 32 });

  const state = model.update({
    objectSupportMask: createMask(),
    targetClass: 'cup',
    landmarks: [
      point({ id: 1, x: 28, y: 28, quality: 0.84 }),
      point({ id: 2, x: 72, y: 32, quality: 0.81 }),
      point({ id: 3, x: 110, y: 82, quality: 0.66 }),
      point({ id: 4, x: 36, y: 92, quality: 0.9 }),
    ],
    poseResidual: 1.4,
  });

  assert.equal(state.surfacePrior, 'tapered-cylinder');
  assert.equal(state.lockedLandmarks, 3);
  assert.ok(state.coverage > 0.3);
  assert.ok(state.coverage < 1);
  assert.equal(state.occlusionState, 'visible');
  assert.ok(state.contourSegments.length >= 4);
});

test('object surface model freezes growth during partial occlusion and exposes recovery state', () => {
  const model = new ObjectSurfaceModel({ cellSize: 32 });
  model.update({
    objectSupportMask: createMask(),
    targetClass: 'cup',
    landmarks: [
      point({ id: 1, x: 30, y: 30 }),
      point({ id: 2, x: 70, y: 30 }),
      point({ id: 3, x: 100, y: 80 }),
      point({ id: 4, x: 40, y: 90 }),
    ],
    poseResidual: 1.5,
  });

  const occluded = model.update({
    objectSupportMask: createMask(),
    targetClass: 'cup',
    landmarks: [
      point({ id: 1, x: 30, y: 30, quality: 0.72, objectOwned: true, residual: 6.5 }),
      point({ id: 2, x: 70, y: 30, quality: 0.36, objectOwned: false, residual: 9 }),
      point({ id: 3, x: 100, y: 80, quality: 0.34, objectOwned: false, residual: 9 }),
    ],
    poseResidual: 7.2,
  });

  assert.equal(occluded.occlusionState, 'partial-occlusion');
  assert.equal(occluded.allowGrowth, false);
  assert.equal(occluded.lockedLandmarks, 1);
  assert.ok(occluded.lastOcclusionReason.includes('object ownership'));

  const recovered = model.update({
    objectSupportMask: createMask(),
    targetClass: 'cup',
    landmarks: [
      point({ id: 1, x: 30, y: 30 }),
      point({ id: 2, x: 70, y: 30 }),
      point({ id: 3, x: 100, y: 80 }),
      point({ id: 4, x: 40, y: 90 }),
    ],
    poseResidual: 1.1,
  });

  assert.equal(recovered.occlusionState, 'recovering');
  assert.equal(recovered.allowGrowth, false);
});

test('object surface model only counts landmarks that are inside the current support mask', () => {
  const model = new ObjectSurfaceModel({ cellSize: 24 });
  const state = model.update({
    objectSupportMask: createMask({ bbox: { x: 20, y: 20, width: 72, height: 72 } }),
    targetClass: 'book',
    landmarks: [
      point({ id: 1, x: 32, y: 34, quality: 0.86, objectOwned: true }),
      point({ id: 2, x: 70, y: 68, quality: 0.84, objectOwned: true }),
      point({ id: 3, x: 8, y: 8, quality: 0.92, objectOwned: true }),
      point({ id: 4, x: 130, y: 106, quality: 0.9, objectOwned: true }),
    ],
    poseResidual: 1.2,
  });

  assert.equal(state.lockedLandmarks, 2);
  assert.equal(state.landmarksInsideMask, 2);
  assert.equal(state.landmarksOutsideMask, 2);
  assert.equal(state.occlusionState, 'partial-occlusion');
  assert.equal(state.allowGrowth, false);
  assert.ok(state.contourFitResidual > 0);
});

test('object surface model derives silhouette segments from the mask shape instead of the bounding box', () => {
  const model = new ObjectSurfaceModel({ cellSize: 24 });
  const width = 80;
  const height = 70;
  const data = new Uint8Array(width * height);
  for (let y = 15; y <= 55; y++) {
    for (let x = 18; x <= 60; x++) {
      const inMainBody = x <= 44;
      const inLowerTab = y >= 38;
      if (inMainBody || inLowerTab) {
        data[y * width + x] = 255;
      }
    }
  }
  const objectSupportMask = createObjectSupportMask({
    width,
    height,
    data,
    source: 'interactive-segmenter',
    confidence: 0.8,
    referencePoint: { x: 34, y: 34 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });

  const state = model.update({
    objectSupportMask,
    targetClass: 'object',
    landmarks: [
      point({ id: 1, x: 28, y: 28 }),
      point({ id: 2, x: 36, y: 48 }),
      point({ id: 3, x: 52, y: 46 }),
    ],
    poseResidual: 1.1,
  });

  assert.equal(state.silhouette.source, 'mask-boundary');
  assert.ok(state.silhouette.boundaryPointCount > state.contourSegments.length);
  assert.ok(state.contourSegments.some((segment) => segment.role === 'mask-silhouette'));
  assert.ok(state.contourSegments.some((segment) => segment.from.x > 44 && segment.from.y >= 38));
});
