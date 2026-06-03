import test from 'node:test';
import assert from 'node:assert/strict';
import { KeypointDetector } from './anchor.keypoints.js';

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
