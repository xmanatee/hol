import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import { reportReplayScenarios } from '../src/cv/synthetic/visionReplayScenarios.js';
import {
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';
import { RECONSTRUCTION_MODES } from '../src/cv/anchor.reconstructionModes.js';
import {
  scoreVisionPipelineQuality,
  summarizeVisionQualityReports,
} from '../src/cv/stageQualityScoring.js';

const SYNTHETIC_OBJECT_SUPPORT = 'synthetic-object-mask';
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
    });
    const summary = summarizeReplay(replay);
    const headPose = scoreHeadPoseReplay({ replay, sequence });
    const quality = scoreVisionPipelineQuality({
      name: `${mode.id}/${scenario.name}`,
      replay,
      summary,
      headPose,
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
