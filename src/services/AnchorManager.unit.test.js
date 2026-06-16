import test from 'node:test';
import assert from 'node:assert/strict';
import { AnchorManager } from './AnchorManager.js';
import { createObjectSupportMask, isPointInsideObjectSupport } from '../cv/objectSupportMask.js';

test('anchor manager attaches tap-time segmenter mask before creating image anchor', async () => {
  const maskData = new Uint8Array(100 * 80);
  for (let y = 8; y < 72; y++) {
    for (let x = 6; x < 94; x++) {
      maskData[y * 100 + x] = 255;
    }
  }
  const objectSupportMask = createObjectSupportMask({
    width: 100,
    height: 80,
    data: maskData,
    source: 'interactive-segmenter',
    confidence: 0.88,
    referencePoint: { x: 50, y: 40 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
  let receivedDetection = null;
  const imageAnchorService = {
    setTrackingMode: () => {},
    createAnchor: async (imageData, tapPosition, detection) => {
      receivedDetection = detection;
      return {
        success: true,
        position: tapPosition,
        keypoints: 24,
        quality: 0.42,
        method: 'GFTT',
        state: 'tracking',
        trackingMode: 'object-pose',
        objectSupportMaskSource: detection.objectSupportMask.source,
      };
    },
  };
  const interactiveSegmenterService = {
    segmentTap: async ({ tapPosition, maxRadius }) => {
      assert.deepEqual(tapPosition, { x: 50, y: 40 });
      assert.equal(maxRadius, undefined);
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
  assert.deepEqual(receivedDetection.objectSupportMask.bbox, { x: 6, y: 8, width: 88, height: 64 });
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

test('anchor manager creates tap-local anchor without detections or segmentation', async () => {
  const manager = new AnchorManager({
    imageAnchorService: {
      setTrackingMode: () => {},
      createAnchor: async (imageData, tapPosition, detection) => ({
        success: true,
        position: tapPosition,
        keypoints: 6,
        quality: 0.12,
        method: 'GFTT_ADAPTIVE_GRID_BOOTSTRAP',
        state: 'candidate',
        trackingMode: 'sparse-reconstruction',
        readiness: { faceReady: false, reason: 'Build more object landmarks before showing the face' },
        evidence: {
          maskCoverage: 1,
          maskConfidence: detection.objectSupportMask.confidence,
          templateKeypoints: 6,
          activeLandmarks: 6,
          objectOwnedLandmarks: 6,
          backgroundRejected: 0,
        },
        objectSupportMaskSource: detection.objectSupportMask.source,
      }),
    },
    interactiveSegmenterService: {
      segmentTap: async () => null,
    },
  });
  manager.initialized = true;
  manager.mode = 'detection';
  manager.detections = [];

  const result = await manager.createAnchorFromTap(
    { x: 10, y: 40 },
    { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4) }
  );

  assert.equal(result.success, true);
  assert.equal(manager.mode, 'anchor');
  assert.equal(manager.activeAnchor.objectSupportMaskSource, 'tap-local');
  assert.equal(manager.activeAnchor.sourceDetection.class, 'segmented-object');
  assert.equal(isPointInsideObjectSupport(manager.activeAnchor.sourceDetection.objectSupportMask, { x: 10, y: 40 }), true);
});

test('anchor manager falls back to tap-local support when tap segmentation fails', async () => {
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
  assert.equal(manager.activeAnchor.objectSupportMaskSource, 'tap-local');
});

test('anchor manager builds an explicit weak tap-local support mask when tap segmentation is empty', async () => {
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
  assert.equal(manager.activeAnchor.objectSupportMaskSource, 'tap-local');
  assert.ok(manager.activeAnchor.sourceDetection.objectSupportMask.bbox.width <= 57);
  assert.ok(manager.activeAnchor.sourceDetection.objectSupportMask.bbox.height <= 57);
});

test('anchor manager never lets a broad debug detection shape fallback support', async () => {
  let supportMask = null;
  const manager = new AnchorManager({
    imageAnchorService: {
      setTrackingMode: () => {},
      createAnchor: async (imageData, tapPosition, detection) => {
        supportMask = detection.objectSupportMask;
        return {
          success: true,
          position: tapPosition,
          keypoints: 8,
          quality: 0.12,
          method: 'GFTT_ADAPTIVE_GRID_BOOTSTRAP',
          state: 'candidate',
          trackingMode: 'sparse-reconstruction',
          readiness: { faceReady: false, reason: 'Build more object landmarks before showing the face' },
          evidence: {
            maskCoverage: 0.18,
            maskConfidence: detection.objectSupportMask.confidence,
            templateKeypoints: 8,
            activeLandmarks: 8,
            objectOwnedLandmarks: 8,
            backgroundRejected: 0,
          },
          objectSupportMaskSource: detection.objectSupportMask.source,
        };
      },
    },
    interactiveSegmenterService: {
      segmentTap: async () => null,
    },
  });
  manager.initialized = true;
  manager.mode = 'detection';
  manager.detections = [{
    x1: 110,
    y1: 40,
    x2: 310,
    y2: 430,
    class: 'person',
    confidence: 0.96,
  }];

  const result = await manager.createAnchorFromTap(
    { x: 205, y: 92 },
    { width: 420, height: 480, data: new Uint8ClampedArray(420 * 480 * 4) }
  );

  assert.equal(result.success, true);
  assert.equal(manager.activeAnchor.objectSupportMaskSource, 'tap-local');
  assert.equal(supportMask.source, 'tap-local');
  assert.ok(supportMask.bbox.width <= 82);
  assert.ok(supportMask.bbox.height <= 82);
  assert.equal(isPointInsideObjectSupport(supportMask, { x: 130, y: 250 }), false);
  assert.equal(isPointInsideObjectSupport(supportMask, { x: 205, y: 92 }), true);
});

test('anchor manager propagates live object mask preview into active-anchor diagnostics', () => {
  const preview = {
    source: 'interactive-segmenter',
    bbox: { x: 12, y: 14, width: 32, height: 34 },
    sampleStride: 4,
    points: [{ x: 12, y: 14 }],
  };
  const manager = new AnchorManager({
    imageAnchorService: {
      setTrackingMode: () => {},
    },
    interactiveSegmenterService: {},
  });

  manager.mode = 'anchor';
  manager.activeAnchor = {
    position: { x: 20, y: 30, z: 0 },
    evidence: {},
  };

  manager._onAnchorUpdate({
    anchored: true,
    state: 'mapping',
    position: { x: 21, y: 31, z: 0 },
    planarTransform: { scale: 1, rotation: 0 },
    metrics: {
      keypointCount: 8,
      activeLandmarkCount: 8,
      objectOwnedLandmarks: 7,
      maskCoverage: 0.16,
      maskConfidence: 0.9,
      backgroundRejected: 4,
      currentObjectSupportMaskPreview: preview,
    },
  });

  assert.deepEqual(manager.activeAnchor.evidence.objectSupportMaskPreview, preview);
  assert.deepEqual(manager.activeAnchor.diagnostics.objectSupportMaskPreview, preview);
});

test('anchor manager refreshes segmentation when object-owned landmark ratio drops', async () => {
  const refreshedMask = createObjectSupportMask({
    width: 160,
    height: 120,
    data: new Uint8Array(160 * 120),
    source: 'interactive-segmenter',
    confidence: 0.87,
    referencePoint: { x: 80, y: 60 },
    createdAtFrame: 5,
    updatedAtFrame: 5,
  });
  for (let y = 50; y <= 70; y++) {
    for (let x = 70; x <= 90; x++) {
      refreshedMask.data[y * refreshedMask.width + x] = 255;
    }
  }
  refreshedMask.bbox = { x: 70, y: 50, width: 21, height: 21 };

  let updateReason = null;
  const manager = new AnchorManager({
    imageAnchorService: {
      setTrackingMode: () => {},
      updateObjectSupportMask: (mask, { reason }) => {
        updateReason = reason;
        assert.equal(mask, refreshedMask);
        return true;
      },
    },
    interactiveSegmenterService: {
      segmentTap: async ({ tapPosition, maxRadius }) => {
        assert.deepEqual(tapPosition, { x: 80, y: 60, z: 0 });
        assert.equal(maxRadius, undefined);
        return refreshedMask;
      },
    },
  });
  manager.initialized = true;
  manager.mode = 'anchor';
  manager.activeAnchor = { position: { x: 80, y: 60, z: 0 } };
  manager.anchorState = {
    state: 'tracking',
    position: { x: 80, y: 60, z: 0 },
    metrics: {
      activeLandmarkCount: 20,
      objectOwnedLandmarks: 9,
    },
  };

  assert.equal(manager.refreshSegmentationIfNeeded({
    width: 160,
    height: 120,
    data: new Uint8ClampedArray(160 * 120 * 4),
  }), true);

  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(updateReason, 'object-ownership-recovery');
  assert.equal(manager.activeAnchor.objectSupportMaskSource, 'interactive-segmenter');
});

test('segmentation refresh radius starts local and grows with object evidence', () => {
  const manager = new AnchorManager({
    imageAnchorService: {
      setTrackingMode: () => {},
    },
    interactiveSegmenterService: {},
  });
  const imageData = {
    width: 640,
    height: 480,
  };

  manager.anchorState = {
    state: 'mapping',
    metrics: {
      activeLandmarkCount: 8,
      objectOwnedLandmarks: 8,
    },
  };
  const bootstrapRadius = manager._getSegmentationRefreshRadius(imageData);

  manager.anchorState = {
    state: 'stable',
    metrics: {
      activeLandmarkCount: 36,
      objectOwnedLandmarks: 34,
      reconstructionReady: true,
    },
  };
  const grownRadius = manager._getSegmentationRefreshRadius(imageData);

  assert.ok(bootstrapRadius <= 43);
  assert.ok(grownRadius > bootstrapRadius * 2);
});

test('anchor manager rejects oversized and discontinuous segmentation refresh masks', () => {
  const manager = new AnchorManager({
    imageAnchorService: {
      setTrackingMode: () => {},
    },
    interactiveSegmenterService: {},
  });

  const oversizedMask = createObjectSupportMask({
    width: 200,
    height: 160,
    data: new Uint8Array(200 * 160).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 100, y: 80 },
    createdAtFrame: 1,
    updatedAtFrame: 1,
  });
  const discontinuousData = new Uint8Array(200 * 160);
  for (let y = 20; y < 34; y++) {
    for (let x = 20; x < 34; x++) {
      discontinuousData[y * 200 + x] = 255;
    }
  }
  const discontinuousMask = createObjectSupportMask({
    width: 200,
    height: 160,
    data: discontinuousData,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 100, y: 80 },
    createdAtFrame: 1,
    updatedAtFrame: 1,
  });

  assert.equal(manager._isAcceptableSegmentationRefresh(oversizedMask, { x: 100, y: 80 }, 42), false);
  assert.equal(manager._isAcceptableSegmentationRefresh(discontinuousMask, { x: 100, y: 80 }, 42), false);
});
