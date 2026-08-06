import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const parseAnnotatedVisionBenchmarkArgs = (args) => {
  let outputPath = null;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    let candidatePath;

    if (argument === '--output') {
      candidatePath = args[index + 1];
      if (!candidatePath || candidatePath.startsWith('--')) {
        throw new Error('Missing path after --output');
      }
      index++;
    } else if (argument.startsWith('--output=')) {
      candidatePath = argument.slice('--output='.length);
      if (!candidatePath) throw new Error('Missing path after --output');
    } else {
      throw new Error(`Unknown annotated benchmark flag: ${argument}`);
    }

    if (outputPath !== null) {
      throw new Error('Annotated benchmark output path may be specified only once');
    }
    outputPath = candidatePath;
  }

  return { outputPath };
};

const compactMetrics = (metrics) => ({
  queryCount: metrics.queryCount,
  evaluationPointCount: metrics.evaluationPointCount,
  visibleGroundTruthPointCount: metrics.visibleGroundTruthPointCount,
  predictedVisiblePointCount: metrics.predictedVisiblePointCount,
  averageJaccard: metrics.averageJaccard,
  averagePointsWithinThreshold: metrics.averagePointsWithinThreshold,
  occlusionAccuracy: metrics.occlusionAccuracy,
  reDetectionAverageJaccard: metrics.reDetectionAverageJaccard,
  stableReDetectionEligibleCount: metrics.stableReDetectionEligibleCount,
  stableReDetectionRecoveredCount: metrics.stableReDetectionRecoveredCount,
  stableReDetectionRecall: metrics.stableReDetectionRecall,
  maximumStableReDetectionLatencyMs: metrics.maximumStableReDetectionLatencyMs,
  maximumFalseVisibleDurationMs: metrics.maximumFalseVisibleDurationMs,
  maximumMissedVisibleDurationMs: metrics.maximumMissedVisibleDurationMs,
  visibleTrackFragmentationCount: metrics.visibleTrackFragmentationCount,
  p95VisiblePointError: metrics.p95VisiblePointError,
});

const compactQuery = (query) => ({
  id: query.id,
  anchorCreated: query.anchorCreated,
  createFailure: query.createFailure,
  evaluatedFrames: query.evaluatedFrames,
  admittedUpdates: query.admittedUpdates,
  visiblePredictions: query.visiblePredictions,
  metrics: compactMetrics(query.metrics),
});

const compactQuerySet = (querySet) => ({
  id: querySet.id,
  metrics: compactMetrics(querySet.metrics),
  queries: querySet.queries.map(compactQuery),
});

const compactFixture = (report) => ({
  id: report.id,
  dataset: report.dataset,
  frameDerivation: report.frameDerivation,
  frames: report.frames,
  metrics: compactMetrics(report.metrics),
  querySets: report.querySets.map(compactQuerySet),
});

export const compactAnnotatedVisionBenchmarkOutput = (output) => ({
  summary: output.summary,
  aggregate: output.aggregate,
  reports: output.reports.map(compactFixture),
});

const artifactSummary = (output, outputPath) => ({
  outputPath,
  fixtures: output.summary.fixtures,
  frames: output.summary.frames,
  independentQueries: output.summary.independentQueries,
  averageJaccard: output.aggregate.averageJaccard,
  occlusionAccuracy: output.aggregate.occlusionAccuracy,
  reDetectionAverageJaccard: output.aggregate.reDetectionAverageJaccard,
  stableReDetectionRecall: output.aggregate.stableReDetectionRecall,
  maximumStableReDetectionLatencyMs: output.aggregate.maximumStableReDetectionLatencyMs,
  maximumFalseVisibleDurationMs: output.aggregate.maximumFalseVisibleDurationMs,
  maximumMissedVisibleDurationMs: output.aggregate.maximumMissedVisibleDurationMs,
  visibleTrackFragmentationCount: output.aggregate.visibleTrackFragmentationCount,
});

export const formatAnnotatedVisionBenchmarkOutput = async (output, { outputPath = null } = {}) => {
  if (outputPath === null) {
    return JSON.stringify(compactAnnotatedVisionBenchmarkOutput(output), null, 2);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return JSON.stringify(artifactSummary(output, outputPath), null, 2);
};
