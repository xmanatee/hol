import test from 'node:test';
import assert from 'node:assert/strict';

import { DirectPhotometricReconstructor } from './anchor.directPhotometric.js';

const affinePoint = point => ({
  x: point.x * 1.08 + point.y * 0.04 + 14,
  y: point.x * -0.03 + point.y * 0.92 + 9,
});

const trackedPoint = ({ id, reference, current, quality }) => ({
  id,
  status: 'active',
  original: reference,
  current,
  response: quality,
  stabilityScore: 0,
  age: 0,
});

test('direct photometric coherence uses the configured affine sample window', () => {
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

  const outliers = Array.from({ length: 18 }, (_, index) => trackedPoint({
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
