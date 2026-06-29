import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createVisionBenchmarkAnalysis,
  scoreBenchmarkRisk,
} from './visionBenchmarkAnalysis.js';

const createReport = ({
  name,
  mode,
  axes,
  overallStatus = 'pass',
  failedStages = [],
  meanAnchorError = 3,
  maxAnchorError = 9,
  maxFrameJump = 4,
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
        maxFrameJump,
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
  const lowRisk = scoreBenchmarkRisk(createReport({
    name: 'stable',
    mode: 'depth-fusion',
    axes: { object: 'planar-book' },
  }));
  const highRisk = scoreBenchmarkRisk(createReport({
    name: 'bad cup',
    mode: 'direct-photometric',
    axes: { object: 'textured-cup' },
    meanAnchorError: 31,
    maxAnchorError: 82,
    maxFrameJump: 18,
    readyFrameRatio: 0.05,
    poseReadyFrameRatio: 0,
    meanReadyNormalError: 1.1,
    maxReadyNormalError: 1.8,
    maxWorldPositionError: 0.22,
  }));

  assert.equal(lowRisk.band, 'low');
  assert.equal(highRisk.band, 'severe');
  assert.ok(highRisk.score > lowRisk.score);
  assert.ok(highRisk.components.some(component => component.name === 'tracking.meanAnchorError'));
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
        geometry: 'handled-tapered-cylinder',
        background: 'kitchen',
        lighting: 'tiled-specular-clutter',
        motion: 'fast',
        occlusion: 'repeated',
      },
      meanAnchorError: 26,
      maxAnchorError: 78,
      maxFrameJump: 22,
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
  assert.equal(analysis.weakPoints.byBackground[0].name, 'kitchen');
  assert.equal(analysis.weakPoints.byOcclusion[0].name, 'repeated');
  assert.equal(analysis.worstReports[0].name, 'unstable mug');
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
  const mugGroup = analysis.weakPoints.byObject.find(group => group.name === 'handled-mug');

  assert.equal(mugGroup.topPrimaryWeaknesses[0].weakness, 'tracking.meanAnchorError');
  assert.equal(mugGroup.topPrimaryWeaknesses[0].count, 2);
  assert.equal(mugGroup.topFailedPrimaryWeaknesses[0].weakness, 'headAttachment.maxWorldPositionError');
  assert.equal(mugGroup.topFailedPrimaryWeaknesses[0].count, 1);
});
