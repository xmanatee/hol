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

test('keypoint refresh expands the landmark map instead of replacing tracked points', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };

  const transform = {
    tx: -9,
    ty: 14,
    scale: 1.04,
    rotation: -16 * Math.PI / 180,
  };
  const originals = Array.from({ length: 16 }, (_, index) => ({
    x: 80 + (index % 4) * 24,
    y: 72 + Math.floor(index / 4) * 22,
  }));
  const newOriginals = Array.from({ length: 12 }, (_, index) => ({
    x: 190 + (index % 4) * 18,
    y: 74 + Math.floor(index / 4) * 20,
  }));
  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.nextPointId = originals.length;
  tracker.keypointCentroid = { x: 116, y: 105 };
  tracker.anchorOriginalPosition = { x: 124, y: 101 };
  tracker.tapOffset = { x: 8, y: -4 };

  const currentGray = {
    cols: 360,
    rows: 260,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: [
        ...originals.map(point => ({ pt: transformPoint(point, transform), response: 0.8 })),
        ...newOriginals.map(point => ({ pt: transformPoint(point, transform), response: 1.0 })),
      ],
    }),
  };

  const refreshed = tracker.refreshKeypoints({}, currentGray, detector, {
    x: 0,
    y: 0,
    width: 260,
    height: 180,
  }, transformPoint(tracker.anchorOriginalPosition, transform));

  assert.equal(refreshed, true);
  assert.equal(tracker.trackedPoints.filter(point => point.id < originals.length).length, originals.length);
  assert.ok(Math.abs(tracker.trackedPoints.find(point => point.id === 0).original.x - originals[0].x) < 0.5);
  assert.ok(Math.abs(tracker.trackedPoints.find(point => point.id === 0).original.y - originals[0].y) < 0.5);
  assert.ok(tracker.trackedPoints.length > originals.length);
  assert.ok(tracker.trackedPoints.some(point => point.original.x > 175));
  assert.deepEqual(tracker.anchorOriginalPosition, { x: 124, y: 101 });
});

test('inactive cleanup preserves stable hidden landmarks and retires weak stale points', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = [
    {
      id: 1,
      original: { x: 10, y: 10 },
      current: { x: 12, y: 11 },
      status: 'active',
      inactiveAge: 0,
      isStable: false,
      stabilityScore: 0.3,
      totalSuccessfulFrames: 5,
    },
    {
      id: 2,
      original: { x: 40, y: 10 },
      current: { x: 42, y: 11 },
      status: 'lost',
      inactiveAge: 60,
      isStable: true,
      stabilityScore: 0.85,
      totalSuccessfulFrames: 90,
    },
    {
      id: 3,
      original: { x: 70, y: 10 },
      current: { x: 72, y: 11 },
      status: 'lost',
      inactiveAge: 60,
      isStable: false,
      stabilityScore: 0.1,
      totalSuccessfulFrames: 2,
    },
  ];

  tracker._cleanupInactiveKeypoints();

  assert.deepEqual(tracker.trackedPoints.map(point => point.id), [1, 2]);
  assert.equal(tracker.trackedPoints.find(point => point.id === 2).inactiveAge, 61);
});

test('pose correspondences prefer the local planar patch around the tapped anchor', () => {
  const tracker = new KeypointTracker();
  tracker.anchorOriginalPosition = { x: 100, y: 100 };
  tracker.trackedPoints = [
    ...Array.from({ length: 16 }, (_, index) => ({
      id: index,
      original: {
        x: 82 + (index % 4) * 12,
        y: 82 + Math.floor(index / 4) * 12,
      },
      current: {
        x: 92 + (index % 4) * 12,
        y: 88 + Math.floor(index / 4) * 12,
      },
      response: 1,
      status: 'active',
      age: 20,
      errorHistory: [1],
      stabilityScore: 0.8,
    })),
    ...Array.from({ length: 16 }, (_, index) => ({
      id: 100 + index,
      original: {
        x: 220 + (index % 4) * 18,
        y: 190 + Math.floor(index / 4) * 18,
      },
      current: {
        x: 210 + (index % 4) * 8,
        y: 194 + Math.floor(index / 4) * 22,
      },
      response: 1,
      status: 'active',
      age: 20,
      errorHistory: [1],
      stabilityScore: 0.8,
    })),
  ];

  const correspondences = tracker.getCorrespondences({
    maxReferenceDistance: 36,
    minCount: 8,
    maxCount: 12,
  });

  assert.equal(correspondences.length, 12);
  assert.ok(correspondences.every(correspondence => correspondence.prev.x < 140));
  assert.ok(correspondences.every(correspondence => correspondence.prev.y < 140));
});

test('tracker restores lost landmarks from a descriptor relocalization transform', () => {
  const tracker = new KeypointTracker();
  const transform = {
    tx: 33,
    ty: -17,
    scale: 1.22,
    rotation: -19 * Math.PI / 180,
  };
  const originals = Array.from({ length: 12 }, (_, index) => ({
    x: 90 + (index % 4) * 20,
    y: 80 + Math.floor(index / 4) * 18,
  }));
  tracker.trackedPoints = originals.map((point, index) => ({
    ...createTrackedPoint(index, point, { tx: 0, ty: 0, scale: 1, rotation: 0 }),
    status: 'lost',
    inactiveAge: 12,
    successfulTrackingStreak: 0,
  }));
  tracker.keypointCentroid = { x: 120, y: 100 };
  tracker.anchorOriginalPosition = { x: 126, y: 96 };
  tracker.tapOffset = { x: 6, y: -4 };
  tracker.previousGray = { delete() {} };

  const currentGray = {
    clone: () => ({ delete() {} }),
  };

  const restored = tracker.restoreFromReferenceTransform(
    currentGray,
    transform,
    originals.map((_, index) => index)
  );

  assert.equal(restored.restored, 12);
  assert.equal(tracker.trackedPoints.filter(point => point.status === 'active').length, 12);
  assert.deepEqual(tracker.anchorOriginalPosition, { x: 126, y: 96 });
  tracker.trackedPoints.forEach((point, index) => {
    const expected = transformPoint(originals[index], transform);
    assert.ok(Math.abs(point.current.x - expected.x) < 0.01);
    assert.ok(Math.abs(point.current.y - expected.y) < 0.01);
    assert.equal(point.inactiveAge, 0);
  });
});
