import test from 'node:test';
import assert from 'node:assert/strict';
import { KeypointDetector } from './anchor.keypoints.js';
import { createObjectSupportMask, createRegionOpenCvMask } from './objectSupportMask.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';

const makeGridKeypoints = (offsetX = 0, offsetY = 0) => {
  const keypoints = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      keypoints.push({
        pt: {
          x: offsetX + 20 + col * 30,
          y: offsetY + 20 + row * 30,
        },
      });
      keypoints.push({
        pt: {
          x: offsetX + 30 + col * 30,
          y: offsetY + 30 + row * 30,
        },
      });
    }
  }
  return keypoints;
};

test('template quality scoring is stable for absolute ROI keypoint coordinates', () => {
  const detector = new KeypointDetector();
  const localKeypoints = makeGridKeypoints();
  const offsetKeypoints = makeGridKeypoints(400, 250);

  const localQuality = detector.assessTemplateQuality(localKeypoints, null, 120, 120);
  const offsetQuality = detector.assessTemplateQuality(offsetKeypoints, null, 120, 120, 400, 250);

  assert.equal(Number(localQuality.overall.toFixed(3)), Number(offsetQuality.overall.toFixed(3)));
  assert.ok(offsetQuality.spatialDistribution > 0.9);
});

test('keypoint extraction uses object support mask to ignore background corners', async () => {
  const cv = await loadOpenCvForNode();
  const detector = new KeypointDetector();
  await detector.initialize(cv);

  const image = cv.Mat.zeros(80, 100, cv.CV_8UC1);
  cv.rectangle(image, new cv.Point(12, 16), new cv.Point(34, 38), new cv.Scalar(255), -1);
  cv.rectangle(image, new cv.Point(64, 16), new cv.Point(88, 40), new cv.Scalar(255), -1);

  const data = new Uint8Array(100 * 80);
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 50; x++) {
      data[y * 100 + x] = 255;
    }
  }
  const objectSupportMask = createObjectSupportMask({
    width: 100,
    height: 80,
    data,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 24, y: 28 },
    createdAtFrame: 1,
    updatedAtFrame: 1,
  });

  const result = detector.extractKeypoints(
    cv,
    image,
    { x: 0, y: 0, width: 100, height: 80 },
    objectSupportMask,
  );

  image.delete();

  assert.ok(result.keypoints.length > 0);
  assert.equal(result.maskSource, 'interactive-segmenter');
  assert.equal(result.gfttCallCount, 1);
  assert.ok(result.keypoints.every((keypoint) => keypoint.pt.x < 50));
});

test('masked keypoint extraction preserves full-region GFTT corners while bounding response work', async () => {
  const cv = await loadOpenCvForNode();
  const detector = new KeypointDetector();
  await detector.initialize(cv);

  const width = 240;
  const height = 180;
  const image = cv.Mat.zeros(height, width, cv.CV_8UC1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      image.data[y * width + x] = (x * 17 + y * 31 + ((x * y) % 47)) % 256;
    }
  }

  const data = new Uint8Array(width * height);
  for (let y = 52; y < 131; y++) {
    for (let x = 76; x < 169; x++) {
      const dx = (x - 122) / 46;
      const dy = (y - 91) / 39;
      if (dx * dx + dy * dy <= 1 && !(x > 118 && x < 128 && y > 82)) {
        data[y * width + x] = 255;
      }
    }
  }
  const objectSupportMask = createObjectSupportMask({
    width,
    height,
    data,
    source: 'interactive-segmenter',
    confidence: 0.93,
    referencePoint: { x: 122, y: 91 },
    createdAtFrame: 1,
    updatedAtFrame: 1,
  });
  const region = { x: 20, y: 15, width: 200, height: 150 };
  const referenceRoi = image.roi(new cv.Rect(region.x, region.y, region.width, region.height));
  const referenceMask = createRegionOpenCvMask(cv, objectSupportMask, region);
  const referenceCorners = new cv.Mat();
  cv.goodFeaturesToTrack(
    referenceRoi,
    referenceCorners,
    detector.maxCorners,
    detector.qualityLevel,
    detector.minDistance,
    referenceMask,
    detector.blockSize,
    detector.useHarrisDetector,
    detector.k,
  );
  const expected = Array.from({ length: referenceCorners.rows }, (_, index) => ({
    x: referenceCorners.data32F[index * 2] + region.x,
    y: referenceCorners.data32F[index * 2 + 1] + region.y,
  }));

  const result = detector.extractKeypoints(cv, image, region, objectSupportMask);

  referenceCorners.delete();
  referenceMask.delete();
  referenceRoi.delete();
  image.delete();

  assert.deepEqual(
    result.keypoints.map((keypoint) => keypoint.pt),
    expected,
  );
  assert.equal(
    result.gfttPixelCount,
    (objectSupportMask.bbox.width + 6) * (objectSupportMask.bbox.height + 6),
  );
  assert.ok(result.gfttPixelCount < region.width * region.height);
});

test('adaptive keypoint extraction reports every real GFTT attempt', async () => {
  const cv = await loadOpenCvForNode();
  const detector = new KeypointDetector();
  await detector.initialize(cv);
  const width = 80;
  const height = 60;
  const image = new cv.Mat(height, width, cv.CV_8UC1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      image.data[y * width + x] = ((x >> 2) + (y >> 2)) % 2 ? 255 : 0;
    }
  }
  let calls = 0;
  const instrumentedCv = Object.create(cv);
  instrumentedCv.goodFeaturesToTrack = (...args) => {
    calls++;
    return cv.goodFeaturesToTrack(...args);
  };

  const result = detector.extractAdaptiveKeypoints(instrumentedCv, image, null, null, {
    minKeypoints: 10000,
  });
  image.delete();

  assert.equal(result.gfttCallCount, 3);
  assert.equal(result.gfttPixelCount, 3 * width * height);
  assert.equal(result.gfttPreparationCount, 1);
  assert.equal(calls, 3);
});

test('fallback filters each pass before selection and releases its scoped native Mats', async () => {
  const mats = [];
  class FakeMat {
    constructor(rows = 0, cols = 0) {
      this.rows = rows;
      this.cols = cols;
      this.data = new Uint8Array(rows * cols);
      this.data32F = new Float32Array();
      this.deleteCount = 0;
      mats.push(this);
    }

    static zeros(rows, cols) {
      return new FakeMat(rows, cols);
    }

    roi(rect) {
      return new FakeMat(rect.height, rect.width);
    }

    delete() {
      this.deleteCount++;
    }
  }
  class FakeRect {
    constructor(x, y, width, height) {
      Object.assign(this, { x, y, width, height });
    }
  }
  const inside = Array.from({ length: 12 }, (_, index) => ({
    x: 2 + index,
    y: 4,
  }));
  const outside = Array.from({ length: 20 }, (_, index) => ({
    x: 20 + (index % 3),
    y: 8 + (index % 5),
  }));
  const outputs = [[...inside.slice(0, 5), ...outside], inside];
  let calls = 0;
  const cv = {
    Mat: FakeMat,
    Rect: FakeRect,
    CV_8UC1: 0,
    goodFeaturesToTrack: (roi, corners) => {
      const points = outputs[calls++];
      corners.rows = points.length;
      corners.data32F = Float32Array.from(points.flatMap((point) => [point.x, point.y]));
    },
  };
  const detector = new KeypointDetector();
  await detector.initialize(cv);
  const image = new FakeMat(30, 40);
  const data = new Uint8Array(30 * 40);
  for (let y = 0; y < 30; y++) {
    data.fill(255, y * 40, y * 40 + 20);
  }
  const objectSupportMask = createObjectSupportMask({
    width: 40,
    height: 30,
    data,
    source: 'test-mask',
    confidence: 1,
    referencePoint: { x: 10, y: 15 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });

  const result = detector.extractKeypointsWithAdaptiveFallback(
    cv,
    image,
    { x: 0, y: 0, width: 40, height: 30 },
    objectSupportMask,
    { minKeypoints: 10 },
  );

  assert.equal(result.method, 'GFTT_ADAPTIVE');
  assert.deepEqual(
    result.keypoints.map((keypoint) => keypoint.pt),
    inside,
  );
  assert.equal(result.count, 12);
  assert.equal(result.gfttCallCount, 2);
  assert.equal(result.gfttPreparationCount, 1);
  assert.equal(calls, 2);
  assert.equal(image.deleteCount, 0);
  assert.equal(
    mats.filter((mat) => mat !== image).every((mat) => mat.deleteCount === 1),
    true,
  );
});

test('partial GFTT preparation releases the ROI before propagating a mask failure', async () => {
  let roi = null;
  class FakeMat {
    static zeros() {
      throw new Error('mask allocation failed');
    }

    roi() {
      roi = {
        cols: 23,
        rows: 30,
        deleteCount: 0,
        delete() {
          this.deleteCount++;
        },
      };
      return roi;
    }

    delete() {}
  }
  const cv = {
    Mat: FakeMat,
    Rect: class {},
    CV_8UC1: 0,
    goodFeaturesToTrack() {},
  };
  const detector = new KeypointDetector();
  await detector.initialize(cv);
  const data = new Uint8Array(30 * 40);
  for (let y = 0; y < 30; y++) {
    data.fill(255, y * 40, y * 40 + 20);
  }
  const objectSupportMask = createObjectSupportMask({
    width: 40,
    height: 30,
    data,
    source: 'test-mask',
    confidence: 1,
    referencePoint: { x: 10, y: 15 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });

  assert.throws(
    () =>
      detector.extractKeypoints(cv, new FakeMat(), { x: 0, y: 0, width: 40, height: 30 }, objectSupportMask),
    /mask allocation failed/,
  );
  assert.equal(roi.deleteCount, 1);
});

test('strict plus adaptive fallback reuses one real OpenCV extraction session', async () => {
  const cv = await loadOpenCvForNode();
  const detector = new KeypointDetector();
  await detector.initialize(cv);

  const width = 220;
  const height = 160;
  const image = new cv.Mat(height, width, cv.CV_8UC1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      image.data[y * width + x] = (x * 19 + y * 29 + ((x * y) % 43)) % 256;
    }
  }
  const data = new Uint8Array(width * height);
  for (let y = 42; y < 126; y++) {
    for (let x = 64; x < 172; x++) {
      data[y * width + x] = 255;
    }
  }
  const objectSupportMask = createObjectSupportMask({
    width,
    height,
    data,
    source: 'interactive-segmenter',
    confidence: 0.95,
    referencePoint: { x: 118, y: 84 },
    createdAtFrame: 1,
    updatedAtFrame: 1,
  });
  const region = { x: 20, y: 15, width: 180, height: 135 };
  const minKeypoints = 10000;
  const primary = detector.extractKeypoints(cv, image, region, objectSupportMask);
  const adaptive = detector.extractAdaptiveKeypoints(cv, image, region, objectSupportMask, { minKeypoints });
  const selected = adaptive.keypoints.length > primary.keypoints.length ? adaptive : primary;
  const expected = {
    ...selected,
    gfttCallCount: primary.gfttCallCount + adaptive.gfttCallCount,
    gfttPixelCount: primary.gfttPixelCount + adaptive.gfttPixelCount,
  };

  const nativeCalls = [];
  const instrumentedCv = Object.create(cv);
  instrumentedCv.goodFeaturesToTrack = (...args) => {
    nativeCalls.push({ roi: args[0], corners: args[1], mask: args[5] });
    return cv.goodFeaturesToTrack(...args);
  };

  try {
    const result = detector.extractKeypointsWithAdaptiveFallback(
      instrumentedCv,
      image,
      region,
      objectSupportMask,
      { minKeypoints },
    );

    assert.deepEqual(result.keypoints, expected.keypoints);
    assert.equal(result.method, expected.method);
    assert.equal(result.count, expected.count);
    assert.equal(result.gfttCallCount, 4);
    assert.equal(result.gfttPixelCount, expected.gfttPixelCount);
    assert.equal(result.gfttPreparationCount, 1);
    assert.equal(nativeCalls.length, 4);
    assert.equal(new Set(nativeCalls.map((call) => call.roi)).size, 1);
    assert.equal(new Set(nativeCalls.map((call) => call.mask)).size, 1);
    assert.equal(new Set(nativeCalls.map((call) => call.corners)).size, 1);
  } finally {
    image.delete();
  }
});
