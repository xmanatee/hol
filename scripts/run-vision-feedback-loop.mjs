import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argSet = new Set(args);
const size = argSet.has('--full') ? 'full' : argSet.has('--quick') ? 'quick' : 'representative';
const labelIndex = args.indexOf('--label');
const outDirIndex = args.indexOf('--out-dir');
const label = labelIndex === -1
  ? new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, `-${size}`)
  : args[labelIndex + 1];
const outDir = outDirIndex === -1 ? 'docs/vision-benchmark-runs' : args[outDirIndex + 1];
const jsonPath = path.join(outDir, `${label}.json`);
const htmlPath = path.join(outDir, `${label}.html`);
const insightsPath = path.join(outDir, `${label}-insights.md`);
const stableFullHtmlPath = 'docs/vision-benchmark-full-report.html';

const benchmarkArgs = ['scripts/vision-benchmark-matrix.mjs', '--summary-only', '--quiet'];
if (size === 'quick') benchmarkArgs.push('--quick');
if (size === 'full') benchmarkArgs.push('--full');

const runNode = (commandArgs, options = {}) => {
  const result = spawnSync(process.execPath, commandArgs, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${commandArgs.join(' ')} exited with ${result.status}`);
  }
  return result.stdout || '';
};

const formatNumber = value => Number.isFinite(value)
  ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
  : 'n/a';

const formatPercent = (value, total) => (
  Number.isFinite(value) && Number.isFinite(total) && total > 0
    ? `${formatNumber(value / total * 100)}%`
    : 'n/a'
);

const strongestMode = modes => [...modes].sort((left, right) => left.meanRiskScore - right.meanRiskScore)[0];

const slowestMode = performanceSummary => performanceSummary?.byMode?.[0] || null;

const topStageTiming = performanceSummary => {
  const entry = Object.entries(performanceSummary?.aggregate?.stageTimings || {})[0];
  return entry
    ? `${entry[0]} (${formatNumber(entry[1].amortizedMeanMs)}ms amortized, ${formatPercent(entry[1].frameCount, performanceSummary.aggregate.frameCount)} coverage, ${formatNumber(entry[1].maxMs)}ms max)`
    : 'not recorded';
};

const budgetLine = performanceSummary => {
  const budget = performanceSummary?.aggregate?.budget;
  if (!budget) return '- Mobile budget: not recorded.';

  const meanStatus = budget.meanFrameProcessingOverBudget ? 'over' : 'within';
  const maxStatus = budget.maxFrameProcessingOverBudget ? 'over' : 'within';
  const sustainedStageOverages = budget.stageOverages || [];
  const spikeStageOverages = budget.stageSpikeOverages || [];
  const sustainedStages = sustainedStageOverages.length
    ? ` Sustained stage overages: ${sustainedStageOverages.map(item => item.stage).join(', ')}.`
    : ' No sustained stage overages recorded.';
  const spikeStages = spikeStageOverages.length
    ? ` Rare spike stages: ${spikeStageOverages.map(item => item.stage).join(', ')}.`
    : ' No rare spike stages recorded.';
  return `- Mobile budget: mean frame processing is ${meanStatus} the ${formatNumber(budget.trackingFrameBudgetMs)}ms tracking budget; max frame processing is ${maxStatus} the ${formatNumber(budget.frameBudgetMs)}ms frame budget.${sustainedStages}${spikeStages}`;
};

const weakestGroupLine = (labelName, item) => (
  `- ${labelName}: ${item.name} has ${formatNumber(item.fail)} strict failures ` +
  `(${formatPercent(item.fail, item.count)}), ${formatNumber(item.severe)} severe cases, ` +
  `and ${formatNumber(item.meanRiskScore)} mean risk.`
);

const createInsightsMarkdown = data => {
  const benchmark = data.benchmark;
  const quality = data.qualitySummary.aggregate;
  const bestMode = strongestMode(benchmark.weakPoints.byMode);
  const worstMode = benchmark.weakPoints.byMode[0];
  const worstObject = benchmark.weakPoints.byObject[0];
  const worstMotion = benchmark.weakPoints.byMotion[0];
  const worstOcclusion = benchmark.weakPoints.byOcclusion[0];
  const worstBackground = benchmark.weakPoints.byBackground[0];
  const worstReplay = benchmark.worstReports[0];
  const performance = data.performanceSummary;
  const slowMode = slowestMode(performance);
  const topStage = topStageTiming(performance);

  return `# Vision Reconstruction Feedback Loop Insights

## Run

- Matrix: ${data.size}
- Scenarios: ${formatNumber(data.scenarioCount)}
- Replays: ${formatNumber(data.replayCount)}
- Strict pass rate: ${formatPercent(quality.byStatus.pass, quality.total)}
- Strict failures: ${formatNumber(quality.byStatus.fail)}
- Mean risk: ${formatNumber(benchmark.aggregate.meanRiskScore)}
- High + severe risk: ${formatNumber((benchmark.aggregate.byRiskBand.high || 0) + (benchmark.aggregate.byRiskBand.severe || 0))}
- Severe risk: ${formatNumber(benchmark.aggregate.byRiskBand.severe || 0)}
- Mean replay wall time: ${performance ? `${formatNumber(performance.aggregate.meanReplayWallTimeMs)}ms` : 'not recorded'}
- Mean frame processing time: ${performance ? `${formatNumber(performance.aggregate.meanFrameProcessingTimeMs)}ms` : 'not recorded'}
- Invalid runtime reports: ${performance ? formatNumber(performance.aggregate.invalidRuntimeCount) : 'not recorded'}

## Conclusions

- Strongest mode: ${bestMode.name} with ${formatNumber(bestMode.meanRiskScore)} mean risk, ${formatNumber(bestMode.fail)} strict failures, and ${formatNumber(bestMode.severe)} severe cases.
- Weakest mode: ${worstMode.name} with ${formatNumber(worstMode.meanRiskScore)} mean risk, ${formatNumber(worstMode.fail)} strict failures, and ${formatNumber(worstMode.severe)} severe cases.
${slowMode ? `- Slowest mode by frame processing: ${slowMode.name} with ${formatNumber(slowMode.meanFrameProcessingTimeMs)}ms mean processing and ${formatNumber(slowMode.maxFrameProcessingTimeMs)}ms max frame processing.` : '- Slowest mode: not recorded.'}
- Top timed stage: ${topStage}.
${budgetLine(performance)}
${weakestGroupLine('Weakest object', worstObject)}
${weakestGroupLine('Weakest motion profile', worstMotion)}
${weakestGroupLine('Weakest occlusion profile', worstOcclusion)}
${weakestGroupLine('Weakest background', worstBackground)}
- Worst replay: ${worstReplay.name} / ${worstReplay.mode}; primary weakness is ${worstReplay.risk.primaryWeakness}.

## Fix Queue

1. Tracking spine: reduce ${worstReplay.risk.primaryWeakness} in the worst ${worstMotion.name} motion and ${worstOcclusion.name} occlusion cases before adding more dense reconstruction complexity.
2. Object ownership: inspect mask refresh, object-owned landmark promotion, and background rejection for ${worstObject.name}.
3. Recovery: improve post-occlusion correspondence recovery for ${worstOcclusion.name} occlusion and ${worstMotion.name} motion.
4. Runtime: profile ${slowMode ? slowMode.name : 'the slowest mode'} first when lag is reported; optimize measured hot loops before adding heavier reconstruction logic.
5. Reconstruction readiness: rerun targeted checks where reconstruction fails after tracking changes, because map readiness often follows anchor stability.
6. Head attachment: only tune render gates when headAttachment is a top failed stage; current failures are mainly upstream.

## Next Iteration Rule

Run a quick loop after every targeted code change, run the representative loop when quick risk improves without regressions, and run the full loop before declaring the weak point closed.
`;
};

fs.mkdirSync(outDir, { recursive: true });

const benchmarkJson = runNode(benchmarkArgs, { capture: true });
fs.writeFileSync(jsonPath, benchmarkJson);
const benchmarkData = JSON.parse(benchmarkJson);
fs.writeFileSync(insightsPath, createInsightsMarkdown(benchmarkData));
runNode(['scripts/generate-vision-benchmark-html.mjs', jsonPath, htmlPath]);
if (size === 'full') {
  runNode(['scripts/generate-vision-benchmark-html.mjs', jsonPath, stableFullHtmlPath]);
}

console.log(JSON.stringify({
  size,
  jsonPath,
  htmlPath,
  stableHtmlPath: size === 'full' ? stableFullHtmlPath : null,
  insightsPath,
  replayCount: benchmarkData.replayCount,
  strictFailures: benchmarkData.qualitySummary.aggregate.byStatus.fail,
  meanRiskScore: benchmarkData.benchmark.aggregate.meanRiskScore,
}, null, 2));
