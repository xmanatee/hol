import test from 'node:test';
import assert from 'node:assert/strict';

import { ParametricSurfaceReconstructor } from './anchor.parametricSurface.js';

const trackedPoint = ({ id, reference, current }) => ({
  id,
  status: 'active',
  original: reference,
  current,
  response: 1,
  stabilityScore: 1,
  age: 30,
});

const transformedPoint = reference => ({
  x: reference.x * 1.04 + reference.y * 0.03 + 12,
  y: reference.x * -0.02 + reference.y * 0.98 + 7,
});

const surfacePoints = count => Array.from({ length: count }, (_, index) => {
  const reference = {
    x: 16 + (index % 6) * 16,
    y: 24 + Math.floor(index / 6) * 24,
  };
  return trackedPoint({
    id: index,
    reference,
    current: transformedPoint(reference),
  });
});

test('parametric surface reuses the reference fit for scale and rotation', () => {
  const reconstructor = new ParametricSurfaceReconstructor();
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });
  reconstructor.frames = [{ observations: [{ id: 'reference' }] }];

  let fitCount = 0;
  reconstructor._fitAttachmentTransform = () => {
    fitCount++;
    return {
      success: true,
      transformKind: 'affine',
      transform: {
        rowX: [1, 0, 0],
        rowY: [0, 1, 0],
      },
      similarityTransform: {
        rotation: 0.12,
      },
    };
  };

  assert.equal(reconstructor._referenceScale(), 1);
  assert.equal(reconstructor._referenceRotation(), 0.12);
  assert.equal(fitCount, 1);
});

test('parametric surface skips pose fitting while the map is still mapping', () => {
  const reconstructor = new ParametricSurfaceReconstructor({
    minLandmarks: 8,
  });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });
  reconstructor.state = 'mapping';
  reconstructor.lastFailureReason = 'Move object through more surface views';

  let fitCount = 0;
  reconstructor._fitAttachmentTransform = () => {
    fitCount++;
    return { success: false };
  };

  const trackedPoints = Array.from({ length: 12 }, (_, index) => {
    const reference = {
      x: 20 + (index % 4) * 18,
      y: 30 + Math.floor(index / 4) * 24,
    };
    return trackedPoint({
      id: index,
      reference,
      current: transformedPoint(reference),
    });
  });
  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPoints);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'Move object through more surface views');
  assert.equal(fitCount, 0);
});

test('parametric surface estimates compact mature-map poses after occlusion', () => {
  const reconstructor = new ParametricSurfaceReconstructor({
    minFrames: 5,
    minLandmarks: 12,
  });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });
  const trackedPoints = surfacePoints(18);

  for (let index = 0; index < 5; index++) {
    reconstructor.addFrameFromTrackedPoints(trackedPoints, 1000 + index);
  }

  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPoints.slice(0, 8));

  assert.equal(result.success, true);
  assert.equal(result.method, 'parametric-surface');
  assert.equal(result.inlierCount, 8);
});

test('parametric surface keeps full pose support for symmetric cups', () => {
  const reconstructor = new ParametricSurfaceReconstructor({
    minFrames: 5,
    minLandmarks: 12,
  });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'cup',
  });
  const trackedPoints = surfacePoints(18);

  for (let index = 0; index < 5; index++) {
    reconstructor.addFrameFromTrackedPoints(trackedPoints, 1000 + index);
  }

  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPoints.slice(0, 8));

  assert.equal(result.success, false);
  assert.equal(result.method, 'parametric-surface');
});

test('parametric surface can return hot-path state without rebuilding preview geometry', () => {
  const reconstructor = new ParametricSurfaceReconstructor({
    minFrames: 1,
    minLandmarks: 8,
  });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });

  let previewCount = 0;
  reconstructor._createPreview = () => {
    previewCount++;
    return { points: [] };
  };

  const trackedPoints = Array.from({ length: 12 }, (_, index) => {
    const reference = {
      x: 20 + (index % 4) * 18,
      y: 30 + Math.floor(index / 4) * 24,
    };
    return trackedPoint({
      id: index,
      reference,
      current: transformedPoint(reference),
    });
  });
  const state = reconstructor.addFrameFromTrackedPoints(trackedPoints, 1000, null, {
    includePreview: false,
  });

  assert.equal('preview' in state, false);
  assert.equal(previewCount, 0);
  assert.equal(state.frameCount, 1);
  assert.equal(state.landmarkCount, 12);
});
