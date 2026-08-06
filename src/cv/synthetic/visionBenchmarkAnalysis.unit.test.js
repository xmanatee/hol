import test from 'node:test';
import assert from 'node:assert/strict';

import { createVisionBenchmarkAnalysis, scoreBenchmarkRisk } from './visionBenchmarkAnalysis.js';

const createReport = ({
  name,
  mode,
  axes,
  overallStatus = 'pass',
  failedStages = [],
  meanAnchorError = 3,
  maxAnchorError = 9,
  p50AnchorError = 3,
  p95AnchorError = 6,
  anchorAccuracyAt4 = 0.75,
  anchorAccuracyAt8 = 0.9,
  anchorAccuracyAt16 = 1,
  postOcclusionWindowCount = 0,
  postOcclusionRecoveredAt8 = 0,
  postOcclusionFailedWindowsAt8 = 0,
  postOcclusionRecoveryRateAt8 = 1,
  maxPostOcclusionRecoveryFramesAt8 = 0,
  meanPostOcclusionRecoveryFramesAt8 = 0,
  targetLossWindowCount = 0,
  targetAbsentFrameCount = 0,
  targetPresentAbsentDisplayFrames = 0,
  falseTrackedAbsentAdmittedFrames = 0,
  targetLossRecoveredAt8 = 0,
  targetLossFailedWindowsAt8 = 0,
  targetLossRecoveryRateAt8 = 1,
  maxTargetLossRecoveryFramesAt8 = 0,
  maxFrameJump = 4,
  objectSupportCorrectionFrames = 0,
  objectSupportRecoveryFrames = 0,
  maxObjectSupportPositionStep = 0,
  maxObjectSupportAnchorError = 0,
  meanObjectSupportAnchorError = 0,
  readyFrameRatio = 0.9,
  poseReadyFrameRatio = 0.8,
  meanReadyNormalError = 0.2,
  maxReadyNormalError = 0.4,
  maxMapConfidence = 0.8,
  maxWorldPositionError = 0.04,
  maxRotationError = 0.25,
  maxScaleLogError = 0.04,
  maxHeadJumpExcess = 0.01,
}) => ({
  name,
  mode,
  axes,
  overallStatus,
  failedStages,
  stages: {
    tracking: {
      metrics: {
        meanAnchorError,
        maxAnchorError,
        p50AnchorError,
        p95AnchorError,
        anchorAccuracyAt4,
        anchorAccuracyAt8,
        anchorAccuracyAt16,
        postOcclusionWindowCount,
        postOcclusionRecoveredAt8,
        postOcclusionFailedWindowsAt8,
        postOcclusionRecoveryRateAt8,
        maxPostOcclusionRecoveryFramesAt8,
        meanPostOcclusionRecoveryFramesAt8,
        targetLossWindowCount,
        targetAbsentFrameCount,
        targetPresentAbsentDisplayFrames,
        falseTrackedAbsentAdmittedFrames,
        targetLossRecoveredAt8,
        targetLossFailedWindowsAt8,
        targetLossRecoveryRateAt8,
        maxTargetLossRecoveryFramesAt8,
        maxFrameJump,
        objectSupportCorrectionFrames,
        objectSupportRecoveryFrames,
        maxObjectSupportPositionStep,
        maxObjectSupportAnchorError,
        meanObjectSupportAnchorError,
      },
    },
    reconstruction: {
      metrics: {
        readyFrameRatio,
        poseReadyFrameRatio,
        meanReadyNormalError,
        maxReadyNormalError,
        maxMapConfidence,
      },
    },
    headAttachment: {
      metrics: {
        maxWorldPositionError,
        maxRotationError,
        maxScaleLogError,
        maxHeadJumpExcess,
      },
    },
  },
});

test('benchmark risk ranks anchor spikes and missing reconstruction support as severe', () => {
  const lowRisk = scoreBenchmarkRisk(
    createReport({
      name: 'stable',
      mode: 'depth-fusion',
      axes: { object: 'planar-book' },
    }),
  );
  const highRisk = scoreBenchmarkRisk(
    createReport({
      name: 'bad cup',
      mode: 'direct-photometric',
      axes: { object: 'textured-cup' },
      meanAnchorError: 31,
      maxAnchorError: 82,
      anchorAccuracyAt8: 0.12,
      anchorAccuracyAt16: 0.35,
      maxFrameJump: 18,
      readyFrameRatio: 0.05,
      poseReadyFrameRatio: 0,
      meanReadyNormalError: 1.1,
      maxReadyNormalError: 1.8,
      maxWorldPositionError: 0.22,
    }),
  );

  assert.equal(lowRisk.band, 'low');
  assert.equal(highRisk.band, 'severe');
  assert.ok(highRisk.score > lowRisk.score);
  assert.ok(highRisk.components.some((component) => component.name === 'tracking.meanAnchorError'));
});

test('benchmark risk penalizes missing required evidence instead of scoring it as zero error', () => {
  const complete = createReport({
    name: 'stable',
    mode: 'depth-fusion',
    axes: { object: 'planar-book' },
  });
  const missing = {
    name: 'missing metrics',
    mode: 'direct-photometric',
    axes: {
      object: 'handled-mug',
      geometry: 'handled-tapered-cylinder',
      background: 'kitchen',
      lighting: 'tiled-specular-clutter',
      motion: 'fast',
      occlusion: 'early',
    },
    overallStatus: 'fail',
    failedStages: ['tracking', 'reconstruction', 'headAttachment'],
    stages: {
      tracking: { metrics: {} },
      reconstruction: { metrics: {} },
      headAttachment: { metrics: {} },
    },
  };

  const missingRisk = scoreBenchmarkRisk(missing);
  const analysis = createVisionBenchmarkAnalysis([complete, missing]);

  assert.equal(missingRisk.band, 'severe');
  assert.equal(missingRisk.primaryWeakness, 'tracking.meanAnchorError');
  assert.ok(missingRisk.score > scoreBenchmarkRisk(complete).score);
  assert.equal(analysis.worstReports[0].name, 'missing metrics');
  assert.equal(analysis.worstReports[0].metrics.meanAnchorError, null);
  assert.equal(analysis.worstReports[0].metrics.readyFrameRatio, null);
});

test('benchmark analysis groups weak points by mode and condition axes', () => {
  const reports = [
    createReport({
      name: 'stable book',
      mode: 'depth-fusion',
      axes: {
        object: 'planar-book',
        targetClass: 'book',
        geometry: 'planar',
        background: 'desk',
        lighting: 'soft-desk',
        motion: 'standard',
        occlusion: 'clean',
      },
    }),
    createReport({
      name: 'unstable mug',
      mode: 'direct-photometric',
      overallStatus: 'fail',
      failedStages: ['tracking', 'headAttachment'],
      axes: {
        object: 'handled-mug',
        targetClass: 'mug',
        geometry: 'handled-tapered-cylinder',
        background: 'kitchen',
        lighting: 'tiled-specular-clutter',
        motion: 'fast',
        occlusion: 'repeated',
      },
      meanAnchorError: 26,
      maxAnchorError: 78,
      p50AnchorError: 24,
      p95AnchorError: 45,
      maxFrameJump: 22,
      postOcclusionWindowCount: 2,
      postOcclusionRecoveryRateAt8: 0.5,
      maxPostOcclusionRecoveryFramesAt8: 3,
      objectSupportCorrectionFrames: 8,
      objectSupportRecoveryFrames: 7,
      maxObjectSupportPositionStep: 6,
      maxObjectSupportAnchorError: 44,
      meanObjectSupportAnchorError: 18,
      readyFrameRatio: 0.12,
      poseReadyFrameRatio: 0,
      maxWorldPositionError: 0.26,
    }),
  ];
  const analysis = createVisionBenchmarkAnalysis(reports);

  assert.equal(analysis.aggregate.total, 2);
  assert.equal(analysis.aggregate.byRiskBand.severe, 1);
  assert.equal(analysis.weakPoints.byMode[0].name, 'direct-photometric');
  assert.equal(analysis.weakPoints.byObject[0].name, 'handled-mug');
  assert.equal(analysis.weakPoints.byTargetClass[0].name, 'mug');
  assert.equal(analysis.weakPoints.byBackground[0].name, 'kitchen');
  assert.equal(analysis.weakPoints.byOcclusion[0].name, 'repeated');
  assert.equal(analysis.weakPoints.byModeObject[0].name, 'direct-photometric / handled-mug');
  assert.equal(analysis.weakPoints.byObjectOcclusion[0].name, 'handled-mug / repeated');
  assert.equal(analysis.weakPoints.byObjectBackground[0].name, 'handled-mug / kitchen');
  assert.equal(analysis.weakPoints.byModeOcclusion[0].name, 'direct-photometric / repeated');
  assert.equal(analysis.worstReports[0].name, 'unstable mug');
  assert.equal(analysis.worstReports[0].metrics.anchorAccuracyAt8, 0.9);
  assert.equal(analysis.worstReports[0].metrics.p95AnchorError, 45);
  assert.equal(analysis.worstReports[0].metrics.postOcclusionRecoveryRateAt8, 0.5);
  assert.equal(analysis.worstReports[0].metrics.maxPostOcclusionRecoveryFramesAt8, 3);
  assert.equal(analysis.worstReports[0].metrics.objectSupportRecoveryFrames, 7);
  assert.equal(analysis.worstReports[0].metrics.maxObjectSupportAnchorError, 44);
});

test('benchmark analysis exposes capture weakness and post-occlusion recovery groups', () => {
  const reports = [
    createReport({
      name: 'nominal book',
      mode: 'sparse-reconstruction',
      axes: {
        object: 'planar-book',
        targetClass: 'book',
        geometry: 'planar',
        background: 'desk',
        lighting: 'soft-desk',
        motion: 'fast',
        occlusion: 'repeated',
        capture: 'nominal',
      },
      postOcclusionWindowCount: 2,
      postOcclusionRecoveredAt8: 2,
    }),
    createReport({
      name: 'night mug',
      mode: 'sparse-reconstruction',
      axes: {
        object: 'handled-mug',
        targetClass: 'mug',
        geometry: 'handled-tapered-cylinder',
        background: 'kitchen',
        lighting: 'tiled-specular-clutter',
        motion: 'fast',
        occlusion: 'repeated',
        capture: 'handheld-night',
      },
      overallStatus: 'fail',
      failedStages: ['tracking'],
      meanAnchorError: 28,
      postOcclusionWindowCount: 2,
      postOcclusionRecoveredAt8: 0,
      postOcclusionFailedWindowsAt8: 2,
      postOcclusionRecoveryRateAt8: 0,
      maxPostOcclusionRecoveryFramesAt8: 24,
    }),
  ];

  const analysis = createVisionBenchmarkAnalysis(reports);

  assert.equal(analysis.weakPoints.byCapture[0].name, 'handheld-night');
  assert.equal(analysis.weakPoints.byModeCapture[0].name, 'sparse-reconstruction / handheld-night');
  assert.equal(analysis.postOcclusionRecovery.byCapture[0].name, 'handheld-night');
  assert.equal(analysis.postOcclusionRecovery.byCapture[0].failedWindowsAt8, 2);
});

test('benchmark analysis aggregates full-loss false locks and recovery outcomes', () => {
  const analysis = createVisionBenchmarkAnalysis([
    createReport({
      name: 'full loss sparse',
      mode: 'sparse-reconstruction',
      axes: { object: 'laminated-card', event: 'full-loss-reentry' },
      targetLossWindowCount: 1,
      targetAbsentFrameCount: 12,
      targetPresentAbsentDisplayFrames: 9,
      falseTrackedAbsentAdmittedFrames: 8,
      targetLossRecoveredAt8: 1,
      targetLossRecoveryRateAt8: 1,
      maxTargetLossRecoveryFramesAt8: 3,
    }),
    createReport({
      name: 'full loss direct',
      mode: 'direct-photometric',
      axes: { object: 'laminated-card', event: 'full-loss-reentry' },
      targetLossWindowCount: 1,
      targetAbsentFrameCount: 12,
      targetPresentAbsentDisplayFrames: 13,
      falseTrackedAbsentAdmittedFrames: 12,
      targetLossFailedWindowsAt8: 1,
      targetLossRecoveryRateAt8: 0,
      maxTargetLossRecoveryFramesAt8: 14,
    }),
  ]);

  assert.deepEqual(analysis.targetLossRecovery, {
    reportCount: 2,
    windowCount: 2,
    absentFrameCount: 24,
    targetPresentAbsentDisplayFrames: 22,
    falseTrackedAbsentAdmittedFrames: 20,
    recoveredAt8: 1,
    failedWindowsAt8: 1,
    maxRecoveryFramesAt8: 14,
    recoveryRateAt8: 0.5,
  });
  assert.equal(analysis.weakPoints.byEvent[0].name, 'full-loss-reentry');
});

test('benchmark risk includes thresholded anchor accuracy without inflating total tracking weight', () => {
  const highAccuracy = scoreBenchmarkRisk(
    createReport({
      name: 'accurate frames',
      mode: 'sparse-reconstruction',
      axes: { object: 'planar-book' },
      meanAnchorError: 2,
      maxAnchorError: 12,
      maxFrameJump: 4,
      anchorAccuracyAt4: 0.6,
      anchorAccuracyAt8: 0.9,
      anchorAccuracyAt16: 1,
    }),
  );
  const lowAccuracy = scoreBenchmarkRisk(
    createReport({
      name: 'many marginal frames',
      mode: 'sparse-reconstruction',
      axes: { object: 'planar-book' },
      meanAnchorError: 2,
      maxAnchorError: 12,
      maxFrameJump: 4,
      anchorAccuracyAt4: 0.15,
      anchorAccuracyAt8: 0.2,
      anchorAccuracyAt16: 0.9,
    }),
  );

  assert.equal(lowAccuracy.primaryWeakness, 'tracking.anchorAccuracyAt8');
  assert.ok(lowAccuracy.score > highAccuracy.score);
});

test('benchmark risk includes p95 anchor error without inflating total tracking weight', () => {
  const lowTail = scoreBenchmarkRisk(
    createReport({
      name: 'stable tail',
      mode: 'sparse-reconstruction',
      axes: { object: 'planar-book' },
      meanAnchorError: 2,
      maxAnchorError: 30,
      p50AnchorError: 2,
      p95AnchorError: 8,
      maxFrameJump: 3,
      anchorAccuracyAt8: 0.96,
      anchorAccuracyAt16: 1,
    }),
  );
  const highTail = scoreBenchmarkRisk(
    createReport({
      name: 'unstable tail',
      mode: 'sparse-reconstruction',
      axes: { object: 'planar-book' },
      meanAnchorError: 2,
      maxAnchorError: 30,
      p50AnchorError: 2,
      p95AnchorError: 24,
      maxFrameJump: 3,
      anchorAccuracyAt8: 0.96,
      anchorAccuracyAt16: 1,
    }),
  );
  const saturatedTrackingOnly = scoreBenchmarkRisk(
    createReport({
      name: 'saturated tracking',
      mode: 'sparse-reconstruction',
      axes: { object: 'planar-book' },
      meanAnchorError: 15,
      maxAnchorError: 45,
      p50AnchorError: 12,
      p95AnchorError: 30,
      maxFrameJump: 20,
      anchorAccuracyAt8: 0,
      anchorAccuracyAt16: 0,
      postOcclusionWindowCount: 1,
      postOcclusionRecoveryRateAt8: 0,
      maxPostOcclusionRecoveryFramesAt8: 15,
      readyFrameRatio: 1,
      poseReadyFrameRatio: 1,
      meanReadyNormalError: 0,
      maxReadyNormalError: 0,
      maxMapConfidence: 1,
      maxWorldPositionError: 0,
      maxRotationError: 0,
      maxScaleLogError: 0,
      maxHeadJumpExcess: 0,
    }),
  );

  assert.ok(highTail.score > lowTail.score);
  assert.ok(Math.abs(saturatedTrackingOnly.score - 44) < 1e-9);
  assert.ok(highTail.components.some((component) => component.name === 'tracking.p95AnchorError'));
});

test('benchmark risk scores post-occlusion recovery without penalizing clean runs', () => {
  const clean = scoreBenchmarkRisk(
    createReport({
      name: 'clean stable run',
      mode: 'depth-fusion',
      axes: { object: 'planar-book', occlusion: 'clean' },
      meanAnchorError: 2,
      maxAnchorError: 6,
      maxFrameJump: 3,
      anchorAccuracyAt8: 0.96,
      anchorAccuracyAt16: 1,
    }),
  );
  const cleanWithRecoveryPlaceholders = scoreBenchmarkRisk(
    createReport({
      name: 'clean stable run with empty recovery fields',
      mode: 'depth-fusion',
      axes: { object: 'planar-book', occlusion: 'clean' },
      meanAnchorError: 2,
      maxAnchorError: 6,
      maxFrameJump: 3,
      anchorAccuracyAt8: 0.96,
      anchorAccuracyAt16: 1,
      postOcclusionWindowCount: 0,
      postOcclusionRecoveryRateAt8: 0,
      maxPostOcclusionRecoveryFramesAt8: 24,
    }),
  );
  const slowRecovery = scoreBenchmarkRisk(
    createReport({
      name: 'slow recovery after occlusion',
      mode: 'depth-fusion',
      axes: { object: 'handled-mug', occlusion: 'repeated' },
      meanAnchorError: 2,
      maxAnchorError: 6,
      maxFrameJump: 3,
      anchorAccuracyAt8: 0.96,
      anchorAccuracyAt16: 1,
      postOcclusionWindowCount: 2,
      postOcclusionRecoveryRateAt8: 0.25,
      maxPostOcclusionRecoveryFramesAt8: 18,
    }),
  );

  assert.equal(clean.score, cleanWithRecoveryPlaceholders.score);
  assert.equal(slowRecovery.primaryWeakness, 'tracking.postOcclusionRecoveryFramesAt8');
  assert.ok(slowRecovery.score > clean.score);
});

test('benchmark analysis summarizes post-occlusion recovery by audit axis', () => {
  const reports = [
    createReport({
      name: 'clean book',
      mode: 'depth-fusion',
      axes: {
        object: 'planar-book',
        targetClass: 'book',
        geometry: 'planar',
        background: 'desk',
        lighting: 'soft-desk',
        motion: 'standard',
        occlusion: 'clean',
      },
    }),
    createReport({
      name: 'mug partial recovery',
      mode: 'direct-photometric',
      axes: {
        object: 'handled-mug',
        targetClass: 'mug',
        geometry: 'handled-tapered-cylinder',
        background: 'kitchen',
        lighting: 'tiled-specular-clutter',
        motion: 'slow',
        occlusion: 'repeated',
      },
      postOcclusionWindowCount: 2,
      postOcclusionRecoveredAt8: 1,
      postOcclusionFailedWindowsAt8: 1,
      postOcclusionRecoveryRateAt8: 0.5,
      maxPostOcclusionRecoveryFramesAt8: 12,
      meanPostOcclusionRecoveryFramesAt8: 7,
    }),
    createReport({
      name: 'can fast recovery',
      mode: 'depth-fusion',
      axes: {
        object: 'glossy-can',
        targetClass: 'can',
        geometry: 'cylindrical-specular',
        background: 'window',
        lighting: 'high-contrast-backlight',
        motion: 'fast',
        occlusion: 'early',
      },
      postOcclusionWindowCount: 1,
      postOcclusionRecoveredAt8: 1,
      postOcclusionFailedWindowsAt8: 0,
      postOcclusionRecoveryRateAt8: 1,
      maxPostOcclusionRecoveryFramesAt8: 2,
      meanPostOcclusionRecoveryFramesAt8: 2,
    }),
    createReport({
      name: 'mug no recovery',
      mode: 'sparse-reconstruction',
      axes: {
        object: 'handled-mug',
        targetClass: 'mug',
        geometry: 'handled-tapered-cylinder',
        background: 'busy',
        lighting: 'moving-high-frequency-clutter',
        motion: 'slow',
        occlusion: 'early',
      },
      postOcclusionWindowCount: 2,
      postOcclusionRecoveredAt8: 0,
      postOcclusionFailedWindowsAt8: 2,
      postOcclusionRecoveryRateAt8: 0,
      maxPostOcclusionRecoveryFramesAt8: 16,
      meanPostOcclusionRecoveryFramesAt8: 16,
    }),
  ];
  const analysis = createVisionBenchmarkAnalysis(reports);
  const recovery = analysis.postOcclusionRecovery;

  assert.equal(recovery.aggregate.reportCount, 3);
  assert.equal(recovery.aggregate.windowCount, 5);
  assert.equal(recovery.aggregate.recoveredAt8, 2);
  assert.equal(recovery.aggregate.failedWindowsAt8, 3);
  assert.equal(recovery.aggregate.recoveryRateAt8, 0.4);
  assert.equal(recovery.aggregate.maxRecoveryFramesAt8, 16);
  assert.equal(recovery.aggregate.meanRecoveryFramesAt8, 9.6);
  assert.equal(recovery.worstReports[0].name, 'mug no recovery');
  assert.equal(recovery.byObject[0].name, 'handled-mug');
  assert.equal(recovery.byObject[0].recoveryRateAt8, 0.25);
  assert.equal(recovery.byTargetClass[0].name, 'mug');
  assert.equal(recovery.byTargetClass[0].recoveryRateAt8, 0.25);
  assert.equal(recovery.byTargetClassOcclusion[0].name, 'mug / early');
  assert.equal(recovery.byMode[0].name, 'sparse-reconstruction');
  assert.equal(recovery.byOcclusion[0].name, 'early');
});

test('benchmark analysis separates all-run and failed-run primary weaknesses', () => {
  const sharedAxes = {
    object: 'handled-mug',
    geometry: 'handled-tapered-cylinder',
    background: 'desk',
    lighting: 'soft-desk',
    motion: 'standard',
    occlusion: 'clean',
  };
  const reports = [
    createReport({
      name: 'stable mug a',
      mode: 'depth-fusion',
      axes: sharedAxes,
      meanAnchorError: 2,
      maxAnchorError: 3,
      maxFrameJump: 1,
    }),
    createReport({
      name: 'stable mug b',
      mode: 'depth-fusion',
      axes: sharedAxes,
      meanAnchorError: 2,
      maxAnchorError: 3,
      maxFrameJump: 1,
    }),
    createReport({
      name: 'bad head attachment mug',
      mode: 'depth-fusion',
      axes: sharedAxes,
      overallStatus: 'fail',
      failedStages: ['headAttachment'],
      meanAnchorError: 0.5,
      maxAnchorError: 1,
      maxFrameJump: 1,
      maxWorldPositionError: 0.8,
    }),
  ];

  const analysis = createVisionBenchmarkAnalysis(reports);
  const mugGroup = analysis.weakPoints.byObject.find((group) => group.name === 'handled-mug');

  assert.equal(mugGroup.topPrimaryWeaknesses[0].weakness, 'tracking.meanAnchorError');
  assert.equal(mugGroup.topPrimaryWeaknesses[0].count, 2);
  assert.equal(mugGroup.topFailedPrimaryWeaknesses[0].weakness, 'headAttachment.maxWorldPositionError');
  assert.equal(mugGroup.topFailedPrimaryWeaknesses[0].count, 1);
});
