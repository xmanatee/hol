import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageAnchorService } from './ImageAnchorService.js';
import { createObjectSupportMask, isPointInsideObjectSupport } from '../cv/objectSupportMask.js';

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

const createPlanarPose = ({
  inlierCount = 22,
  inlierRatio = 0.64,
  confidence = 0.58,
  averageResidual = 1.1,
  referenceSpread = { width: 92, height: 58, minAxis: 58 },
} = {}) => ({
  success: true,
  method: 'planar-homography',
  position: { x: 160, y: 140, z: 0 },
  normal: { x: 0.08, y: -0.06, z: 0.995 },
  planarTransform: {
    scale: 1.04,
    rotation: 0.08,
    confidence,
    inlierCount,
    method: 'planar-homography',
  },
  confidence,
  inlierCount,
  inlierRatio,
  averageResidual,
  foreshortening: 0.96,
  referenceSpread,
});

test('template region ignores raw detection metadata without object support', () => {
  const service = new ImageAnchorService();
  const tap = { x: 500, y: 320 };
  const region = service._calculateTemplateRegion(
    tap,
    { x1: 0, y1: 0, x2: 100, y2: 100 },
    1280,
    720
  );

  assert.equal(region.width, 140);
  assert.equal(region.height, 140);
  assert.equal(region.x + region.width / 2, tap.x);
  assert.equal(region.y + region.height / 2, tap.y);
});

test('large detections create a tap-local template instead of seeding the whole box', () => {
  const service = new ImageAnchorService();
  const tap = { x: 240, y: 180 };
  const region = service._calculateTemplateRegion(
    tap,
    {
      x1: 100,
      y1: 80,
      x2: 900,
      y2: 680,
      objectSupportMask: {
        width: 1280,
        height: 720,
        bbox: { x: 200, y: 140, width: 80, height: 80 },
      },
    },
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

test('pose candidate arbitration uses current silhouette evidence', () => {
  const service = new ImageAnchorService();
  service.trackingMode = 'sparse-reconstruction';
  service.metrics.objectOwnedLandmarks = 22;
  service.metrics.activeLandmarkCount = 24;
  service.metrics.reconstructionMatureLandmarks = 20;
  service.metrics.contourFitResidual = 9.4;
  service.metrics.silhouetteCoverage = 0.16;

  const result = service._recordPoseCandidates({
    reconstructionPose: createObjectPose({
      method: 'sparse-reconstruction',
      confidence: 0.86,
      inlierCount: 28,
      averageResidual: 1.2,
    }),
    planarPose: createPlanarPose({
      confidence: 0.62,
      inlierCount: 20,
      averageResidual: 2.1,
    }),
    objectPose: null,
    trackerAnchorPosition: null,
    reconstructionConsistentWithTracker: true,
  });

  assert.equal(result.selected, null);
  assert.equal(result.rejected['sparse-reconstruction'].reason, 'silhouette-mismatch');
  assert.equal(result.rejected['planar-homography'].reason, 'silhouette-mismatch');
  assert.equal(service.metrics.poseCandidates[0].contourFitResidual, 9.4);
  assert.equal(service.metrics.poseCandidates[0].silhouetteCoverage, 0.16);
});

test('reconstruction pose update suppresses live previews on the tracking hot path', () => {
  for (const mode of ['sparse-reconstruction', 'direct-photometric']) {
    const service = new ImageAnchorService();
    const grayImage = { cols: 64, rows: 64 };
    const trackedPoints = [{
      id: 1,
      status: 'active',
      original: { x: 20, y: 24 },
      current: { x: 23, y: 26 },
    }];
    let addFrameArgs = null;
    let poseArgs = null;

    service.trackingMode = mode;
    service.keypointTracker = { trackedPoints };
    service.reconstructor = {
      addFrameFromTrackedPoints: (...args) => {
        addFrameArgs = args;
        return {
        state: 'ready',
        ready: true,
        frameCount: 1,
        landmarkCount: 12,
        depthQuality: 0.12,
        statistics: { mapConfidence: 0.72 },
        lastFailureReason: null,
        };
      },
      estimatePoseFromTrackedPoints: (...args) => {
        poseArgs = args;
        return {
          success: false,
          method: mode,
          reason: 'unit test pose rejected',
        };
      },
    };

    service._updateReconstructionPoseFromTracker(1000, grayImage);

    assert.equal(addFrameArgs[0], trackedPoints);
    assert.equal(addFrameArgs[1], 1000);
    assert.equal(poseArgs[0], trackedPoints);
    if (mode === 'direct-photometric') {
      assert.equal(addFrameArgs[2], grayImage);
      assert.deepEqual(addFrameArgs[3].includePreview, false);
      assert.equal(poseArgs[1], grayImage);
      assert.deepEqual(poseArgs[2], { includePreview: false });
    } else {
      assert.deepEqual(addFrameArgs[2].includePreview, false);
      assert.deepEqual(poseArgs[1], { includePreview: false });
    }
  }
});

test('selected strong curved reconstruction can bypass planar pose estimation', () => {
  const service = new ImageAnchorService();
  const reconstructionPose = createObjectPose({
    method: 'parametric-surface',
    inlierCount: 18,
    confidence: 0.88,
    averageResidual: 1.4,
  });
  reconstructionPose.depthQuality = 0.16;

  service.trackingMode = 'parametric-surface';
  service.anchorTargetClass = 'mug';
  service.metrics.reconstructionMapConfidence = 0.74;
  assert.equal(service._shouldSkipPlanarPoseForSelectedReconstruction(reconstructionPose), true);

  service.anchorTargetClass = 'book';
  assert.equal(service._shouldSkipPlanarPoseForSelectedReconstruction(reconstructionPose), false);

  service.anchorTargetClass = 'mug';
  service.metrics.reconstructionMapConfidence = 0.4;
  assert.equal(service._shouldSkipPlanarPoseForSelectedReconstruction(reconstructionPose), false);
});

test('object pose is the single anchor pose model', () => {
  const service = new ImageAnchorService();
  const metrics = service.getState().metrics;

  assert.equal(metrics.poseModel, 'object-pose');
  assert.equal(Object.hasOwn(metrics, 'poseStrategy'), false);
});

test('flat paper-like targets use planar pose ownership', () => {
  const service = new ImageAnchorService();

  for (const targetClass of ['book', 'poster', 'phone', 'laminated card', 'shipping label']) {
    service.anchorTargetClass = targetClass;
    assert.equal(service._hasPlanarTargetClass(), true, targetClass);
    assert.equal(service._hasRigidPlanarTargetClass(), true, targetClass);
  }

  service.anchorTargetClass = 'bag';
  assert.equal(service._hasPlanarTargetClass(), true);
  assert.equal(service._hasRigidPlanarTargetClass(), false);

  for (const targetClass of ['can', 'face', 'shelves']) {
    service.anchorTargetClass = targetClass;
    assert.equal(service._hasPlanarTargetClass(), false, targetClass);
    assert.equal(service._hasRigidPlanarTargetClass(), false, targetClass);
  }
});

test('planar dominance does not let weak homography own the tapped attachment', () => {
  const service = new ImageAnchorService();
  service.anchorTargetClass = 'card';
  service.planarDominanceScore = 7;

  const correspondences = Array.from({ length: 28 }, (_, index) => ({
    prev: { x: 90 + index * 3, y: 120 + (index % 4) * 2 },
    curr: { x: 94 + index * 3.1, y: 122 + (index % 4) * 2.1 },
  }));
  const weakLocalPlanarPose = createPlanarPose({
    inlierCount: 9,
    inlierRatio: 0.36,
    confidence: 0.3,
    averageResidual: 1.0,
    referenceSpread: { width: 36, height: 14, minAxis: 14 },
  });
  const strongPlanarPose = createPlanarPose();

  assert.equal(service._shouldPreferPlanarHomography({
    planarPose: weakLocalPlanarPose,
    reconstructionPose: { success: false },
    correspondences,
  }), false);
  assert.equal(service._shouldPreferPlanarHomography({
    planarPose: strongPlanarPose,
    reconstructionPose: { success: false },
    correspondences,
  }), true);
});

test('known flat targets can use moderate planar attachment without passing the face-ready gate', () => {
  const service = new ImageAnchorService();
  service.anchorTargetClass = 'book';
  service.planarDominanceScore = 7;
  const correspondences = Array.from({ length: 18 }, (_, index) => ({
    prev: { x: 80 + index * 5, y: 95 + (index % 6) * 8 },
    curr: { x: 84 + index * 5.2, y: 98 + (index % 6) * 8.1 },
  }));
  const moderatePlanarPose = createPlanarPose({
    inlierCount: 12,
    inlierRatio: 0.54,
    confidence: 0.38,
    averageResidual: 2.1,
    referenceSpread: { width: 86, height: 44, minAxis: 44 },
  });

  assert.equal(service._shouldPreferPlanarHomography({
    planarPose: moderatePlanarPose,
    reconstructionPose: { success: false },
    correspondences,
  }), true);

  const readiness = service._createReadiness({
    state: 'stable',
    poseSource: 'planar-homography',
    positionSource: 'planar-homography',
    reconstructionReady: true,
    poseInliers: moderatePlanarPose.inlierCount,
    poseConfidence: moderatePlanarPose.confidence,
    poseAverageResidual: moderatePlanarPose.averageResidual,
  });

  assert.equal(readiness.poseQualityReady, false);
  assert.equal(readiness.faceReady, false);
});

test('rigid planar targets recover from occlusion with absolute homography support', () => {
  const service = new ImageAnchorService();
  service.anchorTargetClass = 'card';
  service.planarDominanceScore = 8;
  service.metrics.activeLandmarkCount = 36;
  service.metrics.objectOwnedLandmarks = 33;
  service.metrics.silhouetteCoverage = 0.72;
  service.metrics.contourFitResidual = 0.8;

  const correspondences = Array.from({ length: 36 }, (_, index) => ({
    prev: { x: 74 + (index % 9) * 10, y: 92 + Math.floor(index / 9) * 12 },
    curr: { x: 86 + (index % 9) * 10.7, y: 99 + Math.floor(index / 9) * 12.1 },
  }));
  const recoveredPlanarPose = createPlanarPose({
    inlierCount: 9,
    inlierRatio: 0.25,
    confidence: 0.52,
    averageResidual: 8.2,
    referenceSpread: { width: 88, height: 46, minAxis: 46 },
  });

  assert.equal(service._getPoseRejectionReason(recoveredPlanarPose, correspondences), null);
  assert.equal(service._shouldPreferPlanarHomography({
    planarPose: recoveredPlanarPose,
    reconstructionPose: { success: false },
    correspondences,
  }), true);
});

test('rigid planar recovery keeps homography position while using tracker-local transform', () => {
  const service = new ImageAnchorService();
  service.anchorTargetClass = 'card';
  service.planarDominanceScore = 8;
  service.metrics.activeLandmarkCount = 36;
  service.metrics.objectOwnedLandmarks = 36;
  service.metrics.silhouetteCoverage = 0.7;
  service.metrics.contourFitResidual = 1.1;

  const correspondences = Array.from({ length: 22 }, (_, index) => ({
    prev: { x: 80 + (index % 6) * 14, y: 88 + Math.floor(index / 6) * 12 },
    curr: { x: 86 + (index % 6) * 14.4, y: 94 + Math.floor(index / 6) * 12.1 },
  }));
  const recoveredPlanarPose = createPlanarPose({
    inlierCount: 8,
    inlierRatio: 8 / 22,
    confidence: 0.66,
    averageResidual: 1.1,
    referenceSpread: { width: 82, height: 44, minAxis: 44 },
  });
  recoveredPlanarPose.planarTransform.scale = 1.62;
  recoveredPlanarPose.planarTransform.rotation = 0.44;
  const trackerAnchorPosition = {
    scale: 0.94,
    rotation: -0.08,
    confidence: 0.62,
    inlierCount: 18,
    method: 'reference_similarity_transform',
  };

  assert.equal(service._shouldPreferPlanarHomography({
    planarPose: recoveredPlanarPose,
    reconstructionPose: { success: false },
    correspondences,
  }), true);

  const transform = service._selectPlanarAttachmentTransform({
    planarPose: recoveredPlanarPose,
    trackerAnchorPosition,
    correspondences,
  });

  assert.equal(transform.scale, trackerAnchorPosition.scale);
  assert.equal(transform.rotation, trackerAnchorPosition.rotation);
  assert.equal(transform.method, 'reference_similarity_transform');
});

test('textured book targets keep strict planar gates instead of recovery homography', () => {
  const service = new ImageAnchorService();
  service.anchorTargetClass = 'book';
  service.planarDominanceScore = 8;
  service.metrics.activeLandmarkCount = 22;
  service.metrics.objectOwnedLandmarks = 22;
  service.metrics.silhouetteCoverage = 0.7;
  service.metrics.contourFitResidual = 1.1;

  const correspondences = Array.from({ length: 36 }, (_, index) => ({
    prev: { x: 80 + (index % 6) * 14, y: 88 + Math.floor(index / 6) * 12 },
    curr: { x: 86 + (index % 6) * 14.4, y: 94 + Math.floor(index / 6) * 12.1 },
  }));
  const weakBookPose = createPlanarPose({
    inlierCount: 8,
    inlierRatio: 8 / 36,
    confidence: 0.66,
    averageResidual: 1.1,
    referenceSpread: { width: 82, height: 44, minAxis: 44 },
  });

  assert.equal(service._hasRigidPlanarRecoveryPose(weakBookPose, correspondences), false);
  assert.equal(
    service._getPoseRejectionReason(weakBookPose, correspondences),
    'Low pose inlier ratio'
  );
});

test('strong planar attachment owns its own transform', () => {
  const service = new ImageAnchorService();
  service.anchorTargetClass = 'book';
  service.planarDominanceScore = 8;
  const correspondences = Array.from({ length: 28 }, (_, index) => ({
    prev: { x: 72 + (index % 7) * 16, y: 86 + Math.floor(index / 7) * 14 },
    curr: { x: 78 + (index % 7) * 16.8, y: 92 + Math.floor(index / 7) * 14.2 },
  }));
  const planarPose = createPlanarPose({
    inlierCount: 18,
    inlierRatio: 18 / 28,
    confidence: 0.68,
    averageResidual: 1.2,
    referenceSpread: { width: 104, height: 62, minAxis: 62 },
  });
  planarPose.planarTransform.scale = 1.08;
  planarPose.planarTransform.rotation = 0.12;
  const trackerAnchorPosition = {
    scale: 0.94,
    rotation: -0.08,
    confidence: 0.62,
    inlierCount: 18,
    method: 'reference_similarity_transform',
  };

  const transform = service._selectPlanarAttachmentTransform({
    planarPose,
    trackerAnchorPosition,
    correspondences,
  });

  assert.equal(transform.scale, planarPose.planarTransform.scale);
  assert.equal(transform.rotation, planarPose.planarTransform.rotation);
  assert.equal(transform.method, 'planar-homography');
});

test('anchor position filters adapt quickly enough to follow real object motion', () => {
  const service = new ImageAnchorService();

  const first = service.positionFilterX.filter(0, 1000);
  const jumped = service.positionFilterX.filter(100, 1016.67);

  assert.equal(first, 0);
  assert.ok(jumped > 55);
  assert.ok(jumped < 100);
});

test('planar pose-owned positions blend toward raw measurements while fallback stays filtered', () => {
  const planarService = new ImageAnchorService();
  planarService.anchorTargetClass = 'bag';
  planarService.planarDominanceScore = 8;
  planarService.positionFilterX.filter(0, 1000);
  planarService.positionFilterY.filter(0, 1000);

  const planar = planarService._filterPositionCandidate(
    { x: 100, y: 0, z: 0 },
    1016.67,
    'planar-homography'
  );

  const fallbackService = new ImageAnchorService();
  fallbackService.anchorTargetClass = 'bag';
  fallbackService.planarDominanceScore = 8;
  fallbackService.positionFilterX.filter(0, 1000);
  fallbackService.positionFilterY.filter(0, 1000);
  const fallback = fallbackService._filterPositionCandidate(
    { x: 100, y: 0, z: 0 },
    1016.67,
    'reference_similarity_transform'
  );

  assert.ok(planar.x > fallback.x + 14);
  assert.ok(planar.x > 97);
  assert.ok(planar.x < 100);
  assert.equal(planarService.metrics.positionFilterAdjustment, 'planar-pose-blend');
  assert.equal(fallbackService.metrics.positionFilterAdjustment, null);
});

test('book target positions bypass smoothing while retaining step limits', () => {
  const rawService = new ImageAnchorService();
  rawService.anchorTargetClass = 'book';
  rawService.positionFilterX.filter(0, 1000);
  rawService.positionFilterY.filter(0, 1000);

  const raw = rawService._filterPositionCandidate(
    { x: 100, y: 0, z: 0 },
    1016.67,
    'planar-homography'
  );

  assert.equal(raw.x, 100);
  assert.equal(raw.y, 0);
  assert.equal(rawService.metrics.positionFilterAdjustment, 'book-step-position');

  const cappedService = new ImageAnchorService();
  cappedService.setTrackingMode('parametric-surface');
  cappedService.anchorTargetClass = 'book';
  cappedService.currentPosition = { x: 200, y: 160, z: 0 };
  cappedService.templateRegion = { width: 120, height: 120 };
  cappedService.metrics.lastUpdateResult = 'success';
  cappedService.positionFilterX.filter(200, 1000);
  cappedService.positionFilterY.filter(160, 1000);

  const capped = cappedService._filterPositionCandidate(
    { x: 240, y: 160, z: 0 },
    1016.67,
    'planar-homography'
  );

  assert.ok(capped.x <= 210);
  assert.ok(capped.x > 209.8);
  assert.equal(capped.y, 160);
});

test('high-confidence reference transforms bypass smoothing lag while weak transforms stay smoothed', () => {
  const fastService = new ImageAnchorService();
  fastService.currentPosition = { x: 200, y: 160, z: 0 };
  fastService.templateRegion = { width: 120, height: 120 };
  fastService.metrics.lastUpdateResult = 'success';
  fastService.positionFilterX.filter(200, 1000);
  fastService.positionFilterY.filter(160, 1000);

  const fast = fastService._filterPositionCandidate(
    {
      x: 211,
      y: 164,
      z: 0,
      confidence: 0.68,
      averageResidual: 4.5,
    },
    1016.67,
    'reference_similarity_transform'
  );

  assert.equal(fast.x, 211);
  assert.equal(fast.y, 164);
  assert.equal(fastService.metrics.positionFilterAdjustment, 'high-confidence-tracker-step-position');

  const smoothedService = new ImageAnchorService();
  smoothedService.currentPosition = { x: 200, y: 160, z: 0 };
  smoothedService.templateRegion = { width: 120, height: 120 };
  smoothedService.metrics.lastUpdateResult = 'success';
  smoothedService.positionFilterX.filter(200, 1000);
  smoothedService.positionFilterY.filter(160, 1000);

  const smoothed = smoothedService._filterPositionCandidate(
    {
      x: 211,
      y: 164,
      z: 0,
      confidence: 0.18,
      averageResidual: 12,
    },
    1016.67,
    'reference_similarity_transform'
  );

  assert.ok(smoothed.x < 211);
  assert.ok(smoothed.y < 164);
  assert.equal(smoothedService.metrics.positionFilterAdjustment, null);

  const sparseService = new ImageAnchorService();
  sparseService.setTrackingMode('sparse-reconstruction');
  sparseService.currentPosition = { x: 200, y: 160, z: 0 };
  sparseService.templateRegion = { width: 120, height: 120 };
  sparseService.metrics.lastUpdateResult = 'success';
  sparseService.positionFilterX.filter(200, 1000);
  sparseService.positionFilterY.filter(160, 1000);

  const sparse = sparseService._filterPositionCandidate(
    {
      x: 211,
      y: 164,
      z: 0,
      confidence: 0.68,
      averageResidual: 4.5,
    },
    1016.67,
    'reference_similarity_transform'
  );

  assert.ok(sparse.x < 211);
  assert.ok(sparse.y < 164);
  assert.equal(sparseService.metrics.positionFilterAdjustment, null);
});

test('selected curved surface modes use bounded motion hold for weak dropout transforms', () => {
  let now = 1000;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'can';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.74;
  service.metrics.reconstructionMatureLandmarks = 22;
  service.metrics.activeLandmarkCount = 10;
  service.positionFilterX.filter(200, now);
  service.positionFilterY.filter(160, now);

  service._recordCurvedMotionSample({
    success: true,
    method: 'parametric-surface',
    position: { x: 200, y: 160, z: 0 },
    confidence: 0.82,
  });
  now = 1033.33;
  service._recordCurvedMotionSample({
    success: true,
    method: 'parametric-surface',
    position: { x: 194, y: 154, z: 0 },
    confidence: 0.82,
  });

  const held = service._filterPositionCandidate(
    {
      x: 188,
      y: 184,
      z: 0,
      confidence: 0.04,
      averageResidual: 15,
    },
    1066.66,
    'reference_similarity_transform'
  );

  assert.equal(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
  assert.ok(held.x < 194);
  assert.ok(held.y < 154);
  assert.ok(held.y < 170);

  const sparseService = new ImageAnchorService({ now: () => now });
  sparseService.setTrackingMode('sparse-reconstruction');
  sparseService.anchorTargetClass = 'can';
  sparseService.currentPosition = { x: 200, y: 160, z: 0 };
  sparseService.templateRegion = { width: 120, height: 120 };
  sparseService.metrics.lastUpdateResult = 'success';
  sparseService.metrics.reconstructionReady = true;
  sparseService.metrics.reconstructionMapConfidence = 0.74;
  sparseService.metrics.reconstructionMatureLandmarks = 22;
  sparseService.metrics.activeLandmarkCount = 10;
  sparseService.metrics.poseInliers = 10;
  sparseService.metrics.reconstructionPoseInliers = 10;
  sparseService.positionFilterX.filter(200, now);
  sparseService.positionFilterY.filter(160, now);
  sparseService.curvedMotionSample = { ...service.curvedMotionSample };

  sparseService._filterPositionCandidate(
    {
      x: 188,
      y: 184,
      z: 0,
      confidence: 0.04,
      averageResidual: 15,
    },
    1066.66,
    'reference_similarity_transform'
  );

  assert.equal(sparseService.metrics.positionFilterAdjustment, null);
});

test('mature sparse curved maps use bounded motion hold during full pose dropout', () => {
  let now = 1000;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'mug';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.91;
  service.metrics.reconstructionMatureLandmarks = 36;
  service.metrics.activeLandmarkCount = 27;
  service.metrics.objectOwnedLandmarks = 27;
  service.metrics.poseInliers = 0;
  service.metrics.reconstructionPoseInliers = 0;
  service.positionFilterX.filter(200, now);
  service.positionFilterY.filter(160, now);

  service._recordCurvedMotionSample({
    success: true,
    method: 'sparse-reconstruction',
    position: { x: 200, y: 160, z: 0 },
    confidence: 0.86,
  });
  now = 1033.33;
  service._recordCurvedMotionSample({
    success: true,
    method: 'sparse-reconstruction',
    position: { x: 196, y: 154, z: 0 },
    confidence: 0.86,
  });

  const held = service._filterPositionCandidate(
    {
      x: 228,
      y: 190,
      z: 0,
      confidence: 0.82,
      averageResidual: 3.2,
    },
    1066.66,
    'reference_similarity_transform'
  );

  assert.equal(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
  assert.ok(held.x < 196);
  assert.ok(held.y < 154);
});

test('mature sparse curved maps keep weak dropout tracking out of centroid fallback', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'cup';
  service.objectSupportMask = { bbox: { x: 80, y: 80, width: 120, height: 160 } };
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.8;
  service.metrics.reconstructionMatureLandmarks = 22;
  service.metrics.activeLandmarkCount = 12;
  service.metrics.objectOwnedLandmarks = 12;
  service.reconstructor.targetSurfaceModel = 'tapered-cylinder';
  service.keypointTracker.getCentroidAnchorPosition = () => ({
    x: 140,
    y: 130,
    confidence: 0.1,
    inlierCount: 12,
  });

  const trackerAnchorPosition = {
    x: 180,
    y: 150,
    confidence: 0.12,
    averageResidual: 24,
    method: 'reference_similarity_transform',
  };
  const selected = service._selectTrackerAnchorPosition({
    trackerAnchorPosition,
    reconstructionPose: { success: false },
  });

  assert.equal(selected, trackerAnchorPosition);
  assert.equal(service.metrics.trackerAnchorAdjustment, null);
});

test('reconstruction position updates are step-limited to prevent head teleports', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';

  const limited = service._limitPositionStep(
    { x: 240, y: 166, z: 0 },
    'sparse-reconstruction'
  );

  const step = Math.hypot(limited.x - 200, limited.y - 160);
  assert.ok(step <= 9.7);
  assert.ok(step >= 9.1);
  assert.ok(limited.x > 209);
  assert.equal(limited.z, 0);
});

test('rigid planar targets get a larger bounded position step for fast camera motion', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'card';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';

  const limited = service._limitPositionStep(
    { x: 240, y: 160, z: 0 },
    'planar-homography'
  );

  assert.equal(limited.x, 212);
  assert.equal(limited.y, 160);
});

test('book targets keep a tighter planar position step for shelf-like motion', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'book';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';

  const limited = service._limitPositionStep(
    { x: 240, y: 160, z: 0 },
    'planar-homography'
  );

  assert.ok(limited.x <= 210);
  assert.ok(limited.x > 209.8);
  assert.equal(limited.y, 160);
});

test('non-rigid reconstruction targets keep the conservative position step', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'bag';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';

  const limited = service._limitPositionStep(
    { x: 240, y: 160, z: 0 },
    'planar-homography'
  );

  assert.ok(limited.x > 209);
  assert.ok(limited.x < 210);
  assert.equal(limited.y, 160);
});

test('mature curved reconstruction can take a larger bounded recovery step', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'can';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.69;
  service.metrics.reconstructionMatureLandmarks = 18;
  service.metrics.reconstructionTrackerDelta = 14;
  service.metrics.poseInliers = 20;

  const limited = service._limitPositionStep(
    { x: 240, y: 160, z: 0 },
    'parametric-surface'
  );

  assert.ok(limited.x > 211);
  assert.ok(limited.x < 213);
  assert.equal(limited.y, 160);

  service.currentPosition = { x: 200, y: 160, z: 0 };
  const filtered = service._filterPositionCandidate(
    { x: 240, y: 160, z: 0 },
    1000,
    'parametric-surface'
  );

  assert.ok(filtered.x > 211);
  assert.ok(filtered.x < 213);
  assert.equal(service.metrics.positionFilterAdjustment, 'curved-recovery-step-position');
});

test('selected curved modes can catch up from a held pose with strong reference tracking', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'can';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.lastUpdateMethod = 'held-degraded-object-pose';
  service.metrics.reconstructionPreview = {
    surface: { model: 'cylinder' },
  };

  const limited = service._limitPositionStep(
    {
      x: 240,
      y: 160,
      z: 0,
      confidence: 0.76,
      averageResidual: 2.8,
    },
    'reference_similarity_transform'
  );

  assert.ok(limited.x > 217);
  assert.ok(limited.x <= 220);
  assert.equal(limited.y, 160);
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

test('anchor update metrics retain stage timings for benchmark diagnostics', () => {
  const service = new ImageAnchorService();
  service.anchorState = 'tracking';
  service.metrics = {
    poseSource: null,
    reconstructionReady: false,
    poseInliers: 0,
    poseConfidence: 0,
    poseAverageResidual: 0,
    poseForeshortening: 1,
  };

  const timings = {
    framePrepareMs: 1.2,
    keypointTrackMs: 2.4,
    reconstructionUpdateMs: 3.6,
    totalMs: 8.5,
  };
  service._recordAnchorUpdateResult({
    success: true,
    method: 'sparse-reconstruction',
    position: { x: 10, y: 20, z: 0 },
  }, 8.5, timings);

  assert.deepEqual(service.metrics.updateTimings, timings);
});

test('image anchor service keeps update profiling disabled by default', () => {
  const service = new ImageAnchorService();

  assert.equal(service.profileUpdates, false);
});

test('reconstruction metrics preserve the previous preview when hot-path state omits preview', () => {
  const service = new ImageAnchorService();
  const preview = {
    poseModel: 'direct-photometric',
    surface: { model: 'photometric-surfels' },
    statistics: { mapConfidence: 0.74 },
  };
  service.metrics.reconstructionPreview = preview;

  service._recordReconstructionMetrics({
    state: 'ready',
    ready: true,
    frameCount: 8,
    landmarkCount: 28,
    depthQuality: 0.12,
    statistics: {
      averageSupport: 0.8,
      averageReliability: 0.7,
      matureLandmarks: 24,
      mapConfidence: 0.78,
    },
    lastFailureReason: null,
  });

  assert.equal(service.metrics.reconstructionPreview, preview);
  assert.equal(service.metrics.reconstructionMapConfidence, 0.78);
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
      keypoints: Array.from({ length: 18 }, (_, index) => ({ x: 102 + index, y: 112 + index })),
      descriptors: {},
      method: 'fake-orb'
    }),
    assessTemplateQuality: () => ({ overall: 0.17 })
  };
  Object.assign(service.keypointTracker, {
    initializeTracking: () => {}
  });
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
  assert.equal(state.metrics.objectSupportMaskSource, 'tap-local');
  assert.deepEqual(state.metrics.templateRegion, service.templateRegion);
  assert.deepEqual(state.normal, { x: 0, y: 0, z: 1 });
  assert.deepEqual(service.normalStabilizer.getNormal(), { x: 0, y: 0, z: 1 });
});

test('anchor creation passes selected object support mask into keypoint extraction', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }
  const receivedMasks = [];
  const objectSupportMask = createObjectSupportMask({
    width: 320,
    height: 240,
    data: new Uint8Array(320 * 240).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.86,
    referencePoint: { x: 110, y: 120 },
    createdAtFrame: 12,
    updatedAtFrame: 12,
  });

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: (cv, image, region, mask) => {
      receivedMasks.push(mask);
      return {
        keypoints: Array.from({ length: 24 }, (_, index) => ({ pt: { x: 20 + index, y: 30 + index } })),
        descriptors: {},
        method: 'fake-gftt',
        maskSource: mask?.source || null,
      };
    },
    assessTemplateQuality: () => ({ overall: 0.42 })
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    initializeTracking: () => {}
  });
  service.persistenceSystem = {
    storeTemplate: () => {}
  };

  await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 70, y1: 80, x2: 150, y2: 160, objectSupportMask }
  );

  const state = service.getState();
  assert.equal(receivedMasks.length, 2);
  assert.ok(receivedMasks.every(mask => mask === objectSupportMask));
  assert.equal(state.metrics.objectSupportMaskSource, 'interactive-segmenter');
  assert.deepEqual(state.metrics.objectSupportMaskBounds, objectSupportMask.bbox);
  assert.ok(state.metrics.reconstructionRegion.width > state.metrics.templateRegion.width);
  assert.deepEqual(state.metrics.reconstructionRegion, state.metrics.trackingRegion);
  assert.equal(service.expandedObjectSupportRegion, true);
  assert.equal(state.metrics.objectSupportMaskPreview.source, 'interactive-segmenter');
  assert.deepEqual(state.metrics.objectSupportMaskPreview.bbox, objectSupportMask.bbox);
  assert.ok(state.metrics.objectSupportMaskPreview.points.length > 0);
  assert.deepEqual(state.metrics.currentObjectSupportMaskPreview, state.metrics.objectSupportMaskPreview);
});

test('anchor creation filters detector keypoints to the selected object mask', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }
  const data = new Uint8Array(320 * 240);
  for (let y = 84; y <= 144; y++) {
    for (let x = 72; x <= 152; x++) {
      data[y * 320 + x] = 255;
    }
  }
  const objectSupportMask = createObjectSupportMask({
    width: 320,
    height: 240,
    data,
    source: 'interactive-segmenter',
    confidence: 0.88,
    referencePoint: { x: 110, y: 120 },
    createdAtFrame: 12,
    updatedAtFrame: 12,
  });
  let initializedKeypoints = [];

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: [
        ...Array.from({ length: 30 }, (_, index) => ({ pt: { x: 190 + index, y: 42 + (index % 4) }, response: 2 })),
        ...Array.from({ length: 18 }, (_, index) => ({
          pt: {
            x: 82 + (index % 6) * 12,
            y: 96 + Math.floor(index / 6) * 18,
          },
          response: 1,
        })),
      ],
      descriptors: {},
      method: 'fake-gftt',
    }),
    assessTemplateQuality: keypoints => ({ overall: 0.42, keypointCount: keypoints.length })
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    initializeTracking: (cv, keypoints) => {
      initializedKeypoints = keypoints;
    }
  });
  service.persistenceSystem = {
    storeTemplate: () => {}
  };

  const result = await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 60, y1: 76, x2: 170, y2: 156, objectSupportMask }
  );

  assert.equal(result.success, true);
  assert.ok(initializedKeypoints.length >= 12);
  assert.ok(initializedKeypoints.every(keypoint => keypoint.pt.x <= 152));
  assert.equal(result.evidence.objectOwnedLandmarks, initializedKeypoints.length);
  assert.ok(result.evidence.backgroundRejected >= 30);
});

test('anchor creation respects non-convex human masks instead of filling the person box', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }
  const data = new Uint8Array(240 * 260);
  const fillRect = ({ x1, y1, x2, y2 }) => {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        data[y * 240 + x] = 255;
      }
    }
  };
  fillRect({ x1: 106, y1: 28, x2: 134, y2: 58 });   // head
  fillRect({ x1: 98, y1: 62, x2: 142, y2: 156 });    // torso
  fillRect({ x1: 64, y1: 76, x2: 86, y2: 144 });     // left arm
  fillRect({ x1: 154, y1: 76, x2: 176, y2: 144 });   // right arm
  fillRect({ x1: 94, y1: 158, x2: 112, y2: 228 });   // left leg
  fillRect({ x1: 128, y1: 158, x2: 146, y2: 228 });  // right leg
  const objectSupportMask = createObjectSupportMask({
    width: 240,
    height: 260,
    data,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 120, y: 96 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
  let initializedKeypoints = [];

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: [
        ...Array.from({ length: 24 }, (_, index) => ({
          pt: {
            x: 90 + (index % 6) * 12,
            y: 82 + Math.floor(index / 6) * 24,
          },
          response: 1,
        })),
        ...Array.from({ length: 22 }, (_, index) => ({
          pt: {
            x: 88 + (index % 4) * 18,
            y: 166 + Math.floor(index / 4) * 12,
          },
          response: 2,
        })),
      ],
      descriptors: {},
      method: 'fake-gftt',
    }),
    assessTemplateQuality: keypoints => ({ overall: 0.4, keypointCount: keypoints.length })
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    initializeTracking: (cv, keypoints) => {
      initializedKeypoints = keypoints;
    }
  });
  service.persistenceSystem = {
    storeTemplate: () => {}
  };

  const result = await service.createAnchor(
    { width: 240, height: 260 },
    { x: 120, y: 96 },
    { x1: 58, y1: 24, x2: 184, y2: 232, class: 'person', objectSupportMask }
  );

  assert.equal(result.success, true);
  assert.ok(initializedKeypoints.length >= 12);
  assert.equal(initializedKeypoints.some(keypoint => keypoint.pt.x > 88 && keypoint.pt.x < 96 && keypoint.pt.y > 160), false);
  assert.equal(initializedKeypoints.some(keypoint => keypoint.pt.x > 114 && keypoint.pt.x < 124 && keypoint.pt.y > 160), false);
  assert.equal(initializedKeypoints.every(keypoint => isPointInsideObjectSupport(objectSupportMask, keypoint.pt)), true);
  assert.ok(result.evidence.backgroundRejected >= 22);
});

test('weak tap-time object evidence creates a candidate anchor instead of throwing', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }
  let initializedTracking = false;
  const objectSupportMask = createObjectSupportMask({
    width: 320,
    height: 240,
    data: new Uint8Array(320 * 240).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.74,
    referencePoint: { x: 110, y: 120 },
    createdAtFrame: 4,
    updatedAtFrame: 4,
  });

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: Array.from({ length: 5 }, (_, index) => ({ pt: { x: 84 + index * 10, y: 96 + index * 8 }, response: 1 })),
      descriptors: null,
      method: 'fake-gftt',
      count: 5,
    }),
    extractAdaptiveKeypoints: () => ({
      keypoints: Array.from({ length: 5 }, (_, index) => ({ pt: { x: 84 + index * 10, y: 96 + index * 8 }, response: 1 })),
      descriptors: null,
      method: 'fake-gftt-adaptive',
      count: 5,
    }),
    assessTemplateQuality: () => ({ overall: 0.05, keypointCount: 5, spatialDistribution: 0.1 })
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    initializeTracking: () => {
      initializedTracking = true;
    }
  });
  service.persistenceSystem = {
    storeTemplate: () => true
  };

  const result = await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 70, y1: 80, x2: 150, y2: 160, class: 'cup', objectSupportMask }
  );
  const state = service.getState();

  assert.equal(result.success, true);
  assert.equal(result.state, 'candidate');
  assert.equal(result.readiness.faceReady, false);
  assert.match(result.readiness.reason, /more object landmarks/i);
  assert.equal(result.evidence.templateKeypoints, 5);
  assert.equal(result.evidence.objectOwnedLandmarks, 5);
  assert.equal(state.anchored, true);
  assert.equal(state.state, 'candidate');
  assert.equal(state.metrics.templateKeypoints, 5);
  assert.equal(state.metrics.objectOwnedLandmarks, 5);
  assert.equal(state.metrics.maskConfidence, 0.74);
  assert.equal(initializedTracking, true);
});

test('candidate anchor transitions to mapping after object-owned refresh landmarks are collected', () => {
  const service = new ImageAnchorService();
  class FakeMat {
    clone() { return new FakeMat(); }
    delete() {}
  }
  let initializedCount = 0;

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'candidate';
  service.templateRegion = { x: 60, y: 70, width: 90, height: 90 };
  service.trackingRegion = { x: 50, y: 60, width: 120, height: 120 };
  service.templateAnchorOffset = { x: 0, y: 0 };
  service.currentPosition = { x: 110, y: 120, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.currentPlanarTransform = { scale: 1, rotation: 0, confidence: 0.4, inlierCount: 0, method: 'candidate' };
  service.metrics = {
    keypointCount: 5,
    templateKeypoints: 5,
    trackingSuccessRate: 0,
    poseModel: 'sparse-reconstruction',
    reconstructionReady: false,
  };
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: Array.from({ length: 9 }, (_, index) => ({ pt: { x: 82 + index * 5, y: 92 + index * 3 }, response: 1 })),
      descriptors: null,
      method: 'fake-adaptive-gftt',
      count: 9,
    }),
    assessTemplateQuality: () => ({ overall: 0.16, keypointCount: 9, spatialDistribution: 0.4 })
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    initializeTracking: (cv, keypoints) => {
      initializedCount = keypoints.length;
      service.keypointTracker.trackedPoints = keypoints.map((keypoint, index) => ({
        id: index,
        original: { ...keypoint.pt },
        current: { ...keypoint.pt },
        status: 'active',
      }));
    }
  });
  service.persistenceSystem = {
    attemptRecovery: () => ({
      success: true,
      position: { x: 112, y: 121 },
      confidence: 0.78,
      scale: 1,
      method: 'template_matching',
    })
  };

  const result = service.updateAnchor({ width: 320, height: 240 });
  const state = service.getState();

  assert.equal(result.success, true);
  assert.equal(result.state, 'mapping');
  assert.equal(result.readiness.faceReady, false);
  assert.equal(initializedCount, 9);
  assert.equal(state.state, 'mapping');
  assert.equal(state.metrics.activeLandmarks, 9);
  assert.equal(state.metrics.objectOwnedLandmarks, 9);
});

test('tracking region ignores broad debug detection when object support is local', () => {
  const service = new ImageAnchorService();
  const objectSupportMask = {
    width: 420,
    height: 360,
    bbox: { x: 170, y: 80, width: 80, height: 80 },
  };
  const templateRegion = service._calculateTemplateRegion(
    { x: 210, y: 120 },
    { x1: 0, y1: 0, x2: 420, y2: 360, objectSupportMask },
    420,
    360
  );
  const trackingRegion = service._calculateTrackingRegion(
    { x1: 0, y1: 0, x2: 420, y2: 360, objectSupportMask },
    420,
    360,
    templateRegion
  );

  assert.ok(templateRegion.width <= 140);
  assert.ok(templateRegion.height <= 140);
  assert.ok(trackingRegion.width <= 180);
  assert.ok(trackingRegion.height <= 180);
  assert.ok(trackingRegion.width < 420);
  assert.ok(trackingRegion.height < 360);
});

test('overlay readiness fails when object-owned landmark ratio is too low', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.metrics = {
    activeLandmarkCount: 20,
    objectOwnedLandmarks: 8,
  };

  const readiness = service._createReadiness({
    state: 'stable',
    poseSource: 'sparse-reconstruction',
    positionSource: 'sparse-reconstruction',
    reconstructionReady: true,
  });

  assert.equal(readiness.poseReady, true);
  assert.equal(readiness.surfaceReady, true);
  assert.equal(readiness.objectOwnershipReady, false);
  assert.equal(readiness.attachmentReady, false);
  assert.equal(readiness.faceReady, false);
});

test('reconstruction face readiness requires a current usable pose source', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');

  assert.deepEqual(service._createReadiness({
    state: 'stable',
    poseSource: null,
    reconstructionReady: true,
  }), {
    faceReady: false,
    selectionReady: true,
    trackingReady: true,
    poseReady: false,
    poseQualityReady: true,
    surfaceReady: false,
    attachmentSourceReady: true,
    objectOwnershipReady: true,
    attachmentReady: false,
    reason: 'Recovering object pose before showing the face',
  });

  assert.equal(service._createReadiness({
    state: 'stable',
    poseSource: 'parametric-surface',
    reconstructionReady: true,
  }).faceReady, true);

  assert.equal(service._createReadiness({
    state: 'stable',
    poseSource: 'planar-homography',
    reconstructionReady: false,
  }).faceReady, true);
});

test('reconstruction face readiness blocks weak measured attachment poses', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');

  const weakPose = service._createReadiness({
    state: 'stable',
    poseSource: 'parametric-surface',
    reconstructionReady: true,
    poseInliers: 7,
    poseConfidence: 0.6,
    poseAverageResidual: 2.5,
  });
  assert.equal(weakPose.poseReady, false);
  assert.equal(weakPose.surfaceReady, false);
  assert.equal(weakPose.attachmentReady, false);
  assert.equal(weakPose.faceReady, false);
  assert.match(weakPose.reason, /recovering object pose/i);

  const highResidualPose = service._createReadiness({
    state: 'stable',
    poseSource: 'parametric-surface',
    reconstructionReady: true,
    poseInliers: 18,
    poseConfidence: 0.56,
    poseAverageResidual: 9,
  });
  assert.equal(highResidualPose.poseQualityReady, false);
  assert.equal(highResidualPose.faceReady, false);

  const borderlineResidualPose = service._createReadiness({
    state: 'stable',
    poseSource: 'parametric-surface',
    reconstructionReady: true,
    poseInliers: 24,
    poseConfidence: 0.76,
    poseAverageResidual: 6.4,
  });
  assert.equal(borderlineResidualPose.poseQualityReady, false);
  assert.equal(borderlineResidualPose.faceReady, false);

  const strongPose = service._createReadiness({
    state: 'stable',
    poseSource: 'parametric-surface',
    reconstructionReady: true,
    poseInliers: 18,
    poseConfidence: 0.56,
    poseAverageResidual: 4.5,
  });
  assert.equal(strongPose.poseReady, true);
  assert.equal(strongPose.surfaceReady, true);
  assert.equal(strongPose.attachmentReady, true);
  assert.equal(strongPose.faceReady, true);

  const edgeOnReconstructionPose = service._createReadiness({
    state: 'stable',
    poseSource: 'parametric-surface',
    positionSource: 'parametric-surface',
    reconstructionReady: true,
    poseInliers: 36,
    poseConfidence: 0.92,
    poseAverageResidual: 3.5,
    poseForeshortening: 0.14,
  });
  assert.equal(edgeOnReconstructionPose.poseQualityReady, false);
  assert.equal(edgeOnReconstructionPose.faceReady, false);

  const weakPlanarPose = service._createReadiness({
    state: 'stable',
    poseSource: 'planar-homography',
    positionSource: 'planar-homography',
    reconstructionReady: true,
    poseInliers: 14,
    poseConfidence: 0.92,
    poseAverageResidual: 0.8,
  });
  assert.equal(weakPlanarPose.poseQualityReady, false);
  assert.equal(weakPlanarPose.faceReady, false);

  const underSupportedPlanarPose = service._createReadiness({
    state: 'stable',
    poseSource: 'planar-homography',
    positionSource: 'planar-homography',
    reconstructionReady: true,
    poseInliers: 18,
    poseConfidence: 0.72,
    poseAverageResidual: 1.2,
  });
  assert.equal(underSupportedPlanarPose.poseQualityReady, false);
  assert.equal(underSupportedPlanarPose.faceReady, false);

  const strongPlanarPose = service._createReadiness({
    state: 'stable',
    poseSource: 'planar-homography',
    positionSource: 'planar-homography',
    reconstructionReady: true,
    poseInliers: 22,
    poseConfidence: 0.72,
    poseAverageResidual: 1.2,
  });
  assert.equal(strongPlanarPose.poseQualityReady, true);
  assert.equal(strongPlanarPose.faceReady, true);
});

test('reconstruction face readiness requires an object-local attachment source', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');

  const screenSpaceAttachment = service._createReadiness({
    state: 'stable',
    poseSource: 'parametric-surface',
    positionSource: 'reference_similarity_transform',
    reconstructionReady: true,
    poseInliers: 18,
    poseConfidence: 0.56,
    poseAverageResidual: 4.5,
  });

  assert.equal(screenSpaceAttachment.poseReady, true);
  assert.equal(screenSpaceAttachment.surfaceReady, true);
  assert.equal(screenSpaceAttachment.attachmentSourceReady, false);
  assert.equal(screenSpaceAttachment.attachmentReady, false);
  assert.equal(screenSpaceAttachment.faceReady, false);

  const objectLocalAttachment = service._createReadiness({
    state: 'stable',
    poseSource: 'parametric-surface',
    positionSource: 'parametric-surface',
    reconstructionReady: true,
    poseInliers: 18,
    poseConfidence: 0.56,
    poseAverageResidual: 4.5,
  });

  assert.equal(objectLocalAttachment.attachmentSourceReady, true);
  assert.equal(objectLocalAttachment.faceReady, true);
});

test('candidate bootstrap tracks existing landmarks instead of resetting their history', () => {
  const service = new ImageAnchorService();
  class FakeMat {
    clone() { return new FakeMat(); }
    delete() {}
  }
  let initializeCalls = 0;
  let trackCalls = 0;

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'candidate';
  service.templateRegion = { x: 60, y: 70, width: 90, height: 90 };
  service.trackingRegion = { x: 50, y: 60, width: 120, height: 120 };
  service.templateAnchorOffset = { x: 0, y: 0 };
  service.currentPosition = { x: 110, y: 120, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.currentPlanarTransform = { scale: 1, rotation: 0, confidence: 0.4, inlierCount: 0, method: 'candidate' };
  service.metrics = {
    keypointCount: 8,
    templateKeypoints: 8,
    trackingSuccessRate: 0,
    poseModel: 'sparse-reconstruction',
    reconstructionReady: false,
  };
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: Array.from({ length: 8 }, (_, index) => ({ pt: { x: 82 + index * 5, y: 92 + index * 3 }, response: 1 })),
      descriptors: null,
      method: 'fake-adaptive-gftt',
      count: 8,
    }),
    assessTemplateQuality: () => ({ overall: 0.16, keypointCount: 8, spatialDistribution: 0.4 })
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 8 }, (_, index) => ({
      id: index,
      original: { x: 80 + index * 5, y: 90 + index * 3 },
      current: { x: 80 + index * 5, y: 90 + index * 3 },
      status: 'active',
      age: 4,
      totalSuccessfulFrames: 4,
      observations: 4,
    })),
    initializeTracking: () => {
      initializeCalls++;
    },
    trackToFrame: () => {
      trackCalls++;
      for (const point of service.keypointTracker.trackedPoints) {
        point.age++;
        point.totalSuccessfulFrames++;
      }
      return {
        success: true,
        activePointCount: 8,
        successRate: 1,
        averageError: 1,
      };
    },
    getAnchorPosition: () => ({
      x: 112,
      y: 121,
      scale: 1,
      rotation: 0,
      confidence: 0.78,
      inlierCount: 8,
      method: 'reference_similarity_transform',
    }),
    refreshKeypoints: () => false,
  });
  service.persistenceSystem = {
    attemptRecovery: () => ({
      success: true,
      position: { x: 112, y: 121 },
      confidence: 0.78,
      scale: 1,
      method: 'template_matching',
    })
  };

  const result = service.updateAnchor({ width: 320, height: 240 });

  assert.equal(result.success, true);
  assert.equal(result.state, 'mapping');
  assert.equal(trackCalls, 1);
  assert.equal(initializeCalls, 0);
  assert.ok(service.keypointTracker.trackedPoints.every(point => point.age === 5));
});

test('candidate bootstrap reinitializes when too few landmarks exist for coherent refresh', () => {
  const service = new ImageAnchorService();
  class FakeMat {
    clone() { return new FakeMat(); }
    delete() {}
  }
  let initializedCount = 0;

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'candidate';
  service.templateRegion = { x: 60, y: 70, width: 90, height: 90 };
  service.trackingRegion = { x: 50, y: 60, width: 120, height: 120 };
  service.templateAnchorOffset = { x: 0, y: 0 };
  service.currentPosition = { x: 110, y: 120, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.currentPlanarTransform = { scale: 1, rotation: 0, confidence: 0.4, inlierCount: 0, method: 'candidate' };
  service.metrics = {
    keypointCount: 2,
    templateKeypoints: 2,
    trackingSuccessRate: 0,
    poseModel: 'sparse-reconstruction',
    reconstructionReady: false,
  };
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service.keypointDetector = {
    extractKeypoints: () => ({
      keypoints: Array.from({ length: 8 }, (_, index) => ({ pt: { x: 82 + index * 5, y: 92 + index * 3 }, response: 1 })),
      descriptors: null,
      method: 'fake-adaptive-gftt',
      count: 8,
    }),
    assessTemplateQuality: () => ({ overall: 0.16, keypointCount: 8, spatialDistribution: 0.4 })
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 2 }, (_, index) => ({
      id: index,
      original: { x: 80 + index * 5, y: 90 + index * 3 },
      current: { x: 80 + index * 5, y: 90 + index * 3 },
      status: 'active',
      age: 1,
      totalSuccessfulFrames: 1,
    })),
    initializeTracking: (cv, keypoints) => {
      initializedCount = keypoints.length;
      service.keypointTracker.trackedPoints = keypoints.map((keypoint, index) => ({
        id: index,
        original: { ...keypoint.pt },
        current: { ...keypoint.pt },
        status: 'active',
      }));
    },
    trackToFrame: () => ({
      success: false,
      activePointCount: 2,
      successRate: 0,
      averageError: 999,
    }),
    refreshKeypoints: () => false,
  });
  service.persistenceSystem = {
    attemptRecovery: () => ({
      success: false,
    })
  };

  const result = service.updateAnchor({ width: 320, height: 240 });

  assert.equal(result.success, true);
  assert.equal(result.state, 'mapping');
  assert.equal(initializedCount, 8);
  assert.equal(service.keypointTracker.trackedPoints.length, 8);
});

test('landmark metrics report zero object ownership after all active points leave the mask', () => {
  const service = new ImageAnchorService();
  const data = new Uint8Array(100 * 80);
  for (let y = 20; y <= 30; y++) {
    for (let x = 20; x <= 30; x++) {
      data[y * 100 + x] = 255;
    }
  }

  service.objectSupportMask = createObjectSupportMask({
    width: 100,
    height: 80,
    data,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 25, y: 25 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
  service.currentObjectSupportMask = service.objectSupportMask;
  service.metrics = {
    keypointCount: 8,
    landmarkCount: 8,
    activeLandmarkCount: 8,
    objectOwnedLandmarks: 8,
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 8 }, (_, index) => ({
      id: index,
      current: { x: 60 + index, y: 60 },
      status: 'active',
    })),
  });

  service._recordLandmarkMetrics();

  assert.equal(service.metrics.landmarkCount, 8);
  assert.equal(service.metrics.activeLandmarkCount, 8);
  assert.equal(service.metrics.objectOwnedLandmarks, 0);
});

test('landmark metrics expose tracker quality buckets', () => {
  const service = new ImageAnchorService();
  service.metrics = {};
  Object.assign(service.keypointTracker, {
    trackedPoints: [
      { id: 1, current: { x: 10, y: 12 }, status: 'active' },
      { id: 2, current: { x: 24, y: 18 }, status: 'active' },
      { id: 3, current: { x: 36, y: 26 }, status: 'lost' },
    ],
    getLandmarkQualityStats: () => ({
      average: 0.64,
      highQuality: 1,
      poseEligible: 2,
    }),
  });

  service._recordLandmarkMetrics();

  assert.equal(service.metrics.averageLandmarkQuality, 0.64);
  assert.equal(service.metrics.highQualityLandmarks, 1);
  assert.equal(service.metrics.poseEligibleLandmarks, 2);
});

test('mask rejection immediately removes background landmarks from pose ownership', () => {
  const service = new ImageAnchorService();
  const data = new Uint8Array(120 * 90);
  for (let y = 30; y <= 58; y++) {
    for (let x = 30; x <= 68; x++) {
      data[y * 120 + x] = 255;
    }
  }

  service.objectSupportMask = createObjectSupportMask({
    width: 120,
    height: 90,
    data,
    source: 'interactive-segmenter',
    confidence: 0.91,
    referencePoint: { x: 49, y: 44 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
  service.currentPosition = { x: 49, y: 44, z: 0 };
  service.currentPlanarTransform = { scale: 1, rotation: 0 };
  service.metrics = {};
  Object.assign(service.keypointTracker, {
    trackedPoints: [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: index,
        original: { x: 36 + index * 3, y: 42 },
        current: { x: 36 + index * 3, y: 42 },
        status: 'active',
        objectOwned: true,
        age: 8,
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: 100 + index,
        original: { x: 82 + index * 4, y: 64 },
        current: { x: 82 + index * 4, y: 64 },
        status: 'active',
        objectOwned: true,
        age: 8,
      })),
    ],
    getCorrespondences(options = {}) {
      return this.trackedPoints
        .filter(point => point.status === 'active' && point.objectOwned !== false)
        .slice(0, options.maxCount || Infinity)
        .map(point => ({
          prev: point.original,
          curr: point.current,
        }));
    },
  });

  const rejected = service._rejectTrackedPointsOutsideObjectSupport();
  const correspondences = service.keypointTracker.getCorrespondences({ maxCount: 30 });

  assert.equal(rejected, 6);
  assert.equal(service.keypointTracker.trackedPoints.filter(point => point.objectOwned === false).length, 6);
  assert.equal(service.keypointTracker.trackedPoints.filter(point => point.status === 'outlier').length, 6);
  assert.equal(correspondences.length, 10);
  assert.ok(correspondences.every(correspondence => correspondence.curr.x <= 68));
});

test('weak tap-local evidence records candidate diagnostics instead of failing creation', async () => {
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
    extractAdaptiveKeypoints: () => ({
      keypoints: Array.from({ length: 20 }, (_, index) => ({ x: 50 + index, y: 60 + index })),
      descriptors: {},
      method: 'fake-orb-adaptive'
    }),
    assessTemplateQuality: () => ({ overall: 0.08 })
  };
  service.persistenceSystem = {
    storeTemplate: () => true
  };

  const result = await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 70, y1: 80, x2: 150, y2: 160 }
  );

  const state = service.getState();
  assert.equal(result.state, 'candidate');
  assert.equal(state.state, 'candidate');
  assert.equal(state.metrics.templateQuality, 0.08);
  assert.equal(state.metrics.qualityState, 'weak');
  assert.equal(state.metrics.objectSupportMaskSource, 'tap-local');
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

test('max keypoint failures hold degraded pose when template recovery misses', () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.maxKeypointFailures = 3;
  service.keypointFailureCount = 2;
  service.currentPosition = { x: 140, y: 118, z: 0 };
  service.currentNormal = { x: 0.2, y: -0.1, z: 0.97 };
  service.currentPlanarTransform = {
    scale: 0.92,
    rotation: -0.14,
    confidence: 0.62,
    method: 'parametric-surface',
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 6 }, () => ({ status: 'active' })),
  });
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {}
  };
  service._updateWithKeypoints = () => ({
    success: false,
    reason: 'Insufficient keypoint tracking quality',
    state: 'tracking',
  });
  service.persistenceSystem = {
    attemptRecovery: () => ({ success: false, reason: 'Template match below threshold' }),
  };

  const result = service.updateAnchor({ width: 320, height: 240 });

  assert.equal(result.success, true);
  assert.equal(result.method, 'held-degraded-object-pose');
  assert.equal(result.recoverable, true);
  assert.deepEqual(result.position, service.currentPosition);
  assert.deepEqual(result.normal, service.currentNormal);
  assert.equal(result.planarTransform.scale, 0.92);
  assert.equal(service.anchorState, 'degraded');
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
  let relocalizationCalls = 0;
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: () => {
      relocalizationCalls++;
      return {
        success: true,
        method: 'patch-keyframe-relocalization',
        transform,
        confidence: 0.86,
        averageResidual: 1.1,
        matchCount: 22,
        inlierCount: 16,
        inlierIds: trackedPoints.map(point => point.id),
        keyframeCount: 3,
      };
    },
  };
  Object.assign(service.keypointTracker, {
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
  });
  service.homographyEstimator = {
    estimatePose: () => createObjectPose({
      x: 144,
      y: 122,
      scale: 1.18,
      rotation: 0.2,
      method: 'homography',
    }),
  };
  service._shouldAttemptGeometryRelocalization = () => true;

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.method, 'object-pose-affine');
  assert.equal(relocalizationCalls, 1);
  assert.equal(service.metrics.relocalizationResult, 'success');
  assert.equal(service.metrics.relocalizationMatches, 22);
  assert.equal(service.metrics.relocalizationInliers, 16);
  assert.equal(service.metrics.activeLandmarkCount, 16);
});

test('descriptor relocalization extracts query keypoints inside the object support region', () => {
  const service = new ImageAnchorService();
  const width = 320;
  const height = 240;
  const maskData = new Uint8Array(width * height);
  for (let y = 70; y < 135; y++) {
    for (let x = 90; x < 165; x++) {
      maskData[y * width + x] = 255;
    }
  }
  const objectSupportMask = createObjectSupportMask({
    width,
    height,
    data: maskData,
    source: 'synthetic-object-mask',
    confidence: 0.9,
    referencePoint: { x: 125, y: 100 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
  let extractionRegion = null;

  service.cv = {};
  service.objectSupportMask = objectSupportMask;
  service.currentPosition = { x: 125, y: 100, z: 0 };
  service.currentPlanarTransform = null;
  service.keypointDetector = {
    extractKeypoints: (cv, grayImage, region) => {
      extractionRegion = region;
      return { keypoints: [] };
    },
  };
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: () => ({ success: false, reason: 'Insufficient descriptor matches: 0' }),
  };

  service._attemptKeyframeRelocalization({ cols: width, rows: height }, 1000, 'tracking failed');

  assert.ok(extractionRegion.width < width);
  assert.ok(extractionRegion.height < height);
  assert.ok(extractionRegion.x <= objectSupportMask.bbox.x);
  assert.ok(extractionRegion.y <= objectSupportMask.bbox.y);
  assert.ok(extractionRegion.x + extractionRegion.width >= objectSupportMask.bbox.x + objectSupportMask.bbox.width);
  assert.ok(extractionRegion.y + extractionRegion.height >= objectSupportMask.bbox.y + objectSupportMask.bbox.height);
  assert.deepEqual(service.metrics.relocalizationQueryRegion, extractionRegion);
});

test('keypoint updates propagate pose normals from homography correspondences', () => {
  const service = new ImageAnchorService();
  const poseNormal = { x: 0.32, y: -0.21, z: 0.92 };

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {};
  Object.assign(service.keypointTracker, {
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
  });
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

test('keypoint updates pass OpenCV context into attachment positioning', () => {
  const service = new ImageAnchorService();
  const cv = { findHomography: () => null };
  const anchorPositionContexts = [];

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = cv;
  Object.assign(service.keypointTracker, {
    trackToFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 18,
      averageError: 1.2,
    }),
    getCorrespondences: () => Array.from({ length: 12 }, (_, index) => ({
      prev: {
        x: 30 + (index % 4) * 18,
        y: 40 + Math.floor(index / 4) * 16,
      },
      curr: {
        x: 36 + (index % 4) * 18,
        y: 43 + Math.floor(index / 4) * 16,
      },
    })),
    getObjectPose: () => createObjectPose({
      x: 142,
      y: 158,
      scale: 1.04,
      rotation: 0.08,
      inlierCount: 18,
    }),
    getAnchorPosition: receivedCv => {
      anchorPositionContexts.push(receivedCv || null);
      return {
        x: 142,
        y: 158,
        method: receivedCv ? 'reference_homography' : 'reference_similarity_transform',
        confidence: 0.82,
        inlierCount: 18,
        averageResidual: 1.1,
        scale: 1.04,
        rotation: 0.08,
      };
    },
  });
  service.homographyEstimator = {
    estimatePose: () => createObjectPose({
      x: 142,
      y: 158,
      scale: 1.04,
      rotation: 0.08,
      inlierCount: 18,
      method: 'homography',
    }),
  };

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.ok(anchorPositionContexts.includes(cv));
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
  Object.assign(service.keypointTracker, {
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
  });
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
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 6 }, () => ({ status: 'active' }))
  });
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

test('degraded recovery holds the last object pose while landmarks remain', () => {
  const service = new ImageAnchorService();
  service.anchorState = 'degraded';
  service.currentPosition = { x: 120, y: 140, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.currentPlanarTransform = { scale: 1, rotation: 0, confidence: 0.4 };
  service.metrics = { trackingSuccessRate: 0.34 };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 5 }, () => ({ status: 'active' })),
  });

  const result = service._createDegradedHoldResult('Template match below threshold');

  assert.equal(result.success, true);
  assert.equal(result.method, 'held-degraded-object-pose');
  assert.deepEqual(result.position, service.currentPosition);
  assert.equal(result.recoverable, true);
});

test('weak reference transforms fall back to object-owned centroid during segmented recovery', () => {
  const service = new ImageAnchorService();
  const maskData = new Uint8Array(80 * 80);
  for (let y = 18; y <= 54; y++) {
    for (let x = 22; x <= 58; x++) {
      maskData[y * 80 + x] = 255;
    }
  }

  service.objectSupportMask = createObjectSupportMask({
    width: 80,
    height: 80,
    data: maskData,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 40, y: 36 },
    createdAtFrame: 0,
  });
  service.metrics = {
    keypointCount: 10,
    activeLandmarkCount: 10,
    objectOwnedLandmarks: 7,
  };
  let centroidInput = null;
  Object.assign(service.keypointTracker, {
    trackedPoints: [
      { status: 'active', objectOwned: true, current: { x: 30, y: 30 } },
      { status: 'active', objectOwned: true, current: { x: 38, y: 34 } },
      { status: 'active', objectOwned: true, current: { x: 36, y: 36 } },
      { status: 'active', objectOwned: false, current: { x: 90, y: 12 } },
      { status: 'outlier', objectOwned: true, current: { x: 34, y: 36 } },
    ],
    getCentroidAnchorPosition: points => {
      centroidInput = points;
      return {
        x: 34,
        y: 32,
        confidence: 0.3,
        inlierCount: points.length,
        method: 'weighted_centroid_with_offset',
      };
    },
  });

  const selected = service._selectTrackerAnchorPosition({
    trackerAnchorPosition: {
      x: 80,
      y: 15,
      method: 'reference_similarity_transform',
      confidence: 0,
      averageResidual: 34,
      inlierCount: 10,
      scale: 1,
      rotation: 0,
    },
    reconstructionPose: { success: false },
  });

  assert.equal(selected.method, 'object-owned-centroid-position');
  assert.equal(selected.x, 34);
  assert.equal(selected.y, 32);
  assert.equal(selected.transformMethod, 'reference_similarity_transform');
  assert.equal(service.metrics.trackerAnchorAdjustment, 'object-owned-centroid-position');
  assert.equal(centroidInput.length, 3);
  assert.equal(centroidInput.every(point => point.objectOwned === true), true);
});

test('reasonable reference transforms keep owning sparse segmented recovery', () => {
  const service = new ImageAnchorService();
  service.objectSupportMask = createObjectSupportMask({
    width: 20,
    height: 20,
    data: new Uint8Array(20 * 20).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 10, y: 10 },
    createdAtFrame: 0,
  });
  service.metrics = {
    keypointCount: 11,
    activeLandmarkCount: 11,
    objectOwnedLandmarks: 9,
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    getCentroidAnchorPosition: () => ({ x: 12, y: 14 }),
  });
  const trackerAnchorPosition = {
    x: 18,
    y: 21,
    method: 'reference_similarity_transform',
    confidence: 0.31,
    averageResidual: 10,
    inlierCount: 11,
  };

  assert.equal(service._selectTrackerAnchorPosition({
    trackerAnchorPosition,
    reconstructionPose: { success: false },
  }), trackerAnchorPosition);
});

test('weak sparse segmented recovery keeps transform when every active landmark is still object-owned', () => {
  const service = new ImageAnchorService();
  service.objectSupportMask = createObjectSupportMask({
    width: 20,
    height: 20,
    data: new Uint8Array(20 * 20).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 10, y: 10 },
    createdAtFrame: 0,
  });
  service.metrics = {
    keypointCount: 10,
    activeLandmarkCount: 10,
    objectOwnedLandmarks: 10,
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    getCentroidAnchorPosition: () => {
      throw new Error('centroid fallback should not run when ownership is clean');
    },
  });
  const trackerAnchorPosition = {
    x: 18,
    y: 21,
    method: 'reference_similarity_transform',
    confidence: 0.08,
    averageResidual: 34,
    inlierCount: 10,
  };

  assert.equal(service._selectTrackerAnchorPosition({
    trackerAnchorPosition,
    reconstructionPose: { success: false },
  }), trackerAnchorPosition);
});

test('refreshed object support recenters a drifted anchor at the original mask-relative point', () => {
  const service = new ImageAnchorService({ now: () => 1040 });
  const initialData = new Uint8Array(120 * 90);
  for (let y = 20; y < 70; y++) {
    for (let x = 30; x < 90; x++) {
      initialData[y * 120 + x] = 255;
    }
  }

  const initialMask = createObjectSupportMask({
    width: 120,
    height: 90,
    data: initialData,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 60, y: 45 },
    createdAtFrame: 0,
  });

  service.objectSupportMask = initialMask;
  service.currentObjectSupportMask = initialMask;
  service.currentPosition = { x: 92, y: 30, z: 0 };
  service.currentPlanarTransform = { scale: 1, rotation: 0, confidence: 1, inlierCount: 20, method: 'created' };
  service.templateRegion = { x: 30, y: 20, width: 60, height: 50 };
  service.trackingRegion = { x: 24, y: 14, width: 72, height: 62 };
  service.anchorTargetClass = 'mug';
  service.objectSupportAnchorUv = { u: 0.5, v: 0.5 };
  service.metrics.lastUpdateResult = 'success';
  service.positionFilterX.filter(92, 1000);
  service.positionFilterY.filter(30, 1000);

  const refreshedData = new Uint8Array(120 * 90);
  for (let y = 28; y < 78; y++) {
    for (let x = 14; x < 74; x++) {
      refreshedData[y * 120 + x] = 255;
    }
  }
  const refreshedMask = createObjectSupportMask({
    width: 120,
    height: 90,
    data: refreshedData,
    source: 'interactive-segmenter',
    confidence: 0.92,
    referencePoint: { x: 42, y: 53 },
    createdAtFrame: 4,
  });

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: 'pose-dropout-recovery' });

  assert.equal(applied, true);
  assert.ok(service.currentPosition.x < 83);
  assert.ok(service.currentPosition.x > 80);
  assert.ok(service.currentPosition.y > 34);
  assert.ok(service.currentPosition.y < 36);
  assert.ok(service.metrics.objectSupportPositionStep <= 12);
  assert.equal(service.metrics.objectSupportPositionCorrection, 'pose-dropout-recovery');
  assert.equal(service.metrics.objectSupportPositionSource, 'interactive-segmenter');
});

test('rigid planar support refresh does not recenter homography-owned anchors', () => {
  const service = new ImageAnchorService({ now: () => 1040 });
  const data = new Uint8Array(120 * 90);
  for (let y = 28; y < 78; y++) {
    for (let x = 14; x < 74; x++) {
      data[y * 120 + x] = 255;
    }
  }
  const refreshedMask = createObjectSupportMask({
    width: 120,
    height: 90,
    data,
    source: 'interactive-segmenter',
    confidence: 0.92,
    referencePoint: { x: 44, y: 53 },
    createdAtFrame: 4,
  });

  service.currentPosition = { x: 92, y: 30, z: 0 };
  service.currentPlanarTransform = { scale: 1, rotation: 0, confidence: 1, inlierCount: 20, method: 'created' };
  service.templateRegion = { x: 30, y: 20, width: 60, height: 50 };
  service.trackingRegion = { x: 24, y: 14, width: 72, height: 62 };
  service.anchorTargetClass = 'card';
  service.objectSupportAnchorUv = { u: 0.5, v: 0.5 };

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: 'pose-dropout-recovery' });

  assert.equal(applied, true);
  assert.deepEqual(service.currentPosition, { x: 92, y: 30, z: 0 });
  assert.equal(service.metrics.objectSupportPositionCorrection, null);
  assert.equal(service.metrics.objectSupportPositionSource, null);
  assert.equal(service.metrics.objectSupportMaskSource, 'interactive-segmenter');
});

test('handled mug support correction caps follow reconstruction mode ownership', () => {
  const service = new ImageAnchorService();
  const objectSupportMask = {
    bbox: { x: 12, y: 16, width: 80, height: 72 },
  };

  service.anchorTargetClass = 'mug';

  service.setTrackingMode('sparse-reconstruction');
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 10);
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'), 12);

  service.setTrackingMode('depth-fusion');
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 4);
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'), 4);

  service.setTrackingMode('parametric-surface');
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 0);
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'), 12);

  service.setTrackingMode('direct-photometric');
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 12);

  service.anchorTargetClass = 'cup';
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 12);
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'), 14);

  service.anchorTargetClass = 'bottle';
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 12);
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'), 14);

  service.anchorTargetClass = 'can';
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 10);

  service.anchorTargetClass = 'bag';
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 16);
});

test('mature reconstruction dropout uses object-owned centroid instead of raw similarity drift', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'book';
  service.currentPosition = { x: 96, y: 84, z: 0 };
  service.objectSupportMask = { source: 'interactive-segmenter' };
  service.metrics = {
    reconstructionReady: true,
    reconstructionMapConfidence: 0.68,
    reconstructionMatureLandmarks: 28,
    activeLandmarkCount: 16,
    objectOwnedLandmarks: 15,
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [
      { status: 'active', objectOwned: true, current: { x: 94, y: 82 } },
      { status: 'active', objectOwned: true, current: { x: 102, y: 86 } },
      { status: 'active', objectOwned: false, current: { x: 130, y: 106 } },
    ],
    getCentroidAnchorPosition: points => ({
      x: 98,
      y: 84,
      confidence: 0.22,
      inlierCount: points.length,
    }),
  });

  const selected = service._selectTrackerAnchorPosition({
    reconstructionPose: {
      success: false,
      reason: 'Low affine inlier ratio',
    },
    trackerAnchorPosition: {
      x: 122,
      y: 98,
      scale: 1.03,
      rotation: 0.1,
      confidence: 0.3,
      inlierCount: 16,
      averageResidual: 24,
      method: 'reference_similarity_transform',
    },
  });

  assert.equal(selected.method, 'object-owned-centroid-position');
  assert.equal(selected.transformMethod, 'reference_similarity_transform');
  assert.equal(selected.x, 98);
  assert.equal(selected.y, 84);
  assert.equal(selected.inlierCount, 2);
  assert.equal(service.metrics.trackerAnchorAdjustment, 'mature-reconstruction-dropout-centroid');
});

const createRefreshDecisionService = metrics => {
  const service = new ImageAnchorService();
  service.anchorState = 'tracking';
  service.framesSinceRefresh = 0;
  service.objectSupportMask = createObjectSupportMask({
    width: 80,
    height: 80,
    data: new Uint8Array(80 * 80).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 40, y: 40 },
    createdAtFrame: 0,
  });
  service.metrics = {
    trackingSuccessRate: 0.72,
    keypointCount: 9,
    activeLandmarkCount: 9,
    ...metrics,
  };
  return service;
};

test('low object-owned landmark support triggers adaptive refresh after pose dropout', () => {
  const service = createRefreshDecisionService({
    objectOwnedLandmarks: 8,
  });

  assert.equal(service._shouldRefreshKeypoints({
    overallQuality: 0.36,
    poseInliers: 0,
  }), true);
  assert.equal(service.metrics.landmarkRefreshReason, 'object-support-recovery');
});

test('fully object-owned sparse support does not bypass refresh cadence', () => {
  const service = createRefreshDecisionService({
    objectOwnedLandmarks: 9,
  });

  assert.equal(service._shouldRefreshKeypoints({
    overallQuality: 0.36,
    poseInliers: 0,
  }), false);
  assert.equal(service.metrics.landmarkRefreshReason, null);
});

test('recent support growth refreshes landmarks before pose geometry is ready', () => {
  const service = createRefreshDecisionService({
    keypointCount: 20,
    activeLandmarkCount: 20,
    objectOwnedLandmarks: 20,
    segmentationRefreshReason: 'tap-local-support-growth',
    segmentationRefreshFrame: 12,
  });
  service.frameIndex = 12;

  assert.equal(service._shouldRefreshKeypoints({
    overallQuality: 0.42,
    poseInliers: 0,
  }), true);
  assert.equal(service.metrics.landmarkRefreshReason, 'support-growth');
});

test('mature reconstruction map blocks sparse support recovery refresh', () => {
  const service = createRefreshDecisionService({
    objectOwnedLandmarks: 8,
    reconstructionReady: true,
    reconstructionMapConfidence: 0.72,
    reconstructionMatureLandmarks: 24,
  });

  assert.equal(service._shouldRefreshKeypoints({
    overallQuality: 0.36,
    poseInliers: 0,
  }), false);
  assert.equal(service.metrics.landmarkRefreshReason, null);
});

test('masked recovery refresh forwards adaptive extraction options', () => {
  const service = new ImageAnchorService();
  const maskData = new Uint8Array(120 * 100).fill(255);
  const objectSupportMask = createObjectSupportMask({
    width: 120,
    height: 100,
    data: maskData,
    source: 'interactive-segmenter',
    confidence: 0.88,
    referencePoint: { x: 60, y: 50 },
    createdAtFrame: 0,
  });
  let refreshOptions = null;
  let receivedMask = null;

  service.cv = {};
  service.keypointDetector = {};
  service.currentPosition = { x: 60, y: 50, z: 0 };
  service.templateRegion = { width: 80, height: 70 };
  service.objectSupportMask = objectSupportMask;
  service.currentObjectSupportMask = objectSupportMask;
  service.metrics = {
    trackingSuccessRate: 0.42,
    poseInliers: 0,
  };
  Object.assign(service.keypointTracker, {
    lastRefreshStats: null,
    refreshKeypoints: (cv, grayImage, detector, region, mask, options) => {
      receivedMask = mask;
      refreshOptions = options;
      service.keypointTracker.lastRefreshStats = {
        added: 5,
        total: 17,
        rejectedByMask: 11,
      };
      return true;
    },
  });
  service._storeRelocalizationKeyframe = () => {};

  service._refreshKeypoints({ cols: 120, rows: 100 }, {
    adaptive: true,
    minNewKeypoints: 8,
  });

  assert.equal(receivedMask, objectSupportMask);
  assert.deepEqual(refreshOptions, {
    adaptive: true,
    minNewKeypoints: 8,
  });
  assert.equal(service.metrics.landmarkRefreshAdded, 5);
  assert.equal(service.metrics.landmarkRefreshRejectedByMask, 11);
});

test('segmentation refresh expands tracking region used by landmark refresh', () => {
  const service = new ImageAnchorService();
  const maskData = new Uint8Array(200 * 160);
  for (let y = 46; y <= 132; y++) {
    for (let x = 38; x <= 164; x++) {
      maskData[y * 200 + x] = 255;
    }
  }
  const objectSupportMask = createObjectSupportMask({
    width: 200,
    height: 160,
    data: maskData,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 100, y: 88 },
    createdAtFrame: 0,
    updatedAtFrame: 3,
  });
  let refreshRegion = null;
  let reconstructorRegion = null;

  service.cv = {};
  service.keypointDetector = {};
  service.currentPosition = { x: 100, y: 88, z: 0 };
  service.templateRegion = { x: 84, y: 72, width: 32, height: 32 };
  service.trackingRegion = { x: 76, y: 64, width: 48, height: 48 };
  service.metrics = {
    reconstructionRegion: { x: 84, y: 72, width: 32, height: 32 },
  };
  service.reconstructor = {
    updateReferenceRegion: region => {
      reconstructorRegion = region;
    },
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    lastRefreshStats: null,
    refreshKeypoints: (cv, grayImage, detector, region) => {
      refreshRegion = region;
      return false;
    },
  });

  assert.equal(service.updateObjectSupportMask(objectSupportMask), true);
  assert.ok(service.trackingRegion.width > 120);
  assert.ok(service.trackingRegion.height > 80);
  assert.deepEqual(service.metrics.reconstructionRegion, service.trackingRegion);
  assert.deepEqual(reconstructorRegion, service.trackingRegion);

  service._refreshKeypoints({ cols: 200, rows: 160 });

  assert.equal(refreshRegion.width, service.trackingRegion.width);
  assert.equal(refreshRegion.height, service.trackingRegion.height);
});

test('keypoint updates expose tracked planar scale and roll for the overlay', () => {
  const service = new ImageAnchorService();

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {};
  Object.assign(service.keypointTracker, {
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
  });

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

test('rigid planar tracker scale follows measured changes without filter lag', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'book';
  service.planarDominanceScore = 8;

  service._updatePlanarTransform({
    scale: 1.12,
    rotation: 0.1,
    confidence: 0.7,
    averageResidual: 1.2,
    inlierCount: 14,
    method: 'reference_similarity_transform',
  }, 1000);
  const caughtUp = service._updatePlanarTransform({
    scale: 0.96,
    rotation: 0.08,
    confidence: 0.66,
    averageResidual: 1.1,
    inlierCount: 12,
    method: 'reference_similarity_transform',
  }, 1016.67);

  assert.equal(caughtUp.scale, 0.96);
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
  Object.assign(service.keypointTracker, {
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
  });

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
  Object.assign(service.keypointTracker, {
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
  });

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

test('strong curved reconstruction can replace a drifting tracker attachment', () => {
  const service = new ImageAnchorService();
  const reconstructionPose = {
    success: true,
    method: 'sparse-reconstruction',
    position: { x: 236, y: 181, z: 0 },
    normal: { x: 0.48, y: -0.08, z: 0.87 },
    planarTransform: {
      scale: 1.12,
      rotation: 0.04,
      confidence: 0.84,
      inlierCount: 22,
      method: 'sparse-reconstruction',
    },
    confidence: 0.84,
    inlierCount: 22,
    inlierRatio: 0.46,
    averageResidual: 2.4,
    depthQuality: 0.22,
    preview: {
      ready: true,
      statistics: {
        mapConfidence: 0.86,
        averageSupport: 0.78,
        averageReliability: 0.72,
        matureLandmarks: 26,
      },
      current: {
        anchor: { x: 236, y: 181 },
      },
      surface: { model: 'tapered-cylinder' },
    },
  };

  service.setTrackingMode('sparse-reconstruction');
  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.anchorTargetClass = 'cup';
  service.currentPosition = { x: 210, y: 170, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.cv = {};
  service.reconstructor = {
    addFrameFromTrackedPoints: () => ({
      state: 'ready',
      ready: true,
      frameCount: 8,
      landmarkCount: 30,
      depthQuality: 0.22,
      statistics: {
        mapConfidence: 0.86,
        averageSupport: 0.78,
        averageReliability: 0.72,
        matureLandmarks: 26,
      },
      preview: { surface: { model: 'tapered-cylinder' } },
      lastFailureReason: null,
    }),
    getState: () => ({
      state: 'ready',
      ready: true,
      frameCount: 8,
      landmarkCount: 30,
      depthQuality: 0.22,
      statistics: {
        mapConfidence: 0.86,
        averageSupport: 0.78,
        averageReliability: 0.72,
        matureLandmarks: 26,
      },
      preview: { surface: { model: 'tapered-cylinder' } },
      lastFailureReason: null,
    }),
    estimatePoseFromTrackedPoints: () => reconstructionPose,
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 48 }, (_, index) => ({
      id: index,
      status: 'active',
      original: { x: 70 + (index % 8) * 18, y: 70 + Math.floor(index / 8) * 16 },
      current: { x: 84 + (index % 8) * 18, y: 82 + Math.floor(index / 8) * 16 },
    })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 48,
      averageError: 1.2,
    }),
    getObjectPose: () => ({
      success: false,
      method: 'object-pose-affine',
      reason: 'affine unavailable',
    }),
    getCorrespondences: () => [],
    getAnchorPosition: () => ({
      x: 218,
      y: 174,
      method: 'reference_similarity_transform',
      scale: 0.96,
      rotation: -0.1,
      confidence: 0.64,
      inlierCount: 20,
    }),
  });
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.method, 'sparse-reconstruction');
  assert.equal(result.position.x, 236);
  assert.equal(result.position.y, 181);
  assert.equal(result.planarTransform.scale, 1.12);
  assert.equal(result.poseSource, 'sparse-reconstruction');
});

test('mature curved reconstruction can replace a moderately drifting tracker attachment', () => {
  const service = new ImageAnchorService();
  const reconstructionPose = {
    success: true,
    method: 'direct-photometric',
    position: { x: 236, y: 181, z: 0 },
    normal: { x: 0.38, y: -0.24, z: 0.89 },
    planarTransform: {
      scale: 1.08,
      rotation: 0.12,
      confidence: 0.86,
      inlierCount: 24,
      method: 'direct-photometric',
    },
    confidence: 0.86,
    inlierCount: 24,
    inlierRatio: 0.52,
    averageResidual: 8.7,
    depthQuality: 0.12,
    referenceSpread: { width: 84, height: 58, minAxis: 58 },
    preview: {
      ready: true,
      statistics: {
        mapConfidence: 0.84,
        averageSupport: 0.76,
        averageReliability: 0.7,
        matureLandmarks: 28,
      },
      current: {
        anchor: { x: 236, y: 181 },
      },
      surface: { model: 'ellipsoid' },
    },
  };

  service.setTrackingMode('direct-photometric');
  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.anchorTargetClass = 'ball';
  service.templateRegion = { x: 160, y: 120, width: 140, height: 120 };
  service.currentPosition = { x: 230, y: 178, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.cv = {};
  service.reconstructor = {
    addFrameFromTrackedPoints: () => ({
      state: 'ready',
      ready: true,
      frameCount: 10,
      landmarkCount: 36,
      depthQuality: 0.12,
      statistics: {
        mapConfidence: 0.84,
        averageSupport: 0.76,
        averageReliability: 0.7,
        matureLandmarks: 28,
      },
      preview: { surface: { model: 'ellipsoid' } },
      lastFailureReason: null,
    }),
    getState: () => ({
      state: 'ready',
      ready: true,
      frameCount: 10,
      landmarkCount: 36,
      depthQuality: 0.12,
      statistics: {
        mapConfidence: 0.84,
        averageSupport: 0.76,
        averageReliability: 0.7,
        matureLandmarks: 28,
      },
      preview: { surface: { model: 'ellipsoid' } },
      lastFailureReason: null,
    }),
    estimatePoseFromTrackedPoints: () => reconstructionPose,
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 36 }, (_, index) => ({
      id: index,
      status: 'active',
      original: { x: 70 + (index % 6) * 18, y: 70 + Math.floor(index / 6) * 16 },
      current: { x: 84 + (index % 6) * 18, y: 82 + Math.floor(index / 6) * 16 },
    })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.88,
      activePointCount: 36,
      averageError: 1.5,
    }),
    getObjectPose: () => ({
      success: false,
      method: 'object-pose-affine',
      reason: 'affine unavailable',
    }),
    getCorrespondences: () => [],
    getAnchorPosition: () => ({
      x: 220,
      y: 174,
      method: 'reference_similarity_transform',
      scale: 0.98,
      rotation: -0.04,
      confidence: 0.62,
      inlierCount: 18,
    }),
  });
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.method, 'direct-photometric');
  assert.equal(result.position.x, 236);
  assert.equal(result.position.y, 181);
  assert.equal(result.poseSource, 'direct-photometric');
});

test('depth-fusion keeps tracker positioning as the anchor spine', () => {
  const service = new ImageAnchorService();
  const reconstructionPose = {
    success: true,
    method: 'depth-fusion',
    position: { x: 236, y: 181, z: 0 },
    normal: { x: 0.42, y: -0.2, z: 0.89 },
    planarTransform: {
      scale: 1.08,
      rotation: 0.12,
      confidence: 0.86,
      inlierCount: 24,
      method: 'depth-fusion',
    },
    confidence: 0.86,
    inlierCount: 24,
    inlierRatio: 0.52,
    averageResidual: 2.4,
    depthQuality: 0.16,
    referenceSpread: { width: 84, height: 58, minAxis: 58 },
    preview: {
      ready: true,
      statistics: {
        mapConfidence: 0.84,
        averageSupport: 0.76,
        averageReliability: 0.7,
        matureLandmarks: 28,
      },
      current: {
        anchor: { x: 236, y: 181 },
      },
      surface: { model: 'depth-fusion-surfels' },
    },
  };

  service.setTrackingMode('depth-fusion');
  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.anchorTargetClass = 'cup';
  service.templateRegion = { x: 160, y: 120, width: 140, height: 120 };
  service.currentPosition = { x: 230, y: 178, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.cv = {};
  service.reconstructor = {
    addFrameFromTrackedPoints: () => ({
      state: 'ready',
      ready: true,
      frameCount: 10,
      landmarkCount: 220,
      depthQuality: 0.16,
      statistics: {
        mapConfidence: 0.84,
        averageSupport: 0.76,
        averageReliability: 0.7,
        matureLandmarks: 28,
      },
      preview: { surface: { model: 'depth-fusion-surfels' } },
      lastFailureReason: null,
    }),
    getState: () => ({
      state: 'ready',
      ready: true,
      frameCount: 10,
      landmarkCount: 220,
      depthQuality: 0.16,
      statistics: {
        mapConfidence: 0.84,
        averageSupport: 0.76,
        averageReliability: 0.7,
        matureLandmarks: 28,
      },
      preview: { surface: { model: 'depth-fusion-surfels' } },
      lastFailureReason: null,
    }),
    estimatePoseFromTrackedPoints: () => reconstructionPose,
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 36 }, (_, index) => ({
      id: index,
      status: 'active',
      original: { x: 70 + (index % 6) * 18, y: 70 + Math.floor(index / 6) * 16 },
      current: { x: 84 + (index % 6) * 18, y: 82 + Math.floor(index / 6) * 16 },
    })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.88,
      activePointCount: 36,
      averageError: 1.5,
    }),
    getObjectPose: () => ({
      success: false,
      method: 'object-pose-affine',
      reason: 'affine unavailable',
    }),
    getCorrespondences: () => [],
    getAnchorPosition: () => ({
      x: 220,
      y: 174,
      method: 'reference_similarity_transform',
      scale: 0.98,
      rotation: -0.04,
      confidence: 0.62,
      inlierCount: 18,
    }),
  });
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);
  const readiness = service._createReadiness({
    state: result.state,
    poseSource: result.poseSource,
    positionSource: result.method,
    reconstructionReady: service.metrics.reconstructionReady,
    poseInliers: service.metrics.poseInliers,
    poseConfidence: service.metrics.poseConfidence,
    poseAverageResidual: service.metrics.poseAverageResidual,
    poseForeshortening: service.metrics.poseForeshortening,
  });

  assert.equal(result.success, true);
  assert.equal(result.method, 'reference_similarity_transform');
  assert.equal(result.position.x, 220);
  assert.equal(result.position.y, 174);
  assert.equal(result.poseSource, 'depth-fusion');
  assert.equal(readiness.attachmentSourceReady, true);
});

test('arbiter-selected planar pose owns position when reference similarity is weak', () => {
  const service = new ImageAnchorService();
  const correspondences = Array.from({ length: 18 }, (_, index) => {
    const prev = {
      x: 60 + (index % 6) * 18,
      y: 70 + Math.floor(index / 6) * 22,
    };
    return {
      prev,
      curr: { x: prev.x + 14, y: prev.y + 8 },
    };
  });
  const planarPose = {
    success: true,
    method: 'planar-homography',
    position: { x: 154, y: 128, z: 0 },
    normal: { x: 0.05, y: -0.02, z: 0.998 },
    planarTransform: {
      scale: 1.02,
      rotation: 0.04,
      confidence: 0.52,
      inlierCount: 9,
      method: 'planar-homography',
    },
    confidence: 0.52,
    inlierCount: 9,
    inlierRatio: 0.5,
    averageResidual: 4.8,
    referenceSpread: { width: 90, height: 44, minAxis: 44 },
  };
  const weakTrackerAnchor = {
    x: 174,
    y: 139,
    scale: 1.05,
    rotation: 0.08,
    confidence: 0.22,
    inlierCount: 9,
    averageResidual: 13,
    method: 'reference_similarity_transform',
  };

  service.setTrackingMode('direct-photometric');
  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.anchorTargetClass = 'mug';
  service.currentPosition = { x: 140, y: 120, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.cv = {};
  service._recordLandmarkMetrics = () => {
    service.metrics.activeLandmarkCount = 18;
    service.metrics.objectOwnedLandmarks = 18;
  };
  service._updateObjectSurfaceMetrics = () => {
    service.metrics.contourFitResidual = 0;
    service.metrics.silhouetteCoverage = 1;
  };
  service._estimateObjectPoseFromTracker = () => ({
    success: false,
    method: 'object-pose-affine',
    reason: 'unit object pose unavailable',
  });
  service._updateReconstructionPoseFromTracker = () => ({
    success: false,
    method: 'direct-photometric',
    reason: 'unit reconstruction mapping',
  });
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 42 },
    correspondences,
    poseResult: {
      success: true,
      method: 'homography',
      normal: planarPose.normal,
      confidence: planarPose.confidence,
      inlierCount: planarPose.inlierCount,
      inlierRatio: planarPose.inlierRatio,
      averageResidual: planarPose.averageResidual,
      referenceSpread: planarPose.referenceSpread,
    },
  });
  service._createPlanarHomographyPose = () => planarPose;
  service._shouldRefreshKeypoints = () => false;
  service._storeRelocalizationKeyframe = () => null;
  Object.assign(service.keypointTracker, {
    trackedPoints: correspondences.map((correspondence, index) => ({
      id: index,
      status: 'active',
      original: correspondence.prev,
      current: correspondence.curr,
      objectOwned: true,
      response: 1,
      age: 20,
      stabilityScore: 0.7,
    })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 18,
      averageError: 2,
    }),
    getAnchorPosition: () => weakTrackerAnchor,
    getCorrespondences: () => correspondences,
  });

  const result = service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.method, 'planar-homography');
  assert.equal(service.metrics.poseCandidateSource, 'planar-homography');
  assert.equal(service.metrics.rejectedPoseCandidates.reference_similarity_transform.reason, 'weak-geometry');
});

test('curved reconstruction relaxes stale normals when pose drops out', () => {
  const service = new ImageAnchorService();
  const staleNormal = { x: 0.55, y: -0.2, z: 0.81 };

  service.setTrackingMode('parametric-surface');
  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.anchorTargetClass = 'cup';
  service.currentPosition = { x: 210, y: 170, z: 0 };
  service.currentNormal = staleNormal;
  service.normalStabilizer.reset(staleNormal);
  service.framesWithoutNormalPose = 3;
  service.cv = {};
  service.reconstructor = {
    addFrameFromTrackedPoints: () => ({
      state: 'ready',
      ready: true,
      frameCount: 14,
      landmarkCount: 42,
      depthQuality: 0.22,
      statistics: { mapConfidence: 0.9 },
      preview: { surface: { model: 'tapered-cylinder' } },
      lastFailureReason: null,
    }),
    getState: () => ({
      state: 'ready',
      ready: true,
      frameCount: 14,
      landmarkCount: 42,
      depthQuality: 0.22,
      statistics: { mapConfidence: 0.9 },
      preview: { surface: { model: 'tapered-cylinder' } },
      lastFailureReason: null,
    }),
    estimatePoseFromTrackedPoints: () => ({
      success: false,
      method: 'parametric-surface',
      reason: 'No robust similarity consensus',
    }),
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 40 }, () => ({ status: 'active' })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.82,
      activePointCount: 40,
      averageError: 1.4,
    }),
    getObjectPose: () => ({
      success: false,
      method: 'object-pose-affine',
      reason: 'affine unavailable',
    }),
    getCorrespondences: () => [],
    getAnchorPosition: () => ({
      x: 214,
      y: 172,
      method: 'reference_similarity_transform',
      scale: 1,
      rotation: 0,
      confidence: 0.64,
      inlierCount: 18,
    }),
  });
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, true);
  assert.ok(Math.hypot(result.normal.x, result.normal.y) < Math.hypot(staleNormal.x, staleNormal.y));
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
  Object.assign(service.keypointTracker, {
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
  });
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

test('selected surface reconstruction owns pose over planar homography when its map is ready', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.planarDominanceScore = 8;
  service.metrics = {
    reconstructionMapConfidence: 0.66,
  };
  const correspondences = Array.from({ length: 30 }, (_, index) => ({
    prev: { x: 40 + index * 3, y: 80 + (index % 5) * 9 },
    curr: { x: 54 + index * 3.2, y: 92 + (index % 5) * 9.4 },
  }));
  const planarPose = {
    success: true,
    method: 'planar-homography',
    position: { x: 140, y: 132, z: 0 },
    normal: { x: 0.04, y: -0.02, z: 0.999 },
    planarTransform: { scale: 1.05, rotation: 0.02, confidence: 0.9, inlierCount: 28 },
    confidence: 0.9,
    inlierCount: 28,
    inlierRatio: 0.93,
    averageResidual: 0.9,
  };
  const reconstructionPose = {
    success: true,
    method: 'parametric-surface',
    position: { x: 143, y: 135, z: 0 },
    normal: { x: 0.34, y: -0.07, z: 0.94 },
    planarTransform: { scale: 1.11, rotation: 0.17, confidence: 0.72, inlierCount: 24 },
    confidence: 0.72,
    inlierCount: 24,
    inlierRatio: 0.8,
    averageResidual: 2.1,
    depthQuality: 0.18,
    preview: {
      statistics: {
        mapConfidence: 0.66,
      },
    },
  };

  assert.equal(service._shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences }), false);
  assert.equal(service._shouldUsePlanarPatchTransform({ planarPose, reconstructionPose, correspondences }), false);
  assert.equal(service._selectNormalPose({
    reconstructionPose,
    planarPose,
    objectPose: { success: false, confidence: 0 },
    poseResult: null,
    correspondences,
    reconstructionConsistentWithTracker: true,
  }).method, 'parametric-surface');
});

test('rigid planar targets keep strong homography ownership over selected surface reconstruction', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'card';
  service.planarDominanceScore = 8;
  service.metrics = {
    reconstructionMapConfidence: 0.76,
  };
  const correspondences = Array.from({ length: 30 }, (_, index) => ({
    prev: { x: 42 + index * 3, y: 78 + (index % 5) * 8 },
    curr: { x: 50 + index * 3.1, y: 86 + (index % 5) * 8.2 },
  }));
  const planarPose = {
    success: true,
    method: 'planar-homography',
    position: { x: 140, y: 132, z: 0 },
    normal: { x: 0.04, y: -0.02, z: 0.999 },
    planarTransform: { scale: 1.04, rotation: 0.02, confidence: 0.92, inlierCount: 28 },
    confidence: 0.92,
    inlierCount: 28,
    inlierRatio: 0.93,
    averageResidual: 0.9,
    referenceSpread: { width: 122, height: 86, minAxis: 86 },
  };
  const reconstructionPose = {
    success: true,
    method: 'parametric-surface',
    position: { x: 156, y: 146, z: 0 },
    normal: { x: 0.24, y: -0.12, z: 0.963 },
    planarTransform: { scale: 1.12, rotation: 0.16, confidence: 0.78, inlierCount: 24 },
    confidence: 0.78,
    inlierCount: 24,
    inlierRatio: 0.8,
    averageResidual: 2.1,
    depthQuality: 0.012,
    preview: {
      surface: { model: 'plane' },
      statistics: {
        mapConfidence: 0.76,
      },
    },
  };

  assert.equal(service._shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences }), true);
  assert.equal(service._selectNormalPose({
    reconstructionPose,
    planarPose,
    objectPose: { success: false, confidence: 0 },
    poseResult: null,
    correspondences,
    reconstructionConsistentWithTracker: true,
  }).method, 'planar-homography');
});

test('mature selected planar surface can report pose source through glare recovery', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'cell phone';
  service.planarDominanceScore = 8;
  service.metrics = {
    reconstructionMapConfidence: 0.77,
  };
  const correspondences = Array.from({ length: 28 }, (_, index) => ({
    prev: { x: 52 + (index % 7) * 14, y: 68 + Math.floor(index / 7) * 12 },
    curr: { x: 58 + (index % 7) * 14.2, y: 75 + Math.floor(index / 7) * 12.1 },
  }));
  const planarPose = {
    success: true,
    method: 'planar-homography',
    position: { x: 144, y: 136, z: 0 },
    normal: { x: 0.03, y: -0.02, z: 0.999 },
    planarTransform: { scale: 1.04, rotation: 0.02, confidence: 0.78, inlierCount: 18 },
    confidence: 0.78,
    inlierCount: 18,
    inlierRatio: 0.64,
    averageResidual: 0.78,
    referenceSpread: { width: 102, height: 66, minAxis: 66 },
  };
  const reconstructionPose = {
    success: true,
    method: 'parametric-surface',
    position: { x: 146, y: 138, z: 0 },
    normal: { x: 0.05, y: -0.03, z: 0.998 },
    planarTransform: { scale: 1.06, rotation: 0.04, confidence: 0.96, inlierCount: 27 },
    confidence: 0.96,
    inlierCount: 27,
    inlierRatio: 1,
    averageResidual: 1.93,
    depthQuality: 0.02,
    preview: {
      statistics: {
        mapConfidence: 0.77,
      },
    },
  };

  assert.equal(service._shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences }), true);
  assert.equal(service._selectNormalPose({
    reconstructionPose,
    planarPose,
    objectPose: { success: false, confidence: 0 },
    poseResult: null,
    correspondences,
    reconstructionConsistentWithTracker: true,
  }).method, 'parametric-surface');
});

test('rigid planar reconstruction normals are not trusted external corrections', () => {
  const bookService = new ImageAnchorService();
  bookService.setTrackingMode('parametric-surface');
  bookService.anchorTargetClass = 'book';

  assert.equal(
    bookService._shouldTrustNormalPose({
      success: true,
      method: 'parametric-surface',
      confidence: 0.95,
      inlierCount: 24,
      normal: { x: 0.02, y: 0, z: 1 },
    }),
    false
  );

  const cupService = new ImageAnchorService();
  cupService.setTrackingMode('parametric-surface');
  cupService.anchorTargetClass = 'cup';

  assert.equal(
    cupService._shouldTrustNormalPose({
      success: true,
      method: 'parametric-surface',
      confidence: 0.95,
      inlierCount: 24,
      normal: { x: 0.42, y: 0, z: 0.91 },
      depthQuality: 0.08,
      preview: {
        statistics: {
          mapConfidence: 0.72,
        },
      },
    }),
    true
  );
});

test('curved reconstruction targets reject planar homography normals during pose dropout', () => {
  const service = new ImageAnchorService();
  const correspondences = Array.from({ length: 28 }, (_, index) => ({
    prev: { x: 70 + (index % 7) * 16, y: 80 + Math.floor(index / 7) * 15 },
    curr: { x: 78 + (index % 7) * 14, y: 86 + Math.floor(index / 7) * 15 },
  }));
  const planarPose = {
    success: true,
    method: 'planar-homography',
    position: { x: 300, y: 224, z: 0 },
    normal: { x: 0.67, y: -0.17, z: 0.72 },
    planarTransform: { scale: 1.02, rotation: 0.02, confidence: 0.9, inlierCount: 24 },
    confidence: 0.9,
    inlierCount: 24,
    inlierRatio: 0.86,
    averageResidual: 1.1,
  };

  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'can';
  service.metrics.reconstructionPreview = { surface: { model: 'cylinder' } };

  assert.equal(service._selectNormalPose({
    reconstructionPose: {
      success: false,
      method: 'parametric-surface',
      reason: 'No robust similarity consensus',
    },
    planarPose,
    objectPose: { success: false, method: 'object-pose-affine', confidence: 0 },
    poseResult: { ...planarPose, method: 'homography' },
    correspondences,
    reconstructionConsistentWithTracker: false,
  }), null);
});

test('recent mature reconstruction holds through one-frame planar normal dropout', () => {
  const service = new ImageAnchorService();
  const correspondences = Array.from({ length: 30 }, (_, index) => ({
    prev: { x: 62 + (index % 6) * 18, y: 76 + Math.floor(index / 6) * 16 },
    curr: { x: 70 + (index % 6) * 17, y: 84 + Math.floor(index / 6) * 16 },
  }));
  const planarPose = {
    success: true,
    method: 'planar-homography',
    position: { x: 214, y: 172, z: 0 },
    normal: { x: -0.62, y: 0.04, z: 0.78 },
    planarTransform: { scale: 1.03, rotation: 0.02, confidence: 0.82, inlierCount: 22 },
    confidence: 0.82,
    inlierCount: 22,
    inlierRatio: 0.73,
    averageResidual: 1.7,
  };

  service.setTrackingMode('parametric-surface');
  service.lastNormalPoseSource = 'parametric-surface';
  service.framesWithoutNormalPose = 0;
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.71;
  service.metrics.reconstructionMatureLandmarks = 26;

  const selected = service._selectNormalPose({
    reconstructionPose: {
      success: false,
      method: 'parametric-surface',
      reason: 'Temporary PnP dropout',
    },
    planarPose,
    objectPose: { success: false, method: 'object-pose-affine', confidence: 0 },
    poseResult: { ...planarPose, method: 'homography' },
    correspondences,
    reconstructionConsistentWithTracker: false,
  });

  assert.equal(selected, null);
  assert.equal(service.metrics.poseSourceHoldReason, 'transient-reconstruction-dropout');
});

test('selected reconstruction modes accept robust surface residuals without relaxing object pose gates', () => {
  const service = new ImageAnchorService();
  const correspondences = Array.from({ length: 28 }, (_, index) => ({
    prev: { x: 40 + index * 4, y: 70 + (index % 6) * 11 },
    curr: { x: 55 + index * 4.2, y: 82 + (index % 6) * 11.3 },
  }));
  const pose = {
    success: true,
    method: 'parametric-surface',
    normal: { x: 0.28, y: -0.05, z: 0.96 },
    confidence: 0.48,
    inlierCount: 18,
    inlierRatio: 0.42,
    averageResidual: 10.5,
  };

  service.setTrackingMode('parametric-surface');
  assert.equal(service._isUsablePoseResult(pose, correspondences), true);

  service.setTrackingMode('object-pose');
  assert.equal(service._isUsablePoseResult({ ...pose, method: 'object-pose-affine' }, correspondences), false);
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
  Object.assign(service.keypointTracker, {
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
  });
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
  Object.assign(service.keypointTracker, {
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
  });

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

test('planar reconstruction targets hold tracker attachment instead of affine object pose during occlusion', () => {
  const service = new ImageAnchorService();
  const objectPose = createObjectPose({
    x: 212,
    y: 178,
    scale: 1.22,
    rotation: 0.31,
    normal: { x: -0.34, y: -0.24, z: 0.91 },
    confidence: 0.78,
    inlierCount: 18,
    inlierRatio: 0.62,
    averageResidual: 1.6,
  });

  service.setTrackingMode('sparse-reconstruction');
  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.anchorTargetClass = 'book';
  service.planarDominanceScore = 8;
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.currentNormal = { x: 0.08, y: 0.12, z: 0.99 };
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 0.8,
    inlierCount: 20,
    method: 'previous',
  };
  service.cv = {};
  service.reconstructor = {
    addFrameFromTrackedPoints: () => ({
      state: 'ready',
      ready: true,
      frameCount: 8,
      landmarkCount: 22,
      depthQuality: 0.01,
      statistics: { mapConfidence: 0.7 },
      lastFailureReason: null,
    }),
    getState: () => ({
      state: 'ready',
      ready: true,
      frameCount: 8,
      landmarkCount: 22,
      depthQuality: 0.01,
      statistics: { mapConfidence: 0.7 },
      lastFailureReason: null,
    }),
    estimatePoseFromTrackedPoints: () => ({
      success: false,
      method: 'sparse-reconstruction',
      reason: 'Insufficient reconstructed landmarks in view',
    }),
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 26 }, (_, index) => ({
      id: index,
      status: 'active',
      original: { x: 70 + (index % 6) * 18, y: 80 + Math.floor(index / 6) * 16 },
      current: { x: 82 + (index % 6) * 18, y: 90 + Math.floor(index / 6) * 16 },
    })),
    trackToFrame: () => ({
      success: true,
      successRate: 0.82,
      activePointCount: 26,
      averageError: 1.4,
    }),
    getObjectPose: () => objectPose,
    getCorrespondences: () => [],
    getAnchorPosition: () => ({
      x: 146,
      y: 164,
      method: 'reference_similarity_transform',
      rotation: 0.08,
      scale: 1.06,
      confidence: 0.72,
      inlierCount: 18,
    }),
  });
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.method, 'reference_similarity_transform');
  assert.equal(result.position.x, 146);
  assert.equal(result.position.y, 164);
  assert.equal(result.planarTransform.scale, 1.06);
  assert.equal(result.poseSource, 'object-pose-affine');
  assert.ok(service.getState().normal.x < 0);
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
  Object.assign(service.keypointTracker, {
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
  });
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
  Object.assign(service.keypointTracker, {
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
  });

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
  Object.assign(service.keypointTracker, {
    anchorOriginalPosition: { x: 120, y: 130 },
    getCorrespondences: options => (
      options.maxReferenceDistance < 100 ? localCorrespondences : wideCorrespondences
    ),
  });
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

test('curved sparse reconstruction uses tracker-local scale when its attachment is only reference similarity', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'bottle';
  service.metrics.reconstructionPreview = {
    surface: { model: 'cylinder' },
  };
  const trackerAnchorPosition = {
    scale: 0.86,
    rotation: -0.12,
    confidence: 0.54,
    inlierCount: 14,
    method: 'reference_similarity_transform',
  };
  const reconstructionPose = {
    success: true,
    method: 'sparse-reconstruction',
    inlierCount: 15,
    averageResidual: 3.2,
    depthQuality: 0.18,
    planarTransform: {
      scale: 1.08,
      rotation: 0.2,
      confidence: 0.9,
      inlierCount: 15,
      method: 'reference_similarity_transform',
    },
    preview: {
      surface: { model: 'cylinder' },
      statistics: { mapConfidence: 0.72 },
    },
  };

  assert.equal(service._shouldUseTrackedCurvedAttachmentTransform({
    reconstructionPose,
    trackerAnchorPosition,
  }), true);

  const transform = service._selectTrackedAttachmentTransform({
    trackerAnchorPosition,
    reconstructionPose,
    useTrackedTransform: true,
  });

  assert.equal(transform.scale, trackerAnchorPosition.scale);
  assert.equal(transform.rotation, trackerAnchorPosition.rotation);
});

test('selected curved reconstruction blends tracker scale when selected scale diverges', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'can';
  service.metrics.reconstructionPreview = {
    surface: { model: 'cylinder' },
  };
  const trackerAnchorPosition = {
    scale: 0.94,
    rotation: -0.08,
    confidence: 0.78,
    averageResidual: 2.6,
    inlierCount: 18,
    method: 'reference_similarity_transform',
  };
  const reconstructionPose = {
    success: true,
    method: 'parametric-surface',
    inlierCount: 16,
    averageResidual: 3.4,
    confidence: 0.72,
    normal: { x: 0.18, y: -0.08, z: 0.98 },
    planarTransform: {
      scale: 1.38,
      rotation: 0.24,
      confidence: 0.72,
      inlierCount: 16,
      method: 'parametric-surface',
    },
    preview: {
      surface: { model: 'cylinder' },
      statistics: { mapConfidence: 0.76 },
    },
  };

  assert.equal(service._shouldBlendTrackerScaleForSelectedCurvedTransform({
    reconstructionPose,
    trackerAnchorPosition,
  }), true);

  const transform = service._selectBlendedCurvedAttachmentTransform({
    trackerAnchorPosition,
    reconstructionPose
  });

  assert.equal(transform.scale, Math.sqrt(trackerAnchorPosition.scale * reconstructionPose.planarTransform.scale));
  assert.equal(transform.rotation, trackerAnchorPosition.rotation);

  reconstructionPose.planarTransform.scale = 0;
  assert.equal(service._shouldBlendTrackerScaleForSelectedCurvedTransform({
    reconstructionPose,
    trackerAnchorPosition,
  }), false);
});

test('mature curved pose dropout uses centroid position while preserving tracker transform', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'cup';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.activeLandmarks = 39;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  Object.assign(service.keypointTracker, {
    getCentroidAnchorPosition: () => ({
      x: 274,
      y: 221,
      confidence: 0.8,
      inlierCount: 39,
      method: 'weighted_centroid_with_offset',
    }),
  });
  const trackerAnchorPosition = {
    x: 322,
    y: 212,
    scale: 0.91,
    rotation: -0.16,
    confidence: 0,
    inlierCount: 37,
    averageResidual: 39,
    method: 'reference_similarity_transform',
  };
  const reconstructionPose = {
    success: false,
    method: 'sparse-reconstruction',
    reason: 'Insufficient reconstruction pose inliers',
    preview: {
      surface: { model: 'tapered-cylinder' },
    },
  };

  const selected = service._selectTrackerAnchorPosition({
    trackerAnchorPosition,
    reconstructionPose,
  });

  assert.equal(selected.x, 274);
  assert.equal(selected.y, 221);
  assert.equal(selected.scale, trackerAnchorPosition.scale);
  assert.equal(selected.rotation, trackerAnchorPosition.rotation);
  assert.equal(selected.method, 'curved-centroid-position');
  assert.equal(selected.transformMethod, 'reference_similarity_transform');
  assert.equal(service.metrics.trackerAnchorAdjustment, 'curved-dropout-centroid-position');
});

test('mature curved pose dropout centroid ignores active landmarks demoted from object ownership', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'cup';
  service.objectSupportMask = createObjectSupportMask({
    width: 160,
    height: 120,
    data: new Uint8Array(160 * 120).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.88,
    referencePoint: { x: 78, y: 58 },
    createdAtFrame: 0,
  });
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.activeLandmarks = 39;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  let centroidInput = null;
  Object.assign(service.keypointTracker, {
    trackedPoints: [
      { status: 'active', objectOwned: true, current: { x: 74, y: 58 } },
      { status: 'active', objectOwned: false, current: { x: 144, y: 16 } },
      { status: 'active', objectOwned: true, current: { x: 82, y: 62 } },
      { status: 'lost', objectOwned: true, current: { x: 80, y: 64 } },
    ],
    getCentroidAnchorPosition: points => {
      centroidInput = points;
      return {
        x: 78,
        y: 60,
        confidence: 0.8,
        inlierCount: points.length,
        method: 'weighted_centroid_with_offset',
      };
    },
  });

  const selected = service._selectTrackerAnchorPosition({
    trackerAnchorPosition: {
      x: 126,
      y: 70,
      scale: 0.94,
      rotation: -0.12,
      confidence: 0.02,
      inlierCount: 37,
      averageResidual: 28,
      method: 'reference_similarity_transform',
    },
    reconstructionPose: {
      success: false,
      method: 'sparse-reconstruction',
      preview: {
        surface: { model: 'tapered-cylinder' },
      },
    },
  });

  assert.equal(selected.method, 'curved-centroid-position');
  assert.equal(selected.x, 78);
  assert.equal(selected.y, 60);
  assert.equal(centroidInput.length, 2);
  assert.equal(centroidInput.every(point => point.objectOwned === true), true);
});


test('selected curved reconstruction modes do not use sparse centroid dropout fallback', () => {
  for (const mode of ['parametric-surface', 'direct-photometric']) {
    const service = new ImageAnchorService();
    service.setTrackingMode(mode);
    service.anchorTargetClass = 'mug';
    service.metrics.reconstructionReady = true;
    service.metrics.reconstructionMapConfidence = 0.84;
    service.metrics.reconstructionMatureLandmarks = 49;
    service.metrics.activeLandmarks = 52;
    service.metrics.reconstructionPreview = {
      surface: { model: 'tapered-cylinder' },
    };
    Object.assign(service.keypointTracker, {
      getCentroidAnchorPosition: () => ({
        x: 274,
        y: 221,
        confidence: 0.8,
        inlierCount: 52,
        method: 'weighted_centroid_with_offset',
      }),
    });
    const trackerAnchorPosition = {
      x: 322,
      y: 212,
      scale: 0.91,
      rotation: -0.16,
      confidence: 0.02,
      inlierCount: 52,
      averageResidual: 115,
      method: 'reference_similarity_transform',
    };
    const reconstructionPose = {
      success: false,
      method: mode,
      reason: 'Insufficient reconstruction pose inliers',
      preview: {
        surface: { model: 'tapered-cylinder' },
      },
    };

    const selected = service._selectTrackerAnchorPosition({
      trackerAnchorPosition,
      reconstructionPose,
    });

    assert.equal(selected, trackerAnchorPosition, mode);
    assert.equal(service.metrics.trackerAnchorAdjustment, null, mode);
  }
});

test('mature curved reconstruction owns position when tracker transform is incoherent', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'cup';
  service.templateRegion = { width: 132, height: 118 };
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.86;
  service.metrics.reconstructionMatureLandmarks = 22;
  service.metrics.reconstructionTrackerDelta = 18;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  const reconstructionPose = {
    success: true,
    method: 'sparse-reconstruction',
    inlierCount: 10,
    averageResidual: 2.8,
    confidence: 0.7,
    preview: {
      surface: { model: 'tapered-cylinder' },
      statistics: { mapConfidence: 0.86 },
    },
  };
  const trackerAnchorPosition = {
    method: 'reference_similarity_transform',
    confidence: 0.03,
    averageResidual: 15.4,
  };

  assert.equal(service._hasModerateCurvedReconstructionRecovery({
    reconstructionPose,
    trackerAnchorPosition,
  }), true);
});

test('compact mature curved reconstruction recovers position when tracker transform is incoherent', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'mug';
  service.templateRegion = { width: 140, height: 118 };
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.88;
  service.metrics.reconstructionMatureLandmarks = 36;
  service.metrics.reconstructionTrackerDelta = 19;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  const reconstructionPose = {
    success: true,
    method: 'sparse-reconstruction',
    inlierCount: 8,
    averageResidual: 1.6,
    confidence: 0.82,
    preview: {
      surface: { model: 'tapered-cylinder' },
      statistics: { mapConfidence: 0.88 },
    },
  };
  const trackerAnchorPosition = {
    method: 'reference_similarity_transform',
    confidence: 0.04,
    averageResidual: 34,
  };

  assert.equal(service._hasModerateCurvedReconstructionRecovery({
    reconstructionPose,
    trackerAnchorPosition,
  }), true);
});
