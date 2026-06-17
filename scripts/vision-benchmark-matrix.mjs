import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import {
  createSyntheticDepthFrame,
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';
import { createVisionBenchmarkMatrix } from '../src/cv/synthetic/visionBenchmarkMatrix.js';
import { createVisionBenchmarkAnalysis } from '../src/cv/synthetic/visionBenchmarkAnalysis.js';
import { RECONSTRUCTION_MODES } from '../src/cv/anchor.reconstructionModes.js';
import {
  VISION_QUALITY_THRESHOLDS,
  scoreVisionPipelineQuality,
  summarizeVisionQualityReports,
} from '../src/cv/stageQualityScoring.js';

const SYNTHETIC_OBJECT_SUPPORT = 'synthetic-object-mask';

const argSet = new Set(process.argv.slice(2));
const size = argSet.has('--full') ? 'full' : argSet.has('--quick') ? 'quick' : 'representative';
const summaryOnly = argSet.has('--summary-only');
const quiet = argSet.has('--quiet');
const failOnSevere = argSet.has('--fail-on-severe');
const cv = await loadOpenCvForNode();
const scenarios = createVisionBenchmarkMatrix({ size });
const reports = [];
const totalRuns = scenarios.length * RECONSTRUCTION_MODES.length;
let completedRuns = 0;

for (const scenario of scenarios) {
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
    const summary = summarizeReplay(replay);
    const headPose = scoreHeadPoseReplay({ replay, sequence });
    const quality = scoreVisionPipelineQuality({
      name: `${mode.id}/${scenario.name}`,
      replay,
      summary,
      headPose,
      thresholds: VISION_QUALITY_THRESHOLDS,
    });

    completedRuns++;
    if (!quiet && completedRuns % 12 === 0) {
      console.error(`benchmark ${completedRuns}/${totalRuns}`);
    }

    reports.push({
      name: scenario.name,
      kind: sequence.kind,
      mode: mode.id,
      targetClass: sequence.targetClass,
      axes: scenario.axes,
      objectSupportMask: SYNTHETIC_OBJECT_SUPPORT,
      overallStatus: quality.overallStatus,
      failedStages: quality.failedStages,
      stages: quality.stages,
    });
  }
}

const qualitySummary = summarizeVisionQualityReports(reports);
const benchmark = createVisionBenchmarkAnalysis(reports);
const output = {
  size,
  scenarioCount: scenarios.length,
  modeCount: RECONSTRUCTION_MODES.length,
  replayCount: reports.length,
  qualitySummary,
  benchmark: summaryOnly
    ? {
        aggregate: benchmark.aggregate,
        weakPoints: benchmark.weakPoints,
        worstReports: benchmark.worstReports,
      }
    : benchmark,
};

console.log(JSON.stringify(output, null, 2));

if (failOnSevere && benchmark.aggregate.byRiskBand.severe) {
  process.exitCode = 1;
}
