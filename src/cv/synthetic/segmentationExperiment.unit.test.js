import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assertSegmentationMeasurement,
  createSegmentationProbe,
  scoreSegmentationMask,
  summarizeDurations,
  SEGMENTATION_EXPERIMENT_CASES,
} from './segmentationExperiment.js';

const pins = [
  [
    'textured-ellipse',
    'a15dc8fe7880a0703231aea23619c8a6509d63a7aff92b08b977210680994180',
    '1217f580cf946f5e04fd5c86c5abfc752dc3f99ebd4901ab47671dcd4f89915e',
    19533,
  ],
  [
    'portrait-bottle',
    'a838b99b72541ce4ff754565ca8f30c11075701a6525d0569a12aee418d03db1',
    'ca8cfc3d00cc7d5dceec7e778cf0d2cda0a98f9e3788baef3f8b43ca2901df35',
    18631,
  ],
  [
    'thin-object',
    '9912022dd0bb8ab69a3cfefec18c9f5f6504bc9e6dd0b60522ee12aad13f3677',
    '17b37d9d4ec67203f68474fec5ecc246e05506cbec252eba4e9f092806b54e72',
    2445,
  ],
  [
    'low-light',
    '2bffdf78e9f6372f3bbd142b9255198d8a9f3c5af8c5ce717cb931d783c3dd70',
    '1217f580cf946f5e04fd5c86c5abfc752dc3f99ebd4901ab47671dcd4f89915e',
    19533,
  ],
  [
    'specular-label',
    'b696525b4cce85e808d4cdfce1a44ad03de05c8395dd0ae5ddca8a5ce427ec67',
    '1217f580cf946f5e04fd5c86c5abfc752dc3f99ebd4901ab47671dcd4f89915e',
    19533,
  ],
  [
    'similar-distractor',
    '7de618784e0b6af3f3dc65487f4311f4573eb6a000fac37bd8df0e41dc191769',
    '1217f580cf946f5e04fd5c86c5abfc752dc3f99ebd4901ab47671dcd4f89915e',
    19533,
  ],
  [
    'edge-crop',
    '659c9d16b3bdc60741f7c9f97ddf2ecddbf5ece8dbcafd4404f158f25e81d5a7',
    'ee050bc319a5f6f06da461ee57980dd7b188d8f4ff3e7f67c4a2700952e750fb',
    14061,
  ],
  [
    'empty-background',
    '7a202fcae7fe2aae592ce371ea6d643d422ee23c070a9f984f2e628f0cb789c9',
    'e2cc2a1fa6131cf4d86faa3baf78851f35a36853e2467c257b3df9d89e85cce5',
    0,
  ],
  [
    'demo-landscape',
    '49aeb620845c1cee2d2808be6d9b5770ad0aeb54c009d69d1de22908682991b7',
    'f09414c7fa753e2274e43a048faa9ab71e203085d3692179334e4229178e6ada',
    131883,
  ],
  [
    'demo-portrait',
    'bb4fc09714f7612b484d02acd25be6eb9d30deadb3fc40f3415b6c0891da9aa3',
    '26d44b0d3668b86e7eb29a5490589c5c480deb31afc50c04c7bef4aa9313c612',
    126481,
  ],
];
test('every probe has pinned RGBA pixels, independent binary labels and meaningful positive/negative support', () => {
  assert.deepEqual(
    SEGMENTATION_EXPERIMENT_CASES.map(({ id }) => id),
    pins.map(([id]) => id),
  );
  for (const [id, rgba, truth, pixels] of pins) {
    const probe = createSegmentationProbe(id);
    assert.equal(createHash('sha256').update(probe.imageData.data).digest('hex'), rgba);
    assert.equal(createHash('sha256').update(probe.truth).digest('hex'), truth);
    assert.equal(
      probe.truth.reduce((count, value) => count + Number(value > 0), 0),
      pixels,
    );
  }
  const distractor = createSegmentationProbe('similar-distractor');
  assert.equal(distractor.truth[72 * 320 + 38], 0);
  assert.throws(() => createSegmentationProbe('unknown'), /Unknown/);
});

test('mask metrics have explicit empty-set semantics and cannot count foreground leakage as accuracy', () => {
  assert.deepEqual(
    scoreSegmentationMask(new Uint8Array([255, 0, 255, 0]), new Uint8Array([255, 255, 0, 0])),
    {
      iou: 1 / 3,
      precision: 0.5,
      recall: 0.5,
      falseForegroundFraction: 0.25,
      targetPixels: 2,
      predictedPixels: 2,
    },
  );
  assert.equal(scoreSegmentationMask(new Uint8Array(4), new Uint8Array(4)).iou, 1);
  assert.equal(scoreSegmentationMask(new Uint8Array(4), new Uint8Array(4)).recall, null);
  assert.equal(scoreSegmentationMask(new Uint8Array([255]), new Uint8Array(1)).iou, 0);
  assert.throws(() => scoreSegmentationMask(new Uint8Array([1]), new Uint8Array([0])), /only 0 and 255/);
  assert.throws(() => scoreSegmentationMask(new Uint8Array(2), new Uint8Array(3)), /matching/);
  assert.throws(() => scoreSegmentationMask(new Uint8Array(0), new Uint8Array(0)), /nonempty/);
});

test('latency uses raw nearest-rank percentiles, not averages of per-case percentiles', () => {
  assert.deepEqual(summarizeDurations([100, 1, 3, 2]), { count: 4, medianMs: 2, p95Ms: 100, maximumMs: 100 });
  for (const values of [[], [NaN], [-1], [Infinity]])
    assert.throws(() => summarizeDurations(values), /finite/);
});

test('a measurement cannot mix backends, raster sizes, frame IDs or inconsistent timing envelopes', () => {
  const expected = { backendId: 'mediapipe-wasm', width: 2, height: 2, frameId: 1 };
  const sample = {
    backendId: expected.backendId,
    roundTripMs: 8,
    objectSupportMask: {
      width: 2,
      height: 2,
      createdAtFrame: 1,
      updatedAtFrame: 1,
      source: 'interactive-segmenter',
      confidence: 0.9,
      data: new Uint8Array(4),
    },
    timings: {
      cold: false,
      initializationMs: 0,
      segmentCallMs: 1,
      maskReadbackAndSyncMs: 4,
      maskPostprocessMs: 1,
      totalMs: 6,
    },
  };
  assert.doesNotThrow(() => assertSegmentationMeasurement(sample, expected));
  assert.throws(
    () => assertSegmentationMeasurement({ ...sample, backendId: 'mediapipe-webgl' }, expected),
    /ownership/,
  );
  assert.throws(
    () =>
      assertSegmentationMeasurement(
        { ...sample, objectSupportMask: { ...sample.objectSupportMask, updatedAtFrame: 0 } },
        expected,
      ),
    /ownership/,
  );
  assert.throws(
    () => assertSegmentationMeasurement({ ...sample, timings: { ...sample.timings, totalMs: 2 } }, expected),
    /envelopes/,
  );
  assert.throws(
    () =>
      assertSegmentationMeasurement(
        { ...sample, timings: { ...sample.timings, initializationMs: 1 } },
        expected,
      ),
    /initialization/,
  );
});
