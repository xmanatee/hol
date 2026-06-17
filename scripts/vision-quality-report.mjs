import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import { reportReplayScenarios } from '../src/cv/synthetic/visionReplayScenarios.js';
import {
  createSyntheticDepthFrame,
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';
import { RECONSTRUCTION_MODES } from '../src/cv/anchor.reconstructionModes.js';
import {
  VISION_QUALITY_THRESHOLDS,
  scoreVisionPipelineQuality,
  summarizeVisionQualityReports,
} from '../src/cv/stageQualityScoring.js';

const SYNTHETIC_OBJECT_SUPPORT = 'synthetic-object-mask';
const finiteOverrides = values => Object.fromEntries(
  Object.entries(values).filter(([, value]) => Number.isFinite(value))
);

const qualityThresholdsForScenario = ({ scenario, mode }) => {
  const limits = scenario.limitsByMode?.[mode.id] || scenario.limits || {};
  const stageThresholds = scenario.qualityThresholdsByMode?.[mode.id] || scenario.qualityThresholds || {};
  if (!Object.keys(limits).length && !Object.keys(stageThresholds).length) return VISION_QUALITY_THRESHOLDS;

  return {
    ...VISION_QUALITY_THRESHOLDS,
    tracking: {
      ...VISION_QUALITY_THRESHOLDS.tracking,
      ...finiteOverrides({
        maxMeanAnchorError: limits.meanAnchorError,
        maxAnchorError: limits.maxAnchorError,
        maxFrameJump: limits.maxFrameJump,
      }),
    },
    reconstruction: {
      ...VISION_QUALITY_THRESHOLDS.reconstruction,
      ...finiteOverrides(stageThresholds.reconstruction || {}),
    },
    headAttachment: {
      ...VISION_QUALITY_THRESHOLDS.headAttachment,
      ...finiteOverrides({
        maxWorldPositionError: limits.maxWorldPositionError,
        maxRotationError: limits.maxRotationError,
        maxScaleLogError: limits.maxScaleLogError,
        maxHeadJumpExcess: limits.maxHeadJumpExcess,
      }),
    },
  };
};

const cv = await loadOpenCvForNode();
const reports = [];

for (const scenario of reportReplayScenarios) {
  for (const mode of RECONSTRUCTION_MODES) {
    const sequence = scenario.create();
    const replay = await replayImageAnchorSequence({
      cv,
      sequence,
      trackingMode: mode.id,
      useObjectSupportMask: true,
      depthFrameForFrame: mode.requiresDepthFrame ? createSyntheticDepthFrame : null,
    });
    const summary = summarizeReplay(replay);
    const headPose = scoreHeadPoseReplay({ replay, sequence });
    const quality = scoreVisionPipelineQuality({
      name: `${mode.id}/${scenario.name}`,
      replay,
      summary,
      headPose,
      thresholds: qualityThresholdsForScenario({ scenario, mode }),
    });

    reports.push({
      name: scenario.name,
      kind: sequence.kind,
      mode: mode.id,
      targetClass: sequence.targetClass,
      objectSupportMask: SYNTHETIC_OBJECT_SUPPORT,
      overallStatus: quality.overallStatus,
      failedStages: quality.failedStages,
      stages: quality.stages,
    });
  }
}

const summary = summarizeVisionQualityReports(reports);

console.log(JSON.stringify({
  ...summary,
  reports,
}, null, 2));

if (summary.aggregate.byStatus.fail) {
  process.exitCode = 1;
}
