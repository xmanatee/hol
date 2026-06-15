import test from 'node:test';
import assert from 'node:assert/strict';
import { AnchorManager } from './AnchorManager.js';
import { createObjectSupportMask } from '../cv/objectSupportMask.js';

test('anchor manager attaches tap-time segmenter mask before creating image anchor', async () => {
  const objectSupportMask = createObjectSupportMask({
    width: 100,
    height: 80,
    data: new Uint8Array(100 * 80).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.88,
    referencePoint: { x: 50, y: 40 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
  const imageAnchorService = {
    setTrackingMode: () => {},
    createAnchor: async (imageData, tapPosition, detection) => ({
      success: true,
      position: tapPosition,
      keypoints: 24,
      quality: 0.42,
      method: 'GFTT',
      state: 'tracking',
      trackingMode: 'object-pose',
      objectSupportMaskSource: detection.objectSupportMask.source,
    }),
  };
  const interactiveSegmenterService = {
    segmentTap: async ({ tapPosition }) => {
      assert.deepEqual(tapPosition, { x: 50, y: 40 });
      return objectSupportMask;
    },
  };
  const manager = new AnchorManager({ imageAnchorService, interactiveSegmenterService });
  manager.initialized = true;
  manager.mode = 'detection';
  manager.detections = [{ x1: 20, y1: 10, x2: 80, y2: 70, class: 'cup', confidence: 0.93 }];

  const result = await manager.createAnchorFromTap(
    { x: 50, y: 40 },
    { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4) }
  );

  assert.equal(result.success, true);
  assert.equal(manager.activeAnchor.objectSupportMaskSource, 'interactive-segmenter');
});

test('anchor manager creates a free-tap anchor when segmentation succeeds outside detections', async () => {
  const objectSupportMask = createObjectSupportMask({
    width: 100,
    height: 80,
    data: new Uint8Array(100 * 80).fill(0),
    source: 'interactive-segmenter',
    confidence: 0.81,
    referencePoint: { x: 10, y: 40 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
  for (let y = 24; y <= 56; y++) {
    for (let x = 4; x <= 36; x++) {
      objectSupportMask.data[y * objectSupportMask.width + x] = 255;
    }
  }
  objectSupportMask.bbox = { x: 4, y: 24, width: 33, height: 33 };
  const manager = new AnchorManager({
    imageAnchorService: {
      setTrackingMode: () => {},
      createAnchor: async (imageData, tapPosition, detection) => ({
        success: true,
        position: tapPosition,
        keypoints: 9,
        quality: 0.18,
        method: 'GFTT_ADAPTIVE',
        state: 'mapping',
        trackingMode: 'sparse-reconstruction',
        readiness: { faceReady: false, reason: 'Build more object landmarks before showing the face' },
        evidence: {
          maskCoverage: 1,
          maskConfidence: detection.objectSupportMask.confidence,
          templateKeypoints: 9,
          activeLandmarks: 9,
          objectOwnedLandmarks: 9,
          backgroundRejected: 0,
        },
        objectSupportMaskSource: detection.objectSupportMask.source,
      }),
    },
    interactiveSegmenterService: {
      segmentTap: async () => {
        return objectSupportMask;
      },
    },
  });
  manager.initialized = true;
  manager.mode = 'detection';
  manager.detections = [{ x1: 20, y1: 10, x2: 80, y2: 70, class: 'cup', confidence: 0.93 }];

  const result = await manager.createAnchorFromTap(
    { x: 10, y: 40 },
    { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4) }
  );

  assert.equal(result.success, true);
  assert.equal(manager.mode, 'anchor');
  assert.equal(manager.activeAnchor.objectSupportMaskSource, 'interactive-segmenter');
  assert.equal(manager.activeAnchor.sourceDetection.class, 'segmented-object');
  assert.equal(manager.activeAnchor.sourceDetection.x1, 4);
  assert.equal(manager.activeAnchor.sourceDetection.y1, 24);
  assert.equal(manager.activeAnchor.sourceDetection.x2, 37);
  assert.equal(manager.activeAnchor.sourceDetection.y2, 57);
});

test('anchor manager rejects free taps when neither detection nor segmentation is available', async () => {
  const manager = new AnchorManager({
    imageAnchorService: {
      setTrackingMode: () => {},
      createAnchor: async () => {
        throw new Error('createAnchor should not run');
      },
    },
    interactiveSegmenterService: {
      segmentTap: async () => null,
    },
  });
  manager.initialized = true;
  manager.mode = 'detection';
  manager.detections = [{ x1: 20, y1: 10, x2: 80, y2: 70, class: 'cup', confidence: 0.93 }];

  await assert.rejects(
    manager.createAnchorFromTap(
      { x: 10, y: 40 },
      { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4) }
    ),
    /No detection selected/
  );

  assert.equal(manager.mode, 'detection');
  assert.equal(manager.activeAnchor, null);
});

test('anchor manager falls back to weak detection-box support when tap segmentation fails', async () => {
  const manager = new AnchorManager({
    imageAnchorService: {
      setTrackingMode: () => {},
      createAnchor: async (imageData, tapPosition, detection) => ({
        success: true,
        position: tapPosition,
        keypoints: 3,
        quality: 0.06,
        method: 'GFTT_ADAPTIVE_GRID_BOOTSTRAP',
        state: 'candidate',
        trackingMode: 'sparse-reconstruction',
        readiness: { faceReady: false, reason: 'Build more object landmarks before showing the face' },
        evidence: {
          maskCoverage: 1,
          maskConfidence: 0.35,
          templateKeypoints: 3,
          activeLandmarks: 3,
          objectOwnedLandmarks: 3,
          backgroundRejected: 0,
        },
        objectSupportMaskSource: detection.objectSupportMask.source,
      }),
    },
    interactiveSegmenterService: {
      segmentTap: async () => {
        throw new Error('segmenter unavailable');
      },
    },
  });
  manager.initialized = true;
  manager.mode = 'detection';
  manager.detections = [{ x1: 20, y1: 10, x2: 80, y2: 70, class: 'cup', confidence: 0.93 }];

  const result = await manager.createAnchorFromTap(
    { x: 50, y: 40 },
    { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4) }
  );

  assert.equal(result.success, true);
  assert.equal(manager.mode, 'anchor');
  assert.equal(manager.activeAnchor.objectSupportMaskSource, 'detection-box');
});

test('anchor manager builds an explicit weak object support mask when tap segmentation is empty', async () => {
  const imageAnchorService = {
    setTrackingMode: () => {},
    createAnchor: async (imageData, tapPosition, detection) => ({
      success: true,
      position: tapPosition,
      keypoints: 4,
      quality: 0.08,
      method: 'GFTT_ADAPTIVE_GRID_BOOTSTRAP',
      state: 'candidate',
      trackingMode: 'sparse-reconstruction',
      readiness: { faceReady: false, reason: 'Build more object landmarks before showing the face' },
      evidence: {
        maskCoverage: 1,
        maskConfidence: 0.35,
        templateKeypoints: 4,
        activeLandmarks: 4,
        objectOwnedLandmarks: 4,
        backgroundRejected: 0,
      },
      objectSupportMaskSource: detection.objectSupportMask.source,
    }),
  };
  const manager = new AnchorManager({
    imageAnchorService,
    interactiveSegmenterService: {
      segmentTap: async () => null,
    },
  });
  manager.initialized = true;
  manager.mode = 'detection';
  manager.detections = [{ x1: 20, y1: 10, x2: 80, y2: 70, class: 'cup', confidence: 0.93 }];

  const result = await manager.createAnchorFromTap(
    { x: 50, y: 40 },
    { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4) }
  );

  assert.equal(result.success, true);
  assert.equal(manager.activeAnchor.objectSupportMaskSource, 'detection-box');
  assert.equal(manager.activeAnchor.sourceDetection.objectSupportMask.bbox.width, 61);
  assert.equal(manager.activeAnchor.sourceDetection.objectSupportMask.bbox.height, 61);
});
