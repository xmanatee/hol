import test from 'node:test';
import assert from 'node:assert/strict';
import { KeypointDetector } from './anchor.keypoints.js';
import { createObjectSupportMask } from './objectSupportMask.js';
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
    objectSupportMask
  );

  image.delete();

  assert.ok(result.keypoints.length > 0);
  assert.equal(result.maskSource, 'interactive-segmenter');
  assert.ok(result.keypoints.every(keypoint => keypoint.pt.x < 50));
});
