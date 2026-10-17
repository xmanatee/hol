import test from 'node:test';
import assert from 'node:assert/strict';
import {
  associateLandmarkCoordinateIndexes,
  assessOrbGeometry,
  OrbKeyframeRelocalizer,
  matchOrbDescriptors,
  selectRelocalizationLandmarks,
} from './anchor.relocalization.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';

const makeDescriptor = (byte) => new Uint8Array(32).fill(byte);

const referenceHammingDistance = (left, right) => {
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    let bits = left[index] ^ right[index];
    while (bits > 0) {
      distance += bits & 1;
      bits >>>= 1;
    }
  }
  return distance;
};

const referenceMatchOrbDescriptors = (references, queries, { ratioThreshold, maxDescriptorDistance }) => {
  const nearest = (candidates) => {
    const sorted = [...candidates].sort(
      (left, right) => left.distance - right.distance || left.index - right.index,
    );
    return {
      bestIndex: sorted[0]?.index ?? -1,
      bestDistance: sorted[0]?.distance ?? Infinity,
      secondDistance: sorted[1]?.distance ?? Infinity,
    };
  };
  const forward = references.map((reference) =>
    nearest(
      queries.map((query, index) => ({
        index,
        distance: referenceHammingDistance(reference.descriptor, query.descriptor),
      })),
    ),
  );
  const reverse = queries.map((query) =>
    nearest(
      references.map((reference, index) => ({
        index,
        distance: referenceHammingDistance(query.descriptor, reference.descriptor),
      })),
    ),
  );

  return forward
    .map((match, referenceIndex) => ({ match, referenceIndex }))
    .filter(
      ({ match }) =>
        match.bestIndex >= 0 &&
        match.bestDistance <= maxDescriptorDistance &&
        match.bestDistance < match.secondDistance * ratioThreshold,
    )
    .filter(({ match, referenceIndex }) => {
      const reciprocal = reverse[match.bestIndex];
      return reciprocal.bestIndex === referenceIndex && reciprocal.bestDistance < reciprocal.secondDistance;
    })
    .map(({ match, referenceIndex }) => ({
      id: references[referenceIndex].id,
      queryIndex: match.bestIndex,
      descriptorDistance: match.bestDistance,
    }))
    .sort((left, right) => left.descriptorDistance - right.descriptorDistance);
};

const referenceLandmarkFeatureIndexes = (features, landmarks, associationRadius) => {
  const maxDistanceSquared = associationRadius * associationRadius;
  const usedFeatureIndexes = new Set();
  const associations = [];

  landmarks.forEach((landmark, landmarkIndex) => {
    let bestFeatureIndex = -1;
    let bestDistanceSquared = maxDistanceSquared;
    features.forEach((feature, featureIndex) => {
      if (usedFeatureIndexes.has(featureIndex)) return;
      const dx = feature.point.x - landmark.current.x;
      const dy = feature.point.y - landmark.current.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared <= bestDistanceSquared) {
        bestFeatureIndex = featureIndex;
        bestDistanceSquared = distanceSquared;
      }
    });
    if (bestFeatureIndex < 0) return;
    usedFeatureIndexes.add(bestFeatureIndex);
    associations.push({ landmarkIndex, featureIndex: bestFeatureIndex });
  });

  return associations;
};

const createTexturedImage = (cv) => {
  const image = cv.Mat.zeros(240, 240, cv.CV_8UC1);
  let state = 0x6d2b79f5;
  const next = () => {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x9e3779b9) | 0;
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };

  for (let index = 0; index < 90; index++) {
    const x = 14 + Math.floor(next() * 204);
    const y = 14 + Math.floor(next() * 204);
    const size = 3 + Math.floor(next() * 8);
    const intensity = 70 + Math.floor(next() * 185);
    if (index % 3 === 0) {
      cv.circle(image, new cv.Point(x, y), size, new cv.Scalar(intensity), -1);
    } else if (index % 3 === 1) {
      cv.rectangle(
        image,
        new cv.Point(x - size, y - size),
        new cv.Point(x + size, y + size),
        new cv.Scalar(intensity),
        -1,
      );
    } else {
      cv.line(
        image,
        new cv.Point(x - size, y + size),
        new cv.Point(x + size, y - size),
        new cv.Scalar(intensity),
        2,
      );
    }
  }

  return image;
};

const detectOrbPoints = (cv, image) => {
  const detector = new cv.ORB();
  detector.setMaxFeatures(420);
  detector.setFastThreshold(10);
  const mask = new cv.Mat();
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  detector.detectAndCompute(image, mask, keypoints, descriptors);
  const points = Array.from({ length: keypoints.size() }, (_, index) => {
    const keypoint = keypoints.get(index);
    return {
      pt: { x: keypoint.pt.x, y: keypoint.pt.y },
      response: keypoint.response,
    };
  });
  detector.delete();
  mask.delete();
  keypoints.delete();
  descriptors.delete();
  return points;
};

test('relocalization landmark selection accepts only mature object-owned observations', () => {
  const eligible = {
    id: 1,
    original: { x: 30, y: 40 },
    current: { x: 34, y: 43 },
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 2,
    totalSuccessfulFrames: 24,
    successfulTrackingStreak: 18,
    landmarkQuality: 0.74,
    response: 0.8,
  };
  const selected = selectRelocalizationLandmarks([
    eligible,
    { ...eligible, id: 2, objectOwned: false },
    { ...eligible, id: 3, totalSuccessfulFrames: 4 },
    { ...eligible, id: 4, successfulTrackingStreak: 2 },
    { ...eligible, id: 5, landmarkQuality: 0.31 },
    { ...eligible, id: 6, status: 'lost' },
  ]);

  assert.deepEqual(
    selected.map((point) => point.id),
    [1],
  );
});

test('relocalized map storage can include fresh object-owned landmarks without weakening normal keyframes', () => {
  const mature = {
    id: 1,
    original: { x: 30, y: 40 },
    current: { x: 34, y: 43 },
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 2,
    totalSuccessfulFrames: 24,
    successfulTrackingStreak: 18,
    landmarkQuality: 0.74,
    response: 0.8,
  };
  const fresh = {
    ...mature,
    id: 2,
    totalSuccessfulFrames: 0,
    successfulTrackingStreak: 0,
    landmarkQuality: 0.29,
  };
  const background = { ...fresh, id: 3, objectOwned: false };
  const probationary = { ...fresh, id: 4, objectOwnedStreak: 0 };
  const recoveryMapProbation = {
    ...fresh,
    id: 5,
    objectOwnedStreak: 2,
    recoveryOwnershipProbation: true,
  };

  assert.deepEqual(
    selectRelocalizationLandmarks([mature, fresh, background, probationary, recoveryMapProbation]).map(
      (point) => point.id,
    ),
    [1],
  );
  assert.deepEqual(
    selectRelocalizationLandmarks([mature, fresh, background, probationary, recoveryMapProbation], {
      includeFreshLandmarks: true,
    }).map((point) => point.id),
    [1, 2],
  );
});

test('mutual Hamming ratio matching rejects ambiguous binary descriptors', () => {
  const references = [
    { id: 1, descriptor: makeDescriptor(0) },
    { id: 2, descriptor: makeDescriptor(0) },
    { id: 3, descriptor: makeDescriptor(255) },
  ];
  const queries = [
    { point: { x: 10, y: 20 }, descriptor: makeDescriptor(0) },
    { point: { x: 40, y: 50 }, descriptor: makeDescriptor(255) },
  ];

  const matches = matchOrbDescriptors(references, queries, {
    ratioThreshold: 0.82,
    maxDescriptorDistance: 72,
  });

  assert.deepEqual(
    matches.map((match) => match.id),
    [3],
  );
});

test('packed ORB matching is bit-exact with bytewise reciprocal ratio matching', () => {
  let state = 0x7f4a7c15;
  const nextByte = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
  const createDescriptor = () => Uint8Array.from({ length: 32 }, nextByte);
  const references = Array.from({ length: 17 }, (_, id) => ({
    id,
    reference: { x: id * 7, y: id * 3 },
    descriptor: createDescriptor(),
  }));
  const queries = Array.from({ length: 41 }, (_, index) => ({
    point: { x: index * 2, y: index * 5 },
    descriptor: createDescriptor(),
  }));
  for (let index = 0; index < 11; index++) {
    queries[index].descriptor = references[index].descriptor.slice();
    queries[index].descriptor[index % 32] ^= 1 << (index % 8);
  }
  const config = {
    ratioThreshold: 0.92,
    maxDescriptorDistance: 72,
  };

  const expected = referenceMatchOrbDescriptors(references, queries, config);
  const actual = matchOrbDescriptors(references, queries, config).map((match) => ({
    id: match.id,
    queryIndex: queries.findIndex(
      (query) => query.point.x === match.point.x && query.point.y === match.point.y,
    ),
    descriptorDistance: match.descriptorDistance,
  }));

  assert.deepEqual(actual, expected);
});

test('columnar ORB landmark association is bit-exact with ordered exhaustive search', () => {
  let state = 0x51f15e;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const features = Array.from({ length: 1000 }, () => ({
    point: {
      x: Math.floor(next() * 640),
      y: Math.floor(next() * 480),
    },
  }));
  const landmarks = Array.from({ length: 96 }, () => ({
    current: {
      x: Math.floor(next() * 640),
      y: Math.floor(next() * 480),
    },
  }));
  features.push({ point: { x: 100, y: 100 } }, { point: { x: 100, y: 100 } });
  landmarks.unshift({ current: { x: 100, y: 100 } });

  const expected = referenceLandmarkFeatureIndexes(features, landmarks, 16);
  assert.deepEqual(
    associateLandmarkCoordinateIndexes(
      Float64Array.from(features, (feature) => feature.point.x),
      Float64Array.from(features, (feature) => feature.point.y),
      landmarks,
      16,
    ),
    expected,
  );
});

test('ORB geometry validation rejects reflections, collapse, and concentrated matches', () => {
  const inliers = [
    { reference: { x: 20, y: 30 }, current: { x: 40, y: 20 } },
    { reference: { x: 100, y: 30 }, current: { x: 40, y: 100 } },
    { reference: { x: 20, y: 110 }, current: { x: -40, y: 20 } },
    { reference: { x: 100, y: 110 }, current: { x: -40, y: 100 } },
    { reference: { x: 60, y: 45 }, current: { x: 25, y: 60 } },
    { reference: { x: 60, y: 95 }, current: { x: -25, y: 60 } },
  ];
  const valid = assessOrbGeometry({
    transform: { rowX: [0, -1, 70], rowY: [1, 0, 0] },
    inliers,
    averageResidual: 1.4,
  });
  assert.equal(valid.valid, true, valid.reason);

  const reflected = assessOrbGeometry({
    transform: { rowX: [-1, 0, 140], rowY: [0, 1, 0] },
    inliers,
    averageResidual: 1.4,
  });
  assert.equal(reflected.valid, false);
  assert.match(reflected.reason, /reflected|collapsed/i);

  const concentrated = assessOrbGeometry({
    transform: { rowX: [1, 0, 4], rowY: [0, 1, 6] },
    inliers: inliers.map((inlier, index) => ({
      reference: { x: index, y: index % 2 },
      current: { x: index + 4, y: (index % 2) + 6 },
    })),
    averageResidual: 0.2,
  });
  assert.equal(concentrated.valid, false);
  assert.match(concentrated.reason, /spatially concentrated/i);
});

test('ORB keyframes relocalize a low-contrast 90-degree rotation with partial occlusion', async () => {
  const cv = await loadOpenCvForNode();
  const reference = createTexturedImage(cv);
  const detected = detectOrbPoints(cv, reference)
    .sort((left, right) => right.response - left.response)
    .slice(0, 120);
  assert.ok(detected.length >= 40);

  const trackedPoints = detected.map((keypoint, index) => ({
    id: index,
    original: { ...keypoint.pt },
    current: { ...keypoint.pt },
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 2,
    bootstrapOnly: false,
    totalSuccessfulFrames: 36,
    successfulTrackingStreak: 30,
    age: 36,
    stabilityScore: 0.82,
    landmarkQuality: 0.86,
    response: keypoint.response,
  }));
  const relocalizer = new OrbKeyframeRelocalizer({
    minMatches: 8,
    minInliers: 8,
    maxStorageFeatures: 420,
    maxQueryFeatures: 420,
  });

  const stored = relocalizer.storeKeyframe({
    cv,
    grayImage: reference,
    trackedPoints,
    anchorPoint: { x: 120, y: 120 },
    timestamp: 1000,
  });
  assert.equal(stored.success, true);
  assert.ok(stored.descriptorCount >= 20);
  assert.equal(relocalizer.keyframes[0].entries[0].descriptor.buffer.byteLength, stored.descriptorCount * 32);
  const redundant = relocalizer.storeKeyframe({
    cv,
    grayImage: reference,
    trackedPoints,
    anchorPoint: { x: 120, y: 120 },
    timestamp: 1010,
  });
  assert.equal(redundant.success, false);
  assert.equal(redundant.storageEvaluated, false);
  assert.match(redundant.reason, /redundant/i);
  assert.equal(relocalizer.keyframes.length, 1);

  const query = new cv.Mat();
  cv.rotate(reference, query, cv.ROTATE_90_CLOCKWISE);
  cv.rectangle(query, new cv.Point(154, 0), new cv.Point(239, 82), new cv.Scalar(0), -1);
  for (let index = 0; index < query.data.length; index++) {
    query.data[index] = 18 + Math.round(query.data[index] * 0.18);
  }

  const result = relocalizer.relocalize(cv, query);

  assert.equal(result.success, true, result.reason);
  assert.equal(result.method, 'orb-keyframe-relocalization');
  assert.equal(result.transform.type, 'affine');
  assert.ok(result.queryFeatureCount >= 40);
  assert.ok(result.inlierCount >= 8);
  assert.equal(result.inlierMatches.length, result.inlierCount);
  assert.ok(result.timings.featureExtractionMs > 0);
  assert.ok(result.timings.keyframeSearchMs > 0);
  assert.ok(Math.abs(result.anchorPoint.x - 119) < 5, `anchor x was ${result.anchorPoint.x}`);
  assert.ok(Math.abs(result.anchorPoint.y - 120) < 5, `anchor y was ${result.anchorPoint.y}`);
  const center = {
    x: result.transform.rowX[0] * 120 + result.transform.rowX[1] * 120 + result.transform.rowX[2],
    y: result.transform.rowY[0] * 120 + result.transform.rowY[1] * 120 + result.transform.rowY[2],
  };
  assert.ok(Math.abs(center.x - 119) < 5, `center x was ${center.x}`);
  assert.ok(Math.abs(center.y - 120) < 5, `center y was ${center.y}`);

  const searchRegion = { x: 20, y: 18, width: 196, height: 202 };
  const localResult = relocalizer.relocalize(cv, query, { searchRegion });
  assert.equal(localResult.success, true, localResult.reason);
  assert.equal(localResult.frameFeatures, undefined);
  assert.deepEqual(localResult.searchRegion, searchRegion);
  assert.ok(localResult.queryFeatureCount < result.queryFeatureCount);
  assert.ok(Math.abs(localResult.anchorPoint.x - 119) < 5, `local anchor x was ${localResult.anchorPoint.x}`);
  assert.ok(Math.abs(localResult.anchorPoint.y - 120) < 5, `local anchor y was ${localResult.anchorPoint.y}`);
  assert.throws(
    () =>
      relocalizer.relocalize(cv, query, {
        searchRegion: { x: 20.5, y: 18, width: 196, height: 202 },
      }),
    /integer rectangle inside the image/,
  );

  reference.delete();
  query.delete();
});

test('keyframe redundancy separates rich absolute motion from planar residual deformation', () => {
  const relocalizer = new OrbKeyframeRelocalizer({
    minMatches: 5,
    minKeyframeEntries: 8,
  });
  const trackedPoints = Array.from({ length: 14 }, (_, index) => ({
    id: index,
    original: { x: 30 + (index % 4) * 20, y: 40 + Math.floor(index / 4) * 30 },
    current: { x: 48 + (index % 4) * 20, y: 29 + Math.floor(index / 4) * 30 },
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 8,
    bootstrapOnly: false,
    totalSuccessfulFrames: 20,
    successfulTrackingStreak: 16,
    landmarkQuality: 0.9,
  }));
  relocalizer.keyframes.push({
    id: 0,
    entries: trackedPoints.map((point) => ({
      id: point.id,
      landmarkPoint: { x: point.current.x - 18, y: point.current.y + 11 },
    })),
  });

  assert.equal(relocalizer._isRedundantLandmarkView(trackedPoints), false);
  assert.equal(relocalizer._isRedundantLandmarkView(trackedPoints, true), true);
  const boundedAbsolutePoints = trackedPoints.map((point) => ({
    ...point,
    current: { x: point.current.x - 18 + 4.5, y: point.current.y + 11 },
  }));
  const novelAbsolutePoints = trackedPoints.map((point) => ({
    ...point,
    current: { x: point.current.x - 18 + 5.5, y: point.current.y + 11 },
  }));
  assert.equal(relocalizer._isRedundantLandmarkView(boundedAbsolutePoints), true);
  assert.equal(relocalizer._isRedundantLandmarkView(novelAbsolutePoints), false);
  assert.equal(relocalizer._isRedundantLandmarkView(boundedAbsolutePoints.slice(0, 12)), false);
  const boundedResidualPoints = trackedPoints.map((point, index) => ({
    ...point,
    current: { ...point.current, x: point.current.x + (index % 2 ? 3.5 : -3.5) },
  }));
  const novelResidualPoints = trackedPoints.map((point, index) => ({
    ...point,
    current: { ...point.current, x: point.current.x + (index % 2 ? 4.5 : -4.5) },
  }));
  assert.equal(relocalizer._isRedundantLandmarkView(boundedResidualPoints, true), true);
  assert.equal(relocalizer._isRedundantLandmarkView(novelResidualPoints, true), false);
  const rotatedPoints = trackedPoints.map((point) => {
    const x = point.current.x - 78;
    const y = point.current.y - 44;
    return {
      ...point,
      current: {
        x: 78 + x * Math.cos(0.35) - y * Math.sin(0.35),
        y: 44 + x * Math.sin(0.35) + y * Math.cos(0.35),
      },
    };
  });
  assert.equal(relocalizer._isRedundantLandmarkView(rotatedPoints, true), false);

  const result = relocalizer.storeKeyframe({
    cv: null,
    grayImage: null,
    trackedPoints,
    anchorPoint: { x: 78, y: 44 },
    timestamp: 1000,
    translationInvariantRedundancy: true,
  });
  assert.equal(result.success, false);
  assert.equal(result.storageEvaluated, false);
  assert.match(result.reason, /redundant/i);
});

test('successful full-frame relocalization reuses its exact ORB extraction for same-frame storage', async () => {
  const cv = await loadOpenCvForNode();
  const image = createTexturedImage(cv);
  const detected = detectOrbPoints(cv, image)
    .sort((left, right) => right.response - left.response)
    .slice(0, 120);
  const trackedPoints = detected.map((keypoint, index) => ({
    id: index,
    original: { ...keypoint.pt },
    current: { ...keypoint.pt },
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 2,
    bootstrapOnly: false,
    totalSuccessfulFrames: 36,
    successfulTrackingStreak: 30,
    landmarkQuality: 0.86,
    response: keypoint.response,
  }));
  const realOrb = cv.ORB;
  let detectorCount = 0;
  let extractionCount = 0;
  const instrumentedCv = Object.create(cv);
  Object.defineProperty(instrumentedCv, 'ORB', {
    value: function InstrumentedOrb() {
      detectorCount++;
      const detector = new realOrb();
      const detectAndCompute = detector.detectAndCompute.bind(detector);
      detector.detectAndCompute = (...args) => {
        extractionCount++;
        return detectAndCompute(...args);
      };
      return detector;
    },
  });
  const relocalizer = new OrbKeyframeRelocalizer({
    minMatches: 8,
    minInliers: 8,
    maxStorageFeatures: 420,
    maxQueryFeatures: 420,
  });

  const initial = relocalizer.storeKeyframe({
    cv: instrumentedCv,
    grayImage: image,
    trackedPoints,
    anchorPoint: { x: 120, y: 120 },
    timestamp: 1000,
  });
  const relocalized = relocalizer.relocalize(instrumentedCv, image);
  assert.equal(relocalizer.lastResult.frameFeatures, undefined);
  const newLandmarks = trackedPoints.slice(0, 4).map((point, index) => ({
    ...point,
    id: 1000 + index,
    landmarkQuality: 0.99,
    totalSuccessfulFrames: 100,
    successfulTrackingStreak: 100,
  }));
  const stored = relocalizer.storeKeyframe({
    cv: instrumentedCv,
    grayImage: image,
    trackedPoints: [...newLandmarks, ...trackedPoints],
    anchorPoint: { x: 120, y: 120 },
    timestamp: 1010,
    frameFeatures: relocalized.frameFeatures,
  });

  assert.equal(initial.success, true);
  assert.equal(relocalized.success, true, relocalized.reason);
  assert.ok(relocalized.frameFeatures);
  assert.equal(stored.success, true, stored.reason);
  assert.equal(stored.storageEvaluated, true);
  assert.equal(stored.featureExtractionMs, undefined);
  assert.equal(detectorCount, 1);
  assert.equal(extractionCount, 2);
  assert.equal(
    relocalizer.keyframes.at(-1).entries[0].descriptor.buffer.byteLength,
    stored.descriptorCount * 32,
  );
  const workspaceHandles = Object.values(relocalizer.extractionWorkspace).filter(
    (value) => typeof value?.delete === 'function',
  );
  relocalizer.dispose();
  assert.ok(workspaceHandles.every((handle) => handle.isDeleted()));
  assert.equal(relocalizer.extractionWorkspace, null);

  image.delete();
});

test('failed full-frame relocalization still reuses its exact ORB extraction for same-frame storage', async () => {
  const cv = await loadOpenCvForNode();
  const image = createTexturedImage(cv);
  const detected = detectOrbPoints(cv, image)
    .sort((left, right) => right.response - left.response)
    .slice(0, 120);
  const trackedPoints = detected.map((keypoint, index) => ({
    id: index,
    original: { ...keypoint.pt },
    current: { ...keypoint.pt },
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 2,
    bootstrapOnly: false,
    totalSuccessfulFrames: 36,
    successfulTrackingStreak: 30,
    landmarkQuality: 0.86,
    response: keypoint.response,
  }));
  const realOrb = cv.ORB;
  let detectorCount = 0;
  let extractionCount = 0;
  const instrumentedCv = Object.create(cv);
  Object.defineProperty(instrumentedCv, 'ORB', {
    value: function InstrumentedOrb() {
      detectorCount++;
      const detector = new realOrb();
      const detectAndCompute = detector.detectAndCompute.bind(detector);
      detector.detectAndCompute = (...args) => {
        extractionCount++;
        return detectAndCompute(...args);
      };
      return detector;
    },
  });
  const relocalizer = new OrbKeyframeRelocalizer({
    minMatches: 8,
    minInliers: 120,
    maxStorageFeatures: 420,
    maxQueryFeatures: 420,
  });

  const initial = relocalizer.storeKeyframe({
    cv: instrumentedCv,
    grayImage: image,
    trackedPoints,
    anchorPoint: { x: 120, y: 120 },
    timestamp: 1000,
  });
  const relocalized = relocalizer.relocalize(instrumentedCv, image);
  assert.equal(relocalizer.lastResult.frameFeatures, undefined);
  const newLandmarks = trackedPoints.slice(0, 4).map((point, index) => ({
    ...point,
    id: 1000 + index,
    landmarkQuality: 0.99,
    totalSuccessfulFrames: 100,
    successfulTrackingStreak: 100,
  }));
  const stored = relocalizer.storeKeyframe({
    cv: instrumentedCv,
    grayImage: image,
    trackedPoints: [...newLandmarks, ...trackedPoints],
    anchorPoint: { x: 120, y: 120 },
    timestamp: 1010,
    frameFeatures: relocalized.frameFeatures,
  });

  assert.equal(initial.success, true);
  assert.equal(relocalized.success, false);
  assert.ok(relocalized.frameFeatures);
  assert.equal(stored.success, true, stored.reason);
  assert.equal(stored.storageEvaluated, true);
  assert.equal(stored.featureExtractionMs, undefined);
  assert.equal(detectorCount, 1);
  assert.equal(extractionCount, 2);

  image.delete();
});

test('keyframe storage rejects an impossible descriptor quorum before ORB extraction', async () => {
  const cv = await loadOpenCvForNode();
  const image = createTexturedImage(cv);
  const trackedPoints = detectOrbPoints(cv, image)
    .sort((left, right) => right.response - left.response)
    .slice(0, 6)
    .map((keypoint, index) => ({
      id: index,
      original: { ...keypoint.pt },
      current: { ...keypoint.pt },
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 2,
      bootstrapOnly: false,
      totalSuccessfulFrames: 36,
      successfulTrackingStreak: 30,
      landmarkQuality: 0.86,
      response: keypoint.response,
    }));
  const realOrb = cv.ORB;
  let extractionCount = 0;
  const instrumentedCv = Object.create(cv);
  Object.defineProperty(instrumentedCv, 'ORB', {
    value: function InstrumentedOrb() {
      extractionCount++;
      return new realOrb();
    },
  });
  const relocalizer = new OrbKeyframeRelocalizer({
    minMatches: 5,
    minKeyframeEntries: 8,
    maxStorageFeatures: 420,
  });

  const stored = relocalizer.storeKeyframe({
    cv: instrumentedCv,
    grayImage: image,
    trackedPoints,
    anchorPoint: { x: 120, y: 120 },
    timestamp: 1000,
  });

  assert.equal(stored.success, false);
  assert.equal(stored.storageEvaluated, true);
  assert.equal('featuresEvaluated' in stored, false);
  assert.equal(stored.descriptorCount, 0);
  assert.match(stored.reason, /Only 6 mature object-owned landmarks available/);
  assert.equal(extractionCount, 0);

  image.delete();
});
