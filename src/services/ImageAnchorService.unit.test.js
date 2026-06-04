import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageAnchorService } from './ImageAnchorService.js';

const createObjectPose = ({
  x = 140,
  y = 160,
  normal = { x: 0, y: 0, z: 1 },
  scale = 1,
  rotation = 0,
  confidence = 0.82,
  inlierCount = 20,
  method = 'object-pose-affine',
} = {}) => ({
  success: true,
  method,
  position: { x, y, z: 0 },
  normal,
  planarTransform: {
    scale,
    rotation,
    confidence,
    inlierCount,
    method,
  },
  confidence,
  inlierCount,
  inlierRatio: 0.78,
  averageResidual: 1.4,
  referenceSpread: { width: 120, height: 90, minAxis: 90 },
});

test('template region follows the selected detection instead of a full-frame generic crop', () => {
  const service = new ImageAnchorService();
  const region = service._calculateTemplateRegion(
    { x: 500, y: 320 },
    { x1: 440, y1: 260, x2: 560, y2: 380 },
    1280,
    720
  );

  assert.ok(region.x >= 400);
  assert.ok(region.y >= 220);
  assert.ok(region.width < 220);
  assert.ok(region.height < 220);
  assert.ok(region.x <= 500 && region.x + region.width >= 500);
  assert.ok(region.y <= 320 && region.y + region.height >= 320);
});

test('large detections create a tap-local template instead of seeding the whole box', () => {
  const service = new ImageAnchorService();
  const tap = { x: 240, y: 180 };
  const region = service._calculateTemplateRegion(
    tap,
    { x1: 100, y1: 80, x2: 900, y2: 680 },
    1280,
    720
  );

  const center = {
    x: region.x + region.width / 2,
    y: region.y + region.height / 2,
  };

  assert.ok(region.width <= 180);
  assert.ok(region.height <= 180);
  assert.ok(Math.abs(center.x - tap.x) <= 2);
  assert.ok(Math.abs(center.y - tap.y) <= 2);
  assert.ok(center.x < 360);
  assert.ok(center.y < 300);
});

test('moderate template quality is usable but starts degraded', () => {
  const service = new ImageAnchorService();

  assert.equal(service._isUsableTemplateQuality(0.17), true);
  assert.equal(service._getInitialAnchorState(0.17), 'degraded');
  assert.equal(service._getInitialAnchorState(0.31), 'tracking');
});

test('object pose is the single anchor pose model', () => {
  const service = new ImageAnchorService();
  const metrics = service.getState().metrics;

  assert.equal(metrics.poseModel, 'object-pose');
  assert.equal(Object.hasOwn(metrics, 'poseStrategy'), false);
});

test('records usable weak-anchor diagnostics after creation', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: Array.from({ length: 18 }, (_, index) => ({ x: 20 + index, y: 30 + index })),
      descriptors: {},
      method: 'fake-orb'
    }),
    assessTemplateQuality: () => ({ overall: 0.17 })
  };
  service.keypointTracker = {
    initializeTracking: () => {}
  };
  service.persistenceSystem = {
    storeTemplate: () => {}
  };

  const result = await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 70, y1: 80, x2: 150, y2: 160 }
  );
  const state = service.getState();

  assert.equal(result.state, 'degraded');
  assert.equal(state.metrics.qualityState, 'weak');
  assert.equal(state.metrics.templateQuality, 0.17);
  assert.equal(state.metrics.templateKeypoints, 18);
  assert.deepEqual(state.metrics.templateRegion, service.templateRegion);
});

test('records failed anchor creation diagnostics before returning to inactive', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: Array.from({ length: 20 }, (_, index) => ({ x: 50 + index, y: 60 + index })),
      descriptors: {},
      method: 'fake-orb'
    }),
    assessTemplateQuality: () => ({ overall: 0.08 })
  };

  await assert.rejects(
    () => service.createAnchor(
      { width: 320, height: 240 },
      { x: 110, y: 120 },
      { x1: 70, y1: 80, x2: 150, y2: 160 }
    ),
    /Poor template quality/
  );

  const state = service.getState();
  assert.equal(state.state, 'inactive');
  assert.equal(state.metrics.lastFailureStage, 'template-quality');
  assert.match(state.metrics.lastFailureReason, /Poor template quality/);
  assert.equal(state.metrics.templateQuality, 0.08);
  assert.equal(state.metrics.templateKeypoints, 20);
});

test('keeps tracking state during the keypoint retry budget', () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service._updateWithKeypoints = () => ({
    success: false,
    reason: 'Optical flow rejected points',
    state: 'tracking'
  });
  service.persistenceSystem = {
    fullFrameSearch: () => ({ success: false, reason: 'Should not search while retrying' })
  };

  const result = service.updateAnchor({ width: 320, height: 240 });
  const state = service.getState();

  assert.equal(result.success, false);
  assert.equal(state.state, 'tracking');
  assert.equal(state.metrics.keypointFailureCount, 1);
  assert.equal(state.metrics.lostFrameCount, 0);
  assert.match(state.metrics.lastFailureReason, /Optical flow/);
});

test('keypoint updates propagate pose normals from homography correspondences', () => {
  const service = new ImageAnchorService();
  const poseNormal = { x: 0.32, y: -0.21, z: 0.92 };

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {};
  service.keypointTracker = {
    trackToFrame: () => ({
      success: true,
      successRate: 0.92,
      activePointCount: 24,
      averageError: 1.1
    }),
    getCorrespondences: () => Array.from({ length: 12 }, (_, index) => ({
      prev: {
        x: 20 + (index % 4) * 18,
        y: 30 + Math.floor(index / 4) * 16
      },
      curr: {
        x: 24 + (index % 4) * 18,
        y: 33 + Math.floor(index / 4) * 16
      }
    })),
    getObjectPose: () => createObjectPose({
      x: 140,
      y: 160,
      normal: poseNormal,
      scale: 1,
      rotation: 0.04,
      confidence: 0.76,
      inlierCount: 18,
    }),
    getAnchorPosition: () => ({
      x: 140,
      y: 160,
      method: 'reference_transform_with_offset'
    })
  };
  service.homographyEstimator = {
    estimatePose: () => ({
      success: true,
      normal: poseNormal,
      inlierCount: 18,
      inlierRatio: 0.75,
      confidence: 0.84
    })
  };

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.inliers, 18);
  assert.equal(result.normal.x.toFixed(2), '0.32');
  assert.equal(result.normal.y.toFixed(2), '-0.21');
  assert.equal(service.currentNormal.z.toFixed(2), '0.92');
});

test('affine parallax pose derives tilt from local point cloud deformation', () => {
  const service = new ImageAnchorService();
  const correspondences = Array.from({ length: 20 }, (_, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const prev = {
      x: 80 + column * 22,
      y: 70 + row * 20
    };
    const centerX = 124;

    return {
      prev,
      curr: {
        x: centerX + (prev.x - centerX) * 0.56 + 18,
        y: prev.y + 7
      }
    };
  });

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.templateRegion = { width: 180, height: 160 };
  service.cv = {};
  service.homographyEstimator = {
    estimatePose: () => ({
      success: false,
      reason: 'homography unavailable in unit test'
    })
  };
  service.keypointTracker = {
    trackToFrame: () => ({
      success: true,
      successRate: 0.92,
      activePointCount: 24,
      averageError: 1.1
    }),
    getCorrespondences: () => correspondences,
    getObjectPose: () => createObjectPose({
      x: 140,
      y: 160,
      normal: { x: 0.68, y: 0.02, z: 0.73 },
      scale: 1.02,
      rotation: 0,
      confidence: 0.82,
      inlierCount: 20,
    }),
    getAnchorPosition: () => ({
      x: 140,
      y: 160,
      method: 'reference_similarity_transform',
      rotation: 0,
      scale: 0.78,
      confidence: 0.9,
      inlierCount: 20
    })
  };
  service.homographyEstimator = {
    estimatePose: () => ({
      success: false,
      reason: 'homography is ambiguous'
    })
  };

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.poseSource, 'object-pose-affine');
  assert.ok(Math.abs(result.normal.x) > 0.55);
  assert.ok(result.normal.z < 0.84);
  assert.equal(service.getState().metrics.poseModel, 'object-pose');
});

test('template recovery preserves partial reference tracking before full reinitialization', () => {
  const service = new ImageAnchorService();
  let refreshed = 0;
  let reinitialized = 0;

  service.currentPosition = { x: 120, y: 140, z: 0 };
  service.currentNormal = { x: 0.1, y: 0.2, z: 0.97 };
  service.anchorState = 'degraded';
  service.persistenceSystem = {
    attemptRecovery: () => ({
      success: true,
      position: { x: 130, y: 150 },
      confidence: 0.82,
      scale: 1,
      method: 'template_matching'
    })
  };
  service.keypointTracker = {
    trackedPoints: Array.from({ length: 6 }, () => ({ status: 'active' }))
  };
  service._refreshKeypoints = () => {
    refreshed++;
  };
  service._reinitializeKeypoints = () => {
    reinitialized++;
  };

  const result = service._updateWithTemplate({});

  assert.equal(result.success, true);
  assert.equal(refreshed, 1);
  assert.equal(reinitialized, 0);
  assert.deepEqual(service.currentPosition, { x: 130, y: 150, z: 0 });
});

test('keypoint updates expose tracked planar scale and roll for the overlay', () => {
  const service = new ImageAnchorService();

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {};
  service.keypointTracker = {
    trackToFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 24,
      averageError: 1.1
    }),
    getCorrespondences: () => [],
    getObjectPose: () => createObjectPose({
      x: 140,
      y: 160,
      scale: 1.32,
      rotation: 0.37,
      confidence: 0.88,
      inlierCount: 18,
    }),
    getAnchorPosition: () => ({
      x: 140,
      y: 160,
      method: 'reference_similarity_transform',
      rotation: 0.37,
      scale: 1.32,
      confidence: 0.88,
      inlierCount: 18
    })
  };

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);
  const state = service.getState();

  assert.equal(result.success, true);
  assert.equal(result.planarTransform.rotation, 0.37);
  assert.equal(result.planarTransform.scale, 1.32);
  assert.equal(state.planarTransform.rotation, 0.37);
  assert.equal(state.planarTransform.scale, 1.32);
});

test('planar transform smoothing dampens one-frame scale and roll jumps', () => {
  const service = new ImageAnchorService();

  const initial = service._updatePlanarTransform({
    scale: 1,
    rotation: 0,
    confidence: 0.9,
    inlierCount: 24,
    method: 'reference_similarity_transform'
  }, 1000);
  const jumped = service._updatePlanarTransform({
    scale: 2,
    rotation: 1.2,
    confidence: 0.88,
    inlierCount: 24,
    method: 'reference_similarity_transform'
  }, 1016.67);

  assert.equal(initial.scale, 1);
  assert.equal(initial.rotation, 0);
  assert.ok(jumped.scale > 1);
  assert.ok(jumped.scale < 1.32);
  assert.ok(jumped.rotation > 0);
  assert.ok(jumped.rotation < 0.38);
});

test('planar roll smoothing follows the shortest path across the wrap boundary', () => {
  const service = new ImageAnchorService();

  service._updatePlanarTransform({
    scale: 1,
    rotation: Math.PI - 0.04,
    confidence: 0.9,
    inlierCount: 24,
    method: 'reference_similarity_transform'
  }, 1000);
  const wrapped = service._updatePlanarTransform({
    scale: 1,
    rotation: -Math.PI + 0.04,
    confidence: 0.9,
    inlierCount: 24,
    method: 'reference_similarity_transform'
  }, 1016.67);

  assert.ok(wrapped.rotation > 3.0);
});

test('keypoint updates drive the overlay from the object pose model', () => {
  const service = new ImageAnchorService();
  const objectPose = {
    success: true,
    method: 'object-pose-affine',
    position: { x: 214, y: 173, z: 0 },
    normal: { x: 0.7, y: -0.05, z: 0.712 },
    planarTransform: {
      scale: 1.48,
      rotation: 0.31,
      confidence: 0.87,
      inlierCount: 24,
      method: 'object-pose-affine',
    },
    confidence: 0.87,
    inlierCount: 24,
    inlierRatio: 0.8,
    averageResidual: 1.2,
    referenceSpread: { width: 130, height: 96, minAxis: 96 },
  };

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {};
  service.keypointTracker = {
    trackToFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 30,
      averageError: 1.1
    }),
    getObjectPose: () => objectPose,
    getCorrespondences: () => [],
    getAnchorPosition: () => ({
      x: 140,
      y: 160,
      method: 'reference_similarity_transform',
      rotation: 0,
      scale: 0.82,
      confidence: 0.5,
      inlierCount: 12
    })
  };

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.position.x, 214);
  assert.equal(result.position.y, 173);
  assert.equal(result.planarTransform.scale, 1.48);
  assert.equal(result.planarTransform.rotation, 0.31);
  assert.ok(result.normal.x > 0.5);
  assert.equal(result.poseSource, 'object-pose-affine');
});

test('unusable object pose does not replace stable tracker position and scale', () => {
  const service = new ImageAnchorService();

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 0.8,
    inlierCount: 20,
    method: 'previous',
  };
  service.cv = {};
  service.keypointTracker = {
    trackToFrame: () => ({
      success: true,
      successRate: 0.86,
      activePointCount: 28,
      averageError: 1.1
    }),
    getObjectPose: () => ({
      ...createObjectPose({
        x: 900,
        y: 520,
        scale: 2.2,
        rotation: 1.4,
        confidence: 0.18,
        inlierCount: 6,
      }),
      inlierRatio: 0.2,
      averageResidual: 12,
      referenceSpread: { width: 10, height: 8, minAxis: 8 },
    }),
    getCorrespondences: () => [],
    getAnchorPosition: () => ({
      x: 146,
      y: 164,
      method: 'reference_similarity_transform',
      rotation: 0.12,
      scale: 1.08,
      confidence: 0.82,
      inlierCount: 22
    })
  };

  const result = service._updateWithKeypoints({ cols: 1280, rows: 720 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.position.x, 146);
  assert.equal(result.position.y, 164);
  assert.equal(result.planarTransform.scale, 1.08);
  assert.equal(result.planarTransform.rotation, 0.12);
  assert.notEqual(result.position.x, 900);
  assert.equal(result.poseSource, null);
  assert.equal(service.getState().metrics.poseSource, null);
  assert.match(service.getState().metrics.poseRejectedReason, /Insufficient pose inliers|Low pose inlier ratio|Low pose confidence|Degenerate local pose spread/);
});

test('lost anchors stay recoverable instead of scheduling automatic reset', () => {
  const service = new ImageAnchorService();
  let fullFrameSearches = 0;
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'lost';
  service.currentPosition = { x: 120, y: 140, z: 0 };
  service.metrics.recoveryAttempts = 5;
  service.framesSinceFullFrameRecovery = service.fullFrameRecoveryInterval;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.persistenceSystem = {
    attemptRecovery: () => ({ success: false, reason: 'Template not visible' }),
    fullFrameSearch: () => {
      fullFrameSearches++;
      return { success: false, reason: 'Object still outside camera view' };
    }
  };

  const result = service.updateAnchor({ width: 320, height: 240 });
  const state = service.getState();

  assert.equal('_startAutoResetTimer' in service, false);
  assert.equal(result.success, false);
  assert.equal(state.anchored, true);
  assert.equal(state.state, 'lost');
  assert.equal(fullFrameSearches, 1);
});

test('normal tracking refreshes keypoints to grow the landmark map before stable lock', () => {
  const service = new ImageAnchorService();
  let refreshes = 0;

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.framesSinceRefresh = service.refreshInterval - 1;
  service.cv = {};
  service.keypointTracker = {
    trackToFrame: () => ({
      success: true,
      successRate: 0.68,
      activePointCount: 18,
      averageError: 2.2
    }),
    getCorrespondences: () => Array.from({ length: 18 }, (_, index) => ({
      prev: { x: 70 + (index % 6) * 14, y: 80 + Math.floor(index / 6) * 14 },
      curr: { x: 76 + (index % 6) * 13, y: 85 + Math.floor(index / 6) * 14 }
    })),
    getObjectPose: () => createObjectPose({
      x: 142,
      y: 164,
      normal: { x: 0.18, y: -0.05, z: 0.98 },
      scale: 1.02,
      rotation: 0.08,
      confidence: 0.72,
      inlierCount: 16,
    }),
    getAnchorPosition: () => ({
      x: 142,
      y: 164,
      method: 'reference_similarity_transform',
      rotation: 0.08,
      scale: 1.02,
      confidence: 0.7,
      inlierCount: 14
    })
  };
  service._estimatePoseFromCorrespondences = () => ({
    success: true,
    method: 'affine-parallax',
    normal: { x: 0.18, y: -0.05, z: 0.98 },
    inlierCount: 16,
    inlierRatio: 0.72,
    confidence: 0.72
  });
  service._refreshKeypoints = () => {
    refreshes++;
  };

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.state, 'tracking');
  assert.equal(refreshes, 1);
});

test('pose estimation retries with wider landmark support when the tapped patch is too local', () => {
  const service = new ImageAnchorService();
  const calls = [];
  const wideCorrespondences = Array.from({ length: 24 }, (_, index) => ({
    prev: { x: 54 + (index % 6) * 24, y: 62 + Math.floor(index / 6) * 22 },
    curr: { x: 62 + (index % 6) * 16, y: 70 + Math.floor(index / 6) * 22 }
  }));

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.templateRegion = { width: 180, height: 160 };
  service.cv = {};
  service.homographyEstimator = {
    estimatePose: () => ({
      success: false,
      reason: 'homography unavailable in unit test'
    })
  };
  service.keypointTracker = {
    trackedPoints: Array.from({ length: 64 }, () => ({ status: 'active' })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.82,
      activePointCount: 64,
      averageError: 1.4
    }),
    getCorrespondences: options => {
      calls.push(options.maxReferenceDistance);
      return options.maxReferenceDistance < 100
        ? wideCorrespondences.slice(0, 6)
        : wideCorrespondences;
    },
    getObjectPose: () => createObjectPose({
      x: 140,
      y: 160,
      normal: { x: 0.58, y: 0.02, z: 0.81 },
      scale: 1.18,
      rotation: 0,
      confidence: 0.82,
      inlierCount: 24,
    }),
    getAnchorPosition: () => ({
      x: 140,
      y: 160,
      method: 'reference_similarity_transform',
      rotation: 0,
      scale: 0.8,
      confidence: 0.85,
      inlierCount: 24
    })
  };

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.poseSource, 'object-pose-affine');
  assert.ok(Math.abs(result.normal.x) > 0.4);
  assert.ok(calls.some(radius => radius >= 100));
  assert.ok(service.getState().metrics.posePatchRadius >= 100);
});
