import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const parseVisionQualityArgs = (args) => {
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
      if (!candidatePath) {
        throw new Error('Missing path after --output');
      }
    } else {
      throw new Error(`Unknown quality flag: ${argument}`);
    }

    if (outputPath !== null) {
      throw new Error('Quality output path may be specified only once');
    }
    outputPath = candidatePath;
  }

  return { outputPath };
};

const compactFailingReport = (report) => ({
  name: report.name,
  kind: report.kind,
  mode: report.mode,
  targetClass: report.targetClass,
  captureCondition: report.captureCondition,
  overallStatus: report.overallStatus,
  failedStages: report.failedStages,
  stages: Object.fromEntries(report.failedStages.map((stage) => [stage, report.stages[stage]])),
});

export const compactVisionQualityOutput = (output) => ({
  aggregate: output.aggregate,
  failedByMode: output.failedByMode,
  failedByScenario: output.failedByScenario,
  topFailingScenarios: output.topFailingScenarios,
  failingReports: output.reports
    .filter((report) => report.overallStatus === 'fail')
    .map(compactFailingReport),
});

const artifactSummary = (output, outputPath) => ({
  outputPath,
  totalReports: output.aggregate.total,
  passedReports: output.aggregate.byStatus.pass ?? 0,
  failedReports: output.aggregate.byStatus.fail ?? 0,
  failedByStage: output.aggregate.failedByStage,
});

export const formatVisionQualityOutput = async (output, { outputPath = null } = {}) => {
  if (outputPath === null) {
    return JSON.stringify(compactVisionQualityOutput(output), null, 2);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return JSON.stringify(artifactSummary(output, outputPath), null, 2);
};
