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

const transformedPoint = (reference) => ({
  x: reference.x * 1.04 + reference.y * 0.03 + 12,
  y: reference.x * -0.02 + reference.y * 0.98 + 7,
});

const surfacePoints = (count) =>
  Array.from({ length: count }, (_, index) => {
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

const countedSurfacePoints = (count) => {
  let originalReads = 0;
  let currentReads = 0;
  const points = surfacePoints(count).map((point) => ({
    ...point,
    get original() {
      originalReads++;
      return point.original;
    },
    get current() {
      currentReads++;
      return point.current;
    },
  }));

  return {
    points,
    expectedSingleObservationPassReads: count * 4,
    get originalReads() {
      return originalReads;
    },
    get currentReads() {
      return currentReads;
    },
  };
};

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

test('parametric surface keeps one reference fit until the surface model changes', () => {
  const reconstructor = new ParametricSurfaceReconstructor({ maxFrames: 2 });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });
  reconstructor.frames = [{ observations: [{ id: 'initial-reference' }] }];

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
        rotation: reconstructor.model === 'plane' ? 0.24 : 0.12,
      },
    };
  };

  assert.equal(reconstructor._referenceRotation(), 0.12);
  reconstructor.frames = [{ observations: [{ id: 'oldest-retained-frame' }] }];
  reconstructor.updateReferenceRegion({ x: 4, y: 6, width: 92, height: 150 }, 'mug');
  assert.equal(reconstructor._referenceRotation(), 0.12);
  assert.equal(fitCount, 1);

  reconstructor.updateReferenceRegion({ x: 4, y: 6, width: 150, height: 92 }, 'book');
  assert.equal(reconstructor._referenceRotation(), 0.24);
  assert.equal(fitCount, 2);
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

test('parametric surface reuses frame observations between mapping and pose', () => {
  const reconstructor = new ParametricSurfaceReconstructor({
    minFrames: 1,
    minLandmarks: 8,
  });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });
  const tracked = countedSurfacePoints(12);

  reconstructor.addFrameFromTrackedPoints(tracked.points, 1000, {
    includePreview: false,
  });
  const mappingConsensus = reconstructor.frameConsensusCache;
  const result = reconstructor.estimatePoseFromTrackedPoints(tracked.points, {
    includePreview: false,
  });

  assert.equal(result.success, true);
  assert.equal(tracked.originalReads, tracked.expectedSingleObservationPassReads);
  assert.equal(tracked.currentReads, tracked.expectedSingleObservationPassReads);
  assert.ok(mappingConsensus);
  assert.equal(reconstructor.frameConsensusCache, mappingConsensus);
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

  let statisticsCount = 0;
  const originalStatistics = reconstructor._statistics.bind(reconstructor);
  reconstructor._statistics = () => {
    statisticsCount++;
    return originalStatistics();
  };
  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPoints.slice(0, 8));

  assert.equal(result.success, true);
  assert.equal(result.method, 'parametric-surface');
  assert.equal(result.inlierCount, 8);
  assert.equal(statisticsCount, 1);
});

test('parametric surface can estimate hot-path pose without live preview', () => {
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

  let previewCount = 0;
  reconstructor._createPreview = () => {
    previewCount++;
    return { points: [] };
  };

  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPoints, {
    includePreview: false,
  });

  assert.equal(result.success, true);
  assert.equal('preview' in result, false);
  assert.equal(previewCount, 0);
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

test('parametric surface bounds curved affine consensus for the mobile hot path', () => {
  const reconstructor = new ParametricSurfaceReconstructor();

  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });

  assert.equal(reconstructor._consensusOptions().maxSample, 28);
  assert.equal(reconstructor._poseConsensusOptions().maxSample, 28);
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

  let statisticsCount = 0;
  const originalStatistics = reconstructor._statistics.bind(reconstructor);
  reconstructor._statistics = () => {
    statisticsCount++;
    return originalStatistics();
  };
  const originalCreatePreview = reconstructor._createPreview.bind(reconstructor);
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
  assert.equal(statisticsCount, 1);
  assert.equal(state.frameCount, 1);
  assert.equal(state.landmarkCount, 12);

  reconstructor._createPreview = originalCreatePreview;
  statisticsCount = 0;
  const previewState = reconstructor.getState();

  assert.ok(previewState.preview);
  assert.equal(statisticsCount, 1);
  assert.equal(previewState.preview.statistics, previewState.statistics);
});
