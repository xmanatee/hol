import test from 'node:test';
import assert from 'node:assert/strict';

import { DirectPhotometricReconstructor } from './anchor.directPhotometric.js';

const affinePoint = point => ({
  x: point.x * 1.08 + point.y * 0.04 + 14,
  y: point.x * -0.03 + point.y * 0.92 + 9,
});

const similarityPoint = point => {
  const scale = 1.06;
  const rotation = 0.18;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: 18 + scale * (cos * point.x - sin * point.y),
    y: -7 + scale * (sin * point.x + cos * point.y),
  };
};

const trackedPoint = ({ id, reference, current, quality }) => ({
  id,
  status: 'active',
  original: reference,
  current,
  response: quality,
  stabilityScore: 0,
  age: 0,
});

test('direct photometric coherence uses the mobile affine sample window with cluttered rankings', () => {
  const reconstructor = new DirectPhotometricReconstructor({
    minFrames: 1,
    minSurfels: 10,
  });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });
  reconstructor._attachPhotometricData = observation => ({
    ...observation,
    photometric: { values: [0.2, 0.4, 0.6], gradient: 18 },
  });
  assert.equal(reconstructor._consensusOptions().maxSample, 28);

  const outliers = Array.from({ length: 20 }, (_, index) => trackedPoint({
    id: `outlier-${index}`,
    reference: { x: index * 12, y: 0 },
    current: { x: 420 + index * 31, y: -260 + (index % 5) * 95 },
    quality: 10,
  }));
  const highQualityCollinearInliers = [0, 24, 48, 72].map((x, index) => {
    const reference = { x, y: 96 };
    return trackedPoint({
      id: `line-inlier-${index}`,
      reference,
      current: affinePoint(reference),
      quality: 9,
    });
  });
  const lowerQualitySurfaceInliers = [
    { x: 0, y: 32 },
    { x: 24, y: 32 },
    { x: 48, y: 32 },
    { x: 72, y: 32 },
    { x: 0, y: 128 },
    { x: 24, y: 128 },
    { x: 48, y: 128 },
    { x: 72, y: 128 },
  ].map((reference, index) => trackedPoint({
    id: `surface-inlier-${index}`,
    reference,
    current: affinePoint(reference),
    quality: 1,
  }));

  const state = reconstructor.addFrameFromTrackedPoints([
    ...outliers,
    ...highQualityCollinearInliers,
    ...lowerQualitySurfaceInliers,
  ]);

  assert.equal(state.frameCount, 1);
  assert.equal(state.landmarkCount, 12);
});

test('direct photometric reuses frame descriptors between mapping and pose', () => {
  const reconstructor = new DirectPhotometricReconstructor({
    minFrames: 1,
    minSurfels: 8,
  });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });

  let attachCount = 0;
  reconstructor._attachPhotometricData = observation => {
    attachCount++;
    return {
      ...observation,
      photometric: { values: [0.2, 0.4, 0.6], gradient: 18 },
    };
  };

  const trackedPoints = [
    { x: 0, y: 32 },
    { x: 24, y: 32 },
    { x: 48, y: 32 },
    { x: 72, y: 32 },
    { x: 0, y: 96 },
    { x: 24, y: 96 },
    { x: 48, y: 96 },
    { x: 72, y: 96 },
    { x: 0, y: 128 },
    { x: 24, y: 128 },
    { x: 48, y: 128 },
    { x: 72, y: 128 },
  ].map((reference, index) => trackedPoint({
    id: `point-${index}`,
    reference,
    current: affinePoint(reference),
    quality: 5,
  }));
  const grayImage = { cols: 120, rows: 160 };

  reconstructor.addFrameFromTrackedPoints(trackedPoints, 1000, grayImage);
  reconstructor.estimatePoseFromTrackedPoints(trackedPoints, grayImage);

  assert.equal(attachCount, trackedPoints.length);
});

test('direct photometric can estimate hot-path pose without live preview', () => {
  const reconstructor = new DirectPhotometricReconstructor({
    minFrames: 1,
    minSurfels: 8,
  });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });
  reconstructor._attachPhotometricData = observation => ({
    ...observation,
    photometric: { values: [0.2, 0.4, 0.6], gradient: 18 },
  });
  const trackedPoints = [
    { x: 0, y: 32 },
    { x: 24, y: 32 },
    { x: 48, y: 32 },
    { x: 72, y: 32 },
    { x: 0, y: 96 },
    { x: 24, y: 96 },
    { x: 48, y: 96 },
    { x: 72, y: 96 },
    { x: 0, y: 128 },
    { x: 24, y: 128 },
    { x: 48, y: 128 },
    { x: 72, y: 128 },
  ].map((reference, index) => trackedPoint({
    id: `point-${index}`,
    reference,
    current: affinePoint(reference),
    quality: 5,
  }));

  for (let index = 0; index < 3; index++) {
    reconstructor.addFrameFromTrackedPoints(trackedPoints, 1000 + index);
  }
  let previewCount = 0;
  reconstructor._createPreview = () => {
    previewCount++;
    return { points: [] };
  };

  const result = reconstructor.estimatePoseFromTrackedPoints(trackedPoints, null, {
    includePreview: false,
  });

  assert.equal(result.success, true);
  assert.equal('preview' in result, false);
  assert.equal(previewCount, 0);
});

test('direct photometric recovers strict similarity pose when affine consensus degenerates', () => {
  const reconstructor = new DirectPhotometricReconstructor({
    minFrames: 5,
    minSurfels: 12,
  });
  reconstructor.reset({
    anchorReference: { x: 72, y: 96 },
    templateRegion: { x: 0, y: 0, width: 120, height: 160 },
    targetClass: 'mug',
  });
  reconstructor.state = 'ready';

  const observations = Array.from({ length: 12 }, (_, index) => {
    const reference = { x: 12 + index * 10, y: 96 };
    return {
      id: `line-${index}`,
      reference,
      current: similarityPoint(reference),
      quality: 4,
      photometric: { values: [0.2, 0.4, 0.6], gradient: 18 },
    };
  });
  observations.forEach(observation => {
    reconstructor.surfels.set(observation.id, {
      id: observation.id,
      reference: observation.reference,
      observations: 5,
      descriptor: observation.photometric.values,
      gradient: 18,
      residualMean: 0,
      quality: 4,
    });
  });
  reconstructor._photometricObservationsFromTrackedPoints = () => observations;

  const result = reconstructor.estimatePoseFromTrackedPoints([], null, {
    includePreview: false,
  });

  assert.equal(result.success, true);
  assert.equal(result.recoveryKind, 'similarity-after-affine-failure');
  assert.equal(result.inlierCount, 12);
  assert.ok(result.averageResidual < 0.001);
  assert.ok(Math.abs(result.position.x - similarityPoint({ x: 72, y: 96 }).x) < 0.001);
  assert.ok(Math.abs(result.position.y - similarityPoint({ x: 72, y: 96 }).y) < 0.001);
});

test('direct photometric keeps similarity recovery out of unhandled cup targets', () => {
  const reconstructor = new DirectPhotometricReconstructor({
    minFrames: 5,
    minSurfels: 12,
  });
  reconstructor.reset({
    anchorReference: { x: 72, y: 96 },
    templateRegion: { x: 0, y: 0, width: 120, height: 160 },
    targetClass: 'cup',
  });
  reconstructor.state = 'ready';

  const observations = Array.from({ length: 12 }, (_, index) => {
    const reference = { x: 12 + index * 10, y: 96 };
    return {
      id: `line-${index}`,
      reference,
      current: similarityPoint(reference),
      quality: 4,
      photometric: { values: [0.2, 0.4, 0.6], gradient: 18 },
    };
  });
  observations.forEach(observation => {
    reconstructor.surfels.set(observation.id, {
      id: observation.id,
      reference: observation.reference,
      observations: 5,
      descriptor: observation.photometric.values,
      gradient: 18,
      residualMean: 0,
      quality: 4,
    });
  });
  reconstructor._photometricObservationsFromTrackedPoints = () => observations;

  const result = reconstructor.estimatePoseFromTrackedPoints([], null, {
    includePreview: false,
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'No robust affine consensus');
});

test('direct photometric reuses the reference fit for scale and rotation', () => {
  const reconstructor = new DirectPhotometricReconstructor();
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

test('direct photometric skips pose fitting while the map is still mapping', () => {
  const reconstructor = new DirectPhotometricReconstructor();
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });
  reconstructor.state = 'mapping';
  reconstructor.lastFailureReason = 'Move object through more photometric views';

  let observationCount = 0;
  reconstructor._photometricObservationsFromTrackedPoints = () => {
    observationCount++;
    return [];
  };

  const result = reconstructor.estimatePoseFromTrackedPoints([]);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'Move object through more photometric views');
  assert.equal(observationCount, 0);
});

test('direct photometric can return hot-path state without rebuilding preview geometry', () => {
  const reconstructor = new DirectPhotometricReconstructor({
    minFrames: 1,
    minSurfels: 8,
  });
  reconstructor.reset({
    anchorReference: { x: 40, y: 80 },
    templateRegion: { x: 0, y: 0, width: 80, height: 140 },
    targetClass: 'mug',
  });
  reconstructor._attachPhotometricData = observation => ({
    ...observation,
    photometric: { values: [0.2, 0.4, 0.6], gradient: 18 },
  });

  let previewCount = 0;
  reconstructor._createPreview = () => {
    previewCount++;
    return { points: [] };
  };

  const trackedPoints = [
    { x: 0, y: 32 },
    { x: 24, y: 32 },
    { x: 48, y: 32 },
    { x: 72, y: 32 },
    { x: 0, y: 96 },
    { x: 24, y: 96 },
    { x: 48, y: 96 },
    { x: 72, y: 96 },
    { x: 0, y: 128 },
    { x: 24, y: 128 },
    { x: 48, y: 128 },
    { x: 72, y: 128 },
  ].map((reference, index) => trackedPoint({
    id: `point-${index}`,
    reference,
    current: affinePoint(reference),
    quality: 5,
  }));
  const state = reconstructor.addFrameFromTrackedPoints(trackedPoints, 1000, null, {
    includePreview: false,
  });

  assert.equal('preview' in state, false);
  assert.equal(previewCount, 0);
  assert.equal(state.frameCount, 1);
  assert.equal(state.landmarkCount, 12);
});
