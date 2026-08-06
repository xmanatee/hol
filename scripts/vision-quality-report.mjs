import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import { reportReplayScenarios } from '../src/cv/synthetic/visionReplayScenarios.js';
import { formatVisionQualityOutput, parseVisionQualityArgs } from '../src/cv/synthetic/visionQualityCli.js';
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
const { outputPath } = parseVisionQualityArgs(process.argv.slice(2));
const finiteOverrides = (values) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => Number.isFinite(value)));

const mergeStageThresholds = (base = {}, override = {}) => ({
  selection: {
    ...(base.selection ?? {}),
    ...(override.selection ?? {}),
  },
  tracking: {
    ...(base.tracking ?? {}),
    ...(override.tracking ?? {}),
  },
  reconstruction: {
    ...(base.reconstruction ?? {}),
    ...(override.reconstruction ?? {}),
  },
  headAttachment: {
    ...(base.headAttachment ?? {}),
    ...(override.headAttachment ?? {}),
  },
});

const hasStageThresholds = (stageThresholds) =>
  Object.values(stageThresholds).some((thresholds) => Object.keys(thresholds).length);

const qualityThresholdsForScenario = ({ scenario, mode }) => {
  const limits = {
    ...(scenario.limits ?? {}),
    ...(scenario.limitsByMode?.[mode.id] ?? {}),
  };
  const stageThresholds = mergeStageThresholds(
    scenario.qualityThresholds,
    scenario.qualityThresholdsByMode?.[mode.id],
  );
  if (!Object.keys(limits).length && !hasStageThresholds(stageThresholds)) return VISION_QUALITY_THRESHOLDS;

  return {
    ...VISION_QUALITY_THRESHOLDS,
    selection: {
      ...VISION_QUALITY_THRESHOLDS.selection,
      ...finiteOverrides(stageThresholds.selection ?? {}),
    },
    tracking: {
      ...VISION_QUALITY_THRESHOLDS.tracking,
      ...finiteOverrides({
        maxMeanAnchorError: limits.meanAnchorError,
        maxAnchorError: limits.maxAnchorError,
        maxFrameJump: limits.maxFrameJump,
      }),
      ...finiteOverrides(stageThresholds.tracking ?? {}),
    },
    reconstruction: {
      ...VISION_QUALITY_THRESHOLDS.reconstruction,
      ...finiteOverrides(stageThresholds.reconstruction ?? {}),
    },
    headAttachment: {
      ...VISION_QUALITY_THRESHOLDS.headAttachment,
      ...finiteOverrides({
        maxWorldPositionError: limits.maxWorldPositionError,
        maxRotationError: limits.maxRotationError,
        maxScaleLogError: limits.maxScaleLogError,
        maxHeadJumpExcess: limits.maxHeadJumpExcess,
      }),
      ...finiteOverrides(stageThresholds.headAttachment ?? {}),
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
      refreshObjectSupportMask: true,
      depthFrameForFrame: mode.requiresDepthFrame ? createSyntheticDepthFrame : null,
    });
    const replaySummary = summarizeReplay(replay);
    const headPose = scoreHeadPoseReplay({ replay, sequence });
    const quality = scoreVisionPipelineQuality({
      name: `${mode.id}/${scenario.name}`,
      replay,
      summary: replaySummary,
      headPose,
      thresholds: qualityThresholdsForScenario({ scenario, mode }),
    });

    reports.push({
      name: scenario.name,
      kind: sequence.kind,
      mode: mode.id,
      targetClass: sequence.targetClass,
      captureCondition: sequence.metadata.captureCondition || 'nominal',
      objectSupportMask: SYNTHETIC_OBJECT_SUPPORT,
      overallStatus: quality.overallStatus,
      failedStages: quality.failedStages,
      stages: quality.stages,
    });
  }
}

const summary = summarizeVisionQualityReports(reports);
const output = { ...summary, reports };

console.log(await formatVisionQualityOutput(output, { outputPath }));

if (summary.aggregate.byStatus.fail) {
  process.exitCode = 1;
}
