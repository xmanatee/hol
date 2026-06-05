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
  inlierRatio = 0.78,
  foreshortening = 1,
  method = 'object-pose-affine',
  averageResidual = 1.4,
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
  inlierRatio,
  averageResidual,
  foreshortening,
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

test('anchor position filters adapt quickly enough to follow real object motion', () => {
  const service = new ImageAnchorService();

  const first = service.positionFilterX.filter(0, 1000);
  const jumped = service.positionFilterX.filter(100, 1016.67);

  assert.equal(first, 0);
  assert.ok(jumped > 55);
  assert.ok(jumped < 100);
});

test('reconstruction position updates are step-limited to prevent head teleports', () => {
  const service = new ImageAnchorService();
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';

  const limited = service._limitPositionStep(
    { x: 240, y: 166, z: 0 },
    'sparse-reconstruction'
  );

  assert.ok(Math.hypot(limited.x - 200, limited.y - 160) <= 12.1);
  assert.ok(limited.x > 211);
  assert.equal(limited.z, 0);
});

test('small position updates are not step-limited', () => {
  const service = new ImageAnchorService();
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };

  const limited = service._limitPositionStep(
    { x: 207, y: 164, z: 0 },
    'sparse-reconstruction'
  );

  assert.deepEqual(limited, { x: 207, y: 164, z: 0 });
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
  assert.deepEqual(state.normal, { x: 0, y: 0, z: 1 });
  assert.deepEqual(service.normalStabilizer.getNormal(), { x: 0, y: 0, z: 1 });
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
  service.currentNormal = { x: 0.1, y: -0.2, z: 0.97 };
  service.currentPlanarTransform = {
    scale: 1.1,
    rotation: 0.2,
    confidence: 0.7,
    method: 'planar-homography'
  };
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

  assert.equal(result.success, true);
  assert.equal(result.recoverable, true);
  assert.equal(result.method, 'held-last-pose');
  assert.deepEqual(result.position, { x: 100, y: 120, z: 0 });
  assert.deepEqual(result.normal, { x: 0.1, y: -0.2, z: 0.97 });
  assert.equal(result.planarTransform.scale, 1.1);
  assert.equal(state.state, 'tracking');
  assert.equal(state.metrics.keypointFailureCount, 1);
  assert.equal(state.metrics.lostFrameCount, 0);
  assert.match(result.reason, /Optical flow/);
});

test('keypoint failure recovers through descriptor keyframe relocalization before template fallback', () => {
  const service = new ImageAnchorService();
  const transform = {
    tx: 24,
    ty: -12,
    scale: 1.18,
    rotation: 0.2,
    confidence: 0.86,
    averageResidual: 1.1,
  };
  const trackedPoints = Array.from({ length: 16 }, (_, index) => ({
    id: index,
    original: { x: 80 + (index % 4) * 16, y: 70 + Math.floor(index / 4) * 16 },
    current: { x: 0, y: 0 },
    status: 'lost',
    response: 1,
    age: 12,
    stabilityScore: 0.7,
  }));
  const correspondences = trackedPoints.map(point => ({
    prev: point.original,
    curr: {
      x: point.original.x + 20,
      y: point.original.y - 10,
    },
  }));

  service.anchorState = 'tracking';
  service.templateRegion = { x: 40, y: 40, width: 160, height: 140 };
  service.currentPosition = { x: 120, y: 110, z: 0 };
  service.keypointDetector = {
    extractKeypoints: () => ({ keypoints: Array.from({ length: 40 }, (_, index) => ({ pt: { x: 30 + index, y: 40 + index }, response: 1 })) }),
  };
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: () => ({
      success: true,
      method: 'patch-keyframe-relocalization',
      transform,
      confidence: 0.86,
      averageResidual: 1.1,
      matchCount: 22,
      inlierCount: 16,
      inlierIds: trackedPoints.map(point => point.id),
      keyframeCount: 3,
    }),
  };
  service.keypointTracker = {
    trackedPoints,
    trackToFrame: () => ({ success: false, reason: 'LK lost all points' }),
    restoreFromReferenceTransform: () => {
      trackedPoints.forEach(point => {
        point.status = 'active';
      });
      return { restored: 16, total: 16, active: 16 };
    },
    getObjectPose: () => createObjectPose({
      x: 144,
      y: 122,
      scale: 1.18,
      rotation: 0.2,
      method: 'object-pose-affine',
    }),
    getCorrespondences: () => correspondences,
    getAnchorPosition: () => ({
      x: 144,
      y: 122,
      scale: 1.18,
      rotation: 0.2,
      confidence: 0.8,
      inlierCount: 16,
      method: 'reference_similarity_transform',
    }),
    refreshKeypoints: () => false,
  };
  service.homographyEstimator = {
    estimatePose: () => createObjectPose({
      x: 144,
      y: 122,
      scale: 1.18,
      rotation: 0.2,
      method: 'homography',
    }),
  };

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.method, 'object-pose-affine');
  assert.equal(service.metrics.relocalizationResult, 'success');
  assert.equal(service.metrics.relocalizationMatches, 22);
  assert.equal(service.metrics.relocalizationInliers, 16);
  assert.equal(service.metrics.activeLandmarkCount, 16);
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

test('foreshortened object pose normal is not replaced by face-on homography', () => {
  const service = new ImageAnchorService();
  const objectPose = createObjectPose({
    normal: { x: 0.82, y: 0.04, z: 0.57 },
    scale: 0.86,
    rotation: 0.12,
    confidence: 0.49,
    inlierCount: 14,
    inlierRatio: 0.5,
    foreshortening: 0.51,
  });
  const homographyPose = {
    success: true,
    method: 'homography',
    normal: { x: 0, y: 0, z: 1 },
    confidence: 0.74,
    inlierCount: 12,
    inlierRatio: 0.5,
    referenceSpread: { width: 120, height: 90, minAxis: 90 },
  };
  const correspondences = Array.from({ length: 24 }, (_, index) => ({
    prev: { x: 70 + (index % 6) * 20, y: 80 + Math.floor(index / 6) * 18 },
    curr: { x: 72 + (index % 6) * 14, y: 82 + Math.floor(index / 6) * 18 },
  }));

  const selected = service._selectNormalPose({
    objectPose,
    poseResult: homographyPose,
    correspondences,
  });

  assert.equal(selected.method, 'object-pose-affine');
  assert.ok(selected.normal.x > 0.75);
  assert.ok(selected.normal.z < 0.65);
});

test('noisy affine object pose is rejected before it can poison the stabilized normal', () => {
  const service = new ImageAnchorService();
  const pose = createObjectPose({
    confidence: 0.64,
    inlierCount: 18,
    inlierRatio: 0.72,
    averageResidual: 8.8,
  });
  const correspondences = Array.from({ length: 24 }, (_, index) => ({
    prev: { x: 70 + (index % 6) * 20, y: 80 + Math.floor(index / 6) * 18 },
    curr: { x: 72 + (index % 6) * 14, y: 82 + Math.floor(index / 6) * 18 },
  }));

  assert.equal(
    service._getPoseRejectionReason(pose, correspondences),
    'High pose residual'
  );
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

test('reconstruction tracking mode drives the overlay from the sparse 3D map when ready and consistent', () => {
  const service = new ImageAnchorService();
  const reconstructionPose = {
    success: true,
    method: 'sparse-reconstruction',
    position: { x: 238, y: 181, z: 0 },
    normal: { x: 0.42, y: -0.18, z: 0.89 },
    planarTransform: {
      scale: 1.27,
      rotation: 0.22,
      confidence: 0.91,
      inlierCount: 28,
      method: 'sparse-reconstruction',
    },
    confidence: 0.91,
    inlierCount: 28,
    inlierRatio: 0.84,
    averageResidual: 1.1,
    depthQuality: 0.08,
    preview: {
      ready: true,
      poseModel: 'sparse-reconstruction',
      points: [{ id: 1, x: 0, y: 0, z: 0 }],
      statistics: {
        averageSupport: 0.81,
        averageReliability: 0.74,
        matureLandmarks: 29,
        mapConfidence: 0.77,
        mappedFrames: 7,
      },
      anchor: { x: 0, y: 0, z: 0 },
      current: {
        points: [{ id: 1, x: 238, y: 181 }],
        anchor: { x: 238, y: 181 },
        normal: { x: 0.42, y: -0.18, z: 0.89 },
      }
    },
  };

  service.setTrackingMode('sparse-reconstruction');
  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {};
  service.reconstructor = {
    addFrameFromTrackedPoints: () => ({
      state: 'ready',
      ready: true,
      frameCount: 7,
      landmarkCount: 34,
      depthQuality: 0.08,
      statistics: {
        averageSupport: 0.81,
        averageReliability: 0.74,
        matureLandmarks: 29,
        mapConfidence: 0.77,
        mappedFrames: 7,
      },
      lastFailureReason: null,
    }),
    getState: () => ({
      state: 'ready',
      ready: true,
      frameCount: 7,
      landmarkCount: 34,
      depthQuality: 0.08,
      statistics: {
        averageSupport: 0.81,
        averageReliability: 0.74,
        matureLandmarks: 29,
        mapConfidence: 0.77,
        mappedFrames: 7,
      },
      lastFailureReason: null,
    }),
    estimatePoseFromTrackedPoints: () => reconstructionPose,
  };
  service.keypointTracker = {
    trackedPoints: Array.from({ length: 34 }, (_, index) => ({
      id: index,
      status: 'active',
      original: {
        x: 80 + (index % 7) * 22,
        y: 70 + Math.floor(index / 7) * 18,
      },
      current: {
        x: 92 + (index % 7) * 25,
        y: 78 + Math.floor(index / 7) * 20,
      },
    })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.92,
      activePointCount: 34,
      averageError: 1.1
    }),
    getObjectPose: () => createObjectPose({
      x: 130,
      y: 140,
      scale: 0.86,
      rotation: -0.08,
      confidence: 0.7,
      inlierCount: 18,
    }),
    getCorrespondences: () => [],
    getAnchorPosition: () => ({
      x: 232,
      y: 176,
      method: 'reference_similarity_transform',
      rotation: 0,
      scale: 1,
      confidence: 0.7,
      inlierCount: 18
    })
  };

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);
  const state = service.getState();

  assert.equal(result.success, true);
  assert.equal(result.method, 'sparse-reconstruction');
  assert.equal(result.position.x, 238);
  assert.equal(result.position.y, 181);
  assert.equal(result.planarTransform.scale, 1.27);
  assert.equal(result.poseSource, 'sparse-reconstruction');
  assert.equal(state.metrics.poseModel, 'sparse-reconstruction');
  assert.equal(state.metrics.reconstructionReady, true);
  assert.equal(state.metrics.reconstructionPoseInliers, 28);
  assert.equal(state.metrics.reconstructionPreview.current.anchor.x, 238);
  assert.equal(state.metrics.reconstructionMapConfidence, 0.77);
  assert.equal(state.metrics.reconstructionAverageSupport, 0.81);
  assert.equal(state.metrics.reconstructionMatureLandmarks, 29);
});

test('planar homography dominates sparse reconstruction for flat textured objects', () => {
  const service = new ImageAnchorService();
  const anchorReference = { x: 100, y: 100 };
  const homographyMatrix = [
    1.16, 0.12, 28,
    -0.05, 1.08, 19,
    0.00035, -0.00018, 1,
  ];
  const project = point => {
    const denominator = homographyMatrix[6] * point.x + homographyMatrix[7] * point.y + homographyMatrix[8];
    return {
      x: (homographyMatrix[0] * point.x + homographyMatrix[1] * point.y + homographyMatrix[2]) / denominator,
      y: (homographyMatrix[3] * point.x + homographyMatrix[4] * point.y + homographyMatrix[5]) / denominator,
    };
  };
  const expectedAnchor = project(anchorReference);
  const wrongReconstructionPose = {
    success: true,
    method: 'sparse-reconstruction',
    position: { x: 430, y: 82, z: 0 },
    normal: { x: 0.76, y: -0.12, z: 0.64 },
    planarTransform: {
      scale: 0.54,
      rotation: -0.74,
      confidence: 0.82,
      inlierCount: 24,
      method: 'sparse-reconstruction',
    },
    confidence: 0.82,
    inlierCount: 24,
    inlierRatio: 0.72,
    averageResidual: 1.4,
    depthQuality: 0.012,
    preview: {
      statistics: {
        mapConfidence: 0.76,
        averageSupport: 0.82,
        averageReliability: 0.71,
        matureLandmarks: 28,
      },
    },
  };

  service.setTrackingMode('sparse-reconstruction');
  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 100, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.cv = {};
  service.reconstructor = {
    addFrameFromTrackedPoints: () => ({
      state: 'ready',
      ready: true,
      frameCount: 8,
      landmarkCount: 38,
      depthQuality: 0.012,
      statistics: {
        mapConfidence: 0.76,
        averageSupport: 0.82,
        averageReliability: 0.71,
        matureLandmarks: 28,
      },
      lastFailureReason: null,
    }),
    getState: () => ({
      state: 'ready',
      ready: true,
      frameCount: 8,
      landmarkCount: 38,
      depthQuality: 0.012,
      statistics: {
        mapConfidence: 0.76,
        averageSupport: 0.82,
        averageReliability: 0.71,
        matureLandmarks: 28,
      },
      lastFailureReason: null,
    }),
    estimatePoseFromTrackedPoints: () => wrongReconstructionPose,
  };
  service.keypointTracker = {
    anchorOriginalPosition: anchorReference,
    trackedPoints: Array.from({ length: 38 }, (_, index) => ({
      id: index,
      status: 'active',
      original: {
        x: 56 + (index % 8) * 17,
        y: 58 + Math.floor(index / 8) * 19,
      },
      current: {
        x: 66 + (index % 8) * 18,
        y: 70 + Math.floor(index / 8) * 20,
      },
    })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.94,
      activePointCount: 38,
      averageError: 0.9
    }),
    getObjectPose: () => createObjectPose({
      x: expectedAnchor.x,
      y: expectedAnchor.y,
      scale: 1.11,
      rotation: 0.08,
      normal: { x: 0.1, y: -0.04, z: 0.99 },
      confidence: 0.75,
      inlierCount: 24,
      foreshortening: 0.93,
    }),
    getCorrespondences: () => Array.from({ length: 34 }, (_, index) => ({
      prev: {
        x: 56 + (index % 8) * 17,
        y: 58 + Math.floor(index / 8) * 19,
      },
      curr: project({
        x: 56 + (index % 8) * 17,
        y: 58 + Math.floor(index / 8) * 19,
      }),
    })),
    getAnchorPosition: () => ({
      x: expectedAnchor.x,
      y: expectedAnchor.y,
      method: 'reference_similarity_transform',
      scale: 1.1,
      rotation: 0.08,
      confidence: 0.72,
      inlierCount: 24
    })
  };
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: service.keypointTracker.getCorrespondences(),
    poseResult: {
      success: true,
      method: 'homography',
      homographyMatrix,
      normal: { x: 0.16, y: -0.05, z: 0.986 },
      confidence: 0.92,
      inlierCount: 32,
      inlierRatio: 0.94,
      referenceSpread: { width: 150, height: 116, minAxis: 116 },
    }
  });

  const result = service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.method, 'planar-homography');
  assert.ok(Math.abs(result.position.x - expectedAnchor.x) < 0.01);
  assert.ok(Math.abs(result.position.y - expectedAnchor.y) < 0.01);
  assert.ok(result.normal.x < 0.25);
  assert.ok(result.normal.z > 0.97);
  assert.equal(service.getState().metrics.poseSource, 'planar-homography');
});

test('real-depth sparse reconstruction owns orientation while local planar patch owns attachment transform', () => {
  const service = new ImageAnchorService();
  const anchorReference = { x: 120, y: 118 };
  const homographyMatrix = [
    1.04, 0.02, 12,
    0.01, 1.02, 8,
    0.0001, 0.00005, 1,
  ];
  const project = point => {
    const denominator = homographyMatrix[6] * point.x + homographyMatrix[7] * point.y + homographyMatrix[8];
    return {
      x: (homographyMatrix[0] * point.x + homographyMatrix[1] * point.y + homographyMatrix[2]) / denominator,
      y: (homographyMatrix[3] * point.x + homographyMatrix[4] * point.y + homographyMatrix[5]) / denominator,
    };
  };
  const reconstructionPose = {
    success: true,
    method: 'sparse-reconstruction',
    position: { x: 140, y: 129, z: 0 },
    normal: { x: 0.58, y: -0.08, z: 0.81 },
    planarTransform: {
      scale: 1.24,
      rotation: 0.31,
      confidence: 0.83,
      inlierCount: 25,
      method: 'sparse-reconstruction',
    },
    confidence: 0.83,
    inlierCount: 25,
    inlierRatio: 0.72,
    averageResidual: 1.8,
    depthQuality: 0.18,
    preview: {
      statistics: {
        mapConfidence: 0.79,
        averageSupport: 0.78,
        averageReliability: 0.74,
        matureLandmarks: 27,
      },
    },
  };

  service.setTrackingMode('sparse-reconstruction');
  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 120, y: 118, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.planarDominanceScore = 8;
  service.cv = {};
  service.reconstructor = {
    addFrameFromTrackedPoints: () => ({
      state: 'ready',
      ready: true,
      frameCount: 8,
      landmarkCount: 36,
      depthQuality: 0.18,
      statistics: {
        mapConfidence: 0.79,
        averageSupport: 0.78,
        averageReliability: 0.74,
        matureLandmarks: 27,
      },
      lastFailureReason: null,
    }),
    getState: () => ({
      state: 'ready',
      ready: true,
      frameCount: 8,
      landmarkCount: 36,
      depthQuality: 0.18,
      statistics: {
        mapConfidence: 0.79,
        averageSupport: 0.78,
        averageReliability: 0.74,
        matureLandmarks: 27,
      },
      lastFailureReason: null,
    }),
    estimatePoseFromTrackedPoints: () => reconstructionPose,
  };
  service.keypointTracker = {
    anchorOriginalPosition: anchorReference,
    trackedPoints: Array.from({ length: 36 }, (_, index) => ({
      id: index,
      status: 'active',
      original: {
        x: 74 + (index % 9) * 14,
        y: 72 + Math.floor(index / 9) * 16,
      },
      current: {
        x: 82 + (index % 9) * 15,
        y: 78 + Math.floor(index / 9) * 17,
      },
    })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 36,
      averageError: 1.2
    }),
    getObjectPose: () => createObjectPose({
      x: 138,
      y: 128,
      scale: 1.05,
      rotation: 0.05,
      normal: { x: 0.12, y: 0.02, z: 0.99 },
      confidence: 0.72,
      inlierCount: 18,
    }),
    getCorrespondences: () => Array.from({ length: 30 }, (_, index) => ({
      prev: {
        x: 74 + (index % 9) * 14,
        y: 72 + Math.floor(index / 9) * 16,
      },
      curr: project({
        x: 74 + (index % 9) * 14,
        y: 72 + Math.floor(index / 9) * 16,
      }),
    })),
    getAnchorPosition: () => ({
      x: 138,
      y: 128,
      method: 'reference_similarity_transform',
      scale: 1.05,
      rotation: 0.05,
      confidence: 0.72,
      inlierCount: 18
    })
  };
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: service.keypointTracker.getCorrespondences(),
    poseResult: {
      success: true,
      method: 'homography',
      homographyMatrix,
      normal: { x: 0.09, y: 0.01, z: 0.996 },
      confidence: 0.86,
      inlierCount: 22,
      inlierRatio: 0.73,
      referenceSpread: { width: 126, height: 78, minAxis: 78 },
      averageResidual: 1.5,
    }
  });

  const result = service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);
  const expectedPatchPosition = project(anchorReference);

  assert.equal(result.success, true);
  assert.equal(result.method, 'planar-homography');
  assert.ok(Math.abs(result.position.x - expectedPatchPosition.x) < 1e-9);
  assert.ok(Math.abs(result.position.y - expectedPatchPosition.y) < 1e-9);
  assert.equal(result.planarTransform.method, 'planar-homography');
  assert.ok(result.normal.x > 0.25);
  assert.equal(service.getState().metrics.poseSource, 'sparse-reconstruction');
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

test('pose estimation compares local and wide candidates when both are usable', () => {
  const service = new ImageAnchorService();
  const localCorrespondences = Array.from({ length: 12 }, (_, index) => ({
    prev: { x: 90 + (index % 4) * 18, y: 100 + Math.floor(index / 4) * 22 },
    curr: { x: 92 + (index % 4) * 16, y: 102 + Math.floor(index / 4) * 21 },
  }));
  const wideCorrespondences = Array.from({ length: 24 }, (_, index) => ({
    prev: { x: 54 + (index % 6) * 24, y: 62 + Math.floor(index / 6) * 22 },
    curr: { x: 62 + (index % 6) * 16, y: 70 + Math.floor(index / 6) * 22 },
  }));

  service.templateRegion = { width: 180, height: 160 };
  service.cv = {};
  service.keypointTracker = {
    anchorOriginalPosition: { x: 120, y: 130 },
    getCorrespondences: options => (
      options.maxReferenceDistance < 100 ? localCorrespondences : wideCorrespondences
    ),
  };
  service.homographyEstimator = {
    estimatePose: (_cv, correspondences) => {
      const wide = correspondences.length > 12;
      return {
        success: true,
        method: 'homography',
        normal: wide
          ? { x: 0.62, y: -0.08, z: 0.78 }
          : { x: -0.38, y: 0.12, z: 0.92 },
        confidence: wide ? 0.84 : 0.58,
        inlierCount: wide ? 17 : 10,
        inlierRatio: wide ? 0.71 : 0.83,
        averageResidual: wide ? 0.6 : 1.9,
        referenceSpread: wide
          ? { width: 132, height: 88, minAxis: 88 }
          : { width: 54, height: 44, minAxis: 44 },
      };
    },
  };

  const result = service._estimatePoseFromTracker();

  assert.equal(result.correspondences.length, 24);
  assert.ok(result.options.maxReferenceDistance >= 100);
  assert.ok(result.poseResult.normal.x > 0.5);
});

test('inconsistent reconstruction does not replace tracked attachment scale', () => {
  const service = new ImageAnchorService();
  service.planarDominanceScore = 8;
  service.currentPlanarTransform = {
    scale: 1.32,
    rotation: 0.24,
    confidence: 0.8,
    inlierCount: 20,
    method: 'planar-homography',
  };
  const trackerAnchorPosition = {
    scale: 0.92,
    rotation: -0.08,
    confidence: 0.5,
    inlierCount: 18,
    method: 'reference_similarity_transform',
  };
  const reconstructionPose = {
    success: true,
    planarTransform: {
      scale: 1.45,
      rotation: 0.31,
      confidence: 0.86,
      inlierCount: 24,
      method: 'sparse-reconstruction',
    },
  };

  const transform = service._selectTrackedAttachmentTransform({
    trackerAnchorPosition,
    reconstructionPose,
    useTrackedTransform: true,
  });

  assert.equal(transform.scale, trackerAnchorPosition.scale);
  assert.equal(transform.rotation, trackerAnchorPosition.rotation);
  assert.equal(transform.method, 'reference_similarity_transform');
});
