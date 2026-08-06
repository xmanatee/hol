import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argSet = new Set(args);
const size = argSet.has('--hard')
  ? 'hard'
  : argSet.has('--full')
    ? 'full'
    : argSet.has('--quick')
      ? 'quick'
      : 'representative';
const labelIndex = args.indexOf('--label');
const outDirIndex = args.indexOf('--out-dir');
const label =
  labelIndex === -1
    ? new Date()
        .toISOString()
        .replaceAll(':', '-')
        .replace(/\.\d{3}Z$/, `-${size}`)
    : args[labelIndex + 1];
const outDir = outDirIndex === -1 ? 'docs/vision-benchmark-runs' : args[outDirIndex + 1];
const jsonPath = path.join(outDir, `${label}.json`);
const htmlPath = path.join(outDir, `${label}.html`);
const insightsPath = path.join(outDir, `${label}-insights.md`);
const stableFullHtmlPath = 'docs/vision-benchmark-full-report.html';

const benchmarkArgs = ['scripts/vision-benchmark-matrix.mjs', '--summary-only', '--quiet'];
if (size === 'quick') benchmarkArgs.push('--quick');
if (size === 'hard') benchmarkArgs.push('--hard');
if (size === 'full') benchmarkArgs.push('--full');
benchmarkArgs.push('--output', jsonPath);

const runNode = (commandArgs) => {
  const result = spawnSync(process.execPath, commandArgs, {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${commandArgs.join(' ')} exited with ${result.status ?? result.signal}`);
  }
};

const formatNumber = (value) =>
  Number.isFinite(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'n/a';

const formatPercent = (value, total) =>
  Number.isFinite(value) && Number.isFinite(total) && total > 0
    ? `${formatNumber((value / total) * 100)}%`
    : 'n/a';

const formatRatioPercent = (value) => (Number.isFinite(value) ? `${formatNumber(value * 100)}%` : 'n/a');

const strongestMode = (modes) =>
  [...modes].sort((left, right) => left.meanRiskScore - right.meanRiskScore)[0];

const slowestMode = (performanceSummary) => performanceSummary?.byMode?.[0] || null;

const topStageTiming = (performanceSummary) => {
  const entry = Object.entries(performanceSummary?.aggregate?.stageTimings || {}).find(
    ([, timing]) => timing.ownership === 'owned',
  );
  return entry
    ? `${entry[0]} (${formatNumber(entry[1].displayAmortizedExclusiveMeanMs)}ms display-amortized exclusive, ${formatPercent(entry[1].frameCount, performanceSummary.aggregate.admittedUpdateCount)} admitted-update coverage, ${formatNumber(entry[1].maxMs)}ms max)`
    : 'not recorded';
};

const coverageLine = (coverageSummary) => {
  if (!coverageSummary) return '- Coverage audit: not recorded.';

  const topScenarioAxis = coverageSummary.imbalances.scenarioAxes[0];
  const topReplayAxis = coverageSummary.imbalances.replayAxes[0];
  const scenarioAxis = topScenarioAxis
    ? `${topScenarioAxis.name} ${formatNumber(topScenarioAxis.minCount)}-${formatNumber(topScenarioAxis.maxCount)} (${formatNumber(topScenarioAxis.imbalanceRatio)}x)`
    : 'all scenario axes balanced';
  const replayAxis = topReplayAxis
    ? `${topReplayAxis.name} ${formatNumber(topReplayAxis.minCount)}-${formatNumber(topReplayAxis.maxCount)} (${formatNumber(topReplayAxis.imbalanceRatio)}x)`
    : 'all replay axes balanced';

  return `- Coverage audit: ${formatNumber(coverageSummary.scenarioCount)} scenarios x ${formatNumber(coverageSummary.modeCount)} modes = ${formatNumber(coverageSummary.replayCount)} replays; top scenario imbalance ${scenarioAxis}; top replay imbalance ${replayAxis}.`;
};

const budgetLine = (performanceSummary) => {
  const budget = performanceSummary?.aggregate?.budget;
  if (!budget) return '- Mobile budget: not recorded.';

  const amortizedStatus = budget.displayAmortizedUpdateOverBudget ? 'over' : 'within';
  const sustainedStageOverages = budget.stageOverages || [];
  const spikeStageOverages = budget.stageSpikeOverages || [];
  const sustainedStages = sustainedStageOverages.length
    ? ` Sustained stage overages: ${sustainedStageOverages.map((item) => item.stage).join(', ')}.`
    : ' No sustained stage overages recorded.';
  const spikeStages = spikeStageOverages.length
    ? ` Rare spike stages: ${spikeStageOverages.map((item) => item.stage).join(', ')}.`
    : ' No rare spike stages recorded.';
  return `- Mobile budget: display-amortized CV cost is ${amortizedStatus} the ${formatNumber(budget.trackingFrameBudgetMs)}ms tracking budget; ${formatNumber(budget.cadenceLatencyOverageCount)} replay groups exceed their update interval at p95.${sustainedStages}${spikeStages}`;
};

const timingCoverageLine = (performanceSummary) => {
  const aggregate = performanceSummary?.aggregate;
  if (!aggregate || !Number.isFinite(aggregate.timingCoverageRatio)) {
    return '- Timing ownership: not recorded.';
  }
  return `- Timing ownership: ${formatRatioPercent(aggregate.timingCoverageRatio)} attributed; ${formatNumber(aggregate.displayAmortizedUnattributedUpdateTimeMs)}ms/display-frame remains unattributed.`;
};

const weakestGroupLine = (labelName, item) =>
  `- ${labelName}: ${item.name} has ${formatNumber(item.fail)} strict failures ` +
  `(${formatPercent(item.fail, item.count)}), ${formatNumber(item.severe)} severe cases, ` +
  `and ${formatNumber(item.meanRiskScore)} mean risk.`;

const createInsightsMarkdown = (data) => {
  const benchmark = data.benchmark;
  const quality = data.qualitySummary.aggregate;
  const bestMode = strongestMode(benchmark.weakPoints.byMode);
  const worstMode = benchmark.weakPoints.byMode[0];
  const worstObject = benchmark.weakPoints.byObject[0];
  const worstMotion = benchmark.weakPoints.byMotion[0];
  const worstOcclusion = benchmark.weakPoints.byOcclusion[0];
  const worstBackground = benchmark.weakPoints.byBackground[0];
  const worstCapture = benchmark.weakPoints.byCapture[0];
  const worstReplay = benchmark.worstReports[0];
  const performance = data.performanceSummary;
  const targetLoss = benchmark.targetLossRecovery;
  const slowMode = slowestMode(performance);
  const topStage = topStageTiming(performance);

  return `# Vision Reconstruction Feedback Loop Insights

## Run

- Matrix: ${data.size}
- Scenarios: ${formatNumber(data.scenarioCount)}
- Modes: ${formatNumber(data.modeCount)}
- Replays: ${formatNumber(data.replayCount)}
- Covered objects: ${formatNumber(data.coverageSummary?.scenarioAxes?.object?.uniqueCount)}
- Covered backgrounds: ${formatNumber(data.coverageSummary?.scenarioAxes?.background?.uniqueCount)}
- Covered capture profiles: ${formatNumber(data.coverageSummary?.scenarioAxes?.capture?.uniqueCount)}
- Strict pass rate: ${formatPercent(quality.byStatus.pass, quality.total)}
- Strict failures: ${formatNumber(quality.byStatus.fail)}
- Mean risk: ${formatNumber(benchmark.aggregate.meanRiskScore)}
- High + severe risk: ${formatNumber((benchmark.aggregate.byRiskBand.high || 0) + (benchmark.aggregate.byRiskBand.severe || 0))}
- Severe risk: ${formatNumber(benchmark.aggregate.byRiskBand.severe || 0)}
- Mean replay wall time: ${performance ? `${formatNumber(performance.aggregate.meanReplayWallTimeMs)}ms` : 'not recorded'}
- Mean active update time: ${performance ? `${formatNumber(performance.aggregate.meanActiveUpdateTimeMs)}ms` : 'not recorded'}
- Display-amortized update time: ${performance ? `${formatNumber(performance.aggregate.displayAmortizedUpdateTimeMs)}ms` : 'not recorded'}
- Admitted updates: ${performance ? `${formatNumber(performance.aggregate.admittedUpdateCount)} / ${formatNumber(performance.aggregate.sourceFrameCount)} source frames` : 'not recorded'}
- Timing coverage: ${performance ? formatRatioPercent(performance.aggregate.timingCoverageRatio) : 'not recorded'}
- Display-amortized unattributed time: ${performance ? `${formatNumber(performance.aggregate.displayAmortizedUnattributedUpdateTimeMs)}ms` : 'not recorded'}
- Invalid runtime reports: ${performance ? formatNumber(performance.aggregate.invalidRuntimeCount) : 'not recorded'}
- Full-loss false admitted locks: ${formatNumber(targetLoss.falseTrackedAbsentAdmittedFrames)} / ${formatNumber(targetLoss.absentFrameCount)} absent display frames
- Full-loss display presence latency: ${formatNumber(targetLoss.targetPresentAbsentDisplayFrames)} source frames
- Full-loss recovery @8px: ${formatRatioPercent(targetLoss.recoveryRateAt8)}

## Conclusions

- Strongest mode: ${bestMode.name} with ${formatNumber(bestMode.meanRiskScore)} mean risk, ${formatNumber(bestMode.fail)} strict failures, and ${formatNumber(bestMode.severe)} severe cases.
- Weakest mode: ${worstMode.name} with ${formatNumber(worstMode.meanRiskScore)} mean risk, ${formatNumber(worstMode.fail)} strict failures, and ${formatNumber(worstMode.severe)} severe cases.
${slowMode ? `- Slowest mode by display-amortized CV cost: ${slowMode.name} with ${formatNumber(slowMode.displayAmortizedUpdateTimeMs)}ms display-amortized, ${formatNumber(slowMode.meanActiveUpdateTimeMs)}ms mean active, and ${formatNumber(slowMode.maxActiveUpdateTimeMs)}ms max active update.` : '- Slowest mode: not recorded.'}
- Top timed stage: ${topStage}.
${budgetLine(performance)}
${timingCoverageLine(performance)}
${coverageLine(data.coverageSummary)}
${weakestGroupLine('Weakest object', worstObject)}
${weakestGroupLine('Weakest motion profile', worstMotion)}
${weakestGroupLine('Weakest occlusion profile', worstOcclusion)}
${weakestGroupLine('Weakest background', worstBackground)}
${weakestGroupLine('Weakest capture profile', worstCapture)}
- Worst replay: ${worstReplay.name} / ${worstReplay.mode}; primary weakness is ${worstReplay.risk.primaryWeakness}.
${
  targetLoss.windowCount > 0
    ? `- Full target loss: ${formatNumber(targetLoss.falseTrackedAbsentAdmittedFrames)} false admitted CV locks and ${formatNumber(targetLoss.targetPresentAbsentDisplayFrames)} display-latency frames across ${formatNumber(targetLoss.absentFrameCount)} absent frames, with ${formatNumber(targetLoss.recoveredAt8)}/${formatNumber(targetLoss.windowCount)} re-entry windows recovered within eight frames.`
    : '- Full target loss: not covered by this matrix.'
}

## Fix Queue

${
  targetLoss.windowCount > 0
    ? `1. Target loss: reject distractor-only false locks, hide the overlay while the target is absent, and perform global re-entry relocalization before accepting local tracking again.
2. Tracking spine: reduce ${worstReplay.risk.primaryWeakness} in the worst ${worstMotion.name} motion and ${worstOcclusion.name} occlusion cases before adding more dense reconstruction complexity.
3. Object ownership: inspect mask refresh, object-owned landmark promotion, and background rejection for ${worstObject.name}.
4. Recovery: improve post-occlusion correspondence recovery for ${worstOcclusion.name} occlusion and ${worstMotion.name} motion.
5. Runtime: profile ${slowMode ? slowMode.name : 'the slowest mode'} first when lag is reported; optimize measured hot loops before adding heavier reconstruction logic.
6. Reconstruction readiness: rerun targeted checks where reconstruction fails after tracking changes, because map readiness often follows anchor stability.
7. Head attachment: only tune render gates when headAttachment is a top failed stage; current failures are mainly upstream.`
    : `1. Tracking spine: reduce ${worstReplay.risk.primaryWeakness} in the worst ${worstMotion.name} motion and ${worstOcclusion.name} occlusion cases before adding more dense reconstruction complexity.
2. Object ownership: inspect mask refresh, object-owned landmark promotion, and background rejection for ${worstObject.name}.
3. Recovery: improve post-occlusion correspondence recovery for ${worstOcclusion.name} occlusion and ${worstMotion.name} motion.
4. Runtime: profile ${slowMode ? slowMode.name : 'the slowest mode'} first when lag is reported; optimize measured hot loops before adding heavier reconstruction logic.
5. Reconstruction readiness: rerun targeted checks where reconstruction fails after tracking changes, because map readiness often follows anchor stability.
6. Head attachment: only tune render gates when headAttachment is a top failed stage; current failures are mainly upstream.`
}

## Next Iteration Rule

Run a quick loop after every targeted code change, the hard loop after tracker or recovery changes, the representative loop when risk improves without regressions, and the full loop before declaring the weak point closed.
`;
};

fs.mkdirSync(outDir, { recursive: true });

runNode(benchmarkArgs);
const benchmarkJson = fs.readFileSync(jsonPath, 'utf8');
const benchmarkData = JSON.parse(benchmarkJson);
fs.writeFileSync(insightsPath, createInsightsMarkdown(benchmarkData));
runNode(['scripts/generate-vision-benchmark-html.mjs', jsonPath, htmlPath]);
if (size === 'full') {
  runNode(['scripts/generate-vision-benchmark-html.mjs', jsonPath, stableFullHtmlPath]);
}

console.log(
  JSON.stringify(
    {
      size,
      jsonPath,
      htmlPath,
      stableHtmlPath: size === 'full' ? stableFullHtmlPath : null,
      insightsPath,
      replayCount: benchmarkData.replayCount,
      strictFailures: benchmarkData.qualitySummary.aggregate.byStatus.fail,
      meanRiskScore: benchmarkData.benchmark.aggregate.meanRiskScore,
    },
    null,
    2,
  ),
);
