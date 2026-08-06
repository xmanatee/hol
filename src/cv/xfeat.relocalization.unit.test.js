import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchXFeatDescriptors,
  postprocessXFeatOutputs,
  preprocessXFeatImageData,
  XFeatKeyframeRelocalizer,
} from './xfeat.relocalization.js';

const descriptor = (channel) => {
  const values = new Float32Array(64);
  values[channel] = 1;
  return values;
};

test('XFeat preprocessing produces normalized planar RGB with center-aligned resize', () => {
  const imageData = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([0, 10, 20, 255, 100, 110, 120, 255, 200, 210, 220, 255, 255, 250, 240, 255]),
  };

  const tensor = preprocessXFeatImageData(imageData, { width: 1, height: 1 });

  assert.deepEqual(tensor.dims, [1, 3, 1, 1]);
  assert.ok(Math.abs(tensor.data[0] - 138.75 / 255) < 1e-6);
  assert.ok(Math.abs(tensor.data[1] - 145 / 255) < 1e-6);
  assert.ok(Math.abs(tensor.data[2] - 150 / 255) < 1e-6);
});

test('XFeat postprocessing applies 5x5 NMS, reliability ranking, and descriptor normalization', () => {
  const width = 8;
  const height = 8;
  const heatmap = new Float32Array(width * height);
  const reliability = new Float32Array(width * height).fill(1);
  heatmap[3 * width + 3] = 0.9;
  heatmap[3 * width + 4] = 0.8;
  heatmap[6 * width + 6] = 0.7;
  reliability[3 * width + 3] = 0.5;
  reliability[6 * width + 6] = 0.9;
  const descriptorData = new Float32Array(64);
  descriptorData[0] = 3;
  descriptorData[1] = 4;

  const features = postprocessXFeatOutputs(
    {
      descriptors: { data: descriptorData, dims: [1, 64, 1, 1] },
      heatmap: { data: heatmap, dims: [1, 1, height, width] },
      reliability: { data: reliability, dims: [1, 1, height, width] },
    },
    {
      sourceWidth: 80,
      sourceHeight: 40,
      maxFeatures: 2,
    },
  );

  assert.equal(features.length, 2);
  assert.deepEqual(
    features.map((feature) => feature.point),
    [
      { x: 60, y: 30 },
      { x: 30, y: 15 },
    ],
  );
  assert.ok(Math.abs(features[0].descriptor[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(features[0].descriptor[1] - 0.8) < 1e-6);
});

test('XFeat matching accepts only thresholded mutual nearest neighbours', () => {
  const references = [
    { id: 1, descriptor: descriptor(0), reference: { x: 0, y: 0 } },
    { id: 2, descriptor: descriptor(1), reference: { x: 10, y: 0 } },
  ];
  const queries = [
    { descriptor: descriptor(0), point: { x: 2, y: 3 } },
    { descriptor: descriptor(1), point: { x: 12, y: 3 } },
    { descriptor: descriptor(2), point: { x: 20, y: 20 } },
  ];

  const matches = matchXFeatDescriptors(references, queries, { minCosineSimilarity: 0.82 });

  assert.deepEqual(
    matches.map((match) => ({ id: match.id, point: match.point })),
    [
      { id: 1, point: { x: 2, y: 3 } },
      { id: 2, point: { x: 12, y: 3 } },
    ],
  );
});

test('XFeat relocalizer associates learned features with landmarks and restores affine geometry', async () => {
  const referenceFeatures = [];
  const queryFeatures = [];
  const landmarks = [];
  for (let index = 0; index < 8; index++) {
    const x = 24 + (index % 4) * 28;
    const y = 32 + Math.floor(index / 4) * 36;
    referenceFeatures.push({ point: { x: x + 1, y: y - 1 }, descriptor: descriptor(index), response: 0.9 });
    queryFeatures.push({
      point: { x: (x + 1) * 1.1 + 14, y: (y - 1) * 0.95 - 6 },
      descriptor: descriptor(index),
      response: 0.9,
    });
    landmarks.push({
      id: index,
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 5,
      recentDropout: false,
      original: { x, y },
      current: { x, y },
      totalSuccessfulFrames: 8,
      successfulTrackingStreak: 8,
      landmarkQuality: 0.9,
      response: 0.8,
    });
  }
  const extracted = [referenceFeatures, queryFeatures];
  const relocalizer = new XFeatKeyframeRelocalizer({
    extractFeatures: async () => extracted.shift(),
  });

  const stored = await relocalizer.storeReference({
    imageData: { width: 160, height: 120, data: new Uint8ClampedArray(160 * 120 * 4) },
    trackedPoints: landmarks,
    anchorPoint: { x: 66, y: 50 },
  });
  const result = await relocalizer.relocalize({
    width: 160,
    height: 120,
    data: new Uint8ClampedArray(160 * 120 * 4),
  });

  assert.equal(stored.success, true);
  assert.equal(stored.descriptorCount, 8);
  assert.equal(result.success, true);
  assert.equal(result.method, 'xfeat-keyframe-relocalization');
  assert.equal(result.inlierCount, 8);
  assert.ok(Math.abs(result.anchorPoint.x - 86.6) < 0.2);
  assert.ok(Math.abs(result.anchorPoint.y - 41.5) < 0.2);
  assert.deepEqual(
    result.inlierMatches.map((match) => match.id),
    landmarks.map((point) => point.id),
  );
});

test('XFeat memory keeps initial and mature views and selects the strongest geometry', async () => {
  const initialFeatures = [];
  const matureFeatures = [];
  const queryFeatures = [];
  const initialLandmarks = [];
  const matureLandmarks = [];
  for (let index = 0; index < 8; index++) {
    const original = {
      x: 24 + (index % 4) * 28,
      y: 32 + Math.floor(index / 4) * 36,
    };
    const maturePoint = { x: original.x + 20, y: original.y + 5 };
    initialFeatures.push({ point: { ...original }, descriptor: descriptor(index), response: 0.9 });
    matureFeatures.push({ point: { ...maturePoint }, descriptor: descriptor(index + 8), response: 0.9 });
    queryFeatures.push({
      point: { x: maturePoint.x * 1.1 + 14, y: maturePoint.y * 0.95 - 6 },
      descriptor: descriptor(index + 8),
      response: 0.9,
    });
    const landmark = {
      id: index,
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 5,
      recentDropout: false,
      original,
      totalSuccessfulFrames: 8,
      successfulTrackingStreak: 8,
      landmarkQuality: 0.9,
      response: 0.8,
    };
    initialLandmarks.push({ ...landmark, current: original });
    matureLandmarks.push({ ...landmark, current: maturePoint });
  }
  const extracted = [initialFeatures, matureFeatures, queryFeatures];
  const relocalizer = new XFeatKeyframeRelocalizer({
    extractFeatures: async () => extracted.shift(),
  });

  const initial = await relocalizer.storeReference({
    imageData: { width: 160, height: 120 },
    trackedPoints: initialLandmarks,
    anchorPoint: { x: 66, y: 50 },
  });
  const mature = await relocalizer.storeReference({
    imageData: { width: 160, height: 120 },
    trackedPoints: matureLandmarks,
    anchorPoint: { x: 86, y: 55 },
  });
  const rejectedThirdView = await relocalizer.storeReference({
    imageData: { width: 160, height: 120 },
    trackedPoints: matureLandmarks,
    anchorPoint: { x: 88, y: 56 },
  });
  const result = await relocalizer.relocalize({ width: 160, height: 120 });

  assert.equal(initial.keyframeCount, 1);
  assert.equal(mature.keyframeCount, 2);
  assert.equal(rejectedThirdView.success, false);
  assert.equal(rejectedThirdView.keyframeCount, 2);
  assert.match(rejectedThirdView.reason, /already contains 2 keyframes/);
  assert.equal(result.success, true);
  assert.equal(result.keyframeCount, 2);
  assert.equal(result.keyframeId, 1);
  assert.ok(Math.abs(result.anchorPoint.x - 108.6) < 0.2);
  assert.ok(Math.abs(result.anchorPoint.y - 46.25) < 0.2);
});

test('a rejected second XFeat view preserves the initial geometry', async () => {
  const referenceFeatures = [];
  const rejectedFeatures = [];
  const queryFeatures = [];
  const landmarks = [];
  for (let index = 0; index < 8; index++) {
    const point = { x: 24 + (index % 4) * 28, y: 32 + Math.floor(index / 4) * 36 };
    referenceFeatures.push({ point, descriptor: descriptor(index), response: 0.9 });
    queryFeatures.push({
      point: { x: point.x + 12, y: point.y - 7 },
      descriptor: descriptor(index),
      response: 0.9,
    });
    if (index < 3) rejectedFeatures.push(referenceFeatures[index]);
    landmarks.push({
      id: index,
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 5,
      recentDropout: false,
      original: point,
      current: point,
      totalSuccessfulFrames: 8,
      successfulTrackingStreak: 8,
      landmarkQuality: 0.9,
      response: 0.8,
    });
  }
  const extracted = [referenceFeatures, rejectedFeatures, queryFeatures];
  const relocalizer = new XFeatKeyframeRelocalizer({
    extractFeatures: async () => extracted.shift(),
  });

  const initial = await relocalizer.storeReference({
    imageData: { width: 160, height: 120 },
    trackedPoints: landmarks,
    anchorPoint: { x: 66, y: 50 },
  });
  const rejected = await relocalizer.storeReference({
    imageData: { width: 160, height: 120 },
    trackedPoints: landmarks,
    anchorPoint: { x: 70, y: 52 },
  });
  const result = await relocalizer.relocalize({ width: 160, height: 120 });

  assert.equal(initial.success, true);
  assert.equal(rejected.success, false);
  assert.equal(rejected.keyframeCount, 1);
  assert.equal(relocalizer.hasReference(), true);
  assert.equal(result.success, true);
  assert.equal(result.keyframeId, 0);
  assert.ok(Math.abs(result.anchorPoint.x - 78) < 0.2);
  assert.ok(Math.abs(result.anchorPoint.y - 43) < 0.2);
});

test('XFeat relocalizer releases a runtime that finishes initializing after disposal', async () => {
  let finishInitialization;
  let disposalCount = 0;
  const relocalizer = new XFeatKeyframeRelocalizer({
    featureExtractorFactory: () =>
      new Promise((resolve) => {
        finishInitialization = resolve;
      }),
  });
  const landmarks = Array.from({ length: 6 }, (_, index) => ({
    id: index,
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 5,
    recentDropout: false,
    original: { x: 20 + index * 12, y: 30 + index * 7 },
    current: { x: 20 + index * 12, y: 30 + index * 7 },
    totalSuccessfulFrames: 8,
    successfulTrackingStreak: 8,
    landmarkQuality: 0.9,
    response: 0.8,
  }));
  const storage = relocalizer.storeReference({
    imageData: { width: 160, height: 120, data: new Uint8ClampedArray(160 * 120 * 4) },
    trackedPoints: landmarks,
    anchorPoint: { x: 66, y: 50 },
  });

  relocalizer.dispose();
  finishInitialization({
    extract: async () => [],
    dispose: () => {
      disposalCount++;
    },
  });

  await assert.rejects(storage, /disposed during runtime initialization/);
  assert.equal(disposalCount, 1);
});

test('XFeat relocalizer retries runtime initialization after a transient failure', async () => {
  let initializationAttempts = 0;
  const relocalizer = new XFeatKeyframeRelocalizer({
    featureExtractorFactory: () => {
      initializationAttempts++;
      if (initializationAttempts === 1) {
        return Promise.reject(new Error('XFeat runtime unavailable'));
      }
      return Promise.resolve({
        extract: async () => ['recovered-feature'],
        dispose: () => {},
      });
    },
  });

  await assert.rejects(relocalizer._extract({}, 1), /runtime unavailable/);
  assert.deepEqual(await relocalizer._extract({}, 1), ['recovered-feature']);
  assert.equal(initializationAttempts, 2);
});
