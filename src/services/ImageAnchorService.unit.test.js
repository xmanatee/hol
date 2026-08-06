import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageAnchorService } from './ImageAnchorService.js';
import { KeypointDetector } from '../cv/anchor.keypoints.js';
import { createObjectSupportMask, isPointInsideObjectSupport } from '../cv/objectSupportMask.js';
import { CURVED_OBJECT_RECOVERY_REASON } from '../cv/curvedObjectRecovery.js';
import { loadOpenCvForNode } from '../cv/synthetic/opencvNodeLoader.js';

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

const createHomographyEstimatorStub = (estimatePose) => ({
  estimatePose,
  commitPlanarPnPPose() {},
  breakPoseContinuity() {},
});

const installAnchorPositionEvaluationStub = (tracker) => {
  const getAnchorPosition = tracker.getAnchorPosition;
  tracker.createAnchorPositionEvaluation = () => ({
    position: getAnchorPosition(null),
    attachmentEvidence: { testStub: true },
  });
  tracker.resolveAnchorPositionEvaluation = (cv) => getAnchorPosition(cv);
};

const resolveNormalPose = (
  service,
  {
    reconstructionPose = null,
    planarPose = null,
    objectPose = null,
    poseResult = null,
    correspondences = [],
    reconstructionConsistentWithTracker = false,
  },
) => {
  const poseArbitration = service._recordPoseCandidates({
    reconstructionPose,
    planarPose,
    objectPose,
    poseResult,
    trackerAnchorPosition: null,
    reconstructionConsistentWithTracker,
    correspondences,
  });
  const resolved = service._resolveNormalPose({
    poseArbitration,
    reconstructionPose,
    planarPose,
    objectPose,
    poseResult,
    correspondences,
    preferPlanar: service._shouldPreferPlanarHomography({
      planarPose,
      reconstructionPose,
      correspondences,
    }),
  });

  return {
    ...resolved,
    arbitration: poseArbitration,
  };
};

test('template region ignores raw selection metadata without object support', () => {
  const service = new ImageAnchorService();
  const tap = { x: 500, y: 320 };
  const region = service._calculateTemplateRegion(tap, { x1: 0, y1: 0, x2: 100, y2: 100 }, 1280, 720);

  assert.equal(region.width, 140);
  assert.equal(region.height, 140);
  assert.equal(region.x + region.width / 2, tap.x);
  assert.equal(region.y + region.height / 2, tap.y);
});

test('large selections create a tap-local template instead of seeding the whole region', () => {
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
    720,
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

test('learned recovery accepts semantic planes and segmented generic rectangles only', () => {
  const service = new ImageAnchorService();
  const rectangle = {
    source: 'interactive-segmenter',
    bbox: { x: 20, y: 30, width: 120, height: 80 },
    pixelCount: 9200,
  };
  const roundedObject = {
    source: 'interactive-segmenter',
    bbox: { x: 20, y: 20, width: 100, height: 100 },
    pixelCount: 7800,
  };

  assert.equal(service._isRigidPlanarRecoverySelection('card', null), true);
  assert.equal(service._isRigidPlanarRecoverySelection(null, rectangle), true);
  assert.equal(service._isRigidPlanarRecoverySelection('generic-object', rectangle), true);
  assert.equal(service._isRigidPlanarRecoverySelection(null, roundedObject), false);
  assert.equal(service._isRigidPlanarRecoverySelection('cup', rectangle), false);
  assert.equal(
    service._isRigidPlanarRecoverySelection(null, {
      ...rectangle,
      source: 'tap-local',
    }),
    false,
  );
});

test('learned recovery eligibility does not reclassify generic object geometry', () => {
  const service = new ImageAnchorService();
  service.anchorTargetClass = 'generic-object';
  service.rigidPlanarRecoveryEligible = true;

  assert.equal(service._hasPlanarTargetClass(), false);
  assert.equal(service._hasRigidPlanarTargetClass(), false);

  service.anchorTargetClass = 'card';
  assert.equal(service._hasPlanarTargetClass(), true);
  assert.equal(service._hasRigidPlanarTargetClass(), true);
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
    correspondences: [],
  });

  assert.equal(result.selectedOverlay, null);
  assert.equal(result.rejected['sparse-reconstruction'].reason, 'silhouette-mismatch');
  assert.equal(result.rejected['planar-homography'].reason, 'silhouette-mismatch');
  assert.equal(service.metrics.poseCandidates[0].contourFitResidual, 9.4);
  assert.equal(service.metrics.poseCandidates[0].silhouetteCoverage, 0.16);
});

test('normal rejection diagnostics exclude candidates without a normal capability', () => {
  const service = new ImageAnchorService();
  const result = service._recordPoseCandidates({
    reconstructionPose: null,
    planarPose: null,
    objectPose: null,
    poseResult: null,
    trackerAnchorPosition: {
      x: 120,
      y: 130,
      method: 'reference_similarity_transform',
      scale: 1,
      rotation: 0,
      confidence: 0.8,
      inlierCount: 18,
      averageResidual: 1.2,
    },
    reconstructionConsistentWithTracker: false,
    correspondences: [],
  });

  assert.equal(result.byRole.tracker.normalAllowed, false);
  assert.equal(result.byRole.tracker.normalRejectionReason, 'Normal unavailable');
  assert.deepEqual(service.metrics.normalPoseRejectedCandidates, {});
});

test('reconstruction pose update suppresses live previews on the tracking hot path', () => {
  for (const mode of ['sparse-reconstruction', 'direct-photometric', 'depth-fusion']) {
    const service = new ImageAnchorService();
    const grayImage = { cols: 64, rows: 64 };
    const imageData = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
    const trackedPoints = [
      {
        id: 1,
        status: 'active',
        objectOwned: true,
        objectOwnedStreak: 2,
        original: { x: 20, y: 24 },
        current: { x: 23, y: 26 },
      },
    ];
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

    service._updateReconstructionPoseFromTracker(1000, grayImage, {}, null, imageData);

    assert.equal(addFrameArgs[0], trackedPoints);
    assert.equal(addFrameArgs[1], 1000);
    assert.equal(poseArgs[0], trackedPoints);
    if (mode === 'direct-photometric') {
      assert.equal(addFrameArgs[2], grayImage);
      assert.deepEqual(addFrameArgs[3].includePreview, false);
      assert.equal(addFrameArgs[3].imageData, imageData);
      assert.equal(poseArgs[1], grayImage);
      assert.deepEqual(poseArgs[2], { includePreview: false });
    } else {
      assert.deepEqual(addFrameArgs[2].includePreview, false);
      assert.equal(addFrameArgs[2].imageData, imageData);
      assert.deepEqual(poseArgs[1], { includePreview: false });
    }
  }
});

test('ready reconstruction preserves its map while recovery landmarks await validation', () => {
  const service = new ImageAnchorService();
  const trackedPoints = [
    {
      id: 1,
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 2,
      original: { x: 20, y: 24 },
      current: { x: 23, y: 26 },
    },
    {
      id: 2,
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 2,
      recoveryOwnershipProbation: true,
      original: { x: 30, y: 34 },
      current: { x: 33, y: 36 },
    },
    {
      id: 3,
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 4,
      recoveryOwnershipProbation: true,
      original: { x: 40, y: 44 },
      current: { x: 43, y: 46 },
    },
  ];
  let mappedPoints = null;
  let posePoints = null;

  service.trackingMode = 'sparse-reconstruction';
  service.keypointTracker = { trackedPoints };
  service.reconstructor = {
    addFrameFromTrackedPoints: (points) => {
      mappedPoints = points;
      return {
        state: 'mapping',
        ready: false,
        frameCount: 1,
        landmarkCount: 2,
        statistics: {},
        lastFailureReason: null,
      };
    },
    estimatePoseFromTrackedPoints: (points) => {
      posePoints = points;
      return {
        success: false,
        method: 'sparse-reconstruction',
        reason: 'map not ready',
      };
    },
    getState: () => ({
      state: 'ready',
      ready: true,
      frameCount: 12,
      landmarkCount: 24,
      statistics: { mapConfidence: 0.8 },
      lastFailureReason: null,
    }),
  };

  service._updateReconstructionPoseFromTracker(1000, { cols: 64, rows: 64 });

  assert.equal(mappedPoints, null);
  assert.deepEqual(
    posePoints.map((point) => point.id),
    [1, 3],
  );
  assert.equal(service.metrics.reconstructionMapHeldForRecoveryValidation, true);

  service.reconstructor.getState = () => ({
    state: 'mapping',
    ready: false,
    frameCount: 3,
    landmarkCount: 6,
    statistics: { mapConfidence: 0.3 },
    lastFailureReason: null,
  });
  service._updateReconstructionPoseFromTracker(1033, { cols: 64, rows: 64 });

  assert.deepEqual(
    mappedPoints.map((point) => point.id),
    [1, 3],
  );
  assert.equal(service.metrics.reconstructionMapHeldForRecoveryValidation, false);
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
  service.anchorTargetClass = 'cup';
  service.metrics.reconstructionMapConfidence = 0.74;
  assert.equal(service._shouldSkipPlanarPoseForSelectedReconstruction(reconstructionPose), true);

  service.anchorTargetClass = 'book';
  assert.equal(service._shouldSkipPlanarPoseForSelectedReconstruction(reconstructionPose), false);

  service.anchorTargetClass = 'cup';
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

test('generic free-tap targets infer pose ownership from support geometry', () => {
  const service = new ImageAnchorService();
  service.anchorTargetClass = 'generic-object';

  service.currentObjectSupportMask = {
    bbox: { x: 220, y: 120, width: 84, height: 190 },
  };
  service.metrics.reconstructionPreview = { surface: { model: 'plane' } };
  assert.equal(service._targetSurfaceModel(), 'cylinder');
  assert.equal(service._hasCurvedReconstructionTarget(), true);
  assert.equal(service._hasPlanarTargetClass(), false);
  assert.equal(service._hasRigidPlanarTargetClass(), false);

  service.currentObjectSupportMask = {
    bbox: { x: 160, y: 180, width: 220, height: 120 },
  };
  assert.equal(service._targetSurfaceModel(), 'plane');
  assert.equal(service._hasCurvedReconstructionTarget(), false);
  assert.equal(service._hasPlanarTargetClass(), true);
  assert.equal(service._hasRigidPlanarTargetClass(), true);

  service.currentObjectSupportMask = {
    bbox: { x: 220, y: 90, width: 120, height: 260 },
    pixelCount: 120 * 260 * 0.45,
  };
  assert.equal(service._targetSurfaceModel(), null);
  assert.equal(service._hasCurvedReconstructionTarget(), false);

  for (const targetClass of ['person', 'face', 'head']) {
    service.anchorTargetClass = targetClass;
    service.currentObjectSupportMask = {
      bbox: { x: 220, y: 90, width: 110, height: 250 },
    };
    assert.equal(service._targetSurfaceModel(), null, targetClass);
    assert.equal(service._hasCurvedReconstructionTarget(), false, targetClass);
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

  assert.equal(
    service._shouldPreferPlanarHomography({
      planarPose: weakLocalPlanarPose,
      reconstructionPose: { success: false },
      correspondences,
    }),
    false,
  );
  assert.equal(
    service._shouldPreferPlanarHomography({
      planarPose: strongPlanarPose,
      reconstructionPose: { success: false },
      correspondences,
    }),
    true,
  );
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

  assert.equal(
    service._shouldPreferPlanarHomography({
      planarPose: moderatePlanarPose,
      reconstructionPose: { success: false },
      correspondences,
    }),
    true,
  );

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
    averageResidual: 9.5,
    referenceSpread: { width: 88, height: 46, minAxis: 46 },
  });

  assert.equal(service._getPoseRejectionReason(recoveredPlanarPose, correspondences), null);
  assert.equal(
    service._shouldPreferPlanarHomography({
      planarPose: recoveredPlanarPose,
      reconstructionPose: { success: false },
      correspondences,
    }),
    true,
  );
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

  assert.equal(
    service._shouldPreferPlanarHomography({
      planarPose: recoveredPlanarPose,
      reconstructionPose: { success: false },
      correspondences,
    }),
    true,
  );

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
  assert.equal(service._getPoseRejectionReason(weakBookPose, correspondences), 'Low pose inlier ratio');
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

test('absolute global relocalization bypasses stale pose filters and step limits', () => {
  const service = new ImageAnchorService();
  service.currentPosition = { x: 40, y: 50, z: 0 };
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 0.8,
    inlierCount: 12,
    method: 'planar-homography',
  };
  service.metrics.lastUpdateResult = 'success';
  service.positionFilterX.filter(40, 900);
  service.positionFilterY.filter(50, 900);
  service.planarScaleFilter.filter(1, 900);
  service.planarRotationFilter.filter(0, 900);

  const position = service._filterPositionCandidate(
    { x: 220, y: 155, confidence: 0.84, inlierCount: 14 },
    1000,
    'reference_similarity_transform',
    { absoluteRelocalization: true },
  );
  const transform = service._updatePlanarTransform(
    {
      scale: 1.42,
      rotation: 0.7,
      confidence: 0.84,
      inlierCount: 14,
      method: 'reference_similarity_transform',
    },
    1000,
    { absoluteRelocalization: true },
  );

  assert.equal(position.x, 220);
  assert.equal(position.y, 155);
  assert.equal(transform.scale, 1.42);
  assert.equal(transform.rotation, 0.7);
  assert.equal(service.metrics.positionFilterAdjustment, 'absolute-relocalization');
});

test('position filtering preserves the evidence owned by the selected source', () => {
  const service = new ImageAnchorService();
  service.positionFilterX.filter(100, 1000);
  service.positionFilterY.filter(80, 1000);

  const filtered = service._filterPositionCandidate(
    {
      x: 108,
      y: 84,
      z: 0,
      confidence: 0.76,
      averageResidual: 2.4,
      inlierCount: 19,
    },
    1033.33,
    'object-pose-affine',
  );

  assert.equal(filtered.confidence, 0.76);
  assert.equal(filtered.averageResidual, 2.4);
  assert.equal(filtered.inlierCount, 19);
});

test('planar pose-owned positions blend toward raw measurements while fallback stays filtered', () => {
  const planarService = new ImageAnchorService();
  planarService.anchorTargetClass = 'bag';
  planarService.planarDominanceScore = 8;
  planarService.positionFilterX.filter(0, 1000);
  planarService.positionFilterY.filter(0, 1000);

  const planar = planarService._filterPositionCandidate({ x: 100, y: 0, z: 0 }, 1016.67, 'planar-homography');

  const fallbackService = new ImageAnchorService();
  fallbackService.anchorTargetClass = 'bag';
  fallbackService.planarDominanceScore = 8;
  fallbackService.positionFilterX.filter(0, 1000);
  fallbackService.positionFilterY.filter(0, 1000);
  const fallback = fallbackService._filterPositionCandidate(
    { x: 100, y: 0, z: 0 },
    1016.67,
    'reference_similarity_transform',
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

  const raw = rawService._filterPositionCandidate({ x: 100, y: 0, z: 0 }, 1016.67, 'planar-homography');

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
    'planar-homography',
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
    'reference_similarity_transform',
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
    'reference_similarity_transform',
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
    'reference_similarity_transform',
  );

  assert.ok(sparse.x < 211);
  assert.ok(sparse.y < 164);
  assert.equal(sparseService.metrics.positionFilterAdjustment, null);
});

test('fresh coherent curved motion reduces bootstrap lag without releasing divergent tracker measurements', () => {
  const createService = () => {
    const service = new ImageAnchorService();
    service.setTrackingMode('direct-photometric');
    service.anchorTargetClass = 'mug';
    service.currentPosition = { x: 200, y: 160, z: 0 };
    service.templateRegion = { width: 120, height: 120 };
    service.metrics.lastUpdateResult = 'success';
    service.metrics.activeLandmarkCount = 50;
    service.metrics.reconstructionReady = false;
    service.curvedMotionSample = {
      position: { x: 200, y: 160 },
      velocity: { x: 0.12, y: 0 },
      timestamp: 1000,
      confidence: 0.68,
    };
    service.positionFilterX.filter(200, 1000);
    service.positionFilterY.filter(160, 1000);
    return service;
  };

  const coherentService = createService();
  const coherent = coherentService._filterPositionCandidate(
    {
      x: 205,
      y: 160,
      z: 0,
      confidence: 0.42,
      averageResidual: 8.4,
      inlierCount: 16,
    },
    1033.33,
    'reference_similarity_transform',
  );

  assert.ok(coherent.x > 203);
  assert.ok(coherent.x < 205);
  assert.equal(coherentService.metrics.positionFilterAdjustment, 'coherent-curved-tracker-motion-blend');

  const divergentService = createService();
  const divergent = divergentService._filterPositionCandidate(
    {
      x: 214,
      y: 160,
      z: 0,
      confidence: 0.42,
      averageResidual: 8.4,
      inlierCount: 16,
    },
    1033.33,
    'reference_similarity_transform',
  );

  assert.ok(divergent.x < 214);
  assert.equal(divergentService.metrics.positionFilterAdjustment, null);

  const staleService = createService();
  const stale = staleService._filterPositionCandidate(
    {
      x: 205,
      y: 160,
      z: 0,
      confidence: 0.42,
      averageResidual: 8.4,
      inlierCount: 16,
    },
    1100,
    'reference_similarity_transform',
  );

  assert.ok(stale.x < 205);
  assert.equal(staleService.metrics.positionFilterAdjustment, null);
});

test('unready handled-mug modes reject a high-residual reference innovation against recent motion', () => {
  for (const trackingMode of [
    'sparse-reconstruction',
    'parametric-surface',
    'direct-photometric',
    'depth-fusion',
  ]) {
    const service = new ImageAnchorService();
    service.setTrackingMode(trackingMode);
    service.anchorTargetClass = 'handled mug';
    service.objectSupportMask = {
      width: 320,
      height: 240,
      bbox: { x: 60, y: 30, width: 200, height: 180 },
      confidence: 0.96,
    };
    service.currentPosition = { x: 347.5, y: 255.6, z: 0 };
    service.templateRegion = { width: 120, height: 120 };
    service.metrics.lastUpdateResult = 'success';
    service.metrics.reconstructionReady = false;
    service.metrics.reconstructionMatureLandmarks = trackingMode === 'depth-fusion' ? 551 : 0;
    service.positionFilterX.filter(347.5, 1166.67);
    service.positionFilterY.filter(255.6, 1166.67);
    service.curvedMotionSample = {
      position: { x: 344.8, y: 259.7 },
      velocity: { x: 0.038, y: 0 },
      timestamp: 1100,
      confidence: 0.64,
    };

    const held = service._filterPositionCandidate(
      {
        x: 334.2,
        y: 259,
        z: 0,
        confidence: 0,
        averageResidual: 47,
        inlierCount: 26,
      },
      1233.33,
      'reference_similarity_transform',
    );

    assert.equal(service.metrics.positionFilterAdjustment, 'unready-mug-motion-prediction');
    assert.ok(held.x > 349, trackingMode);
    assert.ok(held.x < 351, trackingMode);
  }
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
    'reference_similarity_transform',
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
    'reference_similarity_transform',
  );

  assert.equal(sparseService.metrics.positionFilterAdjustment, null);
});

test('selected curved surface modes blend coherent weak reference motion into prediction', () => {
  let now = 1000;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'can';
  service.currentPosition = { x: 194, y: 154, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.74;
  service.metrics.reconstructionMatureLandmarks = 22;
  service.metrics.activeLandmarkCount = 16;
  service.positionFilterX.filter(194, now);
  service.positionFilterY.filter(154, now);

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

  const blended = service._filterPositionCandidate(
    {
      x: 170,
      y: 154,
      z: 0,
      confidence: 0.32,
      averageResidual: 10.2,
      inlierCount: 8,
    },
    1066.66,
    'reference_similarity_transform',
  );

  assert.equal(service.metrics.positionFilterAdjustment, 'curved-reference-prediction-blend');
  assert.ok(blended.x < 190);
  assert.ok(blended.x > 181);
  assert.ok(Math.abs(blended.y - 154) < 1);
});

test('selected curved modes hold severe zero-confidence reference drift to recent motion', () => {
  let now = 1000;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'cup';
  service.currentPosition = { x: 288, y: 224, z: 0 };
  service.templateRegion = { width: 118, height: 118 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.81;
  service.metrics.reconstructionMatureLandmarks = 28;
  service.metrics.activeLandmarkCount = 25;
  service.metrics.reconstructionTrackerDelta = 34;
  service.positionFilterX.filter(288, now);
  service.positionFilterY.filter(224, now);

  now = 1033.33;
  service.curvedMotionSample = {
    position: { x: 288, y: 224 },
    velocity: { x: -0.27, y: -0.06 },
    timestamp: now,
    confidence: 0.57,
  };

  const held = service._filterPositionCandidate(
    {
      x: 297,
      y: 221,
      z: 0,
      confidence: 0,
      averageResidual: 36,
      inlierCount: 25,
    },
    1066.66,
    'reference_similarity_transform',
  );

  assert.equal(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
  assert.ok(held.x < 283);
  assert.ok(held.x > 276);
  assert.ok(held.y < 224);
});

test('selected curved modes hold severe reference drift even when stored tracker delta is stale', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'can';
  service.currentPosition = { x: 316, y: 232, z: 0 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 27;
  service.metrics.reconstructionPoseInliers = 0;
  service.metrics.activeLandmarkCount = 25;
  service.metrics.reconstructionTrackerDelta = 2.1;
  service.metrics.reconstructionPreview = {
    surface: { model: 'cylinder' },
  };
  service.positionFilterX.filter(316, 1000);
  service.positionFilterY.filter(232, 1000);
  service.curvedMotionSample = {
    position: { x: 316, y: 232 },
    velocity: { x: 0.06, y: 0.03 },
    timestamp: 1000,
    confidence: 0.7,
  };

  const held = service._filterPositionCandidate(
    {
      x: 341,
      y: 233,
      z: 0,
      confidence: 0,
      averageResidual: 24.2,
      inlierCount: 15,
    },
    1033.33,
    'reference_similarity_transform',
  );

  assert.equal(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
  assert.ok(held.x < 323);
  assert.ok(held.y < 236);
});

test('selected curved modes refresh motion samples from coherent reference transforms', () => {
  let now = 1000;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'cup';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };

  service._recordCurvedMotionSample({
    success: true,
    method: 'direct-photometric',
    position: { x: 310, y: 230, z: 0 },
    confidence: 0.82,
  });
  now = 1033.33;
  service._recordCurvedMotionSample({
    success: true,
    method: 'reference_similarity_transform',
    position: { x: 301, y: 227, z: 0 },
    confidence: 0.58,
    averageResidual: 5.6,
    inlierCount: 13,
  });

  assert.deepEqual(service.curvedMotionSample.position, { x: 301, y: 227 });
  assert.ok(service.curvedMotionSample.velocity.x < -0.14);
  assert.ok(service.curvedMotionSample.velocity.y < -0.04);
});

test('high-residual direct poses cannot reverse a coherent curved motion sample', () => {
  const now = 1033.33;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'mug';
  service.curvedMotionSample = {
    position: { x: 354, y: 258 },
    velocity: { x: 0.14, y: -0.01 },
    timestamp: 1000,
    confidence: 0.7,
  };

  service._recordCurvedMotionSample({
    success: true,
    method: 'direct-photometric',
    position: { x: 350, y: 257, z: 0 },
    positionConfidence: 0.76,
    positionAverageResidual: 8.9,
    positionInlierCount: 17,
  });

  assert.deepEqual(service.curvedMotionSample, {
    position: { x: 354, y: 258 },
    velocity: { x: 0.14, y: -0.01 },
    timestamp: 1000,
    confidence: 0.7,
  });
});

test('fresh direct handled-mug motion bridges a weak-geometry position reversal', () => {
  const createService = ({ trackerWeak }) => {
    const service = new ImageAnchorService();
    service.setTrackingMode('direct-photometric');
    service.anchorTargetClass = 'handled mug';
    service.currentPosition = { x: 353.6, y: 258, z: 0 };
    service.templateRegion = { width: 120, height: 120 };
    service.metrics.reconstructionReady = true;
    service.metrics.reconstructionMatureLandmarks = 19;
    service.metrics.reconstructionPoseInliers = 13;
    service.metrics.activeLandmarkCount = 24;
    service.metrics.poseCandidates = [
      {
        role: 'reconstruction',
        source: 'direct-photometric',
        inliers: 13,
        residual: 6.3,
      },
      {
        role: 'tracker',
        source: 'reference_similarity_transform',
        rejected: trackerWeak ? 'weak-geometry' : null,
        positionQualityRejected: trackerWeak ? 'weak-geometry' : null,
      },
    ];
    service.curvedMotionSample = {
      position: { x: 353.6, y: 258 },
      velocity: { x: 0.14, y: -0.01 },
      timestamp: 1000,
      confidence: 0.7,
    };
    service.positionFilterX.filter(353.6, 1000);
    service.positionFilterY.filter(258, 1000);
    return service;
  };

  const weakTrackerService = createService({ trackerWeak: true });
  const bridged = weakTrackerService._filterPositionCandidate(
    {
      x: 339.5,
      y: 257.1,
      z: 0,
      confidence: 0.83,
      averageResidual: 6.3,
      inlierCount: 13,
    },
    1033.33,
    'direct-photometric',
  );

  assert.equal(weakTrackerService.metrics.positionFilterAdjustment, 'weak-mug-motion-bridge');
  assert.ok(bridged.x > weakTrackerService.currentPosition.x);
  assert.ok(bridged.y < weakTrackerService.currentPosition.y);

  const strongTrackerService = createService({ trackerWeak: false });
  strongTrackerService._filterPositionCandidate(
    {
      x: 339.5,
      y: 257.1,
      z: 0,
      confidence: 0.83,
      averageResidual: 6.3,
      inlierCount: 13,
    },
    1033.33,
    'direct-photometric',
  );

  assert.notEqual(strongTrackerService.metrics.positionFilterAdjustment, 'weak-mug-motion-bridge');

  const parametricService = createService({ trackerWeak: true });
  parametricService.setTrackingMode('parametric-surface');
  parametricService._filterPositionCandidate(
    {
      x: 339.5,
      y: 257.1,
      z: 0,
      confidence: 0.73,
      averageResidual: 9.9,
      inlierCount: 19,
    },
    1033.33,
    'parametric-surface',
  );

  assert.notEqual(parametricService.metrics.positionFilterAdjustment, 'weak-mug-motion-bridge');

  const immatureDirectService = createService({ trackerWeak: true });
  immatureDirectService.metrics.reconstructionMatureLandmarks = 16;
  immatureDirectService._filterPositionCandidate(
    {
      x: 339.5,
      y: 257.1,
      z: 0,
      confidence: 0.76,
      averageResidual: 8.9,
      inlierCount: 17,
    },
    1033.33,
    'direct-photometric',
  );

  assert.notEqual(immatureDirectService.metrics.positionFilterAdjustment, 'weak-mug-motion-bridge');
});

test('direct curved relocalization preserves a fresh coherent attachment motion prior', () => {
  const service = new ImageAnchorService({ now: () => 1133.32 });
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'mug';
  service.currentPosition = { x: 353.6, y: 253.2, z: 0 };
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionPoseInliers = 0;
  service.metrics.poseCandidates = [
    {
      role: 'tracker',
      confidence: 0,
      residual: 32,
    },
  ];
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.curvedMotionSample = {
    position: { x: 353.9, y: 258.6 },
    velocity: { x: 0.15, y: -0.02 },
    timestamp: 1000,
    confidence: 0.7,
  };

  const aligned = service._alignRelocalizationAnchorWithCurvedMotion({
    success: true,
    method: 'orb-keyframe-relocalization',
    anchorPoint: { x: 352, y: 252 },
  });

  assert.ok(aligned.anchorPoint.x >= 369);
  assert.ok(aligned.anchorPoint.y < 256);
  assert.equal(service.metrics.relocalizationAnchorAdjustment, 'curved-motion-prior');
});

test('curved reconstruction bootstrap records reliable planar and object position owners', () => {
  let now = 1000;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'handled mug';

  service._recordCurvedMotionSample({
    success: true,
    method: 'planar-homography',
    position: { x: 300, y: 220, z: 0 },
    positionConfidence: 0.88,
    positionAverageResidual: 1.2,
    positionInlierCount: 24,
  });
  now = 1033.33;
  service._recordCurvedMotionSample({
    success: true,
    method: 'object-pose-affine',
    position: { x: 306, y: 222, z: 0 },
    positionConfidence: 0.74,
    positionAverageResidual: 3.1,
    positionInlierCount: 18,
  });

  assert.deepEqual(service.curvedMotionSample.position, { x: 306, y: 222 });
  assert.ok(service.curvedMotionSample.velocity.x > 0.09);
  assert.ok(service.curvedMotionSample.velocity.y > 0.03);

  const depthMugService = new ImageAnchorService();
  depthMugService.setTrackingMode('depth-fusion');
  depthMugService.anchorTargetClass = 'handled mug';
  depthMugService._recordCurvedMotionSample({
    success: true,
    method: 'planar-homography',
    position: { x: 300, y: 220, z: 0 },
    positionConfidence: 0.88,
    positionAverageResidual: 1.2,
    positionInlierCount: 24,
  });

  assert.deepEqual(depthMugService.curvedMotionSample.position, { x: 300, y: 220 });

  const sparseMugService = new ImageAnchorService();
  sparseMugService.setTrackingMode('sparse-reconstruction');
  sparseMugService.anchorTargetClass = 'handled mug';
  sparseMugService.objectSupportMask = {
    width: 320,
    height: 240,
    bbox: { x: 60, y: 30, width: 200, height: 180 },
    confidence: 0.96,
  };
  sparseMugService._recordCurvedMotionSample({
    success: true,
    method: 'planar-homography',
    position: { x: 300, y: 220, z: 0 },
    positionConfidence: 0.88,
    positionAverageResidual: 1.2,
    positionInlierCount: 24,
  });

  assert.deepEqual(sparseMugService.curvedMotionSample.position, { x: 300, y: 220 });

  const depthCanService = new ImageAnchorService();
  depthCanService.setTrackingMode('depth-fusion');
  depthCanService.anchorTargetClass = 'can';
  depthCanService._recordCurvedMotionSample({
    success: true,
    method: 'planar-homography',
    position: { x: 300, y: 220, z: 0 },
    positionConfidence: 0.88,
    positionAverageResidual: 1.2,
    positionInlierCount: 24,
  });

  assert.equal(depthCanService.curvedMotionSample, null);
});

test('selected parametric poses do not reverse mature curved motion samples when map support is weak', () => {
  let now = 1000;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'cup';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.65;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.curvedMotionSample = {
    position: { x: 288, y: 225 },
    velocity: { x: -0.21, y: -0.07 },
    timestamp: now,
    confidence: 0.95,
  };

  now = 1033.33;
  service._recordCurvedMotionSample({
    success: true,
    method: 'parametric-surface',
    position: { x: 298, y: 224, z: 0 },
    confidence: 0.78,
    inliers: 17,
  });

  assert.deepEqual(service.curvedMotionSample.position, { x: 288, y: 225 });
  assert.deepEqual(service.curvedMotionSample.velocity, { x: -0.21, y: -0.07 });
});

test('a marginal just-ready parametric pose cannot overwrite fresh bootstrap motion', () => {
  const now = 1033.33;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'handled mug';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.78;
  service.metrics.reconstructionMatureLandmarks = 16;
  service.metrics.reconstructionPoseInliers = 17;
  service.metrics.reconstructionTrackerDelta = 10;
  service.metrics.activeLandmarkCount = 30;
  service.curvedMotionSample = {
    position: { x: 354, y: 258 },
    velocity: { x: 0.14, y: -0.01 },
    timestamp: 1000,
    confidence: 0.7,
  };

  service._recordCurvedMotionSample({
    success: true,
    method: 'parametric-surface',
    position: { x: 350, y: 257, z: 0 },
    positionConfidence: 0.76,
    positionAverageResidual: 8.9,
    positionInlierCount: 17,
    inliers: 17,
  });

  assert.deepEqual(service.curvedMotionSample, {
    position: { x: 354, y: 258 },
    velocity: { x: 0.14, y: -0.01 },
    timestamp: 1000,
    confidence: 0.7,
  });
});

test('handled-mug reversal thresholds do not suppress a cup pose with mature map support', () => {
  let now = 1033.33;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'cup';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.78;
  service.metrics.reconstructionMatureLandmarks = 16;
  service.metrics.reconstructionPoseInliers = 17;
  service.metrics.reconstructionTrackerDelta = 10;
  service.metrics.activeLandmarkCount = 30;
  service.curvedMotionSample = {
    position: { x: 354, y: 258 },
    velocity: { x: 0.14, y: -0.01 },
    timestamp: 1000,
    confidence: 0.7,
  };

  now = 1066.66;
  service._recordCurvedMotionSample({
    success: true,
    method: 'parametric-surface',
    position: { x: 350, y: 257, z: 0 },
    positionConfidence: 0.76,
    positionAverageResidual: 8.9,
    positionInlierCount: 17,
    inliers: 17,
  });

  assert.deepEqual(service.curvedMotionSample.position, { x: 350, y: 257 });
});

test('selected parametric position filter does not hold reversed poses to stale motion', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'cup';
  service.currentPosition = { x: 288, y: 225, z: 0 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.65;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.curvedMotionSample = {
    position: { x: 288, y: 225 },
    velocity: { x: -0.21, y: -0.07 },
    timestamp: 1000,
    confidence: 0.95,
  };

  const filtered = service._filterPositionCandidate({ x: 331, y: 218, z: 0 }, 1033.33, 'parametric-surface');

  assert.notEqual(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
  assert.ok(filtered.x > 288);
});

test('selected parametric position filter releases reversed motion when surface and tracker agree', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'cup';
  service.currentPosition = { x: 276, y: 217, z: 0 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.68;
  service.metrics.reconstructionMatureLandmarks = 31;
  service.metrics.reconstructionPoseInliers = 16;
  service.metrics.reconstructionTrackerDelta = 0.83;
  service.metrics.activeLandmarkCount = 20;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.positionFilterX.filter(276, 1000);
  service.positionFilterY.filter(217, 1000);
  service.curvedMotionSample = {
    position: { x: 276, y: 217 },
    velocity: { x: -0.06, y: -0.04 },
    timestamp: 1000,
    confidence: 0.95,
  };

  const filtered = service._filterPositionCandidate({ x: 298, y: 228, z: 0 }, 1033.33, 'parametric-surface');

  assert.notEqual(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
  assert.ok(filtered.x > 280);
  assert.ok(filtered.y > 219);
});

test('selected curved motion prediction releases weak references when surface and tracker agree', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'cup';
  service.currentPosition = { x: 276, y: 217, z: 0 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.68;
  service.metrics.reconstructionMatureLandmarks = 31;
  service.metrics.reconstructionPoseInliers = 16;
  service.metrics.reconstructionTrackerDelta = 0.83;
  service.metrics.activeLandmarkCount = 20;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.positionFilterX.filter(276, 1000);
  service.positionFilterY.filter(217, 1000);
  service.curvedMotionSample = {
    position: { x: 276, y: 217 },
    velocity: { x: -0.06, y: -0.04 },
    timestamp: 1000,
    confidence: 0.95,
  };

  const filtered = service._filterPositionCandidate(
    {
      x: 298,
      y: 228,
      z: 0,
      confidence: 0,
      averageResidual: 24,
      inlierCount: 10,
    },
    1033.33,
    'reference_similarity_transform',
  );

  assert.notEqual(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
  assert.ok(filtered.x > 280);
  assert.ok(filtered.y > 219);
});

test('selected bottle targets do not use cup-style curved motion hold', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'bottle';
  service.currentPosition = { x: 320, y: 220, z: 0 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.activeLandmarkCount = 12;
  service.metrics.reconstructionTrackerDelta = 28;
  service.metrics.reconstructionPreview = {
    surface: { model: 'cylinder' },
  };
  service.curvedMotionSample = {
    position: { x: 320, y: 220 },
    velocity: { x: -0.22, y: -0.08 },
    timestamp: 1000,
    confidence: 0.58,
  };

  const filtered = service._filterPositionCandidate(
    {
      x: 338,
      y: 231,
      z: 0,
      confidence: 0,
      averageResidual: 28,
      inlierCount: 9,
    },
    1033.33,
    'reference_similarity_transform',
  );

  assert.notEqual(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
  assert.ok(filtered.x > 320);
});

test('depth-fusion bridges high-support tapered drift without holding low-support recovery', () => {
  const createService = (targetClass, activeLandmarkCount = 16) => {
    const service = new ImageAnchorService();
    service.setTrackingMode('depth-fusion');
    service.anchorTargetClass = targetClass;
    service.currentPosition = { x: 320, y: 220, z: 0 };
    service.metrics.lastUpdateResult = 'success';
    service.metrics.reconstructionReady = true;
    service.metrics.reconstructionMapConfidence = 0.82;
    service.metrics.reconstructionMatureLandmarks = 24;
    service.metrics.activeLandmarkCount = activeLandmarkCount;
    service.metrics.reconstructionTrackerDelta = 24;
    service.metrics.reconstructionPreview = {
      surface: { model: targetClass === 'cup' ? 'tapered-cylinder' : 'cylinder' },
    };
    service.curvedMotionSample = {
      position: { x: 320, y: 220 },
      velocity: { x: -0.2, y: -0.05 },
      timestamp: 1000,
      confidence: 0.58,
    };
    return service;
  };
  const candidate = {
    x: 348,
    y: 235,
    z: 0,
    confidence: 0,
    averageResidual: 24,
    inlierCount: 9,
  };
  const lowSupportCup = createService('cup');
  lowSupportCup._filterPositionCandidate(candidate, 1033.33, 'reference_similarity_transform');
  assert.notEqual(lowSupportCup.metrics.positionFilterAdjustment, 'curved-motion-hold');

  const driftingCup = createService('cup', 36);
  driftingCup._filterPositionCandidate(candidate, 1033.33, 'reference_similarity_transform');
  assert.equal(driftingCup.metrics.positionFilterAdjustment, 'curved-motion-hold');

  const coherentCup = createService('cup', 36);
  coherentCup._filterPositionCandidate(
    {
      ...candidate,
      confidence: 0.7,
      averageResidual: 2,
      inlierCount: 12,
    },
    1033.33,
    'reference_similarity_transform',
  );
  assert.notEqual(coherentCup.metrics.positionFilterAdjustment, 'curved-motion-hold');

  const can = createService('can');
  can._filterPositionCandidate(candidate, 1033.33, 'reference_similarity_transform');
  assert.equal(can.metrics.positionFilterAdjustment, 'curved-motion-hold');
});

test('mature sparse cylinder maps use bounded motion hold during full pose dropout', () => {
  let now = 1000;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'can';
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
    'reference_similarity_transform',
  );

  assert.equal(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
  assert.ok(held.x < 196);
  assert.ok(held.y < 154);
});

test('support recovery treats agreeing mask and tracker evidence as an absolute reinitialization anchor', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'generic-object';
  service.currentPosition = { x: 100, y: 100, z: 0 };
  service.objectSupportAnchorUv = { u: 0.5, v: 0.5 };
  service.objectSupportMask = {
    bbox: { x: 78, y: 60, width: 84, height: 120 },
    confidence: 0.96,
    pixelCount: 8_000,
    source: 'interactive-segmenter',
  };
  service.frameIndex = 8;
  service.lastKeypointReinitializationFrame = -20;
  service.metrics.landmarkRefreshReason = 'support-recovery';
  service.metrics.segmentationRefreshReason = 'pose-dropout-recovery';
  service.metrics.segmentationRefreshFrame = 7;
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 30;
  service.metrics.activeLandmarkCount = 11;
  service.metrics.objectOwnedLandmarks = 11;
  service.metrics.poseInliers = 0;
  service.metrics.trackingSuccessRate = 1;
  const trackerPosition = {
    x: 121,
    y: 119,
    method: 'reference_similarity_transform',
    inlierCount: 11,
  };

  assert.deepEqual(service._createSupportRecoveryPosition(trackerPosition), {
    ...trackerPosition,
    z: 0,
    absolute: true,
  });
  assert.equal(service.metrics.recoveryReferencePositionSource, 'support-tracker-consensus');

  service.currentPosition = { x: 110, y: 110, z: 0 };
  assert.equal(service._createSupportRecoveryPosition(trackerPosition), null);
  service.currentPosition = { x: 100, y: 100, z: 0 };
  service.objectSupportMask.bbox.x = 94;
  assert.equal(service._createSupportRecoveryPosition(trackerPosition), null);
  service.objectSupportMask.bbox.x = 130;
  assert.equal(service._createSupportRecoveryPosition(trackerPosition), null);
  service.objectSupportMask.bbox.x = 78;
  service.objectSupportMask.confidence = 0.7;
  assert.equal(service._createSupportRecoveryPosition(trackerPosition), null);
  service.objectSupportMask.confidence = 0.96;
  service.anchorTargetClass = 'label bottle';
  assert.equal(service._createSupportRecoveryPosition(trackerPosition), null);
});

test('sparse mug motion hold expires before stale reversal dominates recovery', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'mug';
  service.currentPosition = { x: 300, y: 220, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.91;
  service.metrics.reconstructionMatureLandmarks = 36;
  service.metrics.activeLandmarkCount = 18;
  service.metrics.objectOwnedLandmarks = 18;
  service.metrics.poseInliers = 0;
  service.metrics.reconstructionPoseInliers = 0;
  service.positionFilterX.filter(300, 1000);
  service.positionFilterY.filter(220, 1000);
  service.curvedMotionSample = {
    position: { x: 320, y: 236 },
    velocity: { x: -0.2, y: -0.12 },
    timestamp: 1000,
    confidence: 0.86,
  };

  service._filterPositionCandidate(
    {
      x: 312,
      y: 226,
      z: 0,
      confidence: 0.12,
      averageResidual: 9,
      inlierCount: 6,
    },
    1166.67,
    'reference_similarity_transform',
  );

  assert.notEqual(service.metrics.positionFilterAdjustment, 'curved-motion-hold');
});

test('curved motion hold predictions do not extend the motion sample', () => {
  const now = 1033.33;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'mug';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.91;
  service.metrics.reconstructionMatureLandmarks = 36;
  service.metrics.positionFilterAdjustment = 'curved-motion-hold';
  service.curvedMotionSample = {
    position: { x: 196, y: 154 },
    velocity: { x: -0.12, y: -0.18 },
    timestamp: 1000,
    confidence: 0.86,
  };

  service._recordCurvedMotionSample({
    success: true,
    method: 'sparse-reconstruction',
    position: { x: 192, y: 148, z: 0 },
    confidence: 0.86,
  });

  assert.deepEqual(service.curvedMotionSample, {
    position: { x: 196, y: 154 },
    velocity: { x: -0.12, y: -0.18 },
    timestamp: 1000,
    confidence: 0.86,
  });
});

test('mature sparse mug maps release motion hold when many landmarks still track', () => {
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
  service.metrics.activeLandmarkCount = 34;
  service.metrics.objectOwnedLandmarks = 34;
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

  const filtered = service._filterPositionCandidate(
    {
      x: 208,
      y: 168,
      z: 0,
      confidence: 0.82,
      averageResidual: 3.2,
    },
    1066.66,
    'reference_similarity_transform',
  );

  assert.equal(service.metrics.positionFilterAdjustment, null);
  assert.ok(filtered.x > 196);
  assert.ok(filtered.y > 154);
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

  const limited = service._limitStep({ x: 240, y: 166, z: 0 }, 'sparse-reconstruction');

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

  const limited = service._limitStep({ x: 240, y: 160, z: 0 }, 'planar-homography');

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

  const limited = service._limitStep({ x: 240, y: 160, z: 0 }, 'planar-homography');

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

  const limited = service._limitStep({ x: 240, y: 160, z: 0 }, 'planar-homography');

  assert.ok(limited.x > 209);
  assert.ok(limited.x < 210);
  assert.equal(limited.y, 160);
});

test('generic reconstruction targets can catch up without segmentation recentering', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'generic-object';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';

  const limited = service._limitStep({ x: 240, y: 160, z: 0 }, 'direct-photometric');

  assert.equal(limited.x, 210);
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

  const limited = service._limitStep({ x: 240, y: 160, z: 0 }, 'parametric-surface');

  assert.ok(limited.x > 211);
  assert.ok(limited.x < 213);
  assert.equal(limited.y, 160);

  service.currentPosition = { x: 200, y: 160, z: 0 };
  const filtered = service._filterPositionCandidate({ x: 240, y: 160, z: 0 }, 1000, 'parametric-surface');

  assert.ok(filtered.x > 211);
  assert.ok(filtered.x < 213);
  assert.equal(service.metrics.positionFilterAdjustment, 'curved-recovery-step-position');
});

test('mature direct photometric recovery keeps the standard curved position bound', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'mug';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.69;
  service.metrics.reconstructionMatureLandmarks = 18;
  service.metrics.reconstructionTrackerDelta = 14;
  service.metrics.poseInliers = 20;

  const limited = service._limitStep({ x: 240, y: 160, z: 0 }, 'direct-photometric');

  assert.ok(limited.x >= 209.5);
  assert.ok(limited.x <= 209.7);
  assert.equal(limited.y, 160);
});

test('selected curved pose dropout holds weak reference scale', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'cup';
  service.currentPlanarTransform = {
    scale: 1.02,
    rotation: 0,
    confidence: 0.7,
    inlierCount: 18,
    method: 'direct-photometric',
  };
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.reconstructionPoseInliers = 0;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.curvedScaleFilter.filter(1.02, 1000);

  const transform = service._updatePlanarTransform(
    {
      scale: 0.72,
      rotation: -0.08,
      confidence: 0.12,
      inlierCount: 9,
      averageResidual: 18,
      method: 'reference_similarity_transform',
    },
    1033.33,
  );

  assert.ok(transform.scale >= 1.019);
  assert.equal(transform.method, 'reference_similarity_transform');
});

test('selected curved pose dropout follows coherent low-confidence reference scale', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'cup';
  service.currentPlanarTransform = {
    scale: 1.15,
    rotation: 0,
    confidence: 0.7,
    inlierCount: 18,
    method: 'direct-photometric',
  };
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.reconstructionPoseInliers = 0;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.curvedScaleFilter.filter(1.15, 1000);

  const transform = service._updatePlanarTransform(
    {
      scale: 0.9,
      rotation: -0.08,
      confidence: 0.08,
      inlierCount: 12,
      method: 'reference_similarity_transform',
    },
    1033.33,
  );

  assert.ok(transform.scale < 1.15);
  assert.equal(transform.method, 'reference_similarity_transform');
});

test('parametric curved pose dropout keeps low-confidence reference scale held', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'cup';
  service.currentPlanarTransform = {
    scale: 1.15,
    rotation: 0,
    confidence: 0.7,
    inlierCount: 18,
    method: 'parametric-surface',
  };
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.reconstructionPoseInliers = 0;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.curvedScaleFilter.filter(1.15, 1000);

  const transform = service._updatePlanarTransform(
    {
      scale: 0.9,
      rotation: -0.08,
      confidence: 0.08,
      inlierCount: 12,
      method: 'reference_similarity_transform',
    },
    1033.33,
  );

  assert.ok(transform.scale >= 1.149);
  assert.equal(transform.method, 'reference_similarity_transform');
});

test('selected curved modes can catch up from a held pose with strong reference tracking', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'can';
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.lastUpdateMethod = 'held-last-pose';
  service.metrics.reconstructionPreview = {
    surface: { model: 'cylinder' },
  };

  const limited = service._limitStep(
    {
      x: 240,
      y: 160,
      z: 0,
      confidence: 0.76,
      averageResidual: 2.8,
    },
    'reference_similarity_transform',
  );

  assert.ok(limited.x > 217);
  assert.ok(limited.x <= 220);
  assert.equal(limited.y, 160);
});

test('small position updates are not step-limited', () => {
  const service = new ImageAnchorService();
  service.currentPosition = { x: 200, y: 160, z: 0 };
  service.templateRegion = { width: 120, height: 120 };

  const limited = service._limitStep({ x: 207, y: 164, z: 0 }, 'sparse-reconstruction');

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
  service._recordAnchorUpdateResult(
    {
      success: true,
      method: 'sparse-reconstruction',
      position: { x: 10, y: 20, z: 0 },
    },
    8.5,
    timings,
  );

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
  let previousReconstructorDisposals = 0;
  service.reconstructor.dispose = () => {
    previousReconstructorDisposals++;
  };
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {},
  };
  service.keypointDetector = {
    extractKeypointsWithAdaptiveFallback: () => ({
      keypoints: Array.from({ length: 18 }, (_, index) => ({ x: 102 + index, y: 112 + index })),
      descriptors: {},
      method: 'fake-orb',
    }),
    assessTemplateQuality: () => ({ overall: 0.17 }),
  };
  Object.assign(service.keypointTracker, {
    initializeTracking: () => {},
  });
  service.persistenceSystem = {
    storeTemplate: () => {},
  };

  const result = await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 70, y1: 80, x2: 150, y2: 160 },
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
  assert.equal(previousReconstructorDisposals, 1);
});

test('anchor creation passes selected object support mask into keypoint extraction', async () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  class FakeMat {
    delete() {}
  }
  const receivedMasks = [];
  let orbKeyframeStores = 0;
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
    cvtColor: () => {},
  };
  service.keypointDetector = {
    extractKeypointsWithAdaptiveFallback: (cv, image, region, mask) => {
      receivedMasks.push(mask);
      return {
        keypoints: Array.from({ length: 24 }, (_, index) => ({ pt: { x: 20 + index, y: 30 + index } })),
        descriptors: {},
        method: 'fake-gftt',
        maskSource: mask?.source || null,
      };
    },
    assessTemplateQuality: () => ({ overall: 0.42 }),
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    initializeTracking: (cv, trackedPoints) => {
      service.keypointTracker.trackedPoints = trackedPoints;
    },
  });
  service.relocalizer.storeKeyframe = () => {
    orbKeyframeStores++;
    return {
      success: true,
      keyframeCount: 1,
      descriptorCount: 24,
    };
  };
  service.persistenceSystem = {
    storeTemplate: () => {},
  };

  await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    {
      x1: 70,
      y1: 80,
      x2: 150,
      y2: 160,
      objectSupportMask,
      surfaceHint: 'handled mug',
    },
  );

  const state = service.getState();
  assert.equal(receivedMasks.length, 2);
  assert.ok(receivedMasks.every((mask) => mask === objectSupportMask));
  assert.equal(state.metrics.objectSupportMaskSource, 'interactive-segmenter');
  assert.deepEqual(state.metrics.objectSupportMaskBounds, objectSupportMask.bbox);
  assert.ok(state.metrics.reconstructionRegion.width > state.metrics.templateRegion.width);
  assert.deepEqual(state.metrics.reconstructionRegion, state.metrics.trackingRegion);
  assert.equal(service.expandedObjectSupportRegion, true);
  assert.equal(state.metrics.objectSupportMaskPreview.source, 'interactive-segmenter');
  assert.deepEqual(state.metrics.objectSupportMaskPreview.bbox, objectSupportMask.bbox);
  assert.ok(state.metrics.objectSupportMaskPreview.points.length > 0);
  assert.deepEqual(state.metrics.currentObjectSupportMaskPreview, state.metrics.objectSupportMaskPreview);
  assert.equal(service.learnedReferencePromise, null);
  assert.equal(orbKeyframeStores, 1);
});

test('current object support projection is reused only for the same frame transform', () => {
  const service = new ImageAnchorService();
  const width = 48;
  const height = 36;
  const data = new Uint8Array(width * height);
  for (let y = 10; y <= 25; y++) {
    for (let x = 14; x <= 33; x++) {
      data[y * width + x] = 255;
    }
  }

  service.objectSupportMask = createObjectSupportMask({
    width,
    height,
    data,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 24, y: 18 },
    createdAtFrame: 1,
    updatedAtFrame: 1,
  });
  service.currentPosition = { x: 26, y: 17, z: 0 };
  service.currentPlanarTransform = { scale: 1.08, rotation: 0.2 };
  service.frameIndex = 12;

  const first = service._getCurrentObjectSupportMask();
  const repeated = service._getCurrentObjectSupportMask();
  assert.strictEqual(repeated, first);

  service.currentPosition = { x: 27, y: 17, z: 0 };
  const moved = service._getCurrentObjectSupportMask();
  assert.notStrictEqual(moved, first);

  service.currentPlanarTransform = { scale: 1.09, rotation: 0.2 };
  const rescaled = service._getCurrentObjectSupportMask();
  assert.notStrictEqual(rescaled, moved);

  service.objectSupportMask = createObjectSupportMask({
    ...service.objectSupportMask,
    updatedAtFrame: service.frameIndex,
  });
  const refreshed = service._getCurrentObjectSupportMask();
  assert.notStrictEqual(refreshed, rescaled);

  service.frameIndex++;
  const nextFrame = service._getCurrentObjectSupportMask();
  assert.notStrictEqual(nextFrame, refreshed);
});

test('anchor creation preserves detector-owned object-mask evidence', async () => {
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
  const objectKeypoints = Array.from({ length: 18 }, (_, index) => ({
    pt: {
      x: 82 + (index % 6) * 12,
      y: 96 + Math.floor(index / 6) * 18,
    },
    response: 1,
  }));
  let initializedKeypoints = [];

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {},
  };
  service.keypointDetector = {
    extractKeypointsWithAdaptiveFallback: () => ({
      keypoints: objectKeypoints,
      descriptors: {},
      method: 'fake-gftt',
      count: objectKeypoints.length,
      rejectedByMask: 30,
    }),
    assessTemplateQuality: (keypoints) => ({ overall: 0.42, keypointCount: keypoints.length }),
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    initializeTracking: (cv, keypoints) => {
      initializedKeypoints = keypoints;
    },
  });
  service.persistenceSystem = {
    storeTemplate: () => {},
  };

  const result = await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 60, y1: 76, x2: 170, y2: 156, objectSupportMask },
  );

  assert.equal(result.success, true);
  assert.ok(initializedKeypoints.length >= 12);
  assert.ok(initializedKeypoints.every((keypoint) => keypoint.pt.x <= 152));
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
  fillRect({ x1: 106, y1: 28, x2: 134, y2: 58 }); // head
  fillRect({ x1: 98, y1: 62, x2: 142, y2: 156 }); // torso
  fillRect({ x1: 64, y1: 76, x2: 86, y2: 144 }); // left arm
  fillRect({ x1: 154, y1: 76, x2: 176, y2: 144 }); // right arm
  fillRect({ x1: 94, y1: 158, x2: 112, y2: 228 }); // left leg
  fillRect({ x1: 128, y1: 158, x2: 146, y2: 228 }); // right leg
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
  const detectorCandidates = [
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
  ];
  const objectKeypoints = detectorCandidates.filter((keypoint) =>
    isPointInsideObjectSupport(objectSupportMask, keypoint.pt),
  );
  let initializedKeypoints = [];

  service.initialized = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {},
  };
  service.keypointDetector = {
    extractKeypointsWithAdaptiveFallback: () => ({
      keypoints: objectKeypoints,
      descriptors: {},
      method: 'fake-gftt',
      count: objectKeypoints.length,
      rejectedByMask: detectorCandidates.length - objectKeypoints.length,
    }),
    assessTemplateQuality: (keypoints) => ({ overall: 0.4, keypointCount: keypoints.length }),
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    initializeTracking: (cv, keypoints) => {
      initializedKeypoints = keypoints;
    },
  });
  service.persistenceSystem = {
    storeTemplate: () => {},
  };

  const result = await service.createAnchor(
    { width: 240, height: 260 },
    { x: 120, y: 96 },
    { x1: 58, y1: 24, x2: 184, y2: 232, surfaceHint: 'person', objectSupportMask },
  );

  assert.equal(result.success, true);
  assert.ok(initializedKeypoints.length >= 12);
  assert.equal(
    initializedKeypoints.some((keypoint) => keypoint.pt.x > 88 && keypoint.pt.x < 96 && keypoint.pt.y > 160),
    false,
  );
  assert.equal(
    initializedKeypoints.some(
      (keypoint) => keypoint.pt.x > 114 && keypoint.pt.x < 124 && keypoint.pt.y > 160,
    ),
    false,
  );
  assert.equal(
    initializedKeypoints.every((keypoint) => isPointInsideObjectSupport(objectSupportMask, keypoint.pt)),
    true,
  );
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
    cvtColor: () => {},
  };
  service.keypointDetector = {
    extractKeypointsWithAdaptiveFallback: () => ({
      keypoints: Array.from({ length: 5 }, (_, index) => ({
        pt: { x: 84 + index * 10, y: 96 + index * 8 },
        response: 1,
      })),
      descriptors: null,
      method: 'fake-gftt-adaptive',
      count: 5,
    }),
    assessTemplateQuality: () => ({ overall: 0.05, keypointCount: 5, spatialDistribution: 0.1 }),
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    initializeTracking: () => {
      initializedTracking = true;
    },
  });
  service.persistenceSystem = {
    storeTemplate: () => true,
  };

  const result = await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 70, y1: 80, x2: 150, y2: 160, surfaceHint: 'cup', objectSupportMask },
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

test('candidate anchor transitions to mapping after object-owned refresh landmarks are collected', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    clone() {
      return new FakeMat();
    }
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
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 0.4,
    inlierCount: 0,
    method: 'candidate',
  };
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
    cvtColor: () => {},
  };
  service.keypointDetector = {
    extractKeypointsWithAdaptiveFallback: () => ({
      keypoints: Array.from({ length: 9 }, (_, index) => ({
        pt: { x: 82 + index * 5, y: 92 + index * 3 },
        response: 1,
      })),
      descriptors: null,
      method: 'fake-adaptive-gftt',
      count: 9,
    }),
    assessTemplateQuality: () => ({ overall: 0.16, keypointCount: 9, spatialDistribution: 0.4 }),
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
    },
  });
  service.persistenceSystem = {
    attemptRecovery: () => ({
      success: true,
      position: { x: 112, y: 121 },
      confidence: 0.78,
      scale: 1,
      method: 'template_matching',
    }),
  };

  const result = await service.updateAnchor({ width: 320, height: 240 });
  const state = service.getState();

  assert.equal(result.success, true);
  assert.equal(result.state, 'mapping');
  assert.equal(result.readiness.faceReady, false);
  assert.equal(initializedCount, 9);
  assert.equal(state.state, 'mapping');
  assert.equal(state.metrics.activeLandmarks, 9);
  assert.equal(state.metrics.objectOwnedLandmarks, 9);
});

test('tracking region ignores broad selection bounds when object support is local', () => {
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
    360,
  );
  const trackingRegion = service._calculateTrackingRegion(
    { x1: 0, y1: 0, x2: 420, y2: 360, objectSupportMask },
    420,
    360,
    templateRegion,
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

test('reconstruction pose recovery does not downgrade healthy 2D tracking state', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('depth-fusion');
  service.metrics.reconstructionReady = true;

  assert.equal(
    service._selectTrackingState({
      overallQuality: 0.72,
      poseInliers: 0,
    }),
    'tracking',
  );
});

test('reconstruction face readiness requires a current usable pose source', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');

  assert.deepEqual(
    service._createReadiness({
      state: 'stable',
      poseSource: null,
      reconstructionReady: true,
    }),
    {
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
    },
  );

  assert.equal(
    service._createReadiness({
      state: 'stable',
      poseSource: 'parametric-surface',
      reconstructionReady: true,
    }).faceReady,
    true,
  );

  assert.equal(
    service._createReadiness({
      state: 'stable',
      poseSource: 'planar-homography',
      reconstructionReady: false,
    }).faceReady,
    true,
  );
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

test('candidate bootstrap tracks existing landmarks instead of resetting their history', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    clone() {
      return new FakeMat();
    }
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
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 0.4,
    inlierCount: 0,
    method: 'candidate',
  };
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
    cvtColor: () => {},
  };
  service.keypointDetector = {
    extractKeypointsWithAdaptiveFallback: () => ({
      keypoints: Array.from({ length: 8 }, (_, index) => ({
        pt: { x: 82 + index * 5, y: 92 + index * 3 },
        response: 1,
      })),
      descriptors: null,
      method: 'fake-adaptive-gftt',
      count: 8,
    }),
    assessTemplateQuality: () => ({ overall: 0.16, keypointCount: 8, spatialDistribution: 0.4 }),
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
    trackCandidate: () => {
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
    }),
  };

  const result = await service.updateAnchor({ width: 320, height: 240 });

  assert.equal(result.success, true);
  assert.equal(result.state, 'mapping');
  assert.equal(trackCalls, 1);
  assert.equal(initializeCalls, 0);
  assert.ok(service.keypointTracker.trackedPoints.every((point) => point.age === 5));
});

test('candidate bootstrap reinitializes when too few landmarks exist for coherent refresh', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    clone() {
      return new FakeMat();
    }
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
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 0.4,
    inlierCount: 0,
    method: 'candidate',
  };
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
    cvtColor: () => {},
  };
  service.keypointDetector = {
    extractKeypointsWithAdaptiveFallback: () => ({
      keypoints: Array.from({ length: 8 }, (_, index) => ({
        pt: { x: 82 + index * 5, y: 92 + index * 3 },
        response: 1,
      })),
      descriptors: null,
      method: 'fake-adaptive-gftt',
      count: 8,
    }),
    assessTemplateQuality: () => ({ overall: 0.16, keypointCount: 8, spatialDistribution: 0.4 }),
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
    trackFrame: () => ({
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
    }),
  };

  const result = await service.updateAnchor({ width: 320, height: 240 });

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

test('landmark quality buckets only count object-owned active landmarks', () => {
  const service = new ImageAnchorService();
  const data = new Uint8Array(100 * 80);
  for (let y = 20; y <= 40; y++) {
    for (let x = 20; x <= 40; x++) {
      data[y * 100 + x] = 255;
    }
  }

  service.objectSupportMask = createObjectSupportMask({
    width: 100,
    height: 80,
    data,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 30, y: 30 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });
  service.currentObjectSupportMask = service.objectSupportMask;
  service.metrics = {};
  Object.assign(service.keypointTracker, {
    trackedPoints: [
      {
        id: 1,
        current: { x: 28, y: 28 },
        status: 'active',
        objectOwned: true,
        objectOwnedStreak: 2,
        age: 45,
        totalSuccessfulFrames: 60,
        errorHistory: [1],
        stabilityScore: 1,
        response: 1,
      },
      {
        id: 2,
        current: { x: 70, y: 60 },
        status: 'active',
        objectOwned: true,
        objectOwnedStreak: 2,
        age: 45,
        totalSuccessfulFrames: 60,
        errorHistory: [1],
        stabilityScore: 1,
        response: 1,
      },
    ],
  });

  service._recordLandmarkMetrics();

  assert.equal(service.metrics.activeLandmarkCount, 2);
  assert.equal(service.metrics.objectOwnedLandmarks, 1);
  assert.equal(service.metrics.highQualityLandmarks, 1);
  assert.equal(service.metrics.poseEligibleLandmarks, 1);
});

test('landmark metrics expose tracker quality buckets', () => {
  const service = new ImageAnchorService();
  service.metrics = {};
  service.keypointTracker.trackedPoints = [
    {
      id: 1,
      current: { x: 10, y: 12 },
      status: 'active',
      objectOwned: true,
      objectOwnedStreak: 2,
      age: 45,
      totalSuccessfulFrames: 60,
      errorHistory: [1],
      stabilityScore: 1,
      response: 1,
    },
    {
      id: 2,
      current: { x: 24, y: 18 },
      status: 'active',
      objectOwned: false,
      errorHistory: [22],
    },
    { id: 3, current: { x: 36, y: 26 }, status: 'lost' },
  ];

  service._recordLandmarkMetrics();

  assert.ok(service.metrics.averageLandmarkQuality > 0.5);
  assert.equal(service.metrics.highQualityLandmarks, 1);
  assert.equal(service.metrics.poseEligibleLandmarks, 1);
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
        .filter((point) => point.status === 'active' && point.objectOwned !== false)
        .slice(0, options.maxCount || Infinity)
        .map((point) => ({
          prev: point.original,
          curr: point.current,
        }));
    },
  });

  const rejected = service._rejectTrackedPointsOutsideObjectSupport();
  const correspondences = service.keypointTracker.getCorrespondences({ maxCount: 30 });

  assert.equal(rejected, 6);
  assert.equal(
    service.keypointTracker.trackedPoints.filter((point) => point.objectOwned === false).length,
    6,
  );
  assert.equal(service.keypointTracker.trackedPoints.filter((point) => point.status === 'outlier').length, 6);
  assert.equal(correspondences.length, 10);
  assert.ok(correspondences.every((correspondence) => correspondence.curr.x <= 68));
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
    cvtColor: () => {},
  };
  service.keypointDetector = {
    extractKeypointsWithAdaptiveFallback: () => ({
      keypoints: [],
      descriptors: {},
      method: 'fake-orb-adaptive',
      count: 0,
      rejectedByMask: 20,
    }),
    assessTemplateQuality: () => ({ overall: 0.08 }),
  };
  service.persistenceSystem = {
    storeTemplate: () => true,
  };

  const result = await service.createAnchor(
    { width: 320, height: 240 },
    { x: 110, y: 120 },
    { x1: 70, y1: 80, x2: 150, y2: 160 },
  );

  const state = service.getState();
  assert.equal(result.state, 'candidate');
  assert.equal(state.state, 'candidate');
  assert.equal(state.metrics.templateQuality, 0.08);
  assert.equal(state.metrics.qualityState, 'weak');
  assert.equal(state.metrics.objectSupportMaskSource, 'tap-local');
});

test('keeps tracking state during the keypoint retry budget', async () => {
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
    method: 'planar-homography',
  };
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {},
  };
  service._updateWithKeypoints = () => ({
    success: false,
    reason: 'Optical flow rejected points',
    state: 'tracking',
  });
  const result = await service.updateAnchor({ width: 320, height: 240 });
  const state = service.getState();

  assert.equal(result.success, true);
  assert.equal(result.targetPresent, false);
  assert.equal(result.recoverable, true);
  assert.equal(result.method, 'held-last-pose');
  assert.deepEqual(result.position, { x: 100, y: 120, z: 0 });
  assert.deepEqual(result.normal, { x: 0.1, y: -0.2, z: 0.97 });
  assert.equal(result.planarTransform.scale, 1.1);
  assert.equal(state.state, 'tracking');
  assert.equal(state.metrics.keypointFailureCount, 1);
  assert.equal(state.metrics.lostFrameCount, 0);
  assert.equal(state.metrics.targetPresent, false);
  assert.match(result.reason, /Optical flow/);
});

test('the failure threshold declares target loss without accepting a local template hold', async () => {
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
    cvtColor: () => {},
  };
  service._updateWithKeypoints = () => ({
    success: false,
    reason: 'Insufficient keypoint tracking quality',
    state: 'tracking',
  });
  let templateRecoveries = 0;
  service.persistenceSystem = {
    attemptRecovery: () => {
      templateRecoveries++;
      return { success: true, position: { x: 12, y: 14 }, confidence: 0.99, scale: 1 };
    },
  };

  const result = await service.updateAnchor({ width: 320, height: 240 });

  assert.equal(result.success, false);
  assert.equal(result.targetPresent, false);
  assert.equal(result.method, 'target-lost');
  assert.equal(result.recoverable, true);
  assert.deepEqual(result.position, service.currentPosition);
  assert.deepEqual(result.normal, service.currentNormal);
  assert.equal(result.planarTransform.scale, 0.92);
  assert.equal(service.anchorState, 'lost');
  assert.equal(templateRecoveries, 0);
});

test('keypoint failure recovers through descriptor keyframe relocalization before template fallback', async () => {
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
  const correspondences = trackedPoints.map((point) => ({
    prev: point.original,
    curr: {
      x: point.original.x + 20,
      y: point.original.y - 10,
    },
  }));

  service.anchorState = 'tracking';
  service.templateRegion = { x: 40, y: 40, width: 160, height: 140 };
  service.currentPosition = { x: 120, y: 110, z: 0 };
  let staleMaskDetectorCalls = 0;
  service.keypointDetector = {
    extractKeypoints: () => {
      staleMaskDetectorCalls++;
      return { keypoints: [] };
    },
  };
  let relocalizationCalls = 0;
  let relocalizationGrowthOptions = null;
  const frameFeatures = {
    count: 40,
    descriptorBytes: new Uint8Array(40 * 32),
    descriptorSize: 32,
    features: [],
  };
  service.relocalizer = {
    hasKeyframes: () => true,
    getKeyframeCount: () => 3,
    relocalize: () => {
      relocalizationCalls++;
      return {
        success: true,
        method: 'orb-keyframe-relocalization',
        transform,
        confidence: 0.86,
        averageResidual: 1.1,
        matchCount: 22,
        inlierCount: 16,
        inlierIds: trackedPoints.map((point) => point.id),
        inlierMatches: trackedPoints.map((point) => ({
          id: point.id,
          reference: point.original,
          point: { x: point.original.x + 20, y: point.original.y - 10 },
        })),
        queryFeatureCount: 40,
        keyframeCount: 3,
        frameFeatures,
        timings: {
          featureExtractionMs: 18.5,
          keyframeSearchMs: 2.25,
        },
      };
    },
  };
  Object.assign(service.keypointTracker, {
    trackedPoints,
    trackFrame: () => ({ success: false, reason: 'LK lost all points' }),
    restoreFromRelocalizationMatches: () => {
      trackedPoints.forEach((point) => {
        point.status = 'active';
      });
      return { restored: 16, total: 16, active: 16 };
    },
    getObjectPose: () =>
      createObjectPose({
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
  installAnchorPositionEvaluationStub(service.keypointTracker);
  service.homographyEstimator = createHomographyEstimatorStub(() =>
    createObjectPose({
      x: 144,
      y: 122,
      scale: 1.18,
      rotation: 0.2,
      method: 'homography',
    }),
  );
  service._shouldAttemptGeometryRelocalization = () => true;
  service._refreshKeypoints = (grayImage, options) => {
    relocalizationGrowthOptions = { grayImage, options };
    return true;
  };
  let staleMaskRejectionCalls = 0;
  service._rejectTrackedPointsOutsideObjectSupport = () => {
    staleMaskRejectionCalls++;
    return 0;
  };

  const updateTimings = {};
  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000, {}, updateTimings);

  assert.equal(result.success, true);
  assert.equal(result.method, 'object-pose-affine');
  assert.equal(relocalizationCalls, 1);
  assert.equal(staleMaskDetectorCalls, 0);
  assert.equal(staleMaskRejectionCalls, 0);
  assert.equal(service.metrics.relocalizationResult, 'success');
  assert.equal(service.metrics.relocalizationMatches, 22);
  assert.equal(service.metrics.relocalizationInliers, 16);
  assert.equal(service.metrics.relocalizationSuccessFrame, 0);
  assert.equal(service.metrics.activeLandmarkCount, 16);
  assert.equal(updateTimings.relocalizationFeatureExtractionMs, 18.5);
  assert.equal(updateTimings.relocalizationKeyframeSearchMs, 2.25);
  assert.ok(updateTimings.relocalizationMs >= 0);
  assert.equal(relocalizationGrowthOptions.options.updateTimings, updateTimings);
  assert.equal(
    relocalizationGrowthOptions.options.anchorPositionEvaluation.attachmentEvidence.testStub,
    true,
  );
  assert.deepEqual(
    {
      ...relocalizationGrowthOptions,
      options: {
        ...relocalizationGrowthOptions.options,
        anchorPositionEvaluation: undefined,
        updateTimings: undefined,
      },
    },
    {
      grayImage: { cols: 320, rows: 240 },
      options: {
        adaptive: true,
        minNewKeypoints: 12,
        storeFreshRelocalizationKeyframe: true,
        frameFeatures,
        anchorPositionEvaluation: undefined,
        updateTimings: undefined,
      },
    },
  );
  assert.equal(service.metrics.landmarkRefreshReason, 'relocalization-growth');
});

test('ORB relocalization searches the full recovery frame instead of a stale object mask', async () => {
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
  let detectorCalls = 0;
  let relocalizationInput = null;
  const frameFeatures = {
    count: 18,
    descriptorBytes: new Uint8Array(18 * 32),
    descriptorSize: 32,
    features: [],
  };

  service.cv = { runtime: 'opencv' };
  service.objectSupportMask = objectSupportMask;
  service.currentPosition = { x: 125, y: 100, z: 0 };
  service.currentPlanarTransform = null;
  service.keypointDetector = {
    extractKeypoints: () => {
      detectorCalls++;
      return { keypoints: [] };
    },
  };
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: (cv, queryGrayImage) => {
      relocalizationInput = { cv, grayImage: queryGrayImage };
      return {
        success: false,
        reason: 'Insufficient reciprocal ORB matches: 0',
        queryFeatureCount: 18,
        frameFeatures,
      };
    },
  };

  const grayImage = { cols: width, rows: height };
  const result = await service._attemptKeyframeRelocalization(grayImage, 'tracking failed');

  assert.equal(detectorCalls, 0);
  assert.deepEqual(relocalizationInput, { cv: service.cv, grayImage });
  assert.deepEqual(service.metrics.relocalizationQueryRegion, { x: 0, y: 0, width, height });
  assert.equal(service.metrics.relocalizationQueryKeypoints, 18);
  assert.equal(result.frameFeatures, frameFeatures);
});

test('failed ORB recovery falls through to XFeat and restores only learned inliers', async () => {
  const service = new ImageAnchorService();
  const learnedMatches = Array.from({ length: 8 }, (_, id) => ({
    id,
    reference: { x: 30 + id * 8, y: 40 + id * 5 },
    point: { x: 48 + id * 8, y: 32 + id * 5 },
  }));
  service.cv = { runtime: 'opencv' };
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: () => ({
      success: false,
      reason: 'No robust ORB geometric consensus',
      queryFeatureCount: 120,
      matchCount: 4,
      inlierCount: 3,
      frameFeatures: { count: 120, descriptorSize: 32, descriptorBytes: new Uint8Array() },
      timings: { featureExtractionMs: 12, keyframeSearchMs: 1 },
    }),
  };
  service.learnedReferencePromise = Promise.resolve({ success: true, descriptorCount: 20 });
  service.learnedRelocalizer = {
    hasReference: () => true,
    relocalize: async () => ({
      success: true,
      method: 'xfeat-keyframe-relocalization',
      confidence: 0.88,
      averageResidual: 1.4,
      matchCount: 14,
      inlierCount: 8,
      inlierMatches: learnedMatches,
      queryFeatureCount: 500,
      keyframeCount: 1,
      timings: { featureExtractionMs: 10, keyframeSearchMs: 2 },
    }),
  };
  service.keypointTracker.restoreFromRelocalizationMatches = (_gray, matches) => ({
    restored: matches.length,
    active: matches.length,
  });

  const result = await service._attemptKeyframeRelocalization(
    { cols: 320, rows: 240 },
    'tracking failed',
    null,
    { width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4) },
  );

  assert.equal(result.success, true);
  assert.equal(result.method, 'xfeat-keyframe-relocalization');
  assert.equal(result.restore.restored, 8);
  assert.equal(service.metrics.relocalizationMethod, 'xfeat-keyframe-relocalization');
  assert.equal(service.metrics.relocalizationMatches, 14);
  assert.equal(service.metrics.relocalizationInliers, 8);
});

test('a rejected learned-memory extension keeps the first XFeat view available for recovery', async () => {
  const service = new ImageAnchorService();
  let learnedCalls = 0;
  service.cv = { runtime: 'opencv' };
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: () => ({
      success: false,
      reason: 'No robust ORB geometric consensus',
      queryFeatureCount: 120,
      matchCount: 4,
      inlierCount: 3,
    }),
  };
  service.learnedReferencePromise = Promise.resolve({
    success: false,
    descriptorCount: 3,
    keyframeCount: 1,
    reason: 'Insufficient second-view support',
  });
  service.learnedRelocalizer = {
    hasReference: () => true,
    relocalize: async () => {
      learnedCalls++;
      return { success: false, reason: 'No robust XFeat geometric consensus' };
    },
  };

  await service._attemptKeyframeRelocalization({ cols: 320, rows: 240 }, 'tracking failed', null, {
    width: 320,
    height: 240,
  });

  assert.equal(learnedCalls, 1);
});

test('a proven ORB keyframe arms learned recovery once for a generic target', async () => {
  const service = new ImageAnchorService();
  const imageData = {
    width: 320,
    height: 240,
    data: new Uint8ClampedArray(320 * 240 * 4),
  };
  const storedReferences = [];
  service.anchorTargetClass = 'generic-object';
  service.currentPosition = { x: 140, y: 110, z: 0 };
  service.keypointTracker.trackedPoints = Array.from({ length: 12 }, (_, id) => ({ id }));
  service.learnedRelocalizer = {
    hasReference: () => false,
    storeReference: async (reference) => {
      storedReferences.push(reference);
      return { success: true, descriptorCount: 10 };
    },
  };

  const first = service._storeLearnedReference(imageData);
  const duplicate = service._storeLearnedReference(imageData);
  await first;

  assert.equal(first, duplicate);
  assert.equal(storedReferences.length, 1);
  assert.equal(storedReferences[0].imageData, imageData);
  assert.equal(storedReferences[0].trackedPoints, service.keypointTracker.trackedPoints);
  assert.deepEqual(storedReferences[0].anchorPoint, service.currentPosition);
  assert.deepEqual(await service.learnedReferencePromise, { success: true, descriptorCount: 10 });
});

test('rejected ORB keyframes cannot arm learned recovery', () => {
  const service = new ImageAnchorService();
  let storageCalls = 0;
  service.learnedRelocalizer = {
    hasReference: () => false,
    storeReference: async () => {
      storageCalls++;
      return { success: true, descriptorCount: 10 };
    },
  };

  const result = service._storeLearnedReference(
    { width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4) },
    false,
  );

  assert.equal(result, null);
  assert.equal(storageCalls, 0);
  assert.equal(service.learnedReferencePromise, null);
});

test('XFeat runtime failure preserves the original ORB failure and disables learned recovery', async () => {
  const service = new ImageAnchorService();
  service.cv = { runtime: 'opencv' };
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: () => ({
      success: false,
      reason: 'No robust ORB geometric consensus',
      queryFeatureCount: 120,
      matchCount: 4,
      inlierCount: 3,
    }),
  };
  service.learnedReferencePromise = Promise.resolve({ success: true, descriptorCount: 20 });
  service.learnedRelocalizer = {
    hasReference: () => true,
    relocalize: () => Promise.reject(new Error('worker crashed')),
  };

  const result = await service._attemptKeyframeRelocalization(
    { cols: 320, rows: 240 },
    'tracking failed',
    null,
    { width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4) },
  );

  assert.equal(result.success, false);
  assert.equal(result.reason, 'No robust ORB geometric consensus');
});

test('learned recovery runs at a bounded cadence while ORB continues every frame', async () => {
  const service = new ImageAnchorService();
  let orbCalls = 0;
  let learnedCalls = 0;
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: () => {
      orbCalls++;
      return {
        success: false,
        reason: 'No robust ORB geometric consensus',
        queryFeatureCount: 120,
        matchCount: 4,
        inlierCount: 3,
      };
    },
  };
  service.learnedReferencePromise = Promise.resolve({ success: true, descriptorCount: 20 });
  service.learnedRelocalizer = {
    hasReference: () => true,
    relocalize: async () => {
      learnedCalls++;
      return { success: false, reason: 'No robust XFeat geometric consensus' };
    },
  };
  const grayImage = { cols: 320, rows: 240 };
  const imageData = { width: 320, height: 240 };

  service.frameIndex = 10;
  await service._attemptKeyframeRelocalization(grayImage, 'tracking failed', null, imageData);
  service.frameIndex = 11;
  await service._attemptKeyframeRelocalization(grayImage, 'tracking failed', null, imageData);
  service.frameIndex = 13;
  await service._attemptKeyframeRelocalization(grayImage, 'tracking failed', null, imageData);

  assert.equal(orbCalls, 3);
  assert.equal(learnedCalls, 2);
});

test('failed landmark restoration preserves same-frame ORB evidence for storage', async () => {
  const service = new ImageAnchorService();
  const frameFeatures = {
    count: 24,
    descriptorBytes: new Uint8Array(24 * 32),
    descriptorSize: 32,
    features: [],
  };

  service.cv = { runtime: 'opencv' };
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: () => ({
      success: true,
      method: 'orb-keyframe-relocalization',
      confidence: 0.8,
      averageResidual: 1.2,
      matchCount: 12,
      inlierCount: 8,
      inlierMatches: [],
      queryFeatureCount: 24,
      keyframeCount: 2,
      frameFeatures,
    }),
  };
  service.keypointTracker.restoreFromRelocalizationMatches = () => ({
    restored: 4,
    active: 4,
  });

  const result = await service._attemptKeyframeRelocalization({ cols: 320, rows: 240 }, 'tracking failed');

  assert.equal(result.success, false);
  assert.match(result.reason, /restored only 4 landmarks/);
  assert.equal(result.frameFeatures, frameFeatures);
});

test('ORB geometry recovery searches a padded anchor-local region', async () => {
  const service = new ImageAnchorService();
  const grayImage = { cols: 320, rows: 240 };
  let relocalizationInput = null;

  service.cv = { runtime: 'opencv' };
  service.currentPosition = { x: 120, y: 100, z: 0 };
  service.templateRegion = { x: 80, y: 70, width: 80, height: 60 };
  service.trackingRegion = { x: 70, y: 60, width: 100, height: 80 };
  service.relocalizer = {
    hasKeyframes: () => true,
    relocalize: (cv, image, options) => {
      relocalizationInput = { cv, image, options };
      return {
        success: false,
        reason: 'No reciprocal matches',
        queryFeatureCount: 12,
        searchRegion: options.searchRegion,
      };
    },
  };

  const searchRegion = service._getLocalRelocalizationSearchRegion(grayImage);
  await service._attemptKeyframeRelocalization(
    grayImage,
    'Reference geometry became incoherent',
    searchRegion,
  );

  assert.deepEqual(searchRegion, { x: 46, y: 36, width: 148, height: 128 });
  assert.deepEqual(relocalizationInput, {
    cv: service.cv,
    image: grayImage,
    options: { searchRegion },
  });
  assert.deepEqual(service.metrics.relocalizationQueryRegion, searchRegion);
  assert.equal(service.metrics.relocalizationQueryKeypoints, 12);
});

test('periodic ORB keyframe storage exposes its full wall time to frame profiling', () => {
  const service = new ImageAnchorService();
  const grayImage = { cols: 320, rows: 240 };
  const updateTimings = {};
  const storeInputs = [];

  service.cv = { runtime: 'opencv' };
  service.currentPosition = { x: 120, y: 100, z: 0 };
  service.templateRegion = { x: 80, y: 70, width: 80, height: 60 };
  service.trackingRegion = { x: 70, y: 60, width: 100, height: 80 };
  service.framesSinceRelocalizationKeyframe = 3;
  service.metrics.trackingSuccessRate = 0.9;
  service.keypointTracker.trackedPoints = Array.from({ length: 12 }, (_, index) => ({
    id: index,
    status: 'active',
    original: { x: 82 + index * 4, y: 74 + index * 3 },
    current: { x: 92 + index * 4, y: 80 + index * 3 },
    objectOwned: true,
    objectOwnedStreak: 4,
    totalSuccessfulFrames: 24,
    successfulTrackingStreak: 18,
    landmarkQuality: 0.8,
  }));
  service.relocalizer = {
    getKeyframeCount: () => 2,
    storeKeyframe: (input) => {
      storeInputs.push(input);
      return {
        success: true,
        keyframeCount: 3,
        descriptorCount: 12,
        storageEvaluated: true,
        featureExtractionMs: 7.5,
      };
    },
  };

  service._storeRelocalizationKeyframe(grayImage, { updateTimings });

  assert.ok(updateTimings.keyframeStoreMs >= 0);
  assert.equal(updateTimings.keyframeFeatureExtractionMs, 7.5);
  assert.equal(storeInputs[0].translationInvariantRedundancy, false);

  service.rigidPlanarRecoveryEligible = true;
  service.framesSinceRelocalizationKeyframe = 3;
  service._storeRelocalizationKeyframe(grayImage);

  assert.equal(storeInputs[1].translationInvariantRedundancy, true);
});

test('mature ORB keyframes arm two learned views only for unknown and generic targets', () => {
  const service = new ImageAnchorService();
  const imageData = { width: 320, height: 240 };
  let learnedStores = 0;
  let keyframeCount = 1;

  service.currentPosition = { x: 120, y: 100, z: 0 };
  service.framesSinceRelocalizationKeyframe = 4;
  service.metrics.trackingSuccessRate = 0.9;
  service.keypointTracker.trackedPoints = Array.from({ length: 12 }, (_, id) => ({
    id,
    status: 'active',
    objectOwned: true,
    objectOwnedStreak: 4,
  }));
  service.relocalizer = {
    getKeyframeCount: () => 2,
    storeKeyframe: () => ({ success: true, keyframeCount, descriptorCount: 12 }),
  };
  service.learnedRelocalizer = {
    storeReference: async () => {
      learnedStores++;
      return { success: true, descriptorCount: 12 };
    },
  };

  service._storeRelocalizationKeyframe({ cols: 320, rows: 240 }, { learnedImageData: imageData });
  assert.equal(learnedStores, 1);

  keyframeCount = 3;
  service.framesSinceRelocalizationKeyframe = 4;
  service._storeRelocalizationKeyframe({ cols: 320, rows: 240 }, { learnedImageData: imageData });
  assert.equal(learnedStores, 2);

  service.anchorTargetClass = 'handled mug';
  service.framesSinceRelocalizationKeyframe = 4;
  service._storeRelocalizationKeyframe({ cols: 320, rows: 240 }, { learnedImageData: imageData });
  assert.equal(learnedStores, 2);
});

test('keypoint updates propagate pose normals from homography correspondences', async () => {
  const service = new ImageAnchorService();
  const poseNormal = { x: 0.32, y: -0.21, z: 0.92 };

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {};
  Object.assign(service.keypointTracker, {
    trackFrame: () => ({
      success: true,
      successRate: 0.92,
      activePointCount: 24,
      averageError: 1.1,
    }),
    getCorrespondences: () =>
      Array.from({ length: 12 }, (_, index) => ({
        prev: {
          x: 20 + (index % 4) * 18,
          y: 30 + Math.floor(index / 4) * 16,
        },
        curr: {
          x: 24 + (index % 4) * 18,
          y: 33 + Math.floor(index / 4) * 16,
        },
      })),
    getObjectPose: () =>
      createObjectPose({
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
      method: 'reference_transform_with_offset',
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);
  service.homographyEstimator = createHomographyEstimatorStub(() => ({
    success: true,
    normal: poseNormal,
    inlierCount: 18,
    inlierRatio: 0.75,
    confidence: 0.84,
  }));

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.inliers, 18);
  assert.equal(result.normal.x.toFixed(2), '0.32');
  assert.equal(result.normal.y.toFixed(2), '-0.21');
  assert.equal(service.currentNormal.z.toFixed(2), '0.92');
});

test('keypoint updates resolve one current-frame anchor evaluation with OpenCV', async () => {
  const service = new ImageAnchorService();
  const cv = { findHomography: () => null };
  const anchorPositionContexts = [];
  const anchorPositionEvaluation = {
    position: {
      x: 142,
      y: 158,
      method: 'reference_similarity_transform',
      confidence: 0.82,
      inlierCount: 18,
      averageResidual: 1.1,
      scale: 1.04,
      rotation: 0.08,
    },
    attachmentEvidence: { frame: 1 },
  };
  let evaluationCreations = 0;

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = cv;
  Object.assign(service.keypointTracker, {
    trackFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 18,
      averageError: 1.2,
    }),
    getCorrespondences: () =>
      Array.from({ length: 12 }, (_, index) => ({
        prev: {
          x: 30 + (index % 4) * 18,
          y: 40 + Math.floor(index / 4) * 16,
        },
        curr: {
          x: 36 + (index % 4) * 18,
          y: 43 + Math.floor(index / 4) * 16,
        },
      })),
    getObjectPose: () =>
      createObjectPose({
        x: 142,
        y: 158,
        scale: 1.04,
        rotation: 0.08,
        inlierCount: 18,
      }),
    createAnchorPositionEvaluation: () => {
      evaluationCreations++;
      return anchorPositionEvaluation;
    },
    resolveAnchorPositionEvaluation: (receivedCv, evaluation) => {
      anchorPositionContexts.push(receivedCv);
      assert.equal(evaluation, anchorPositionEvaluation);
      return {
        x: 142,
        y: 158,
        method: 'reference_homography',
        confidence: 0.82,
        inlierCount: 18,
        averageResidual: 1.1,
        scale: 1.04,
        rotation: 0.08,
      };
    },
    getAnchorPosition: () => assert.fail('one-shot anchor position should not run in the tracked update'),
  });
  service.homographyEstimator = createHomographyEstimatorStub(() =>
    createObjectPose({
      x: 142,
      y: 158,
      scale: 1.04,
      rotation: 0.08,
      inlierCount: 18,
      method: 'homography',
    }),
  );

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(evaluationCreations, 1);
  assert.deepEqual(anchorPositionContexts, [cv]);
});

test('descriptor restore invalidates preliminary anchor evidence before final resolution', async () => {
  const service = new ImageAnchorService();
  const evaluations = [];
  let resolvedEvaluation = null;

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = { runtime: 'opencv' };
  Object.assign(service.keypointTracker, {
    trackFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 18,
      averageError: 1.2,
    }),
    createAnchorPositionEvaluation: () => {
      const evaluation = {
        position: {
          x: 142,
          y: 158,
          method: 'reference_similarity_transform',
          confidence: 0.82,
          inlierCount: 18,
          averageResidual: 1.1,
          scale: 1.04,
          rotation: 0.08,
        },
        attachmentEvidence: { sequence: evaluations.length },
      };
      evaluations.push(evaluation);
      return evaluation;
    },
    resolveAnchorPositionEvaluation: (cv, evaluation) => {
      assert.equal(cv, service.cv);
      resolvedEvaluation = evaluation;
      return evaluation.position;
    },
    getCorrespondences: () =>
      Array.from({ length: 12 }, (_, index) => ({
        prev: { x: 30 + (index % 4) * 18, y: 40 + Math.floor(index / 4) * 16 },
        curr: { x: 36 + (index % 4) * 18, y: 43 + Math.floor(index / 4) * 16 },
      })),
    getObjectPose: () =>
      createObjectPose({
        x: 142,
        y: 158,
        scale: 1.04,
        rotation: 0.08,
        inlierCount: 18,
      }),
    getAnchorPosition: () => assert.fail('one-shot anchor position should not run in the tracked update'),
  });
  service.homographyEstimator = createHomographyEstimatorStub(() =>
    createObjectPose({
      x: 142,
      y: 158,
      scale: 1.04,
      rotation: 0.08,
      inlierCount: 18,
      method: 'homography',
    }),
  );
  service._shouldAttemptGeometryRelocalization = () => true;
  service._attemptKeyframeRelocalization = () => ({
    success: true,
    restore: { restored: 18, active: 18 },
    matches: 22,
    inliers: 18,
    confidence: 0.9,
    trackingResult: {
      success: true,
      successRate: 0.9,
      activePointCount: 18,
      averageError: 1.1,
      relocalized: true,
    },
  });

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(evaluations.length, 2);
  assert.equal(resolvedEvaluation, evaluations[1]);
});

test('affine parallax pose derives tilt from local point cloud deformation', async () => {
  const service = new ImageAnchorService();
  const correspondences = Array.from({ length: 20 }, (_, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const prev = {
      x: 80 + column * 22,
      y: 70 + row * 20,
    };
    const centerX = 124;

    return {
      prev,
      curr: {
        x: centerX + (prev.x - centerX) * 0.56 + 18,
        y: prev.y + 7,
      },
    };
  });

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.templateRegion = { width: 180, height: 160 };
  service.cv = {};
  service.homographyEstimator = createHomographyEstimatorStub(() => ({
    success: false,
    reason: 'homography unavailable in unit test',
  }));
  Object.assign(service.keypointTracker, {
    trackFrame: () => ({
      success: true,
      successRate: 0.92,
      activePointCount: 24,
      averageError: 1.1,
    }),
    getCorrespondences: () => correspondences,
    getObjectPose: () =>
      createObjectPose({
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
      inlierCount: 20,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);
  service.homographyEstimator = createHomographyEstimatorStub(() => ({
    success: false,
    reason: 'homography is ambiguous',
  }));

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

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

  const selected = resolveNormalPose(service, {
    objectPose,
    poseResult: homographyPose,
    correspondences,
  }).pose;

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

  assert.equal(service._getPoseRejectionReason(pose, correspondences), 'High pose residual');
});

test('degraded recovery gets one local evidence attempt and keeps the frame alive across async recovery', async () => {
  const service = new ImageAnchorService();
  const matrices = [];
  class FakeMat {
    constructor() {
      this.deleted = false;
      matrices.push(this);
    }

    delete() {
      this.deleted = true;
    }
  }

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'degraded';
  service.currentPosition = { x: 120, y: 140, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.currentPlanarTransform = { scale: 1, rotation: 0, confidence: 0.7 };
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {},
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [{ status: 'active' }],
  });

  let matrixAliveAfterAsyncBoundary = false;
  let recoveryOptions = null;
  service._updateWithKeypoints = async (
    grayImage,
    timestamp,
    depthContext,
    updateTimings,
    imageData,
    options,
  ) => {
    await Promise.resolve();
    matrixAliveAfterAsyncBoundary = !grayImage.deleted;
    recoveryOptions = options;
    return {
      success: true,
      targetPresent: true,
      position: service.currentPosition,
      normal: service.currentNormal,
      planarTransform: service.currentPlanarTransform,
      confidence: 0.8,
      method: 'keypoint_tracking',
      state: 'tracking',
    };
  };

  const result = await service.updateAnchor({ width: 320, height: 240 });

  assert.equal(result.success, true);
  assert.equal(recoveryOptions, undefined);
  assert.equal(matrixAliveAfterAsyncBoundary, true);
  assert.equal(matrices.length, 3);
  assert.equal(matrices[0].deleted, true);
  assert.equal(matrices[1].deleted, false);
  assert.equal(matrices[2].deleted, false);

  service.dispose();

  assert.equal(
    matrices.every((matrix) => matrix.deleted),
    true,
  );
});

test('weak degraded anchors return to progressive bootstrap after local flow collapses', async () => {
  const service = new ImageAnchorService();
  class FakeMat {
    delete() {}
  }
  const support = createObjectSupportMask({
    width: 320,
    height: 240,
    data: new Uint8Array(320 * 240).fill(255),
    source: 'tap-local',
    confidence: 0.5,
    referencePoint: { x: 120, y: 140 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'degraded';
  service.currentPosition = { x: 120, y: 140, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.currentPlanarTransform = { scale: 1, rotation: 0, confidence: 0.7 };
  service.objectSupportMask = support;
  service.currentObjectSupportMask = support;
  service.metrics.templateQuality = 0.17;
  service.metrics.targetPresent = true;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {},
  };
  service._updateWithKeypoints = async () => ({
    success: false,
    targetPresent: false,
    reason: 'Lucas-Kanade retained 5/15 points',
    state: 'degraded',
  });

  const result = await service.updateAnchor({ width: 320, height: 240 });
  const state = service.getState();

  assert.equal(result.success, false);
  assert.equal(result.targetPresent, false);
  assert.equal(result.method, 'progressive-bootstrap-reset');
  assert.equal(result.recoverable, true);
  assert.equal(state.state, 'candidate');
  assert.equal(state.metrics.readiness.faceReady, false);
});

test('XFeat recovery rejects a local-strength consensus before mutating landmarks', async () => {
  const service = new ImageAnchorService();
  let restoreCalls = 0;
  service.relocalizer = {
    hasKeyframes: () => false,
  };
  service.learnedReferencePromise = Promise.resolve({ success: true });
  service.learnedRelocalizer = {
    hasReference: () => true,
    relocalize: async () => ({
      success: true,
      method: 'xfeat-keyframe-relocalization',
      inlierCount: 6,
      matchCount: 9,
      confidence: 0.72,
      averageResidual: 2.8,
      inlierMatches: Array.from({ length: 6 }, (_, id) => ({ id })),
      transform: { model: 'affine' },
    }),
  };
  service.keypointTracker.restoreFromRelocalizationMatches = () => {
    restoreCalls++;
    return { restored: 6, active: 12 };
  };

  const result = await service._attemptKeyframeRelocalization(
    { cols: 640, rows: 480 },
    'Target lost',
    null,
    { width: 640, height: 480 },
    { minimumInliers: 5 },
  );

  assert.equal(result.success, false);
  assert.equal(result.reason, 'Descriptor relocalization found only 6 inliers; 8 required');
  assert.equal(restoreCalls, 0);
  assert.equal(service.metrics.relocalizationResult, 'failed');
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
    getCentroidAnchorPosition: (points) => {
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
  assert.equal(
    centroidInput.every((point) => point.objectOwned === true),
    true,
  );
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

  assert.equal(
    service._selectTrackerAnchorPosition({
      trackerAnchorPosition,
      reconstructionPose: { success: false },
    }),
    trackerAnchorPosition,
  );
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

  assert.equal(
    service._selectTrackerAnchorPosition({
      trackerAnchorPosition,
      reconstructionPose: { success: false },
    }),
    trackerAnchorPosition,
  );
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
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
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

test('support recovery shares the current frame motion envelope with tracking', () => {
  const service = new ImageAnchorService({ now: () => 1040 });
  const data = new Uint8Array(160 * 100);
  for (let y = 20; y < 70; y++) {
    for (let x = 70; x < 130; x++) {
      data[y * 160 + x] = 255;
    }
  }
  const refreshedMask = createObjectSupportMask({
    width: 160,
    height: 100,
    data,
    source: 'interactive-segmenter',
    confidence: 0.94,
    referencePoint: { x: 100, y: 45 },
    createdAtFrame: 8,
  });

  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'can';
  service.templateRegion = { x: 20, y: 10, width: 120, height: 80 };
  service.trackingRegion = { x: 16, y: 8, width: 128, height: 88 };
  service.frameStartPosition = { x: 60, y: 45, z: 0 };
  service.currentPosition = { x: 66, y: 45, z: 0 };
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
  service.objectSupportAnchorUv = { u: 0.5, v: 0.5 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.lastUpdateMethod = 'reference_similarity_transform';

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: 'pose-dropout-recovery' });
  const totalFrameStep = Math.hypot(
    service.currentPosition.x - service.frameStartPosition.x,
    service.currentPosition.y - service.frameStartPosition.y,
  );

  assert.equal(applied, true);
  assert.ok(totalFrameStep <= 9.6 + 1e-6);
  assert.ok(service.metrics.objectSupportPositionStep < 4);
  assert.equal(service.metrics.objectSupportFrameStepLimited, true);
});

test('periodic curved support refresh updates mask without recentering anchor', () => {
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
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
  service.templateRegion = { x: 30, y: 20, width: 60, height: 50 };
  service.trackingRegion = { x: 24, y: 14, width: 72, height: 62 };
  service.anchorTargetClass = 'cup';
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.objectSupportAnchorUv = { u: 0.5, v: 0.5 };

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: 'periodic-segmentation-refresh' });

  assert.equal(applied, true);
  assert.deepEqual(service.currentPosition, { x: 92, y: 30, z: 0 });
  assert.equal(service.metrics.objectSupportPositionCorrection, null);
  assert.equal(service.metrics.objectSupportPositionSource, null);
  assert.equal(service.metrics.objectSupportMaskSource, 'interactive-segmenter');
});

test('periodic sparse mug support refresh can recenter stale sparse drift', () => {
  const service = new ImageAnchorService({ now: () => 1040 });
  const data = new Uint8Array(140 * 100);
  for (let y = 24; y < 84; y++) {
    for (let x = 56; x < 132; x++) {
      data[y * 140 + x] = 255;
    }
  }
  const refreshedMask = createObjectSupportMask({
    width: 140,
    height: 100,
    data,
    source: 'interactive-segmenter',
    confidence: 0.92,
    referencePoint: { x: 94, y: 54 },
    createdAtFrame: 8,
  });

  service.setTrackingMode('sparse-reconstruction');
  service.currentPosition = { x: 58, y: 78, z: 0 };
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
  service.templateRegion = { x: 30, y: 20, width: 60, height: 50 };
  service.trackingRegion = { x: 24, y: 14, width: 72, height: 62 };
  service.anchorTargetClass = 'mug';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.72;
  service.metrics.activeLandmarkCount = 18;
  service.objectSupportAnchorUv = { u: 0.5, v: 0.5 };

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: 'periodic-segmentation-refresh' });

  assert.equal(applied, true);
  assert.equal(service.metrics.objectSupportPositionCorrection, 'periodic-segmentation-refresh');
  assert.ok(service.metrics.objectSupportPositionStep <= 8 + 1e-6);
  assert.ok(service.currentPosition.x > 62);
  assert.ok(service.currentPosition.y < 75);
});

test('sparse mug support correction hold rejects reconstruction backtracking', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'mug';
  service.frameIndex = 14;
  service.currentPosition = { x: 120, y: 80, z: 0 };
  service.objectSupportCorrectionHold = {
    frameIndex: 12,
    direction: { x: 8, y: -2 },
    magnitude: Math.hypot(8, -2),
    reason: 'periodic-segmentation-refresh',
  };

  const held = service._filterPositionCandidate(
    { x: 112, y: 82, z: 0, confidence: 0.8, averageResidual: 2, inlierCount: 14 },
    1066,
    'sparse-reconstruction',
  );

  assert.deepEqual(held, {
    x: 120,
    y: 80,
    z: 0,
    confidence: 0.8,
    averageResidual: 2,
    inlierCount: 14,
  });
  assert.equal(service.metrics.positionFilterAdjustment, 'sparse-mug-support-correction-hold');
});

test('curved support recovery does not override a motion-held anchor', () => {
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

  service.currentPosition = { x: 50, y: 56, z: 0 };
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
  service.templateRegion = { x: 30, y: 20, width: 60, height: 50 };
  service.trackingRegion = { x: 24, y: 14, width: 72, height: 62 };
  service.anchorTargetClass = 'cup';
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.metrics.positionFilterAdjustment = 'curved-motion-hold';
  service.objectSupportAnchorUv = { u: 0.5, v: 0.5 };

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: 'pose-dropout-recovery' });

  assert.equal(applied, true);
  assert.deepEqual(service.currentPosition, { x: 50, y: 56, z: 0 });
  assert.equal(service.metrics.objectSupportPositionCorrection, null);
  assert.equal(service.metrics.objectSupportPositionSource, null);
  assert.equal(service.metrics.objectSupportMaskSource, 'interactive-segmenter');
});

test('curved support recovery corrects a stale motion hold when support disagreement is large', () => {
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
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
  service.templateRegion = { x: 30, y: 20, width: 60, height: 50 };
  service.trackingRegion = { x: 24, y: 14, width: 72, height: 62 };
  service.anchorTargetClass = 'cup';
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.metrics.positionFilterAdjustment = 'curved-motion-hold';
  service.objectSupportAnchorUv = { u: 0.5, v: 0.5 };

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: 'pose-dropout-recovery' });

  assert.equal(applied, true);
  assert.equal(service.metrics.objectSupportPositionCorrection, 'pose-dropout-recovery');
  assert.equal(service.metrics.objectSupportPositionSource, 'interactive-segmenter');
  assert.ok(Math.abs(service.metrics.objectSupportPositionStep - 14) < 1e-6);
  assert.ok(service.currentPosition.x < 80);
  assert.ok(service.currentPosition.x > 77);
  assert.ok(service.currentPosition.y > 36);
});

test('dense generic depth-fusion support recovery can rebuild collapsed reference landmarks', () => {
  const service = new ImageAnchorService();
  const data = new Uint8Array(80 * 140).fill(255);
  const objectSupportMask = createObjectSupportMask({
    width: 80,
    height: 140,
    data,
    source: 'interactive-segmenter',
    confidence: 0.93,
    referencePoint: { x: 40, y: 70 },
    createdAtFrame: 0,
  });

  service.setTrackingMode('depth-fusion');
  service.anchorTargetClass = 'generic-object';
  service.objectSupportMask = objectSupportMask;
  service.currentObjectSupportMask = objectSupportMask;
  service.frameIndex = 12;
  service.lastKeypointReinitializationFrame = -20;
  service.metrics.landmarkRefreshReason = 'support-recovery';
  service.metrics.landmarkRefreshFailureReason = 'no-reference-transform';
  service.metrics.activeLandmarkCount = 14;
  service.metrics.objectOwnedLandmarks = 13;
  service.metrics.poseInliers = 7;
  service.metrics.trackingSuccessRate = 1;

  assert.equal(service._shouldReinitializeAfterFailedSupportRefresh(), true);

  service.anchorTargetClass = 'can';
  assert.equal(service._shouldReinitializeAfterFailedSupportRefresh(), true);

  service.anchorTargetClass = 'cup';
  assert.equal(service._shouldReinitializeAfterFailedSupportRefresh(), false);
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
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
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

test('handled mug parametric recovery uses support correction only for lateral recentering', () => {
  const service = new ImageAnchorService({ now: () => 1040 });
  const data = new Uint8Array(200 * 160);
  for (let y = 40; y < 130; y++) {
    for (let x = 70; x < 170; x++) {
      data[y * 200 + x] = 255;
    }
  }
  const refreshedMask = createObjectSupportMask({
    width: 200,
    height: 160,
    data,
    source: 'interactive-segmenter',
    confidence: 0.92,
    referencePoint: { x: 120, y: 85 },
    createdAtFrame: 4,
  });

  service.setTrackingMode('parametric-surface');
  service.currentPosition = { x: 96, y: 108, z: 0 };
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
  service.templateRegion = { x: 40, y: 40, width: 100, height: 90 };
  service.trackingRegion = { x: 32, y: 32, width: 120, height: 110 };
  service.anchorTargetClass = 'mug';
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  service.metrics.positionFilterAdjustment = 'curved-motion-hold';
  service.objectSupportAnchorUv = { u: 0.72, v: 0.72 };

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: CURVED_OBJECT_RECOVERY_REASON });

  assert.equal(applied, true);
  assert.equal(service.metrics.objectSupportPositionCorrection, CURVED_OBJECT_RECOVERY_REASON);
  assert.ok(service.currentPosition.x > 107);
  assert.equal(service.currentPosition.y, 108);
});

test('immature handled mug recovery keeps high-active tracker position while refreshing support', () => {
  const service = new ImageAnchorService({ now: () => 1040 });
  const data = new Uint8Array(200 * 160);
  for (let y = 40; y < 130; y++) {
    for (let x = 70; x < 170; x++) {
      data[y * 200 + x] = 255;
    }
  }
  const refreshedMask = createObjectSupportMask({
    width: 200,
    height: 160,
    data,
    source: 'interactive-segmenter',
    confidence: 0.92,
    referencePoint: { x: 120, y: 85 },
    createdAtFrame: 4,
  });

  service.setTrackingMode('parametric-surface');
  service.currentPosition = { x: 160, y: 108, z: 0 };
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
  service.templateRegion = { x: 40, y: 40, width: 100, height: 90 };
  service.trackingRegion = { x: 32, y: 32, width: 120, height: 110 };
  service.anchorTargetClass = 'mug';
  service.metrics.reconstructionMatureLandmarks = 0;
  service.metrics.activeLandmarkCount = 29;
  service.objectSupportAnchorUv = { u: 0.32, v: 0.72 };

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: 'pose-dropout-recovery' });

  assert.equal(applied, true);
  assert.deepEqual(service.currentPosition, { x: 160, y: 108, z: 0 });
  assert.equal(service.metrics.objectSupportPositionCorrection, null);
  assert.equal(service.metrics.objectSupportMaskSource, 'interactive-segmenter');
});

test('every unready dense handled-mug mode keeps high-active tracker position during support refresh', () => {
  for (const trackingMode of ['parametric-surface', 'direct-photometric', 'depth-fusion']) {
    const service = new ImageAnchorService();
    service.setTrackingMode(trackingMode);
    service.anchorTargetClass = 'handled mug';
    service.metrics.reconstructionReady = false;
    service.metrics.reconstructionMatureLandmarks = trackingMode === 'depth-fusion' ? 551 : 0;
    service.metrics.activeLandmarkCount = 29;

    assert.equal(service._shouldKeepTrackerPositionDuringSupportRecovery('pose-dropout-recovery'), true);
  }
});

test('immature handled mug recovery caps low-active support recentering', () => {
  const service = new ImageAnchorService({ now: () => 1040 });
  const data = new Uint8Array(200 * 160);
  for (let y = 40; y < 130; y++) {
    for (let x = 70; x < 170; x++) {
      data[y * 200 + x] = 255;
    }
  }
  const refreshedMask = createObjectSupportMask({
    width: 200,
    height: 160,
    data,
    source: 'interactive-segmenter',
    confidence: 0.92,
    referencePoint: { x: 120, y: 85 },
    createdAtFrame: 4,
  });

  service.setTrackingMode('parametric-surface');
  service.currentPosition = { x: 160, y: 108, z: 0 };
  service.currentPlanarTransform = {
    scale: 1,
    rotation: 0,
    confidence: 1,
    inlierCount: 20,
    method: 'created',
  };
  service.templateRegion = { x: 40, y: 40, width: 100, height: 90 };
  service.trackingRegion = { x: 32, y: 32, width: 120, height: 110 };
  service.anchorTargetClass = 'mug';
  service.metrics.reconstructionMatureLandmarks = 0;
  service.metrics.activeLandmarkCount = 14;
  service.objectSupportAnchorUv = { u: 0.32, v: 0.72 };

  const applied = service.updateObjectSupportMask(refreshedMask, { reason: 'pose-dropout-recovery' });

  assert.equal(applied, true);
  assert.equal(service.metrics.objectSupportPositionCorrection, 'pose-dropout-recovery');
  assert.ok(Math.abs(service.metrics.objectSupportPositionStep - 6) < 1e-6);
  assert.ok(service.currentPosition.y < 108);
  assert.ok(service.currentPosition.y > 107);
});

test('sparse cup recovery refreshes support without recentering the anchor', () => {
  const service = new ImageAnchorService();
  const objectSupportMask = {
    bbox: { x: 12, y: 16, width: 80, height: 72 },
  };

  service.anchorTargetClass = 'cup';
  service.setTrackingMode('sparse-reconstruction');

  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    0,
  );

  service.anchorTargetClass = 'generic-object';
  service.currentObjectSupportMask = {
    bbox: { x: 12, y: 16, width: 56, height: 80 },
  };
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    6,
  );
});

test('depth-fusion cup recovery uses a conservative support recentering cap', () => {
  const service = new ImageAnchorService();
  const objectSupportMask = {
    bbox: { x: 12, y: 16, width: 80, height: 72 },
  };

  service.anchorTargetClass = 'cup';
  service.setTrackingMode('depth-fusion');
  service.metrics.reconstructionTrackerDelta = 4;

  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    5,
  );

  service.metrics.reconstructionTrackerDelta = 18;
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    5,
  );
});

test('bootstrap sparse cylinder recovery uses a conservative support recentering cap', () => {
  const service = new ImageAnchorService();
  const objectSupportMask = {
    bbox: { x: 12, y: 16, width: 80, height: 72 },
  };

  service.anchorTargetClass = 'can';
  service.setTrackingMode('sparse-reconstruction');
  service.metrics.reconstructionReady = false;

  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    7,
  );
});

test('mature sparse cylinder recovery leaves room for same-frame tracked motion', () => {
  const service = new ImageAnchorService();
  const objectSupportMask = {
    bbox: { x: 12, y: 16, width: 80, height: 72 },
  };

  service.anchorTargetClass = 'can';
  service.setTrackingMode('sparse-reconstruction');
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMatureLandmarks = 24;
  service.metrics.poseAverageResidual = 4;

  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    9,
  );
});

test('handled mug support correction caps follow reconstruction mode ownership', () => {
  const service = new ImageAnchorService();
  const objectSupportMask = {
    bbox: { x: 12, y: 16, width: 80, height: 72 },
  };

  service.anchorTargetClass = 'mug';

  service.setTrackingMode('sparse-reconstruction');
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 0);
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    6,
  );

  service.setTrackingMode('depth-fusion');
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 0);
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    4,
  );

  service.setTrackingMode('parametric-surface');
  service.metrics.reconstructionMatureLandmarks = 16;
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 0);
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    12,
  );

  service.setTrackingMode('direct-photometric');
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 0);
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    2,
  );

  service.anchorTargetClass = 'cup';
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 0);
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    14,
  );

  service.anchorTargetClass = 'bottle';
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 0);
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    10,
  );

  service.anchorTargetClass = 'can';
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 0);
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    10,
  );

  service.anchorTargetClass = 'generic-object';
  service.setTrackingMode('direct-photometric');
  assert.equal(
    service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask, 'pose-dropout-recovery'),
    0,
  );

  service.anchorTargetClass = 'bag';
  assert.equal(service._getObjectSupportPositionCorrectionMaxStep(objectSupportMask), 6);

  service.anchorTargetClass = 'person';
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
    getCentroidAnchorPosition: (points) => ({
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

const createRefreshDecisionService = (metrics) => {
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

  assert.equal(
    service._shouldRefreshKeypoints({
      overallQuality: 0.36,
      poseInliers: 0,
    }),
    true,
  );
  assert.equal(service.metrics.landmarkRefreshReason, 'object-support-recovery');
});

test('fully object-owned sparse support does not bypass refresh cadence', () => {
  const service = createRefreshDecisionService({
    objectOwnedLandmarks: 9,
  });

  assert.equal(
    service._shouldRefreshKeypoints({
      overallQuality: 0.36,
      poseInliers: 0,
    }),
    false,
  );
  assert.equal(service.metrics.landmarkRefreshReason, null);
});

test('rigid planar tracking defers low-support growth without direct planar geometry', () => {
  const service = createRefreshDecisionService({
    trackingSuccessRate: 0.64,
    keypointCount: 15,
    activeLandmarkCount: 15,
    objectOwnedLandmarks: 15,
    homographyInliers: 0,
    landmarkCount: 70,
  });
  service.anchorTargetClass = 'card';

  assert.equal(
    service._shouldRefreshKeypoints({
      overallQuality: 0.52,
      poseInliers: 8,
    }),
    false,
  );
  assert.equal(service.metrics.landmarkRefreshReason, null);

  service.metrics.homographyInliers = 8;
  assert.equal(
    service._shouldRefreshKeypoints({
      overallQuality: 0.52,
      poseInliers: 8,
    }),
    true,
  );
  assert.equal(service.metrics.landmarkRefreshReason, 'occlusion-support');

  service.metrics.homographyInliers = 0;
  service.anchorTargetClass = 'cup';
  assert.equal(
    service._shouldRefreshKeypoints({
      overallQuality: 0.52,
      poseInliers: 8,
    }),
    true,
  );
  assert.equal(service.metrics.landmarkRefreshReason, 'occlusion-support');
});

test('mature rigid-planar map with sparse active support triggers descriptor relocalization before LK failure', () => {
  const service = new ImageAnchorService();
  service.relocalizer = {
    hasKeyframes: () => true,
  };
  service.anchorTargetClass = 'card';
  Object.assign(service.metrics, {
    keypointCount: 15,
    landmarkCount: 70,
  });

  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 10,
      averageResidual: 7,
      confidence: 0.5,
    }),
    true,
  );
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 10,
      averageResidual: 6.5,
      confidence: 0.5,
    }),
    true,
  );

  service.metrics.landmarkCount = 69;
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 10,
      averageResidual: 7,
      confidence: 0.5,
    }),
    false,
  );

  Object.assign(service.metrics, {
    keypointCount: 18,
    landmarkCount: 70,
  });
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 10,
      averageResidual: 7,
      confidence: 0.5,
    }),
    false,
  );

  service.metrics.keypointCount = 15;
  service.anchorTargetClass = 'cup';
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 10,
      averageResidual: 7,
      confidence: 0.5,
    }),
    false,
  );
});

test('ready direct mug relocalizes a deformed reference before active support collapses', () => {
  const service = new ImageAnchorService();
  service.relocalizer = {
    hasKeyframes: () => true,
  };
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'handled mug';
  Object.assign(service.metrics, {
    keypointCount: 24,
    landmarkCount: 76,
    reconstructionReady: true,
  });

  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 18,
      averageResidual: 24,
      confidence: 0.42,
    }),
    true,
  );

  service.metrics.keypointCount = 25;
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 18,
      averageResidual: 24,
      confidence: 0.42,
    }),
    false,
  );

  service.metrics.keypointCount = 24;
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 18,
      averageResidual: 23.99,
      confidence: 0.42,
    }),
    false,
  );

  service.metrics.reconstructionReady = false;
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 18,
      averageResidual: 24,
      confidence: 0.42,
    }),
    false,
  );
});

test('ready sparse mug relocalizes catastrophic reference drift while its 3D pose still has support', () => {
  const service = new ImageAnchorService();
  service.relocalizer = {
    hasKeyframes: () => true,
  };
  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'handled mug';
  Object.assign(service.metrics, {
    keypointCount: 32,
    landmarkCount: 76,
    reconstructionReady: true,
    reconstructionPoseInliers: 12,
  });

  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 18,
      averageResidual: 40,
      confidence: 0,
    }),
    true,
  );

  service.metrics.keypointCount = 33;
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 18,
      averageResidual: 40,
      confidence: 0,
    }),
    false,
  );

  service.metrics.keypointCount = 32;
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 18,
      averageResidual: 39.99,
      confidence: 0,
    }),
    false,
  );

  service.metrics.reconstructionPoseInliers = 7;
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 18,
      averageResidual: 40,
      confidence: 0,
    }),
    false,
  );

  service.metrics.reconstructionPoseInliers = 12;
  service.metrics.reconstructionReady = false;
  assert.equal(
    service._shouldAttemptGeometryRelocalization({
      method: 'reference_similarity_transform',
      inlierCount: 18,
      averageResidual: 40,
      confidence: 0,
    }),
    false,
  );
});

test('ready dense mugs explicitly prefer object-wide similarity recovery', () => {
  const service = new ImageAnchorService();
  service.anchorTargetClass = 'handled mug';
  service.metrics.reconstructionReady = true;

  service.setTrackingMode('depth-fusion');
  assert.equal(service._shouldPreferObjectWideTrackerSimilarity(), true);

  service.setTrackingMode('direct-photometric');
  assert.equal(service._shouldPreferObjectWideTrackerSimilarity(), true);

  service.setTrackingMode('parametric-surface');
  assert.equal(service._shouldPreferObjectWideTrackerSimilarity(), false);

  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'cup';
  assert.equal(service._shouldPreferObjectWideTrackerSimilarity(), false);

  service.anchorTargetClass = 'handled mug';
  service.metrics.reconstructionReady = false;
  assert.equal(service._shouldPreferObjectWideTrackerSimilarity(), false);
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

  assert.equal(
    service._shouldRefreshKeypoints({
      overallQuality: 0.42,
      poseInliers: 0,
    }),
    true,
  );
  assert.equal(service.metrics.landmarkRefreshReason, 'support-growth');
});

test('recent pose-dropout support refresh grows landmarks even with a mature map', () => {
  const service = createRefreshDecisionService({
    keypointCount: 14,
    activeLandmarkCount: 14,
    objectOwnedLandmarks: 14,
    reconstructionReady: true,
    reconstructionMapConfidence: 0.82,
    reconstructionMatureLandmarks: 20,
    segmentationRefreshReason: 'pose-dropout-recovery',
    segmentationRefreshFrame: 18,
  });
  service.frameIndex = 19;

  assert.equal(
    service._shouldRefreshKeypoints({
      overallQuality: 0.4,
      poseInliers: 0,
    }),
    true,
  );
  assert.equal(service.metrics.landmarkRefreshReason, 'support-recovery');
});

test('failed support refresh reinitialization is limited to recoverable support-owned targets', () => {
  const metrics = {
    keypointCount: 13,
    activeLandmarkCount: 13,
    objectOwnedLandmarks: 13,
    poseInliers: 0,
    landmarkRefreshReason: 'support-recovery',
    landmarkRefreshFailureReason: 'no-reference-transform',
  };
  const eligible = createRefreshDecisionService(metrics);
  eligible.trackingMode = 'sparse-reconstruction';
  eligible.anchorTargetClass = 'can';
  eligible.frameIndex = 24;

  assert.equal(eligible._shouldReinitializeAfterFailedSupportRefresh(), true);

  const generic = createRefreshDecisionService(metrics);
  generic.trackingMode = 'sparse-reconstruction';
  generic.anchorTargetClass = 'generic-object';
  generic.objectSupportMask = createObjectSupportMask({
    width: 120,
    height: 240,
    data: new Uint8Array(120 * 240).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 60, y: 120 },
    createdAtFrame: 0,
  });
  generic.frameIndex = 24;
  assert.equal(generic._shouldReinitializeAfterFailedSupportRefresh(), true);

  const sparseGeneric = createRefreshDecisionService(metrics);
  sparseGeneric.trackingMode = 'sparse-reconstruction';
  sparseGeneric.anchorTargetClass = 'generic-object';
  sparseGeneric.objectSupportMask = createObjectSupportMask({
    width: 120,
    height: 240,
    data: (() => {
      const data = new Uint8Array(120 * 240);
      for (let y = 0; y < 240; y++) {
        data[y * 120 + 20] = 255;
        data[y * 120 + 100] = 255;
      }
      return data;
    })(),
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 60, y: 120 },
    createdAtFrame: 0,
  });
  sparseGeneric.frameIndex = 24;
  assert.equal(sparseGeneric._shouldReinitializeAfterFailedSupportRefresh(), false);

  const dense = createRefreshDecisionService(metrics);
  dense.trackingMode = 'depth-fusion';
  dense.anchorTargetClass = 'can';
  dense.frameIndex = 24;
  assert.equal(dense._shouldReinitializeAfterFailedSupportRefresh(), true);

  const denseActiveCan = createRefreshDecisionService({
    ...metrics,
    keypointCount: 22,
    activeLandmarkCount: 22,
    objectOwnedLandmarks: 21,
  });
  denseActiveCan.trackingMode = 'depth-fusion';
  denseActiveCan.anchorTargetClass = 'can';
  denseActiveCan.frameIndex = 24;
  assert.equal(denseActiveCan._shouldReinitializeAfterFailedSupportRefresh(), true);

  const sparseActiveCan = createRefreshDecisionService({
    ...metrics,
    keypointCount: 22,
    activeLandmarkCount: 22,
    objectOwnedLandmarks: 21,
  });
  sparseActiveCan.trackingMode = 'sparse-reconstruction';
  sparseActiveCan.anchorTargetClass = 'can';
  sparseActiveCan.frameIndex = 24;
  assert.equal(sparseActiveCan._shouldReinitializeAfterFailedSupportRefresh(), false);

  const depthCup = createRefreshDecisionService(metrics);
  depthCup.trackingMode = 'depth-fusion';
  depthCup.anchorTargetClass = 'cup';
  depthCup.frameIndex = 24;
  assert.equal(depthCup._shouldReinitializeAfterFailedSupportRefresh(), false);

  const direct = createRefreshDecisionService(metrics);
  direct.trackingMode = 'direct-photometric';
  direct.anchorTargetClass = 'can';
  direct.frameIndex = 24;
  assert.equal(direct._shouldReinitializeAfterFailedSupportRefresh(), true);

  const mug = createRefreshDecisionService(metrics);
  mug.trackingMode = 'sparse-reconstruction';
  mug.anchorTargetClass = 'mug';
  mug.frameIndex = 24;
  assert.equal(mug._shouldReinitializeAfterFailedSupportRefresh(), false);

  for (const trackingMode of ['parametric-surface', 'direct-photometric', 'depth-fusion']) {
    const immatureMug = createRefreshDecisionService({
      ...metrics,
      reconstructionReady: false,
      reconstructionMatureLandmarks: 0,
    });
    immatureMug.trackingMode = trackingMode;
    immatureMug.anchorTargetClass = 'handled mug';
    immatureMug.frameIndex = 24;
    assert.equal(immatureMug._shouldReinitializeAfterFailedSupportRefresh(), true, trackingMode);
  }

  const unreadyDenseMug = createRefreshDecisionService({
    ...metrics,
    reconstructionReady: false,
    reconstructionMatureLandmarks: 551,
  });
  unreadyDenseMug.trackingMode = 'depth-fusion';
  unreadyDenseMug.anchorTargetClass = 'handled mug';
  unreadyDenseMug.frameIndex = 24;
  assert.equal(unreadyDenseMug._shouldReinitializeAfterFailedSupportRefresh(), true);

  const matureMug = createRefreshDecisionService({
    ...metrics,
    reconstructionReady: true,
    reconstructionMatureLandmarks: 20,
  });
  matureMug.trackingMode = 'parametric-surface';
  matureMug.anchorTargetClass = 'handled mug';
  matureMug.frameIndex = 24;
  assert.equal(matureMug._shouldReinitializeAfterFailedSupportRefresh(), false);

  const person = createRefreshDecisionService(metrics);
  person.trackingMode = 'sparse-reconstruction';
  person.anchorTargetClass = 'person';
  person.frameIndex = 24;
  assert.equal(person._shouldReinitializeAfterFailedSupportRefresh(), false);

  eligible.lastKeypointReinitializationFrame = 20;
  assert.equal(eligible._shouldReinitializeAfterFailedSupportRefresh(), false);
});

test('immature handled-mug recovery keeps only motion-aligned tracker displacement', () => {
  const service = new ImageAnchorService({ now: () => 1300 });
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'handled mug';
  service.currentPosition = { x: 347, y: 250, z: 0 };
  service.objectSupportMask = createObjectSupportMask({
    width: 200,
    height: 200,
    data: new Uint8Array(200 * 200).fill(255),
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 100, y: 100 },
    createdAtFrame: 0,
  });
  service.metrics = {
    trackingSuccessRate: 0.72,
    keypointCount: 11,
    activeLandmarkCount: 11,
    objectOwnedLandmarks: 11,
    poseInliers: 0,
    reconstructionReady: false,
    reconstructionMatureLandmarks: 0,
    landmarkRefreshReason: 'support-recovery',
    landmarkRefreshFailureReason: 'no-reference-transform',
  };
  service.frameIndex = 24;
  service.curvedMotionSample = {
    position: { x: 345, y: 260 },
    velocity: { x: 0.04, y: 0 },
    timestamp: 1100,
    confidence: 0.64,
  };

  assert.deepEqual(
    service._createSupportRecoveryPosition({
      x: 369,
      y: 227,
      z: 0,
      inlierCount: 10,
    }),
    { x: 369, y: 250, z: 0 },
  );

  assert.equal(
    service._createSupportRecoveryPosition({
      x: 330,
      y: 250,
      z: 0,
      inlierCount: 10,
    }),
    null,
  );

  service.curvedMotionSample.timestamp = 1000;
  assert.equal(
    service._createSupportRecoveryPosition({
      x: 369,
      y: 227,
      z: 0,
      inlierCount: 10,
    }),
    null,
  );
});

test('segmentation refresh markers survive the next frame for async recovery', () => {
  const service = new ImageAnchorService();
  service.metrics.segmentationRefreshReason = 'pose-dropout-recovery';
  service.metrics.segmentationRefreshFrame = 8;
  service.metrics.keypointReinitializationResult = 'reinitialized';
  service.metrics.landmarkRefreshReason = 'support-recovery';
  service.metrics.landmarkRefreshAdded = 12;
  service.metrics.landmarkRefreshFailureReason = 'no-reference-transform';
  service.metrics.landmarkRefreshCoverageBefore = 0.25;
  service.metrics.landmarkRefreshCoverageAfter = 0.5;
  service.metrics.landmarkRefreshCoverageCellCount = 8;
  service.metrics.landmarkRefreshOccupiedBefore = 2;
  service.metrics.landmarkRefreshOccupiedAfter = 4;
  service.metrics.landmarkRefreshCandidateCount = 12;
  service.metrics.landmarkRefreshGfttCallCount = 2;
  service.metrics.landmarkRefreshGfttPixelCount = 4800;
  service.metrics.landmarkRefreshGfttPreparationCount = 1;
  service.metrics.keypointReinitializationGfttCallCount = 1;
  service.metrics.keypointReinitializationGfttPixelCount = 2400;
  service.metrics.keypointReinitializationGfttPreparationCount = 1;
  service.metrics.posePositionRole = 'tracker';
  service.metrics.posePositionReason = 'tracker-fallback';
  service.metrics.normalPoseRejectedCandidates = {
    'sparse-reconstruction': 'weak-normal-innovation',
  };
  service.metrics.relocalizationKeyframes = 4;
  service.metrics.relocalizationKeyframeResult = 'stored';
  service.metrics.relocalizationKeyframeReason = 'accepted-novel-view';
  service.frameIndex = 9;

  service._resetFrameMetrics();
  assert.equal(service.metrics.segmentationRefreshReason, 'pose-dropout-recovery');
  assert.equal(service.metrics.segmentationRefreshFrame, 8);
  assert.equal(service.metrics.keypointReinitializationResult, null);
  assert.equal(service.metrics.landmarkRefreshReason, null);
  assert.equal(service.metrics.landmarkRefreshAdded, 0);
  assert.equal(service.metrics.landmarkRefreshFailureReason, null);
  assert.equal(service.metrics.landmarkRefreshCoverageBefore, null);
  assert.equal(service.metrics.landmarkRefreshCoverageAfter, null);
  assert.equal(service.metrics.landmarkRefreshCoverageCellCount, null);
  assert.equal(service.metrics.landmarkRefreshOccupiedBefore, null);
  assert.equal(service.metrics.landmarkRefreshOccupiedAfter, null);
  assert.equal(service.metrics.landmarkRefreshCandidateCount, null);
  assert.equal(service.metrics.landmarkRefreshGfttCallCount, null);
  assert.equal(service.metrics.landmarkRefreshGfttPixelCount, null);
  assert.equal(service.metrics.landmarkRefreshGfttPreparationCount, null);
  assert.equal(service.metrics.keypointReinitializationGfttCallCount, null);
  assert.equal(service.metrics.keypointReinitializationGfttPixelCount, null);
  assert.equal(service.metrics.keypointReinitializationGfttPreparationCount, null);
  assert.equal(service.metrics.posePositionRole, null);
  assert.equal(service.metrics.posePositionReason, null);
  assert.deepEqual(service.metrics.normalPoseRejectedCandidates, {});
  assert.equal(service.metrics.relocalizationKeyframes, 4);
  assert.equal(service.metrics.relocalizationKeyframeResult, null);
  assert.equal(service.metrics.relocalizationKeyframeReason, null);

  service.frameIndex = 11;
  service._resetFrameMetrics();
  assert.equal(service.metrics.segmentationRefreshReason, null);
  assert.equal(service.metrics.segmentationRefreshFrame, null);
});

test('mature reconstruction map blocks sparse support recovery refresh', () => {
  const service = createRefreshDecisionService({
    objectOwnedLandmarks: 8,
    reconstructionReady: true,
    reconstructionMapConfidence: 0.72,
    reconstructionMatureLandmarks: 24,
  });

  assert.equal(
    service._shouldRefreshKeypoints({
      overallQuality: 0.36,
      poseInliers: 0,
    }),
    false,
  );
  assert.equal(service.metrics.landmarkRefreshReason, null);
});

test('fresh support-recovery landmarks use map probation only for depth-fusion cups', () => {
  const service = new ImageAnchorService();
  service.metrics.landmarkRefreshReason = 'support-recovery';
  service.anchorTargetClass = 'cup';
  service.trackingMode = 'depth-fusion';
  assert.equal(service._shouldQuarantineFreshRecoveryLandmarks(), true);

  service.trackingMode = 'sparse-reconstruction';
  assert.equal(service._shouldQuarantineFreshRecoveryLandmarks(), false);

  service.trackingMode = 'depth-fusion';
  service.anchorTargetClass = 'handled mug';
  assert.equal(service._shouldQuarantineFreshRecoveryLandmarks(), false);

  service.anchorTargetClass = 'cup';
  service.metrics.landmarkRefreshReason = 'map-growth';
  assert.equal(service._shouldQuarantineFreshRecoveryLandmarks(), false);
});

test('mature parametric handled-mug recovery derives a reference transform from the accepted attachment', () => {
  const now = 1000;
  const service = new ImageAnchorService({ now: () => now });
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'handled mug';
  service.frameIndex = 20;
  service.currentPosition = { x: 148, y: 112, z: 0 };
  service.currentPlanarTransform = {
    scale: 1.08,
    rotation: 0.2,
    confidence: 0.82,
    inlierCount: 12,
    method: 'reference_similarity_transform',
  };
  service.keypointTracker.anchorOriginalPosition = { x: 104, y: 86 };
  service.metrics = {
    landmarkRefreshReason: 'support-recovery',
    segmentationRefreshReason: 'pose-dropout-recovery',
    segmentationRefreshFrame: 19,
    reconstructionReady: true,
    reconstructionMapConfidence: 0.68,
    reconstructionMatureLandmarks: 36,
    reconstructionPoseInliers: 0,
    activeLandmarkCount: 15,
    objectOwnedLandmarks: 14,
    trackingSuccessRate: 0.9,
  };

  const transform = service._createRecoveryReferenceTransform();
  assert.equal(service.metrics.recoveryReferencePositionSource, 'current-attachment');
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  const mappedAnchor = {
    x:
      transform.tx +
      transform.scale *
        (cos * service.keypointTracker.anchorOriginalPosition.x -
          sin * service.keypointTracker.anchorOriginalPosition.y),
    y:
      transform.ty +
      transform.scale *
        (sin * service.keypointTracker.anchorOriginalPosition.x +
          cos * service.keypointTracker.anchorOriginalPosition.y),
  };

  assert.ok(Math.abs(mappedAnchor.x - service.currentPosition.x) < 1e-9);
  assert.ok(Math.abs(mappedAnchor.y - service.currentPosition.y) < 1e-9);

  service.curvedMotionSample = {
    position: { x: 148, y: 112 },
    velocity: { x: 0.16, y: -0.03 },
    timestamp: 966.67,
    confidence: 0.76,
  };
  const predictedTransform = service._createRecoveryReferenceTransform();
  assert.equal(service.metrics.recoveryReferencePositionSource, 'curved-motion-prediction');
  const predictedAnchor = {
    x:
      predictedTransform.tx +
      predictedTransform.scale *
        (cos * service.keypointTracker.anchorOriginalPosition.x -
          sin * service.keypointTracker.anchorOriginalPosition.y),
    y:
      predictedTransform.ty +
      predictedTransform.scale *
        (sin * service.keypointTracker.anchorOriginalPosition.x +
          cos * service.keypointTracker.anchorOriginalPosition.y),
  };

  assert.ok(predictedAnchor.x > service.currentPosition.x + 5);
  assert.ok(predictedAnchor.y < service.currentPosition.y);

  service.anchorTargetClass = 'cup';
  assert.equal(service._createRecoveryReferenceTransform(), null);
});

test('established parametric can maps expose a recovery reference only after multi-view evidence', () => {
  const service = new ImageAnchorService({ now: () => 1000 });
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'glossy can';
  service.frameIndex = 30;
  service.currentPosition = { x: 148, y: 112, z: 0 };
  service.currentPlanarTransform = {
    scale: 1.08,
    rotation: 0.2,
    confidence: 0.82,
    inlierCount: 12,
    method: 'reference_similarity_transform',
  };
  service.keypointTracker.anchorOriginalPosition = { x: 104, y: 86 };
  service.metrics = {
    landmarkRefreshReason: 'support-recovery',
    segmentationRefreshReason: 'pose-dropout-recovery',
    segmentationRefreshFrame: 29,
    reconstructionReady: true,
    reconstructionMapConfidence: 0.68,
    reconstructionMatureLandmarks: 36,
    reconstructionPoseInliers: 0,
    reconstructionFrames: 11,
    activeLandmarkCount: 15,
    objectOwnedLandmarks: 14,
    trackingSuccessRate: 0.9,
  };

  assert.equal(service._createRecoveryReferenceTransform(), null);

  service.metrics.reconstructionFrames = 12;
  const transform = service._createRecoveryReferenceTransform();

  assert.ok(transform);
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  assert.ok(
    Math.abs(
      transform.tx +
        transform.scale *
          (cos * service.keypointTracker.anchorOriginalPosition.x -
            sin * service.keypointTracker.anchorOriginalPosition.y) -
        service.currentPosition.x,
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      transform.ty +
        transform.scale *
          (sin * service.keypointTracker.anchorOriginalPosition.x +
            cos * service.keypointTracker.anchorOriginalPosition.y) -
        service.currentPosition.y,
    ) < 1e-9,
  );
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
  let refreshPlanOptions = null;
  let receivedMask = null;
  const anchorPositionEvaluation = {
    attachmentEvidence: { frame: 11 },
  };

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
    planKeypointRefresh: (cv, options) => {
      refreshPlanOptions = options;
      return {
        kind: 'reference',
        transform: { tx: 0, ty: 0, scale: 1, rotation: 0 },
        source: 'tracked-landmarks',
        activeCount: 12,
        total: 17,
      };
    },
    refreshKeypoints: ({
      plan,
      objectSupportMask: refreshMask,
      adaptive,
      minNewKeypoints,
      admission,
      candidateOrder,
    }) => {
      receivedMask = refreshMask;
      refreshOptions = { adaptive, minNewKeypoints, admission, candidateOrder };
      return {
        success: true,
        status: 'refreshed',
        added: 5,
        recovered: 0,
        probationaryAdded: 0,
        total: 17,
        active: 17,
        rejectedByMask: 11,
        candidateCount: 24,
        gfttCallCount: 1,
        gfttPixelCount: 5400,
        gfttPreparationCount: 1,
        referenceTransformSource: plan.source,
        reason: null,
        coverageBefore: 0.25,
        coverageAfter: 0.5,
        coverageCellCount: 8,
        coverageOccupiedBefore: 2,
        coverageOccupiedAfter: 4,
      };
    },
  });
  service._storeRelocalizationKeyframe = () => {};

  service._refreshKeypoints(
    { cols: 120, rows: 100 },
    {
      adaptive: true,
      minNewKeypoints: 8,
      anchorPositionEvaluation,
    },
  );

  assert.equal(receivedMask, objectSupportMask);
  assert.equal(refreshPlanOptions.attachmentEvidence, anchorPositionEvaluation.attachmentEvidence);
  assert.deepEqual(refreshOptions, {
    adaptive: true,
    minNewKeypoints: 8,
    admission: 'routine-refresh',
    candidateOrder: 'response-ranked',
  });
  assert.equal(service.metrics.landmarkRefreshAdded, 5);
  assert.equal(service.metrics.landmarkRefreshRejectedByMask, 11);
  assert.equal(service.metrics.landmarkRefreshCoverageBefore, 0.25);
  assert.equal(service.metrics.landmarkRefreshCoverageAfter, 0.5);
  assert.equal(service.metrics.landmarkRefreshCoverageCellCount, 8);
  assert.equal(service.metrics.landmarkRefreshOccupiedBefore, 2);
  assert.equal(service.metrics.landmarkRefreshOccupiedAfter, 4);
  assert.equal(service.metrics.landmarkRefreshGfttCallCount, 1);
  assert.equal(service.metrics.landmarkRefreshGfttPixelCount, 5400);
  assert.equal(service.metrics.landmarkRefreshGfttPreparationCount, 1);

  service.metrics.landmarkRefreshReason = 'map-growth';
  service._refreshKeypoints({ cols: 120, rows: 100 });
  assert.equal(refreshOptions.candidateOrder, 'mask-coverage');
});

test('service skips real adaptive GFTT when a blocked refresh has no recovery consumer', async () => {
  const cv = await loadOpenCvForNode();
  const service = new ImageAnchorService();
  const detector = new KeypointDetector();
  await detector.initialize(cv);
  await service.keypointTracker.initialize(cv);
  service.cv = cv;
  service.keypointDetector = detector;
  service.currentPosition = { x: 100, y: 80, z: 0 };
  service.templateRegion = { x: 30, y: 20, width: 140, height: 120 };
  service.metrics = {
    trackingSuccessRate: 0.7,
    activeLandmarkCount: 2,
    objectOwnedLandmarks: 2,
    landmarkRefreshReason: 'mapping-growth',
  };
  service.keypointTracker.trackedPoints = [
    {
      id: 0,
      original: { x: 80, y: 80 },
      current: { x: 80, y: 80 },
      status: 'active',
      objectOwnedStreak: 2,
    },
    {
      id: 1,
      original: { x: 92, y: 82 },
      current: { x: 92, y: 82 },
      status: 'active',
      objectOwnedStreak: 2,
    },
  ];
  const gray = new cv.Mat(180, 220, cv.CV_8UC1);
  for (let y = 0; y < gray.rows; y++) {
    for (let x = 0; x < gray.cols; x++) {
      gray.data[y * gray.cols + x] = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0;
    }
  }
  const extractKeypoints = detector.extractKeypoints.bind(detector);
  let gfttCallCount = 0;
  detector.extractKeypoints = (...args) => {
    gfttCallCount++;
    return extractKeypoints(...args);
  };

  try {
    const outcome = service._refreshKeypoints(gray, {
      adaptive: true,
      minNewKeypoints: 8,
    });

    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.reason, 'no-reference-transform');
    assert.equal(outcome.candidateCount, null);
    assert.equal(outcome.gfttCallCount, 0);
    assert.equal(outcome.gfttPreparationCount, 0);
    assert.equal(gfttCallCount, 0);
    assert.equal(service.metrics.landmarkRefreshCandidateCount, null);
    assert.equal(service.metrics.landmarkRefreshGfttCallCount, 0);
    assert.equal(service.metrics.landmarkRefreshGfttPixelCount, 0);
    assert.equal(service.metrics.landmarkRefreshGfttPreparationCount, 0);
  } finally {
    gray.delete();
    service.keypointTracker.dispose();
  }
});

test('service defers no-reference candidate extraction to the reinitialization consumer', () => {
  const service = new ImageAnchorService();
  service.cv = {};
  service.currentPosition = { x: 100, y: 80, z: 0 };
  service.templateRegion = { x: 30, y: 20, width: 140, height: 120 };
  service.metrics.landmarkRefreshReason = 'support-recovery';
  service._isSupportRefreshReinitializationEligible = () => true;
  Object.assign(service.keypointTracker, {
    planKeypointRefresh: () => ({
      kind: 'no-reference',
      activeCount: 3,
      total: 9,
    }),
    refreshKeypoints: () => {
      assert.fail('tracker extraction must be owned by the sole candidate consumer');
    },
  });

  const outcome = service._refreshKeypoints({ cols: 220, rows: 180 });

  assert.deepEqual(outcome, {
    success: false,
    status: 'reinitialization-required',
    added: 0,
    recovered: 0,
    probationaryAdded: 0,
    rejectedByMask: 0,
    total: 9,
    active: 3,
    candidateCount: null,
    gfttCallCount: 0,
    gfttPixelCount: 0,
    gfttPreparationCount: 0,
    minNewKeypoints: 15,
    referenceTransformSource: null,
    reason: 'no-reference-transform',
  });
});

test('keypoint reinitialization reports actual failure and resets reconstruction only on success', () => {
  const service = new ImageAnchorService();
  service.cv = {};
  service.currentPosition = { x: 60, y: 50, z: 0 };
  service.templateRegion = { x: 20, y: 20, width: 80, height: 60 };
  service.framesSinceRefresh = 9;
  service.lastKeypointReinitializationFrame = -20;
  let reconstructionResets = 0;
  service.reconstructor = {
    reset: () => {
      reconstructionResets++;
    },
    getState: () => ({
      state: 'mapping',
      ready: false,
      frameCount: 0,
      landmarkCount: 0,
      preview: null,
    }),
  };
  service._extractObjectKeypoints = () => ({
    keypoints: Array.from({ length: 7 }, (_, index) => ({
      pt: { x: 30 + index * 4, y: 40 },
      response: 1,
    })),
    gfttCallCount: 2,
    gfttPixelCount: 9600,
    gfttPreparationCount: 1,
  });

  const failed = service._reinitializeKeypoints(
    { cols: 120, rows: 100 },
    {
      minKeypoints: 8,
      objectSupportMask: null,
      resetReconstruction: true,
      reason: 'test-recovery',
    },
  );

  assert.deepEqual(failed, {
    success: false,
    status: 'insufficient-candidates',
    candidateCount: 7,
    gfttCallCount: 2,
    gfttPixelCount: 9600,
    gfttPreparationCount: 1,
  });
  assert.equal(service.framesSinceRefresh, 9);
  assert.equal(service.lastKeypointReinitializationFrame, -20);
  assert.equal(reconstructionResets, 0);
  assert.equal(service.metrics.keypointReinitializationGfttCallCount, 2);
  assert.equal(service.metrics.keypointReinitializationGfttPixelCount, 9600);
  assert.equal(service.metrics.keypointReinitializationGfttPreparationCount, 1);

  let initializedKeypoints = 0;
  service.keypointTracker.initializeTracking = (cv, keypoints) => {
    initializedKeypoints = keypoints.length;
  };
  service._recordLandmarkMetrics = () => {};
  service._extractObjectKeypoints = () => ({
    keypoints: Array.from({ length: 8 }, (_, index) => ({
      pt: { x: 30 + index * 4, y: 40 },
      response: 1,
    })),
    gfttCallCount: 1,
    gfttPixelCount: 4800,
    gfttPreparationCount: 1,
  });

  const succeeded = service._reinitializeKeypoints(
    { cols: 120, rows: 100 },
    {
      minKeypoints: 8,
      objectSupportMask: null,
      resetReconstruction: true,
      reason: 'test-recovery',
    },
  );

  assert.equal(succeeded.success, true);
  assert.equal(succeeded.status, 'reinitialized');
  assert.equal(succeeded.reconstructionReset, true);
  assert.equal(succeeded.gfttCallCount, 1);
  assert.equal(succeeded.gfttPixelCount, 4800);
  assert.equal(succeeded.gfttPreparationCount, 1);
  assert.equal(initializedKeypoints, 8);
  assert.equal(reconstructionResets, 1);
});

test('support recovery reinitialization shares the current frame position envelope', () => {
  const service = new ImageAnchorService({ now: () => 1040 });
  service.setTrackingMode('sparse-reconstruction');
  service.cv = {};
  service.currentPosition = { x: 68, y: 50, z: 0 };
  service.frameStartPosition = { x: 60, y: 50, z: 0 };
  service.templateRegion = { x: 0, y: 0, width: 120, height: 80 };
  service.metrics.lastUpdateResult = 'success';
  service.metrics.lastUpdateMethod = 'reference_similarity_transform';
  service._extractObjectKeypoints = () => ({
    keypoints: Array.from({ length: 8 }, (_, index) => ({
      pt: { x: 30 + index * 4, y: 40 },
      response: 1,
    })),
    gfttCallCount: 1,
    gfttPixelCount: 4800,
    gfttPreparationCount: 1,
  });
  service.keypointTracker.initializeTracking = () => {};
  service._recordLandmarkMetrics = () => {};
  service.reconstructor = {
    reset: () => {},
    getState: () => ({
      state: 'mapping',
      ready: false,
      frameCount: 0,
      landmarkCount: 0,
      preview: null,
    }),
  };

  const result = service._reinitializeKeypoints(
    { cols: 120, rows: 100 },
    {
      minKeypoints: 8,
      objectSupportMask: null,
      anchorPosition: { x: 96, y: 68, z: 0 },
      resetReconstruction: true,
      reason: 'support-recovery-reference-collapse',
    },
  );
  const frameStep = Math.hypot(
    service.currentPosition.x - service.frameStartPosition.x,
    service.currentPosition.y - service.frameStartPosition.y,
  );

  assert.equal(result.success, true);
  assert.equal(result.frameStepLimited, true);
  assert.ok(frameStep <= 9.6 + 1e-6);
});

test('partial-occlusion flow admission requires a present mature curved map', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'bottle';
  service.metrics = {
    targetPresent: true,
    reconstructionReady: true,
    reconstructionMapConfidence: 0.72,
    reconstructionMatureLandmarks: 28,
    poseInliers: 20,
  };
  const trackingResult = {
    success: false,
    partialFlow: {
      inlierCount: 10,
      inlierRatio: 0.83,
      averageResidual: 6.2,
      confidence: 0.48,
    },
  };

  assert.equal(service._canAdmitPartialFlow(trackingResult), true);

  service.setTrackingMode('sparse-reconstruction');
  assert.equal(service._canAdmitPartialFlow(trackingResult), false);

  service.setTrackingMode('parametric-surface');
  service.metrics.targetPresent = false;
  assert.equal(service._canAdmitPartialFlow(trackingResult), false);

  service.metrics.targetPresent = true;
  service.anchorTargetClass = 'book';
  assert.equal(service._canAdmitPartialFlow(trackingResult), false);

  service.anchorTargetClass = 'bottle';
  assert.equal(service._canAdmitPartialFlow({ success: false }), false);
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
    updateReferenceRegion: (region) => {
      reconstructorRegion = region;
    },
  };
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    planKeypointRefresh: () => ({
      kind: 'reference',
      transform: { tx: 0, ty: 0, scale: 1, rotation: 0 },
      source: 'tracked-landmarks',
      activeCount: 12,
      total: 12,
    }),
    refreshKeypoints: ({ plan, region }) => {
      refreshRegion = region;
      return {
        success: false,
        status: 'failed',
        added: 0,
        recovered: 0,
        probationaryAdded: 0,
        rejectedByMask: 0,
        total: plan.total,
        active: plan.activeCount,
        candidateCount: 0,
        gfttCallCount: 1,
        gfttPixelCount: 5400,
        gfttPreparationCount: 1,
        referenceTransformSource: plan.source,
        reason: 'insufficient-candidates',
      };
    },
  });

  assert.equal(
    service.updateObjectSupportMask(objectSupportMask, { reason: 'periodic-segmentation-refresh' }),
    true,
  );
  assert.ok(service.trackingRegion.width > 120);
  assert.ok(service.trackingRegion.height > 80);
  assert.deepEqual(service.metrics.reconstructionRegion, service.trackingRegion);
  assert.deepEqual(reconstructorRegion, service.trackingRegion);

  service._refreshKeypoints({ cols: 200, rows: 160 });

  assert.equal(refreshRegion.width, service.trackingRegion.width);
  assert.equal(refreshRegion.height, service.trackingRegion.height);
});

test('repeated segmentation refresh does not accumulate tracking-region padding', () => {
  const service = new ImageAnchorService();
  const maskData = new Uint8Array(640 * 480);
  for (let y = 190; y < 270; y++) {
    for (let x = 270; x < 370; x++) {
      maskData[y * 640 + x] = 255;
    }
  }
  const objectSupportMask = createObjectSupportMask({
    width: 640,
    height: 480,
    data: maskData,
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 320, y: 230 },
    createdAtFrame: 0,
    updatedAtFrame: 3,
  });

  service.currentPosition = { x: 320, y: 230, z: 0 };
  service.anchorTargetClass = 'card';
  service.trackingMode = 'parametric-surface';
  service.templateRegion = { x: 290, y: 200, width: 60, height: 60 };
  service.trackingRegion = { x: 280, y: 190, width: 80, height: 80 };
  service.reconstructor = { updateReferenceRegion: () => {} };

  assert.equal(
    service.updateObjectSupportMask(objectSupportMask, { reason: 'periodic-segmentation-refresh' }),
    true,
  );
  const firstRegion = { ...service.trackingRegion };
  assert.equal(
    service.updateObjectSupportMask(objectSupportMask, { reason: 'periodic-segmentation-refresh' }),
    true,
  );

  assert.deepEqual(service.trackingRegion, firstRegion);
});

test('keypoint updates expose tracked planar scale and roll for the overlay', async () => {
  const service = new ImageAnchorService();

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.cv = {};
  Object.assign(service.keypointTracker, {
    trackFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 24,
      averageError: 1.1,
    }),
    getCorrespondences: () => [],
    getObjectPose: () =>
      createObjectPose({
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
      inlierCount: 18,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);
  const state = service.getState();

  assert.equal(result.success, true);
  assert.equal(result.planarTransform.rotation, 0.37);
  assert.equal(result.planarTransform.scale, 1.32);
  assert.equal(state.planarTransform.rotation, 0.37);
  assert.equal(state.planarTransform.scale, 1.32);
});

test('planar transform smoothing dampens one-frame scale and roll jumps', () => {
  const service = new ImageAnchorService();

  const initial = service._updatePlanarTransform(
    {
      scale: 1,
      rotation: 0,
      confidence: 0.9,
      inlierCount: 24,
      method: 'reference_similarity_transform',
    },
    1000,
  );
  const jumped = service._updatePlanarTransform(
    {
      scale: 2,
      rotation: 1.2,
      confidence: 0.88,
      inlierCount: 24,
      method: 'reference_similarity_transform',
    },
    1016.67,
  );

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

  service._updatePlanarTransform(
    {
      scale: 1.12,
      rotation: 0.1,
      confidence: 0.7,
      averageResidual: 1.2,
      inlierCount: 14,
      method: 'reference_similarity_transform',
    },
    1000,
  );
  const caughtUp = service._updatePlanarTransform(
    {
      scale: 0.96,
      rotation: 0.08,
      confidence: 0.66,
      averageResidual: 1.1,
      inlierCount: 12,
      method: 'reference_similarity_transform',
    },
    1016.67,
  );

  assert.equal(caughtUp.scale, 0.96);
});

test('planar roll smoothing follows the shortest path across the wrap boundary', () => {
  const service = new ImageAnchorService();

  service._updatePlanarTransform(
    {
      scale: 1,
      rotation: Math.PI - 0.04,
      confidence: 0.9,
      inlierCount: 24,
      method: 'reference_similarity_transform',
    },
    1000,
  );
  const wrapped = service._updatePlanarTransform(
    {
      scale: 1,
      rotation: -Math.PI + 0.04,
      confidence: 0.9,
      inlierCount: 24,
      method: 'reference_similarity_transform',
    },
    1016.67,
  );

  assert.ok(wrapped.rotation > 3.0);
});

test('keypoint updates drive the overlay from the object pose model', async () => {
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
    trackFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 30,
      averageError: 1.1,
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
      inlierCount: 12,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.position.x, 214);
  assert.equal(result.position.y, 173);
  assert.equal(result.planarTransform.scale, 1.48);
  assert.equal(result.planarTransform.rotation, 0.31);
  assert.ok(result.normal.x > 0.5);
  assert.equal(result.poseSource, 'object-pose-affine');
});

test('reconstruction tracking mode drives the overlay from the sparse 3D map when ready and consistent', async () => {
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
      },
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
      objectOwnedStreak: 2,
      original: {
        x: 80 + (index % 7) * 22,
        y: 70 + Math.floor(index / 7) * 18,
      },
      current: {
        x: 92 + (index % 7) * 25,
        y: 78 + Math.floor(index / 7) * 20,
      },
    })),
    trackFrame: () => ({
      success: true,
      successRate: 0.92,
      activePointCount: 34,
      averageError: 1.1,
    }),
    getObjectPose: () =>
      createObjectPose({
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
      inlierCount: 18,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);
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

test('strong curved reconstruction can replace a drifting tracker attachment', async () => {
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
      objectOwned: true,
      objectOwnedStreak: 2,
      original: { x: 70 + (index % 8) * 18, y: 70 + Math.floor(index / 8) * 16 },
      current: { x: 84 + (index % 8) * 18, y: 82 + Math.floor(index / 8) * 16 },
    })),
    trackFrame: () => ({
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
  installAnchorPositionEvaluationStub(service.keypointTracker);
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = await service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.method, 'sparse-reconstruction');
  assert.equal(result.position.x, 236);
  assert.equal(result.position.y, 181);
  assert.equal(result.planarTransform.scale, 1.12);
  assert.equal(result.poseSource, 'sparse-reconstruction');
});

test('mature curved reconstruction can replace a moderately drifting tracker attachment', async () => {
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
    trackFrame: () => ({
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
      averageResidual: 1.5,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = await service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.method, 'direct-photometric');
  assert.equal(result.position.x, 236);
  assert.equal(result.position.y, 181);
  assert.equal(result.poseSource, 'direct-photometric');
});

test('depth-fusion keeps tracker positioning as the anchor spine', async () => {
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
    trackFrame: () => ({
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
      averageResidual: 1.5,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = await service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);
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

test('parametric planar position consensus uses arbiter scores and excludes weak tracker geometry', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'book';
  service.planarDominanceScore = 8;

  const reconstructionPose = {
    success: true,
    method: 'parametric-surface',
    position: { x: 100, y: 80, z: 0 },
    confidence: 0.9,
    averageResidual: 2,
    inlierCount: 24,
    preview: {
      surface: { model: 'plane' },
    },
  };
  const trackerAnchorPosition = {
    x: 120,
    y: 100,
    method: 'reference_similarity_transform',
  };
  const poseArbitration = {
    byRole: {
      reconstruction: {
        positionAllowed: true,
        positionScore: 0.75,
      },
      tracker: {
        positionAllowed: true,
        positionQualityRejectionReason: null,
        positionScore: 0.25,
      },
    },
  };

  assert.deepEqual(
    service._selectReconstructionPositionCandidate({
      reconstructionPose,
      poseArbitration,
      trackerAnchorPosition,
    }),
    {
      x: 105,
      y: 85,
      z: 0,
      confidence: 0.9,
      averageResidual: 2,
      inlierCount: 24,
      adjustment: 'planar-reconstruction-consensus',
    },
  );

  poseArbitration.byRole.tracker.positionQualityRejectionReason = 'weak-geometry';
  assert.deepEqual(
    service._selectReconstructionPositionCandidate({
      reconstructionPose,
      poseArbitration,
      trackerAnchorPosition,
    }),
    {
      x: 100,
      y: 80,
      z: 0,
      confidence: 0.9,
      averageResidual: 2,
      inlierCount: 24,
    },
  );
});

test('mature depth-fusion curved pose can own position when reference geometry is weak', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('depth-fusion');
  service.anchorTargetClass = 'can';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.9;
  service.metrics.reconstructionMatureLandmarks = 1400;

  const reconstructionPose = {
    success: true,
    method: 'depth-fusion',
    confidence: 0.42,
    inlierCount: 14,
    averageResidual: 5.5,
    preview: {
      surface: { model: 'depth-fusion-surfels' },
      statistics: {
        mapConfidence: 0.9,
        matureLandmarks: 1400,
      },
    },
  };
  const trackerAnchorPosition = {
    method: 'reference_similarity_transform',
    confidence: 0,
    averageResidual: 22,
  };
  const poseArbitration = {
    selectedAttachment: { source: 'depth-fusion' },
    selectedPosition: { source: 'depth-fusion' },
    byRole: {
      tracker: { positionQualityRejectionReason: 'weak-geometry' },
    },
    rejected: {
      reference_similarity_transform: { reason: 'weak-geometry' },
    },
  };
  const useArbiterReconstructionPosition = service._shouldUseArbiterReconstructionPosition({
    poseArbitration,
    reconstructionPose,
    trackerAnchorPosition,
  });

  assert.equal(useArbiterReconstructionPosition, true);
  assert.equal(
    service._shouldHoldTrackerPositionForDepthFusion({
      trackerAnchorPosition,
      reconstructionPose,
      useArbiterReconstructionPosition,
    }),
    false,
  );

  service.anchorTargetClass = 'cup';
  const useCupArbiterReconstructionPosition = service._shouldUseArbiterReconstructionPosition({
    poseArbitration,
    reconstructionPose,
    trackerAnchorPosition,
  });
  assert.equal(useCupArbiterReconstructionPosition, true);
  assert.equal(
    service._shouldHoldTrackerPositionForDepthFusion({
      trackerAnchorPosition,
      reconstructionPose,
      useArbiterReconstructionPosition: useCupArbiterReconstructionPosition,
    }),
    false,
  );

  service.anchorTargetClass = 'mug';
  assert.equal(
    service._shouldUseArbiterReconstructionPosition({
      poseArbitration,
      reconstructionPose,
      trackerAnchorPosition,
    }),
    false,
  );
  assert.equal(
    service._shouldHoldTrackerPositionForDepthFusion({
      trackerAnchorPosition,
      reconstructionPose,
      useArbiterReconstructionPosition: true,
    }),
    true,
  );
});

test('arbiter-selected planar pose owns position when reference similarity is weak', async () => {
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
    trackFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 18,
      averageError: 2,
    }),
    getAnchorPosition: () => weakTrackerAnchor,
    getCorrespondences: () => correspondences,
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.method, 'planar-homography');
  assert.equal(service.metrics.poseOverlayCandidateSource, 'planar-homography');
  assert.equal(service.metrics.posePositionCandidateSource, 'planar-homography');
  assert.equal(service.metrics.posePositionRole, 'planar');
  assert.equal(service.metrics.posePositionReason, 'planar-evidence');
  assert.equal(service.metrics.rejectedPoseCandidates.reference_similarity_transform.reason, 'weak-geometry');
});

test('parametric mug reconstruction position does not own attachment normal', () => {
  const service = new ImageAnchorService();
  const reconstructionPose = createObjectPose({
    method: 'parametric-surface',
    confidence: 0.9,
    inlierCount: 28,
    averageResidual: 1.2,
    normal: { x: 0.42, y: 0.08, z: 0.9 },
  });
  reconstructionPose.depthQuality = 0.2;
  reconstructionPose.preview = {
    statistics: {
      mapConfidence: 0.82,
      matureLandmarks: 28,
    },
    surface: { model: 'tapered-cylinder' },
  };
  const trackerAnchorPosition = {
    method: 'reference_similarity_transform',
    confidence: 0.1,
    averageResidual: 20,
  };
  const poseArbitration = {
    selectedAttachment: { source: 'parametric-surface' },
    selectedPosition: { source: 'parametric-surface' },
    byRole: {
      tracker: { positionQualityRejectionReason: 'weak-geometry' },
    },
    rejected: {
      reference_similarity_transform: { reason: 'weak-geometry' },
    },
  };

  service.setTrackingMode('parametric-surface');
  service.anchorTargetClass = 'cup';
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.82;
  service.metrics.reconstructionMatureLandmarks = 28;
  service.metrics.reconstructionTrackerDelta = 18;

  assert.equal(service._hasSelectedReconstructionPose(reconstructionPose), true);
  assert.equal(service._canSelectedReconstructionOwnAttachment(reconstructionPose), true);
  assert.equal(service._hasStrongCurvedReconstructionPosition(reconstructionPose), true);
  assert.equal(
    service._shouldUseArbiterReconstructionPosition({
      poseArbitration,
      reconstructionPose,
      trackerAnchorPosition,
    }),
    true,
  );
  assert.equal(service._shouldSkipPlanarPoseForSelectedReconstruction(reconstructionPose), true);
  assert.equal(service._shouldTrustNormalPose(reconstructionPose), true);

  service.anchorTargetClass = 'mug';

  assert.equal(service._hasSelectedReconstructionPose(reconstructionPose), true);
  assert.equal(service._canSelectedReconstructionOwnAttachment(reconstructionPose), false);
  assert.equal(service._hasStrongCurvedReconstructionPosition(reconstructionPose), true);
  assert.equal(
    service._shouldUseArbiterReconstructionPosition({
      poseArbitration,
      reconstructionPose,
      trackerAnchorPosition,
    }),
    true,
  );
  assert.equal(service._shouldSkipPlanarPoseForSelectedReconstruction(reconstructionPose), false);
  assert.equal(service._shouldTrustNormalPose(reconstructionPose), false);

  service.metrics.activeLandmarkCount = 28;
  service.metrics.objectOwnedLandmarks = 28;
  service.metrics.contourFitResidual = 0;
  service.metrics.silhouetteCoverage = 1;
  const arbitration = service._recordPoseCandidates({
    reconstructionPose,
    planarPose: null,
    objectPose: null,
    trackerAnchorPosition: null,
    reconstructionConsistentWithTracker: true,
    correspondences: [],
  });
  assert.equal(arbitration.selectedOverlay, null);
  assert.equal(arbitration.rejected['parametric-surface'].reason, 'attachment-not-owned');
});

test('curved reconstruction relaxes stale normals when pose drops out', async () => {
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
    trackFrame: () => ({
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
  installAnchorPositionEvaluationStub(service.keypointTracker);
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = await service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, true);
  assert.ok(Math.hypot(result.normal.x, result.normal.y) < Math.hypot(staleNormal.x, staleNormal.y));
});

test('planar homography dominates sparse reconstruction for flat textured objects', async () => {
  const service = new ImageAnchorService();
  const anchorReference = { x: 100, y: 100 };
  const homographyMatrix = [1.16, 0.12, 28, -0.05, 1.08, 19, 0.00035, -0.00018, 1];
  const project = (point) => {
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
    trackFrame: () => ({
      success: true,
      successRate: 0.94,
      activePointCount: 38,
      averageError: 0.9,
    }),
    getObjectPose: () =>
      createObjectPose({
        x: expectedAnchor.x,
        y: expectedAnchor.y,
        scale: 1.11,
        rotation: 0.08,
        normal: { x: 0.1, y: -0.04, z: 0.99 },
        confidence: 0.75,
        inlierCount: 24,
        foreshortening: 0.93,
      }),
    getCorrespondences: () =>
      Array.from({ length: 34 }, (_, index) => ({
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
      inlierCount: 24,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);
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
    },
  });

  const result = await service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

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

  assert.equal(
    service._shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences }),
    false,
  );
  assert.equal(
    service._shouldUsePlanarPatchTransform({ planarPose, reconstructionPose, correspondences }),
    false,
  );
  assert.equal(
    resolveNormalPose(service, {
      reconstructionPose,
      planarPose,
      objectPose: { success: false, confidence: 0 },
      poseResult: null,
      correspondences,
      reconstructionConsistentWithTracker: true,
    }).pose.method,
    'parametric-surface',
  );
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

  assert.equal(
    service._shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences }),
    true,
  );
  assert.equal(
    resolveNormalPose(service, {
      reconstructionPose,
      planarPose,
      objectPose: { success: false, confidence: 0 },
      poseResult: null,
      correspondences,
      reconstructionConsistentWithTracker: true,
    }).pose.method,
    'planar-homography',
  );
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

  assert.equal(
    service._shouldPreferPlanarHomography({ planarPose, reconstructionPose, correspondences }),
    true,
  );
  assert.equal(
    resolveNormalPose(service, {
      reconstructionPose,
      planarPose,
      objectPose: { success: false, confidence: 0 },
      poseResult: null,
      correspondences,
      reconstructionConsistentWithTracker: true,
    }).pose.method,
    'parametric-surface',
  );
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
    false,
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
    true,
  );

  assert.equal(
    cupService._shouldTrustNormalPose({
      success: true,
      method: 'parametric-surface',
      confidence: 0.95,
      inlierCount: 24,
      normal: { x: 0.99, y: 0.02, z: 0.08 },
      depthQuality: 0.08,
      preview: {
        statistics: {
          mapConfidence: 0.72,
        },
      },
    }),
    false,
  );
});

test('weak support-held sparse mug normals are not trusted fast corrections', () => {
  const service = new ImageAnchorService();
  const reconstructionPose = createObjectPose({
    method: 'sparse-reconstruction',
    confidence: 0.88,
    inlierCount: 16,
    averageResidual: 1.6,
    normal: { x: 0.46, y: -0.12, z: 0.88 },
  });
  reconstructionPose.depthQuality = 0.12;
  reconstructionPose.preview = {
    statistics: {
      mapConfidence: 0.94,
      matureLandmarks: 49,
    },
    surface: { model: 'tapered-cylinder' },
  };

  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'mug';
  service.metrics.positionFilterAdjustment = 'sparse-mug-support-correction-hold';
  service.metrics.reconstructionMapConfidence = 0.94;
  service.metrics.reconstructionMatureLandmarks = 49;

  assert.equal(service._hasStrongNonPlanarReconstruction(reconstructionPose), true);
  assert.equal(service._shouldTrustNormalPose(reconstructionPose), false);

  reconstructionPose.inlierCount = 24;
  assert.equal(service._shouldTrustNormalPose(reconstructionPose), true);

  service.metrics.reconstructionMapConfidence = 0.57;
  reconstructionPose.preview.statistics.mapConfidence = 0.57;
  assert.equal(service._shouldTrustNormalPose(reconstructionPose), false);

  service.metrics.positionFilterAdjustment = null;
  reconstructionPose.preview.statistics.mapConfidence = 0.94;
  assert.equal(service._shouldTrustNormalPose(reconstructionPose), true);
});

test('weakly observed sparse curved support rejects only a large normal innovation', () => {
  const service = new ImageAnchorService();
  const reconstructionPose = createObjectPose({
    method: 'sparse-reconstruction',
    confidence: 0.78,
    inlierCount: 14,
    averageResidual: 4.42,
    normal: { x: -0.57, y: -0.09, z: 0.81 },
  });
  reconstructionPose.depthQuality = 0.22;
  reconstructionPose.poseObs = 0.006;
  reconstructionPose.preview = {
    statistics: {
      mapConfidence: 0.94,
      matureLandmarks: 49,
    },
    surface: { model: 'tapered-cylinder' },
  };

  service.setTrackingMode('sparse-reconstruction');
  service.anchorTargetClass = 'handled mug';
  service.currentNormal = { x: 0.42, y: -0.16, z: 0.89 };
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.94;
  service.metrics.reconstructionMatureLandmarks = 49;
  service.metrics.activeLandmarkCount = 40;
  service.metrics.reconstructionTrackerDelta = 15.8;

  const weaklyObserved = service._recordPoseCandidates({
    reconstructionPose,
    planarPose: null,
    objectPose: null,
    poseResult: null,
    trackerAnchorPosition: null,
    reconstructionConsistentWithTracker: true,
    correspondences: reconstructionPose.correspondences || [],
  });

  assert.equal(weaklyObserved.byRole.reconstruction.positionAllowed, true);
  assert.equal(weaklyObserved.byRole.reconstruction.normalAllowed, false);
  assert.equal(weaklyObserved.byRole.reconstruction.normalRejectionReason, 'weak-normal-innovation');

  reconstructionPose.poseObs = 0.08;
  const supported = service._recordPoseCandidates({
    reconstructionPose,
    planarPose: null,
    objectPose: null,
    poseResult: null,
    trackerAnchorPosition: null,
    reconstructionConsistentWithTracker: true,
    correspondences: reconstructionPose.correspondences || [],
  });

  assert.equal(supported.byRole.reconstruction.normalAllowed, true);
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

  assert.equal(
    resolveNormalPose(service, {
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
    }).pose,
    null,
  );
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

  const resolved = resolveNormalPose(service, {
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

  assert.equal(resolved.pose, null);
  assert.equal(resolved.arbitration.byRole.local.normalRejectionReason, 'transient-reconstruction-dropout');
});

test('raw homography normal candidates report the canonical planar pose source', () => {
  const service = new ImageAnchorService();
  const selected = resolveNormalPose(service, {
    poseResult: {
      success: true,
      method: 'homography',
      normal: { x: 0.08, y: -0.02, z: 0.996 },
      confidence: 0.86,
      inlierCount: 24,
      inlierRatio: 0.8,
      averageResidual: 1.1,
      referenceSpread: { width: 80, height: 62, minAxis: 62 },
    },
    correspondences: Array.from({ length: 30 }, (_, index) => ({
      prev: { x: 40 + (index % 6) * 16, y: 60 + Math.floor(index / 6) * 14 },
      curr: { x: 44 + (index % 6) * 16, y: 64 + Math.floor(index / 6) * 14 },
    })),
  }).pose;

  assert.equal(selected.method, 'planar-homography');
  assert.equal(selected.inlierCount, 24);
});

test('normal observability rejects weak sources without changing their position eligibility', () => {
  const rigidPlanarService = new ImageAnchorService();
  rigidPlanarService.setTrackingMode('sparse-reconstruction');
  rigidPlanarService.anchorTargetClass = 'laminated card';
  rigidPlanarService.planarDominanceScore = 8;
  const rigidArbitration = rigidPlanarService._recordPoseCandidates({
    reconstructionPose: null,
    planarPose: createPlanarPose({
      confidence: 0.45,
      inlierCount: 8,
      inlierRatio: 0.5,
      averageResidual: 0.98,
    }),
    objectPose: createObjectPose({
      normal: { x: 0.54, y: -0.44, z: 0.72 },
      confidence: 0.59,
      inlierCount: 9,
      averageResidual: 4.75,
    }),
    poseResult: null,
    trackerAnchorPosition: null,
    reconstructionConsistentWithTracker: false,
    correspondences: [],
  });

  assert.equal(rigidArbitration.byRole.object.positionAllowed, true);
  assert.equal(rigidArbitration.byRole.object.normalAllowed, false);
  assert.equal(rigidArbitration.byRole.object.normalRejectionReason, 'planar-target-requires-planar-normal');
  assert.equal(rigidArbitration.byRole.planar.positionAllowed, true);
  assert.equal(rigidArbitration.byRole.planar.normalAllowed, false);
  assert.equal(rigidArbitration.byRole.planar.normalRejectionReason, 'low-normal-confidence');

  const curvedService = new ImageAnchorService();
  curvedService.setTrackingMode('sparse-reconstruction');
  curvedService.anchorTargetClass = 'handled mug';
  curvedService.metrics.reconstructionMapConfidence = 0.69;

  const weakInconsistentReconstruction = createObjectPose({
    method: 'sparse-reconstruction',
    normal: { x: 0.47, y: -0.14, z: 0.87 },
    confidence: 0.84,
    inlierCount: 8,
    averageResidual: 2.94,
  });
  Object.assign(weakInconsistentReconstruction, {
    depthQuality: 0.22,
    preview: {
      statistics: {
        mapConfidence: 0.69,
      },
      surface: {
        model: 'tapered-cylinder',
      },
    },
  });
  const weakArbitration = curvedService._recordPoseCandidates({
    reconstructionPose: weakInconsistentReconstruction,
    planarPose: null,
    objectPose: null,
    poseResult: null,
    trackerAnchorPosition: null,
    reconstructionConsistentWithTracker: false,
    correspondences: weakInconsistentReconstruction.correspondences || [],
  });
  const strongArbitration = curvedService._recordPoseCandidates({
    reconstructionPose: {
      ...weakInconsistentReconstruction,
      inlierCount: 18,
    },
    planarPose: null,
    objectPose: null,
    poseResult: null,
    trackerAnchorPosition: null,
    reconstructionConsistentWithTracker: false,
    correspondences: weakInconsistentReconstruction.correspondences || [],
  });

  assert.equal(weakArbitration.byRole.reconstruction.positionAllowed, true);
  assert.equal(weakArbitration.byRole.reconstruction.normalAllowed, false);
  assert.equal(
    weakArbitration.byRole.reconstruction.normalRejectionReason,
    'weak-inconsistent-reconstruction-normal',
  );
  assert.equal(strongArbitration.byRole.reconstruction.normalAllowed, true);
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
    averageResidual: 14,
  };

  service.setTrackingMode('parametric-surface');
  assert.equal(service._isUsablePoseResult(pose, correspondences), true);

  service.setTrackingMode('object-pose');
  assert.equal(
    service._isUsablePoseResult({ ...pose, method: 'object-pose-affine' }, correspondences),
    false,
  );
});

test('pose transform validation does not require an orientation normal', () => {
  const service = new ImageAnchorService();
  const correspondences = Array.from({ length: 12 }, (_, index) => ({
    prev: { x: 30 + index * 5, y: 40 + (index % 4) * 12 },
    curr: { x: 42 + index * 5, y: 48 + (index % 4) * 12 },
  }));
  const positionOnlyPose = {
    success: true,
    method: 'object-pose-affine',
    position: { x: 120, y: 90, z: 0 },
    normal: null,
    confidence: 0.72,
    inlierCount: 10,
    inlierRatio: 0.72,
    averageResidual: 2.1,
  };

  assert.equal(service._getPoseTransformRejectionReason(positionOnlyPose, correspondences), null);
  assert.equal(service._getPoseRejectionReason(positionOnlyPose, correspondences), 'Pose unavailable');
});

test('real-depth sparse reconstruction owns orientation while local planar patch owns attachment transform', async () => {
  const service = new ImageAnchorService();
  const anchorReference = { x: 120, y: 118 };
  const homographyMatrix = [1.04, 0.02, 12, 0.01, 1.02, 8, 0.0001, 0.00005, 1];
  const project = (point) => {
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
      objectOwned: true,
      objectOwnedStreak: 2,
      original: {
        x: 74 + (index % 9) * 14,
        y: 72 + Math.floor(index / 9) * 16,
      },
      current: {
        x: 82 + (index % 9) * 15,
        y: 78 + Math.floor(index / 9) * 17,
      },
    })),
    trackFrame: () => ({
      success: true,
      successRate: 0.9,
      activePointCount: 36,
      averageError: 1.2,
    }),
    getObjectPose: () =>
      createObjectPose({
        x: 138,
        y: 128,
        scale: 1.05,
        rotation: 0.05,
        normal: { x: 0.12, y: 0.02, z: 0.99 },
        confidence: 0.72,
        inlierCount: 18,
      }),
    getCorrespondences: () =>
      Array.from({ length: 30 }, (_, index) => ({
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
      inlierCount: 18,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);
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
    },
  });

  const result = await service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);
  const expectedPatchPosition = project(anchorReference);

  assert.equal(result.success, true);
  assert.equal(result.method, 'planar-homography');
  assert.ok(Math.abs(result.position.x - expectedPatchPosition.x) < 1e-9);
  assert.ok(Math.abs(result.position.y - expectedPatchPosition.y) < 1e-9);
  assert.equal(result.planarTransform.method, 'planar-homography');
  assert.ok(result.normal.x > 0.25);
  assert.equal(service.getState().metrics.poseSource, 'sparse-reconstruction');
});

test('unusable object pose does not replace stable tracker position and scale', async () => {
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
    trackFrame: () => ({
      success: true,
      successRate: 0.86,
      activePointCount: 28,
      averageError: 1.1,
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
      inlierCount: 22,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);

  const result = await service._updateWithKeypoints({ cols: 1280, rows: 720 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.position.x, 146);
  assert.equal(result.position.y, 164);
  assert.equal(result.planarTransform.scale, 1.08);
  assert.equal(result.planarTransform.rotation, 0.12);
  assert.notEqual(result.position.x, 900);
  assert.equal(result.poseSource, null);
  assert.equal(service.getState().metrics.poseSource, null);
  assert.match(
    service.getState().metrics.poseRejectedReason,
    /Insufficient pose inliers|Low pose inlier ratio|Low pose confidence|Degenerate local pose spread/,
  );
});

test('frames without a position clear previous normal-owner diagnostics', async () => {
  const service = new ImageAnchorService();

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.currentNormal = { x: 0, y: 0, z: 1 };
  service.cv = {};
  service.metrics.poseNormalRole = 'planar';
  service.metrics.poseNormalReason = 'planar-target-evidence';
  service.metrics.poseNormalCandidateSource = 'planar-homography';
  Object.assign(service.keypointTracker, {
    trackedPoints: [],
    trackFrame: () => ({
      success: true,
      successRate: 0.8,
      activePointCount: 18,
      averageError: 1.2,
    }),
    getObjectPose: () => ({
      success: false,
      method: 'object-pose-affine',
      reason: 'Object pose unavailable',
    }),
    getCorrespondences: () => [],
    getAnchorPosition: () => null,
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = await service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'No position data available');
  assert.equal(service.metrics.poseNormalRole, null);
  assert.equal(service.metrics.poseNormalReason, null);
  assert.equal(service.metrics.poseNormalCandidateSource, null);
});

test('planar reconstruction targets hold tracker attachment and prior normal during occlusion', async () => {
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
    trackFrame: () => ({
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
  installAnchorPositionEvaluationStub(service.keypointTracker);
  service._estimatePoseFromTracker = () => ({
    options: { maxReferenceDistance: 120 },
    correspondences: [],
    poseResult: null,
  });

  const result = await service._updateWithKeypoints({ cols: 640, rows: 480 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.method, 'reference_similarity_transform');
  assert.equal(result.position.x, 146);
  assert.equal(result.position.y, 164);
  assert.equal(result.planarTransform.scale, 1.06);
  assert.equal(result.poseSource, null);
  assert.ok(service.getState().normal.x > 0);
});

test('lost anchors require global descriptor relocalization and stay recoverable', async () => {
  const service = new ImageAnchorService();
  let recoveryOptions = null;
  class FakeMat {
    delete() {}
  }

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'lost';
  service.currentPosition = { x: 120, y: 140, z: 0 };
  service.metrics.recoveryAttempts = 5;
  service.cv = {
    Mat: FakeMat,
    COLOR_RGBA2GRAY: 0,
    matFromImageData: () => new FakeMat(),
    cvtColor: () => {},
  };
  service._updateWithKeypoints = (...args) => {
    recoveryOptions = args[5];
    return {
      success: false,
      targetPresent: false,
      reason: 'No globally consistent descriptor match',
      state: 'lost',
    };
  };

  const result = await service.updateAnchor({ width: 320, height: 240 });
  const state = service.getState();

  assert.equal('_startAutoResetTimer' in service, false);
  assert.equal(result.success, false);
  assert.equal(result.targetPresent, false);
  assert.equal(result.recoverable, true);
  assert.equal(state.anchored, true);
  assert.equal(state.state, 'lost');
  assert.deepEqual(recoveryOptions, { requireGlobalRelocalization: true });
  assert.equal(state.metrics.targetPresent, false);
});

test('global-only recovery never runs stale optical flow when the target is lost', async () => {
  const service = new ImageAnchorService();
  let opticalFlowCalls = 0;
  service.anchorState = 'lost';
  service.keypointTracker.trackFrame = () => {
    opticalFlowCalls++;
    return { success: true };
  };
  service._attemptKeyframeRelocalization = async () => ({
    success: false,
    reason: 'No globally consistent descriptor match',
  });

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000, {}, null, null, {
    requireGlobalRelocalization: true,
  });

  assert.equal(result.success, false);
  assert.equal(result.targetPresent, false);
  assert.equal(opticalFlowCalls, 0);
});

test('global recovery restores presence through the shared path for every reconstruction mode', async () => {
  for (const trackingMode of [
    'sparse-reconstruction',
    'parametric-surface',
    'direct-photometric',
    'depth-fusion',
  ]) {
    const service = new ImageAnchorService();
    class FakeMat {
      delete() {}
    }
    service.initialized = true;
    service.anchored = true;
    service.anchorState = 'lost';
    service.trackingMode = trackingMode;
    service.currentPosition = { x: 120, y: 140, z: 0 };
    service.cv = {
      Mat: FakeMat,
      COLOR_RGBA2GRAY: 0,
      matFromImageData: () => new FakeMat(),
      cvtColor: () => {},
    };
    service._updateWithKeypoints = () => ({
      success: true,
      targetPresent: true,
      position: { x: 220, y: 160, z: 0 },
      confidence: 0.8,
      method: 'orb-keyframe-relocalization',
      state: 'lost',
    });

    const result = await service.updateAnchor({ width: 320, height: 240 });
    const state = service.getState();

    assert.equal(result.targetPresent, true, trackingMode);
    assert.equal(result.state, 'tracking', trackingMode);
    assert.equal(state.state, 'tracking', trackingMode);
    assert.equal(state.metrics.targetPresent, true, trackingMode);
  }
});

test('normal tracking refreshes keypoints to grow the landmark map before stable lock', async () => {
  const service = new ImageAnchorService();
  let refreshes = 0;
  let refreshOptions = null;
  let currentAnchorPositionEvaluation = null;
  const frameFeatures = {
    count: 32,
    descriptorBytes: new Uint8Array(32 * 32),
    descriptorSize: 32,
    features: [],
  };

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.framesSinceRefresh = service.refreshInterval - 1;
  service.cv = {};
  Object.assign(service.keypointTracker, {
    trackFrame: () => ({
      success: true,
      successRate: 0.68,
      activePointCount: 18,
      averageError: 2.2,
    }),
    getCorrespondences: () =>
      Array.from({ length: 18 }, (_, index) => ({
        prev: { x: 70 + (index % 6) * 14, y: 80 + Math.floor(index / 6) * 14 },
        curr: { x: 76 + (index % 6) * 13, y: 85 + Math.floor(index / 6) * 14 },
      })),
    getObjectPose: () =>
      createObjectPose({
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
      inlierCount: 14,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);
  const createAnchorPositionEvaluation = service.keypointTracker.createAnchorPositionEvaluation;
  service.keypointTracker.createAnchorPositionEvaluation = () => {
    currentAnchorPositionEvaluation = createAnchorPositionEvaluation();
    return currentAnchorPositionEvaluation;
  };
  service._estimatePoseFromCorrespondences = () => ({
    success: true,
    method: 'affine-parallax',
    normal: { x: 0.18, y: -0.05, z: 0.98 },
    inlierCount: 16,
    inlierRatio: 0.72,
    confidence: 0.72,
  });
  service.relocalizer = {
    hasKeyframes: () => true,
    getKeyframeCount: () => 2,
    relocalize: () => ({
      success: false,
      reason: 'No robust ORB geometric consensus',
      queryFeatureCount: 32,
      keyframeCount: 2,
      frameFeatures,
    }),
  };
  service._shouldAttemptGeometryRelocalization = () => true;
  service._refreshKeypoints = (grayImage, options) => {
    refreshes++;
    refreshOptions = options;
    return true;
  };

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.state, 'tracking');
  assert.equal(refreshes, 1);
  assert.equal(refreshOptions.frameFeatures, frameFeatures);
  assert.equal(refreshOptions.anchorPositionEvaluation, currentAnchorPositionEvaluation);
});

test('pose estimation retries with wider landmark support when the tapped patch is too local', async () => {
  const service = new ImageAnchorService();
  const calls = [];
  const wideCorrespondences = Array.from({ length: 24 }, (_, index) => ({
    prev: { x: 54 + (index % 6) * 24, y: 62 + Math.floor(index / 6) * 22 },
    curr: { x: 62 + (index % 6) * 16, y: 70 + Math.floor(index / 6) * 22 },
  }));

  service.initialized = true;
  service.anchored = true;
  service.anchorState = 'tracking';
  service.currentPosition = { x: 100, y: 120, z: 0 };
  service.templateRegion = { width: 180, height: 160 };
  service.cv = {};
  service.homographyEstimator = createHomographyEstimatorStub(() => ({
    success: false,
    reason: 'homography unavailable in unit test',
  }));
  Object.assign(service.keypointTracker, {
    trackedPoints: Array.from({ length: 64 }, () => ({ status: 'active' })),
    trackFrame: () => ({
      success: true,
      successRate: 0.82,
      activePointCount: 64,
      averageError: 1.4,
    }),
    getCorrespondences: (options) => {
      calls.push(options.maxReferenceDistance);
      return options.maxReferenceDistance < 100 ? wideCorrespondences.slice(0, 6) : wideCorrespondences;
    },
    getObjectPose: () =>
      createObjectPose({
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
      inlierCount: 24,
    }),
  });
  installAnchorPositionEvaluationStub(service.keypointTracker);

  const result = await service._updateWithKeypoints({ cols: 320, rows: 240 }, 1000);

  assert.equal(result.success, true);
  assert.equal(result.poseSource, 'object-pose-affine');
  assert.ok(Math.abs(result.normal.x) > 0.4);
  assert.ok(calls.some((radius) => radius >= 100));
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
    getCorrespondences: (options) =>
      options.maxReferenceDistance < 100 ? localCorrespondences : wideCorrespondences,
  });
  service.homographyEstimator = createHomographyEstimatorStub((_cv, correspondences) => {
    const wide = correspondences.length > 12;
    return {
      success: true,
      method: 'homography',
      normal: wide ? { x: 0.62, y: -0.08, z: 0.78 } : { x: -0.38, y: 0.12, z: 0.92 },
      confidence: wide ? 0.84 : 0.58,
      inlierCount: wide ? 17 : 10,
      inlierRatio: wide ? 0.71 : 0.83,
      averageResidual: wide ? 0.6 : 1.9,
      referenceSpread: wide
        ? { width: 132, height: 88, minAxis: 88 }
        : { width: 54, height: 44, minAxis: 44 },
    };
  });

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

  assert.equal(
    service._shouldUseTrackedCurvedAttachmentTransform({
      reconstructionPose,
      trackerAnchorPosition,
    }),
    true,
  );

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

  assert.equal(
    service._shouldBlendTrackerScaleForSelectedCurvedTransform({
      reconstructionPose,
      trackerAnchorPosition,
    }),
    true,
  );

  const transform = service._selectBlendedCurvedAttachmentTransform({
    trackerAnchorPosition,
    reconstructionPose,
  });

  assert.equal(
    transform.scale,
    Math.sqrt(trackerAnchorPosition.scale * reconstructionPose.planarTransform.scale),
  );
  assert.equal(transform.rotation, trackerAnchorPosition.rotation);

  reconstructionPose.planarTransform.scale = 0;
  assert.equal(
    service._shouldBlendTrackerScaleForSelectedCurvedTransform({
      reconstructionPose,
      trackerAnchorPosition,
    }),
    false,
  );
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
    getCentroidAnchorPosition: (points) => {
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
  assert.equal(
    centroidInput.every((point) => point.objectOwned === true),
    true,
  );
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

  assert.equal(
    service._hasModerateCurvedReconstructionRecovery({
      reconstructionPose,
      trackerAnchorPosition,
    }),
    true,
  );
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

  assert.equal(
    service._hasModerateCurvedReconstructionRecovery({
      reconstructionPose,
      trackerAnchorPosition,
    }),
    true,
  );
});

test('curved recovery rejects divergent poses that lack mode-appropriate geometric support', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('direct-photometric');
  service.anchorTargetClass = 'cup';
  service.templateRegion = { width: 118, height: 118 };
  service.metrics.reconstructionReady = true;
  service.metrics.reconstructionMapConfidence = 0.81;
  service.metrics.reconstructionMatureLandmarks = 28;
  service.metrics.reconstructionTrackerDelta = 34.5;
  service.metrics.reconstructionPreview = {
    surface: { model: 'tapered-cylinder' },
  };
  const reconstructionPose = {
    success: true,
    method: 'direct-photometric',
    position: { x: 331, y: 218, z: 0 },
    inlierCount: 16,
    averageResidual: 7.8,
    confidence: 0.79,
    depthQuality: 0.12,
    preview: {
      surface: { model: 'tapered-cylinder' },
      statistics: { mapConfidence: 0.81 },
    },
  };
  const trackerAnchorPosition = {
    method: 'reference_similarity_transform',
    confidence: 0,
    averageResidual: 36,
  };

  assert.equal(service._shouldRejectDivergentCurvedPosition(reconstructionPose), true);
  assert.equal(service._hasSelectedReconstructionPose(reconstructionPose), true);
  assert.equal(service._hasSelectedReconstructionPosition(reconstructionPose), false);
  assert.equal(service._canSelectedReconstructionOwnAttachment(reconstructionPose), false);
  assert.equal(service._hasStrongCurvedReconstructionPosition(reconstructionPose), false);
  assert.equal(
    service._hasModerateCurvedReconstructionRecovery({
      reconstructionPose,
      trackerAnchorPosition,
    }),
    false,
  );

  service.setTrackingMode('sparse-reconstruction');
  service.metrics.reconstructionTrackerDelta = 27.5;
  const sparsePose = {
    ...reconstructionPose,
    method: 'sparse-reconstruction',
    inlierCount: 13,
    averageResidual: 5.1,
  };

  assert.equal(service._shouldRejectDivergentCurvedPosition(sparsePose), false);

  service.anchorTargetClass = 'mug';
  assert.equal(service._shouldRejectDivergentCurvedPosition(sparsePose), true);

  service.metrics.reconstructionTrackerDelta = 19;
  assert.equal(service._shouldRejectDivergentCurvedPosition(sparsePose), false);
});

test('reselecting the active tracking mode preserves the current reconstruction map', () => {
  const service = new ImageAnchorService();
  service.setTrackingMode('parametric-surface');
  service.anchored = true;
  service.currentPosition = { x: 80, y: 60, z: 0 };
  service.trackingRegion = { x: 20, y: 20, width: 120, height: 80 };
  const reconstructor = service.reconstructor;

  service.setTrackingMode('parametric-surface');

  assert.equal(service.reconstructor, reconstructor);
});

test('tracking mode replacement and service disposal release their reconstruction engines', () => {
  const service = new ImageAnchorService();
  service.anchored = true;
  service.currentPosition = { x: 80, y: 60, z: 0 };
  service.trackingRegion = { x: 20, y: 20, width: 120, height: 80 };
  let previousDisposals = 0;
  service.reconstructor.dispose = () => {
    previousDisposals++;
  };

  service.setTrackingMode('parametric-surface');

  assert.equal(previousDisposals, 1);
  let activeDisposals = 0;
  service.reconstructor.dispose = () => {
    activeDisposals++;
  };

  service.dispose();

  assert.equal(activeDisposals, 1);
});
