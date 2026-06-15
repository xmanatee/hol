import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import { reportReplayScenarios } from '../src/cv/synthetic/visionReplayScenarios.js';
import {
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';
import { RECONSTRUCTION_MODES } from '../src/cv/anchor.reconstructionModes.js';
import { scoreVisionPipelineQuality } from '../src/cv/stageQualityScoring.js';

const cv = await loadOpenCvForNode();
const reports = [];

for (const scenario of reportReplayScenarios) {
  for (const mode of RECONSTRUCTION_MODES) {
    const sequence = scenario.create();
    const replay = await replayImageAnchorSequence({
      cv,
      sequence,
      trackingMode: mode.id,
    });
    const summary = summarizeReplay(replay);
    const headPose = scoreHeadPoseReplay({ replay, sequence }).summary;
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
      overallStatus: quality.overallStatus,
      failedStages: quality.failedStages,
      stages: quality.stages,
    });
  }
}

const aggregate = reports.reduce((result, report) => {
  result.total++;
  result.byStatus[report.overallStatus] = (result.byStatus[report.overallStatus] || 0) + 1;
  report.failedStages.forEach(stageName => {
    result.failedByStage[stageName] = (result.failedByStage[stageName] || 0) + 1;
  });
  return result;
}, {
  total: 0,
  byStatus: {},
  failedByStage: {},
});

console.log(JSON.stringify({
  aggregate,
  reports,
}, null, 2));

if (aggregate.byStatus.fail) {
  process.exitCode = 1;
}
