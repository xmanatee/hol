import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreVisionPipelineQuality } from './stageQualityScoring.js';

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
    Object.values(report.stages).map(stage => stage.status),
    ['pass', 'pass', 'pass', 'pass']
  );
});

test('vision quality scorer identifies each failing stage', () => {
  const report = scoreVisionPipelineQuality({
    name: 'bad fixture',
    replay: {
      anchorCreated: false,
      createFailure: 'No detection selected at tap position',
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
