import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreVisionPipelineQuality, summarizeVisionQualityReports } from './stageQualityScoring.js';

const createGoodReplay = () => ({
  anchorCreated: true,
  createResult: {
    evidence: {
      maskCoverage: 0.42,
      maskConfidence: 0.88,
      templateKeypoints: 24,
      activeLandmarks: 28,
      objectOwnedLandmarks: 26,
      backgroundRejected: 3,
    },
  },
  frames: [
    {
      index: 7,
      success: true,
      anchorError: 2.5,
      normalError: 0.1,
      metrics: {
        reconstructionReady: false,
        poseInliers: 10,
        reconstructionMapConfidence: 0.36,
        reconstructionDepthQuality: 0.08,
        objectOwnedLandmarks: 20,
      },
    },
    {
      success: true,
      anchorError: 3.2,
      normalError: 0.12,
      metrics: {
        reconstructionReady: true,
        poseInliers: 18,
        reconstructionMapConfidence: 0.7,
        reconstructionDepthQuality: 0.16,
        objectOwnedLandmarks: 30,
      },
    },
  ],
});

const goodSummary = {
  failedFrames: 0,
  maxAnchorError: 3.2,
  meanAnchorError: 2.85,
  maxFrameJump: 2.1,
  minPoseInliers: 10,
  meanNormalError: 0.11,
  maxNormalError: 0.12,
};

const goodHeadPose = {
  visibleMismatches: 0,
  maxWorldPositionError: 0.05,
  maxRotationError: 0.28,
  maxScaleLogError: 0.04,
  maxHeadJumpExcess: 0.01,
};

test('vision quality scorer passes a stable replay across all stages', () => {
  const report = scoreVisionPipelineQuality({
    name: 'good fixture',
    replay: createGoodReplay(),
    summary: goodSummary,
    headPose: goodHeadPose,
  });

  assert.equal(report.overallStatus, 'pass');
  assert.deepEqual(
    Object.values(report.stages).map((stage) => stage.status),
    ['pass', 'pass', 'pass', 'pass'],
  );
});

test('vision quality scorer identifies each failing stage', () => {
  const report = scoreVisionPipelineQuality({
    name: 'bad fixture',
    replay: {
      anchorCreated: false,
      createFailure: 'No object selected at tap position',
      frames: [
        {
          success: false,
          anchorError: Infinity,
          normalError: Infinity,
          metrics: {
            reconstructionReady: false,
            poseInliers: 0,
            reconstructionMapConfidence: 0,
            reconstructionDepthQuality: 0,
            objectOwnedLandmarks: 0,
          },
        },
      ],
    },
    summary: {
      failedFrames: 1,
      maxAnchorError: 40,
      meanAnchorError: 40,
      maxFrameJump: 25,
      minPoseInliers: 0,
      meanNormalError: 1.5,
      maxNormalError: 1.5,
    },
    headPose: {
      visibleMismatches: 1,
      maxWorldPositionError: 0.4,
      maxRotationError: 1.6,
      maxScaleLogError: 0.35,
      maxHeadJumpExcess: 0.2,
    },
  });

  assert.equal(report.overallStatus, 'fail');
  assert.equal(report.stages.selection.status, 'fail');
  assert.equal(report.stages.tracking.status, 'fail');
  assert.equal(report.stages.reconstruction.status, 'fail');
  assert.equal(report.stages.headAttachment.status, 'fail');
  assert.match(report.stages.selection.failures.join('\n'), /Anchor was not created/);
  assert.match(report.stages.tracking.failures.join('\n'), /tracking frames failed/);
  assert.match(report.stages.reconstruction.failures.join('\n'), /Reconstruction ready ratio/);
  assert.match(report.stages.headAttachment.failures.join('\n'), /visibility mismatches/);
});

test('reconstruction scoring ignores pose-inlier warmup before the map is ready', () => {
  const replay = createGoodReplay();
  replay.frames = [
    {
      success: true,
      anchorError: 2,
      normalError: 0.1,
      metrics: {
        reconstructionReady: false,
        poseInliers: 0,
        reconstructionMapConfidence: 0.2,
        reconstructionDepthQuality: 0.02,
      },
    },
    {
      success: true,
      anchorError: 2,
      normalError: 0.1,
      metrics: {
        reconstructionReady: true,
        poseInliers: 14,
        reconstructionMapConfidence: 0.66,
        reconstructionDepthQuality: 0.12,
      },
    },
  ];

  const report = scoreVisionPipelineQuality({
    name: 'warmup fixture',
    replay,
    summary: {
      ...goodSummary,
      minPoseInliers: 0,
    },
    headPose: goodHeadPose,
  });

  assert.equal(report.stages.reconstruction.status, 'pass');
  assert.equal(report.stages.reconstruction.metrics.minReadyPoseInliers, 14);
});

test('reconstruction scoring ignores transient pose dropout after the map is ready', () => {
  const replay = createGoodReplay();
  replay.frames = [
    {
      success: true,
      anchorError: 2,
      normalError: 0.1,
      metrics: {
        poseModel: 'parametric-surface',
        poseSource: 'parametric-surface',
        reconstructionReady: true,
        poseInliers: 18,
        reconstructionMapConfidence: 0.72,
        reconstructionDepthQuality: 0.14,
      },
    },
    {
      success: true,
      anchorError: 2,
      normalError: 0.1,
      metrics: {
        poseModel: 'parametric-surface',
        poseSource: null,
        reconstructionReady: true,
        poseInliers: 0,
        reconstructionMapConfidence: 0.72,
        reconstructionDepthQuality: 0.14,
        readiness: {
          faceReady: false,
          reason: 'Recovering object pose before showing the face',
        },
      },
    },
  ];

  const report = scoreVisionPipelineQuality({
    name: 'pose dropout fixture',
    replay,
    summary: {
      ...goodSummary,
      minPoseInliers: 0,
    },
    headPose: goodHeadPose,
  });

  assert.equal(report.stages.reconstruction.status, 'pass');
  assert.equal(report.stages.reconstruction.metrics.poseReadyFrames, 1);
  assert.equal(report.stages.reconstruction.metrics.minReadyPoseInliers, 18);
});

test('reconstruction scoring counts pose evidence even when attachment safety rejects pose ownership', () => {
  const replay = createGoodReplay();
  replay.frames = [
    {
      success: true,
      anchorError: 2,
      normalError: 1.4,
      reconstructionNormalError: 0.3,
      metrics: {
        poseModel: 'parametric-surface',
        poseSource: null,
        reconstructionReady: true,
        poseInliers: 12,
        reconstructionPoseInliers: 12,
        reconstructionPoseNormalDetached: true,
        reconstructionMapConfidence: 0.68,
        reconstructionDepthQuality: 0.14,
        poseNormalReason: 'incomplete-selected-surface-prior',
      },
    },
    {
      success: true,
      anchorError: 3,
      normalError: 1.45,
      reconstructionNormalError: Infinity,
      metrics: {
        poseModel: 'parametric-surface',
        poseSource: null,
        reconstructionReady: true,
        poseInliers: 0,
        reconstructionPoseInliers: 0,
        reconstructionMapConfidence: 0.68,
        reconstructionDepthQuality: 0.14,
      },
    },
  ];

  const report = scoreVisionPipelineQuality({
    name: 'attachment safety fixture',
    replay,
    summary: {
      ...goodSummary,
      minPoseInliers: 0,
    },
    headPose: goodHeadPose,
  });

  assert.equal(report.stages.reconstruction.status, 'pass');
  assert.equal(report.stages.reconstruction.metrics.poseReadyFrames, 1);
  assert.equal(report.stages.reconstruction.metrics.minReadyPoseInliers, 12);
  assert.equal(report.stages.reconstruction.metrics.meanReadyNormalError, 0.3);
});

test('reconstruction normal scoring excludes pose evidence without a normal owner', () => {
  const replay = createGoodReplay();
  replay.frames = [
    {
      success: true,
      anchorError: 2,
      normalError: 0.42,
      metrics: {
        poseModel: 'sparse-reconstruction',
        poseSource: 'sparse-reconstruction',
        poseNormalCandidateSource: 'sparse-reconstruction',
        reconstructionReady: true,
        poseInliers: 16,
        reconstructionPoseInliers: 16,
        reconstructionMapConfidence: 0.7,
        reconstructionDepthQuality: 0.18,
      },
    },
    {
      success: true,
      anchorError: 3,
      normalError: 1.35,
      metrics: {
        poseModel: 'sparse-reconstruction',
        poseSource: null,
        poseNormalCandidateSource: null,
        reconstructionReady: true,
        poseInliers: 8,
        reconstructionPoseInliers: 8,
        reconstructionMapConfidence: 0.7,
        reconstructionDepthQuality: 0.18,
      },
    },
  ];

  const report = scoreVisionPipelineQuality({
    name: 'position-only recovery fixture',
    replay,
    summary: {
      ...goodSummary,
      minPoseInliers: 0,
    },
    headPose: goodHeadPose,
  });

  assert.equal(report.stages.reconstruction.status, 'pass');
  assert.equal(report.stages.reconstruction.metrics.poseReadyFrames, 2);
  assert.equal(report.stages.reconstruction.metrics.normalReadyFrames, 1);
  assert.equal(report.stages.reconstruction.metrics.maxReadyNormalError, 0.42);
});

test('quality thresholds tolerate floating point boundary noise', () => {
  const report = scoreVisionPipelineQuality({
    name: 'boundary fixture',
    replay: createGoodReplay(),
    summary: {
      ...goodSummary,
      maxFrameJump: 12.000000000000004,
    },
    headPose: goodHeadPose,
  });

  assert.equal(report.stages.tracking.status, 'pass');
});

test('tracking scoring exposes object support correction and anchor bias diagnostics', () => {
  const replay = createGoodReplay();
  replay.frames = [
    {
      index: 7,
      success: true,
      positionSource: 'reference_similarity_transform',
      poseSource: null,
      predicted: { x: 24, y: 10 },
      groundTruth: { anchor: { x: 25, y: 10 } },
      anchorError: 1,
      normalError: 0.1,
      metrics: {
        poseInliers: 0,
        trackingSuccessRate: 0.8,
        ownershipProbationLandmarks: 6,
        landmarkRefreshProbationary: 4,
        landmarkOwnershipPromoted: 2,
        landmarkRefreshCoverageBefore: 0.25,
        landmarkRefreshCoverageAfter: 0.5,
        landmarkRefreshOccupiedBefore: 2,
        landmarkRefreshOccupiedAfter: 4,
        objectSupportPositionCorrection: 'pose-dropout-recovery',
        objectSupportPositionStep: 6,
        objectSupportFrameStepLimited: true,
        objectSupportAnchorUv: { u: 0.5, v: 0.5 },
        objectSupportMaskBounds: { x: 0, y: 0, width: 20, height: 20 },
        reconstructionReady: true,
        reconstructionMapConfidence: 0.7,
        reconstructionDepthQuality: 0.16,
      },
    },
  ];
  const report = scoreVisionPipelineQuality({
    name: 'support bias fixture',
    replay,
    summary: {
      ...goodSummary,
      failedFrames: 0,
      maxAnchorError: 1,
      meanAnchorError: 1,
      maxFrameJump: 0,
      objectSupportCorrectionFrames: 1,
      objectSupportFrameStepLimitedFrames: 1,
      objectSupportRecoveryFrames: 1,
      maxOwnershipProbationLandmarks: 6,
      landmarkRefreshProbationaryLandmarks: 4,
      landmarkOwnershipPromotions: 2,
      landmarkRefreshCoverageFrames: 1,
      landmarkRefreshCoverageGain: 0.25,
      landmarkRefreshNewOccupiedCells: 2,
      maxObjectSupportPositionStep: 6,
      objectSupportCorrectionCounts: {
        'pose-dropout-recovery': 1,
      },
    },
    headPose: goodHeadPose,
  });
  const metrics = report.stages.tracking.metrics;

  assert.equal(metrics.objectSupportCorrectionFrames, 1);
  assert.equal(metrics.objectSupportFrameStepLimitedFrames, 1);
  assert.equal(metrics.objectSupportRecoveryFrames, 1);
  assert.equal(metrics.maxOwnershipProbationLandmarks, 6);
  assert.equal(metrics.landmarkRefreshProbationaryLandmarks, 4);
  assert.equal(metrics.landmarkOwnershipPromotions, 2);
  assert.equal(metrics.landmarkRefreshCoverageFrames, 1);
  assert.equal(metrics.landmarkRefreshCoverageGain, 0.25);
  assert.equal(metrics.landmarkRefreshNewOccupiedCells, 2);
  assert.equal(metrics.maxObjectSupportPositionStep, 6);
  assert.equal(metrics.maxObjectSupportAnchorError, 15);
  assert.equal(metrics.meanObjectSupportAnchorError, 15);
  assert.deepEqual(metrics.objectSupportCorrectionCounts, {
    'pose-dropout-recovery': 1,
  });
  assert.equal(metrics.worstObjectSupportAnchorFrames[0].index, 7);
  assert.equal(metrics.worstObjectSupportAnchorFrames[0].objectSupportAnchorError, 15);
});

test('tracking scoring reports thresholded anchor accuracy from replay frames', () => {
  const replay = createGoodReplay();
  replay.frames = [
    {
      success: true,
      anchorError: 3,
      normalError: 0.1,
      metrics: {
        reconstructionReady: true,
        poseInliers: 12,
        reconstructionMapConfidence: 0.7,
      },
    },
    {
      success: true,
      anchorError: 9,
      normalError: 0.1,
      metrics: {
        reconstructionReady: true,
        poseInliers: 12,
        reconstructionMapConfidence: 0.7,
      },
    },
    {
      success: true,
      anchorError: 20,
      normalError: 0.1,
      metrics: {
        reconstructionReady: true,
        poseInliers: 12,
        reconstructionMapConfidence: 0.7,
      },
    },
    {
      success: false,
      anchorError: Infinity,
      normalError: Infinity,
      metrics: {
        reconstructionReady: false,
        poseInliers: 0,
      },
    },
  ];

  const report = scoreVisionPipelineQuality({
    name: 'threshold accuracy fixture',
    replay,
    summary: {
      ...goodSummary,
      failedFrames: 1,
      maxAnchorError: 20,
      meanAnchorError: 10.67,
      maxFrameJump: 12,
    },
    headPose: goodHeadPose,
  });
  const metrics = report.stages.tracking.metrics;

  assert.equal(metrics.anchorAccuracyAt4, 0.25);
  assert.equal(metrics.anchorAccuracyAt8, 0.25);
  assert.equal(metrics.anchorAccuracyAt16, 0.5);
  assert.equal(metrics.p50AnchorError, 9);
  assert.ok(Math.abs(metrics.p95AnchorError - 18.9) < 1e-9);
});

test('tracking scoring exposes post-occlusion recovery diagnostics', () => {
  const replay = createGoodReplay();
  replay.frames = [
    {
      index: 1,
      occluded: false,
      success: true,
      anchorError: 2,
      normalError: 0.1,
      metrics: { reconstructionReady: true, poseInliers: 12, reconstructionMapConfidence: 0.7 },
    },
    {
      index: 2,
      occluded: true,
      success: true,
      anchorError: 30,
      normalError: 0.1,
      metrics: { reconstructionReady: true, poseInliers: 12, reconstructionMapConfidence: 0.7 },
    },
    {
      index: 3,
      occluded: false,
      success: true,
      anchorError: 12,
      normalError: 0.1,
      metrics: { reconstructionReady: true, poseInliers: 12, reconstructionMapConfidence: 0.7 },
    },
    {
      index: 4,
      occluded: false,
      success: true,
      anchorError: 6,
      normalError: 0.1,
      metrics: { reconstructionReady: true, poseInliers: 12, reconstructionMapConfidence: 0.7 },
    },
  ];

  const report = scoreVisionPipelineQuality({
    name: 'occlusion recovery fixture',
    replay,
    summary: {
      ...goodSummary,
      failedFrames: 0,
      maxAnchorError: 30,
      meanAnchorError: 12.5,
      maxFrameJump: 8,
    },
    headPose: goodHeadPose,
  });
  const metrics = report.stages.tracking.metrics;

  assert.equal(metrics.postOcclusionWindowCount, 1);
  assert.equal(metrics.postOcclusionRecoveredAt8, 1);
  assert.equal(metrics.postOcclusionRecoveryRateAt8, 1);
  assert.equal(metrics.maxPostOcclusionRecoveryFramesAt8, 2);
  assert.equal(metrics.worstPostOcclusionWindows[0].startFrameIndex, 3);
});

test('head attachment scoring reports policy-hidden frames', () => {
  const report = scoreVisionPipelineQuality({
    name: 'hidden head fixture',
    replay: createGoodReplay(),
    summary: goodSummary,
    headPose: {
      ...goodHeadPose,
      hiddenByPolicyFrames: 3,
    },
  });

  assert.equal(report.stages.headAttachment.status, 'pass');
  assert.equal(report.stages.headAttachment.metrics.hiddenByPolicyFrames, 3);
});

test('quality report attributes tracking and head errors to pose sources', () => {
  const replay = createGoodReplay();
  replay.frames = [
    {
      success: true,
      anchorError: 2,
      predicted: { x: 10, y: 10 },
      positionSource: 'planar-homography',
      poseSource: 'planar-homography',
      normalError: 0.1,
      metrics: {
        poseModel: 'parametric-surface',
        poseSource: 'planar-homography',
        reconstructionReady: true,
        poseInliers: 12,
        reconstructionMapConfidence: 0.66,
      },
    },
    {
      success: true,
      anchorError: 11,
      predicted: { x: 24, y: 18 },
      positionSource: 'reference_similarity_transform',
      poseSource: 'parametric-surface',
      normalError: 0.2,
      metrics: {
        poseModel: 'parametric-surface',
        poseSource: 'parametric-surface',
        reconstructionReady: true,
        poseInliers: 18,
        reconstructionMapConfidence: 0.72,
      },
    },
  ];

  const report = scoreVisionPipelineQuality({
    name: 'source fixture',
    replay,
    summary: {
      ...goodSummary,
      maxAnchorError: 11,
      meanAnchorError: 6.5,
    },
    headPose: {
      ...goodHeadPose,
      summary: {
        ...goodHeadPose,
        hiddenByPolicyFrames: 0,
        worstFrames: [],
      },
      frames: [
        {
          poseSource: 'planar-homography',
          positionSource: 'planar-homography',
          hiddenByPolicy: false,
          worldPositionError: 0.04,
          rotationError: 0.2,
          scaleLogError: 0.01,
          headJumpExcess: 0,
        },
        {
          poseSource: 'parametric-surface',
          positionSource: 'reference_similarity_transform',
          hiddenByPolicy: false,
          worldPositionError: 0.14,
          rotationError: 0.7,
          scaleLogError: 0.08,
          headJumpExcess: 0.03,
        },
      ],
    },
  });

  assert.equal(
    report.stages.tracking.metrics.byPositionSource['reference_similarity_transform'].maxAnchorError,
    11,
  );
  assert.equal(report.stages.headAttachment.metrics.byPoseSource['parametric-surface'].maxRotationError, 0.7);
});

test('quality report attributes source-switch instability to transition pairs', () => {
  const replay = createGoodReplay();
  replay.frames = [
    {
      index: 1,
      success: true,
      anchorError: 2,
      predicted: { x: 10, y: 10 },
      positionSource: 'planar-homography',
      poseSource: 'planar-homography',
      normalError: 0.1,
      metrics: {
        poseModel: 'parametric-surface',
        poseSource: 'planar-homography',
        reconstructionReady: true,
        poseInliers: 12,
        reconstructionMapConfidence: 0.66,
      },
    },
    {
      index: 2,
      success: true,
      anchorError: 13,
      predicted: { x: 28, y: 16 },
      positionSource: 'reference_similarity_transform',
      poseSource: 'parametric-surface',
      normalError: 0.2,
      metrics: {
        poseModel: 'parametric-surface',
        poseSource: 'parametric-surface',
        reconstructionReady: true,
        poseInliers: 18,
        reconstructionMapConfidence: 0.72,
      },
    },
    {
      index: 3,
      success: true,
      anchorError: 5,
      predicted: { x: 30, y: 17 },
      positionSource: 'reference_similarity_transform',
      poseSource: 'parametric-surface',
      normalError: 0.15,
      metrics: {
        poseModel: 'parametric-surface',
        poseSource: 'parametric-surface',
        reconstructionReady: true,
        poseInliers: 19,
        reconstructionMapConfidence: 0.73,
      },
    },
  ];

  const report = scoreVisionPipelineQuality({
    name: 'transition fixture',
    replay,
    summary: {
      ...goodSummary,
      maxAnchorError: 13,
      meanAnchorError: 6.67,
      maxFrameJump: 18.97,
    },
    headPose: {
      ...goodHeadPose,
      summary: {
        ...goodHeadPose,
        hiddenByPolicyFrames: 0,
        worstFrames: [],
      },
      frames: [
        {
          index: 1,
          poseSource: 'planar-homography',
          positionSource: 'planar-homography',
          hiddenByPolicy: false,
          worldPositionError: 0.04,
          rotationError: 0.2,
          scaleLogError: 0.01,
          headJumpExcess: 0,
        },
        {
          index: 2,
          poseSource: 'parametric-surface',
          positionSource: 'reference_similarity_transform',
          hiddenByPolicy: false,
          worldPositionError: 0.15,
          rotationError: 0.8,
          scaleLogError: 0.07,
          headJumpExcess: 0.05,
        },
      ],
    },
  });

  const trackingTransitions = report.stages.tracking.metrics.positionSourceTransitions;
  const headTransitions = report.stages.headAttachment.metrics.poseSourceTransitions;

  assert.equal(trackingTransitions.transitionCount, 1);
  assert.equal(
    trackingTransitions.byTransition['planar-homography->reference_similarity_transform'].frameCount,
    1,
  );
  assert.equal(
    Number(
      trackingTransitions.byTransition[
        'planar-homography->reference_similarity_transform'
      ].maxAnchorJump.toFixed(2),
    ),
    18.97,
  );
  assert.equal(headTransitions.transitionCount, 1);
  assert.equal(headTransitions.byTransition['planar-homography->parametric-surface'].maxHeadJumpExcess, 0.05);
});

test('vision quality summary exposes actionable failure buckets', () => {
  const reports = [
    {
      name: 'busy background cup',
      mode: 'parametric-surface',
      captureCondition: 'motion-blur',
      overallStatus: 'fail',
      failedStages: ['tracking', 'headAttachment'],
      stages: {
        tracking: {
          metrics: {
            byPositionSource: {
              reference_similarity_transform: {
                frameCount: 3,
                meanAnchorError: 12,
                maxAnchorError: 24,
              },
            },
            positionSourceTransitions: {
              transitionCount: 1,
              maxAnchorJump: 18,
              byTransition: {
                'planar-homography->reference_similarity_transform': {
                  frameCount: 1,
                  maxAnchorJump: 18,
                  maxAnchorError: 12,
                },
              },
            },
          },
        },
        headAttachment: {
          metrics: {
            byPoseSource: {
              'parametric-surface': {
                frameCount: 2,
                maxWorldPositionError: 0.18,
                maxRotationError: 0.72,
                maxHeadJumpExcess: 0.02,
              },
            },
            poseSourceTransitions: {
              transitionCount: 1,
              maxHeadJumpExcess: 0.03,
              byTransition: {
                'planar-homography->parametric-surface': {
                  frameCount: 1,
                  maxHeadJumpExcess: 0.03,
                  maxWorldPositionError: 0.18,
                  maxRotationError: 0.72,
                },
              },
            },
          },
        },
      },
    },
    {
      name: 'planar book',
      mode: 'sparse-reconstruction',
      overallStatus: 'pass',
      failedStages: [],
      stages: {
        tracking: {
          metrics: {
            byPositionSource: {
              'planar-homography': {
                frameCount: 4,
                meanAnchorError: 4,
                maxAnchorError: 8,
              },
            },
            positionSourceTransitions: {
              transitionCount: 0,
              maxAnchorJump: 0,
              byTransition: {},
            },
          },
        },
        headAttachment: {
          metrics: {
            byPoseSource: {},
            poseSourceTransitions: {
              transitionCount: 0,
              maxHeadJumpExcess: 0,
              byTransition: {},
            },
          },
        },
      },
    },
  ];

  const summary = summarizeVisionQualityReports(reports);

  assert.equal(summary.aggregate.total, 2);
  assert.equal(summary.aggregate.byStatus.fail, 1);
  assert.equal(summary.failedByMode['parametric-surface'], 1);
  assert.equal(summary.failedByScenario['busy background cup'], 1);
  assert.equal(summary.trackingSources.reference_similarity_transform.frames, 3);
  assert.equal(summary.trackingSources.reference_similarity_transform.meanAnchorError, 12);
  assert.equal(summary.topTrackingSources[0].source, 'reference_similarity_transform');
  assert.equal(summary.headPoseSources['parametric-surface'].maxWorldPositionError, 0.18);
  assert.equal(
    summary.trackingTransitions['planar-homography->reference_similarity_transform'].maxAnchorJump,
    18,
  );
  assert.equal(summary.headPoseTransitions['planar-homography->parametric-surface'].maxHeadJumpExcess, 0.03);
  assert.equal(summary.topFailingScenarios[0].name, 'busy background cup');
  assert.deepEqual(summary.captureConditions['motion-blur'], {
    total: 1,
    byStatus: { fail: 1 },
    failedByStage: { tracking: 1, headAttachment: 1 },
  });
  assert.deepEqual(summary.captureConditions.nominal, {
    total: 1,
    byStatus: { pass: 1 },
    failedByStage: {},
  });
});

test('vision quality summary reads capture condition from benchmark axes', () => {
  const summary = summarizeVisionQualityReports([
    {
      name: 'compound capture case',
      mode: 'sparse-reconstruction',
      axes: { capture: 'handheld-night' },
      overallStatus: 'fail',
      failedStages: ['tracking'],
      stages: {},
    },
  ]);

  assert.deepEqual(summary.captureConditions, {
    'handheld-night': {
      total: 1,
      byStatus: { fail: 1 },
      failedByStage: { tracking: 1 },
    },
  });
});
