import test from 'node:test';
import assert from 'node:assert/strict';
import { KeypointTracker } from './anchor.tracking.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';

const transformPoint = (point, transform) => ({
  x: transform.tx + transform.scale * Math.cos(transform.rotation) * point.x - transform.scale * Math.sin(transform.rotation) * point.y,
  y: transform.ty + transform.scale * Math.sin(transform.rotation) * point.x + transform.scale * Math.cos(transform.rotation) * point.y,
});

const projectHomographyPoint = (point, matrix) => {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
};

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

test('reference homography preserves tapped anchor through perspective tilt', async () => {
  const cv = await loadOpenCvForNode();
  const tracker = new KeypointTracker();
  const homography = [
    1.08, 0.18, 22,
    -0.05, 0.92, 18,
    0.0009, -0.0007, 1,
  ];
  const originals = Array.from({ length: 24 }, (_, index) => {
    const column = index % 6;
    const row = Math.floor(index / 6);
    return {
      x: 80 + column * 28,
      y: 70 + row * 24,
    };
  });

  tracker.trackedPoints = originals.map((point, index) => ({
    id: index,
    original: point,
    current: projectHomographyPoint(point, homography),
    response: 1,
    status: 'active',
    errorHistory: [1],
    age: 10,
    successfulTrackingStreak: 10,
    totalSuccessfulFrames: 10,
    stabilityScore: 0.7,
    isStable: true,
  }));
  tracker.keypointCentroid = { x: 150, y: 106 };
  tracker.tapOffset = { x: 21, y: -9 };
  tracker.anchorOriginalPosition = {
    x: tracker.keypointCentroid.x + tracker.tapOffset.x,
    y: tracker.keypointCentroid.y + tracker.tapOffset.y,
  };

  const anchor = tracker.getAnchorPosition(cv);
  const expected = projectHomographyPoint(tracker.anchorOriginalPosition, homography);

  assert.equal(anchor.method, 'reference_homography');
  assert.ok(Math.hypot(anchor.x - expected.x, anchor.y - expected.y) < 0.75);
  assert.ok(anchor.inlierCount >= 16);
  assert.ok(anchor.averageResidual < 0.75);
});

test('attachment positioning keeps similarity fallback when homography is unavailable', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = Array.from({ length: 6 }, (_, index) => ({
    id: index,
    original: { x: 80 + index * 12, y: 90 + (index % 2) * 18 },
    current: { x: 90 + index * 12, y: 96 + (index % 2) * 18 },
    response: 1,
    status: 'active',
    errorHistory: [8],
    age: 8,
    successfulTrackingStreak: 3,
    totalSuccessfulFrames: 8,
    stabilityScore: 0.35,
    isStable: false,
  }));
  tracker.keypointCentroid = { x: 110, y: 99 };
  tracker.tapOffset = { x: 6, y: -3 };
  tracker.anchorOriginalPosition = { x: 116, y: 96 };
  tracker._estimateReferenceTransformation = () => ({
    tx: 10,
    ty: 6,
    scale: 1,
    rotation: 0,
    confidence: 0.12,
    inlierCount: 4,
    averageResidual: 13,
  });

  const anchor = tracker.getAnchorPosition({ findHomography: () => null });

  assert.equal(anchor.method, 'reference_similarity_transform');
  assert.equal(anchor.x, 126);
  assert.equal(anchor.y, 102);
});

test('centroid anchor fallback reports weighted point motion without transform scale', () => {
  const tracker = new KeypointTracker();
  tracker.trackedPoints = [
    {
      id: 1,
      original: { x: 90, y: 90 },
      current: { x: 112, y: 98 },
      response: 1,
      status: 'active',
      errorHistory: [1],
      age: 10,
    },
    {
      id: 2,
      original: { x: 130, y: 90 },
      current: { x: 150, y: 102 },
      response: 1,
      status: 'active',
      errorHistory: [20],
      age: 4,
    },
    {
      id: 3,
      original: { x: 110, y: 130 },
      current: { x: 132, y: 136 },
      response: 1,
      status: 'inactive',
      errorHistory: [1],
      age: 10,
    },
  ];
  tracker.tapOffset = { x: 7, y: -5 };

  const anchor = tracker.getCentroidAnchorPosition();

  assert.equal(anchor.method, 'weighted_centroid_with_offset');
  assert.equal(anchor.inlierCount, 2);
  assert.ok(anchor.x > 119);
  assert.ok(anchor.x < 124);
  assert.ok(anchor.y > 93);
  assert.ok(anchor.y < 96);
  assert.equal(anchor.scale, undefined);
});

test('attachment positioning prefers the local tapped patch over distant curved-object motion', () => {
  const tracker = new KeypointTracker();
  const anchor = { x: 120, y: 110 };
  const localTransform = {
    tx: 18,
    ty: -8,
    scale: 1.04,
    rotation: 4 * Math.PI / 180,
  };
  const farTransform = {
    tx: -34,
    ty: 26,
    scale: 0.82,
    rotation: -18 * Math.PI / 180,
  };
  const localOriginals = Array.from({ length: 10 }, (_, index) => ({
    x: 96 + (index % 5) * 12,
    y: 96 + Math.floor(index / 5) * 16,
  }));
  const farOriginals = Array.from({ length: 32 }, (_, index) => ({
    x: 215 + (index % 8) * 14,
    y: 150 + Math.floor(index / 8) * 18,
  }));

  tracker.trackedPoints = [
    ...localOriginals.map((point, index) => createTrackedPoint(index, point, localTransform)),
    ...farOriginals.map((point, index) => createTrackedPoint(100 + index, point, farTransform)),
  ];
  tracker.keypointCentroid = { x: 195, y: 150 };
  tracker.anchorOriginalPosition = anchor;
  tracker.tapOffset = {
    x: tracker.anchorOriginalPosition.x - tracker.keypointCentroid.x,
    y: tracker.anchorOriginalPosition.y - tracker.keypointCentroid.y,
  };

  const predicted = tracker.getAnchorPosition();
  const expected = transformPoint(anchor, localTransform);

  assert.equal(predicted.method, 'reference_similarity_transform');
  assert.ok(Math.hypot(predicted.x - expected.x, predicted.y - expected.y) < 1.5);
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
  });

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
  });

  assert.equal(refreshed, true);
  assert.equal(tracker.trackedPoints.filter(point => point.id < originals.length).length, originals.length);
  assert.ok(Math.abs(tracker.trackedPoints.find(point => point.id === 0).original.x - originals[0].x) < 0.5);
  assert.ok(Math.abs(tracker.trackedPoints.find(point => point.id === 0).original.y - originals[0].y) < 0.5);
  assert.ok(tracker.trackedPoints.length > originals.length);
  assert.ok(tracker.trackedPoints.some(point => point.original.x > 175));
  assert.deepEqual(tracker.anchorOriginalPosition, { x: 124, y: 101 });
});

test('keypoint refresh rejects a weak homography when similarity keeps the reference frame coherent', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };

  const transform = {
    tx: -7,
    ty: 11,
    scale: 1.07,
    rotation: 14 * Math.PI / 180,
  };
  const originals = Array.from({ length: 16 }, (_, index) => ({
    x: 78 + (index % 4) * 24,
    y: 68 + Math.floor(index / 4) * 22,
  }));
  const newOriginals = Array.from({ length: 8 }, (_, index) => ({
    x: 194 + (index % 4) * 18,
    y: 80 + Math.floor(index / 4) * 20,
  }));
  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.nextPointId = originals.length;
  tracker.keypointCentroid = { x: 114, y: 101 };
  tracker.anchorOriginalPosition = { x: 122, y: 98 };
  tracker.tapOffset = { x: 8, y: -3 };
  tracker._estimateReferenceHomography = () => ({
    type: 'homography',
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    inverseMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: 1,
    rotation: 0,
    confidence: 0.08,
    inlierCount: 9,
    averageResidual: 8.4,
  });

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
    width: 300,
    height: 200,
  });

  const added = tracker.trackedPoints.filter(point => point.id >= originals.length);

  assert.equal(refreshed, true);
  assert.ok(added.length > 0);
  assert.ok(added.some(point => (
    Math.abs(point.original.x - newOriginals[0].x) < 0.6 &&
    Math.abs(point.original.y - newOriginals[0].y) < 0.6
  )));
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

test('pose correspondences exclude active landmarks already classified as background', () => {
  const tracker = new KeypointTracker();
  tracker.anchorOriginalPosition = { x: 100, y: 100 };
  tracker.trackedPoints = [
    ...Array.from({ length: 12 }, (_, index) => ({
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
      objectOwned: true,
    })),
    ...Array.from({ length: 18 }, (_, index) => ({
      id: 100 + index,
      original: {
        x: 160 + (index % 6) * 18,
        y: 150 + Math.floor(index / 6) * 18,
      },
      current: {
        x: 168 + (index % 6) * 18,
        y: 156 + Math.floor(index / 6) * 18,
      },
      response: 1,
      status: 'active',
      age: 20,
      errorHistory: [1],
      stabilityScore: 0.8,
      objectOwned: false,
    })),
  ];

  const correspondences = tracker.getCorrespondences({
    maxReferenceDistance: Infinity,
    minCount: 8,
    maxCount: 30,
  });

  assert.equal(correspondences.length, 12);
  assert.ok(correspondences.every(correspondence => correspondence.prev.x < 140));
});

test('keypoint refresh rejects textured background candidates outside the object mask', () => {
  const tracker = new KeypointTracker();
  tracker.initialized = true;
  tracker.previousGray = { delete() {} };

  const transform = {
    tx: 10,
    ty: 8,
    scale: 1,
    rotation: 0,
  };
  const originals = Array.from({ length: 12 }, (_, index) => ({
    x: 84 + (index % 4) * 12,
    y: 86 + Math.floor(index / 4) * 12,
  }));
  const objectCandidates = Array.from({ length: 10 }, (_, index) => ({
    x: 90 + (index % 5) * 9,
    y: 92 + Math.floor(index / 5) * 12,
  }));
  const backgroundCandidates = Array.from({ length: 24 }, (_, index) => ({
    x: 190 + (index % 6) * 12,
    y: 42 + Math.floor(index / 6) * 14,
  }));
  tracker.trackedPoints = originals.map((point, index) => createTrackedPoint(index, point, transform));
  tracker.trackedPoints.forEach(point => {
    point.objectOwned = true;
  });
  tracker.nextPointId = originals.length;
  tracker.keypointCentroid = { x: 102, y: 98 };
  tracker.anchorOriginalPosition = { x: 102, y: 98 };
  tracker.tapOffset = { x: 0, y: 0 };

  const maskData = new Uint8Array(320 * 240);
  for (let y = 78; y <= 136; y++) {
    for (let x = 78; x <= 156; x++) {
      maskData[y * 320 + x] = 255;
    }
  }
  const objectSupportMask = {
    width: 320,
    height: 240,
    data: maskData,
  };
  const currentGray = {
    cols: 320,
    rows: 240,
    empty: () => false,
    clone: () => ({ delete() {} }),
  };
  const detector = {
    extractKeypoints: () => ({
      keypoints: [
        ...backgroundCandidates.map(point => ({ pt: point, response: 1.0 })),
        ...objectCandidates.map(point => ({ pt: transformPoint(point, transform), response: 0.8 })),
      ],
    }),
  };

  const refreshed = tracker.refreshKeypoints({}, currentGray, detector, {
    x: 30,
    y: 20,
    width: 260,
    height: 180,
  }, objectSupportMask);

  assert.equal(refreshed, true);
  assert.ok(tracker.trackedPoints.length > originals.length);
  assert.equal(tracker.lastRefreshStats.rejectedByMask, backgroundCandidates.length);
  assert.ok(tracker.trackedPoints.every(point => point.objectOwned !== false));
  assert.ok(tracker.trackedPoints.every(point => point.current.x < 170));
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

test('stability metrics use stored anchor history instead of an unimplemented timestamp lookup', () => {
  const tracker = new KeypointTracker();
  tracker.trackingHistory = Array.from({ length: 6 }, (_, index) => ({
    timestamp: 1000 + index * 100,
    successRate: 0.86,
    anchorPosition: { x: 120 + index, y: 140 },
  }));

  const stability = tracker.getStabilityMetrics();

  assert.equal(stability.velocityStable, true);
  assert.equal(stability.coherenceStable, true);
  assert.equal(stability.overallStable, true);
});
