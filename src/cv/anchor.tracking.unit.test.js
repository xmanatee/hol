import test from 'node:test';
import assert from 'node:assert/strict';
import { KeypointTracker } from './anchor.tracking.js';

const transformPoint = (point, transform) => ({
  x: transform.tx + transform.scale * Math.cos(transform.rotation) * point.x - transform.scale * Math.sin(transform.rotation) * point.y,
  y: transform.ty + transform.scale * Math.sin(transform.rotation) * point.x + transform.scale * Math.cos(transform.rotation) * point.y,
});

const createTrackedPoint = (id, original, transform) => ({
  id,
  original,
  current: transformPoint(original, transform),
  response: 1,
  status: 'active',
  errorHistory: [2],
  age: 10,
  successfulTrackingStreak: 10,
  totalSuccessfulFrames: 10,
  stabilityScore: 0.5,
  isStable: false,
});

test('reference transform preserves anchor tap offset through rotation and scale', () => {
  const tracker = new KeypointTracker();
  const transform = {
    tx: 40,
    ty: -25,
    scale: 1.18,
    rotation: 28 * Math.PI / 180,
  };
  const originals = [
    { x: 80, y: 70 },
    { x: 160, y: 70 },
    { x: 160, y: 150 },
    { x: 80, y: 150 },
    { x: 120, y: 90 },
    { x: 140, y: 130 },
  ];

  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.keypointCentroid = { x: 120, y: 110 };
  tracker.tapOffset = { x: 18, y: -12 };
  tracker.anchorOriginalPosition = {
    x: tracker.keypointCentroid.x + tracker.tapOffset.x,
    y: tracker.keypointCentroid.y + tracker.tapOffset.y,
  };

  const anchor = tracker.getAnchorPosition();
  const expected = transformPoint(tracker.anchorOriginalPosition, transform);

  assert.equal(anchor.method, 'reference_similarity_transform');
  assert.ok(Math.abs(anchor.x - expected.x) < 0.5);
  assert.ok(Math.abs(anchor.y - expected.y) < 0.5);
  assert.ok(Math.abs(anchor.rotation - transform.rotation) < 0.03);
  assert.ok(Math.abs(anchor.scale - transform.scale) < 0.03);
});

test('outlier filtering keeps coherent rotational motion instead of assuming pure translation', () => {
  const tracker = new KeypointTracker();
  const transform = {
    tx: 12,
    ty: 9,
    scale: 1,
    rotation: 18 * Math.PI / 180,
  };

  tracker.trackedPoints = Array.from({ length: 24 }, (_, index) => {
    const angle = index / 24 * Math.PI * 2;
    const original = {
      x: 140 + Math.cos(angle) * 60,
      y: 120 + Math.sin(angle) * 36,
    };
    return createTrackedPoint(index, original, transform);
  });

  tracker._filterOutliers();

  assert.equal(tracker.trackedPoints.filter(point => point.status === 'active').length, 24);
});

test('keypoint refresh preserves the original reference frame for homography pose', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };

  const transform = {
    tx: 18,
    ty: -11,
    scale: 1.1,
    rotation: 22 * Math.PI / 180,
  };
  const originals = Array.from({ length: 16 }, (_, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    return {
      x: 80 + column * 24,
      y: 70 + row * 22,
    };
  });
  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.keypointCentroid = { x: 120, y: 110 };
  tracker.tapOffset = { x: 10, y: -8 };
  tracker.anchorOriginalPosition = { x: 130, y: 102 };

  const currentGray = {
    cols: 320,
    rows: 240,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: originals.map(point => ({ pt: transformPoint(point, transform), response: 1 })),
    }),
  };

  const refreshed = tracker.refreshKeypoints({}, currentGray, detector, {
    x: 0,
    y: 0,
    width: 220,
    height: 180,
  }, transformPoint(tracker.anchorOriginalPosition, transform));

  assert.equal(refreshed, true);
  assert.deepEqual(tracker.anchorOriginalPosition, { x: 130, y: 102 });
  assert.ok(Math.abs(tracker.trackedPoints[0].original.x - originals[0].x) < 0.5);
  assert.ok(Math.abs(tracker.trackedPoints[0].original.y - originals[0].y) < 0.5);
});
