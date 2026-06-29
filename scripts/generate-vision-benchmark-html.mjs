import fs from 'node:fs';

const [inputPath = '/tmp/hol-vision-benchmark-full.json', outputPath = 'docs/vision-benchmark-full-report.html'] =
  process.argv.slice(2);

const benchmarkOutput = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const benchmark = benchmarkOutput.benchmark;
const quality = benchmarkOutput.qualitySummary.aggregate;
const performance = benchmarkOutput.performanceSummary || null;
const risk = benchmark.aggregate;

const formatNumber = value => Number.isFinite(value)
  ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
  : 'n/a';

const formatPercent = (value, total) => (
  Number.isFinite(value) && Number.isFinite(total) && total > 0
    ? `${formatNumber(value / total * 100)}%`
    : 'n/a'
);

const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const riskClass = score => {
  if (score >= 58) return 'severe';
  if (score >= 36) return 'high';
  if (score >= 20) return 'moderate';
  return 'low';
};

const riskCell = score => `<span class="risk ${riskClass(score)}">${formatNumber(score)}</span>`;

const msCell = value => Number.isFinite(value) ? `${formatNumber(value)}ms` : 'n/a';

const percentBar = (value, total, className = '') => `
  <div class="bar ${className}" aria-hidden="true">
    <span style="width: ${Math.max(0, Math.min(100, value / total * 100))}%"></span>
  </div>
`;

const groupRows = group => group.map(item => {
  const failRate = item.fail / item.count;
  const severeHigh = item.severe + item.high;
  return `
    <tr>
      <th scope="row">${escapeHtml(item.name)}</th>
      <td>${formatNumber(item.count)}</td>
      <td>${riskCell(item.meanRiskScore)}</td>
      <td>${riskCell(item.maxRiskScore)}</td>
      <td>${formatNumber(item.severe)}</td>
      <td>${formatNumber(item.high)}</td>
      <td>${formatNumber(item.fail)} <span class="muted">(${formatPercent(item.fail, item.count)})</span>${percentBar(item.fail, item.count, 'fail')}</td>
      <td>${formatNumber(severeHigh)} <span class="muted">(${formatPercent(severeHigh, item.count)})</span>${percentBar(severeHigh, item.count, 'riskbar')}</td>
      <td>${escapeHtml(item.topPrimaryWeaknesses[0].weakness)}</td>
      <td>${escapeHtml(item.worst.name)} <span class="muted">/ ${escapeHtml(item.worst.mode)}</span></td>
    </tr>
  `;
}).join('');

const compactGroupRows = group => group.map(item => `
  <tr>
    <th scope="row">${escapeHtml(item.name)}</th>
    <td>${riskCell(item.meanRiskScore)}</td>
    <td>${riskCell(item.maxRiskScore)}</td>
    <td>${formatNumber(item.fail)} <span class="muted">(${formatPercent(item.fail, item.count)})</span>${percentBar(item.fail, item.count, 'fail')}</td>
    <td>${formatNumber(item.severe + item.high)} <span class="muted">(${formatPercent(item.severe + item.high, item.count)})</span>${percentBar(item.severe + item.high, item.count, 'riskbar')}</td>
    <td>${escapeHtml(item.worst.name)} <span class="muted">/ ${escapeHtml(item.worst.mode)}</span></td>
  </tr>
`).join('');

const performanceRows = group => group.map(item => `
  <tr>
    <th scope="row">${escapeHtml(item.name)}</th>
    <td>${formatNumber(item.count)}</td>
    <td>${msCell(item.meanReplayWallTimeMs)}</td>
    <td>${msCell(item.maxReplayWallTimeMs)}</td>
    <td>${msCell(item.meanFrameWallTimeMs)}</td>
    <td>${msCell(item.meanFrameProcessingTimeMs)}</td>
    <td>${msCell(item.maxFrameProcessingTimeMs)}</td>
    <td>${item.budget.meanFrameProcessingOverBudget ? 'over' : 'ok'}</td>
  </tr>
`).join('');

const slowestRows = reports => reports.map((report, index) => `
  <tr>
    <td>${index + 1}</td>
    <th scope="row">${escapeHtml(report.name)}</th>
    <td>${escapeHtml(report.mode)}</td>
    <td>${msCell(report.runtime.wallTimeMs)}</td>
    <td>${msCell(report.runtime.meanFrameWallTimeMs)}</td>
    <td>${msCell(report.runtime.meanProcessingTimeMs)}</td>
    <td>${msCell(report.runtime.maxProcessingTimeMs)}</td>
  </tr>
`).join('');

const stageTimingRows = stageTimings => Object.entries(stageTimings || {})
  .slice(0, 12)
  .map(([stage, timing]) => `
    <tr>
      <th scope="row">${escapeHtml(stage)}</th>
      <td>${msCell(timing.meanMs)}</td>
      <td>${msCell(timing.maxMs)}</td>
    </tr>
  `).join('');

const percentMetricCell = value => Number.isFinite(value) ? `${formatNumber(value * 100)}%` : 'n/a';

const worstRows = benchmark.worstReports.map((report, index) => `
  <tr>
    <td>${index + 1}</td>
    <th scope="row">${escapeHtml(report.name)}</th>
    <td>${escapeHtml(report.mode)}</td>
    <td>${riskCell(report.risk.score)}</td>
    <td><span class="band ${report.risk.band}">${escapeHtml(report.risk.band)}</span></td>
    <td>${escapeHtml(report.risk.primaryWeakness)}</td>
    <td>${escapeHtml(report.failedStages.join(', '))}</td>
    <td>${formatNumber(report.metrics.meanAnchorError)} px</td>
    <td>${formatNumber(report.metrics.maxAnchorError)} px</td>
    <td>${percentMetricCell(report.metrics.readyFrameRatio)}</td>
  </tr>
`).join('');

const modeRanking = benchmark.weakPoints.byMode;
const objectRanking = benchmark.weakPoints.byObject;
const motionRanking = benchmark.weakPoints.byMotion;
const occlusionRanking = benchmark.weakPoints.byOcclusion;
const backgroundRanking = benchmark.weakPoints.byBackground;
const bestMode = [...modeRanking].sort((left, right) => left.meanRiskScore - right.meanRiskScore)[0];
const highSevereCount = (risk.byRiskBand.high || 0) + (risk.byRiskBand.severe || 0);
const slowMode = performance?.byMode?.[0] || null;
const failedStages = Object.entries(quality.failedByStage || {})
  .map(([stage, count]) => ({ stage, count }))
  .sort((left, right) => right.count - left.count || left.stage.localeCompare(right.stage));
const topFailedStage = failedStages[0] || { stage: 'none', count: 0 };
const topOcclusions = occlusionRanking.slice(0, 2).map(item => item.name).join(' and ');
const budget = performance?.aggregate?.budget || null;
const weakestBackground = backgroundRanking[0];
const strongestBackground = backgroundRanking[backgroundRanking.length - 1];
const backgroundRiskSpread = weakestBackground.meanRiskScore - strongestBackground.meanRiskScore;

const conclusions = [
  `${bestMode.name} is the strongest mode overall in this run: ${formatNumber(bestMode.meanRiskScore)} mean risk, ${formatNumber(bestMode.severe)} severe cases, and ${formatNumber(bestMode.fail)} strict failures out of ${formatNumber(bestMode.count)} replays.`,
  `${topFailedStage.stage} is the top failed stage with ${formatNumber(topFailedStage.count)} failed-stage reports. Use the primaryWeakness field before assuming the owner is reconstruction or rendering.`,
  `${motionRanking[0].name} motion is the most damaging dynamic condition: ${formatNumber(motionRanking[0].fail)} failures out of ${formatNumber(motionRanking[0].count)}, with ${formatNumber(motionRanking[0].severe + motionRanking[0].high)} high-or-severe runs.`,
  `${topOcclusions} are the most damaging occlusion patterns. Clean scenes fail ${formatPercent(occlusionRanking.find(item => item.name === 'clean')?.fail || 0, occlusionRanking.find(item => item.name === 'clean')?.count || 0)}, so this is not only an occlusion problem.`,
  `${objectRanking[0].name} is the clearest object weak point: ${formatPercent(objectRanking[0].fail, objectRanking[0].count)} strict failure rate and ${formatNumber(objectRanking[0].severe)} severe cases.`,
  `${weakestBackground.name} is the weakest background in this run. Background mean-risk spread is ${formatNumber(backgroundRiskSpread)} points (${formatNumber(strongestBackground.meanRiskScore)}-${formatNumber(weakestBackground.meanRiskScore)}).`,
  performance
    ? `Runtime is measured in the same loop. The slowest mode by frame processing is ${slowMode.name}: ${msCell(slowMode.meanFrameProcessingTimeMs)} mean processing and ${msCell(slowMode.maxFrameProcessingTimeMs)} max processing.`
    : 'Runtime is not present in this JSON; rerun the feedback loop with the current benchmark runner to include lag analysis.',
  budget
    ? `Mobile budget status: mean frame processing is ${budget.meanFrameProcessingOverBudget ? 'over' : 'within'} the ${msCell(budget.trackingFrameBudgetMs)} tracking budget; max frame processing is ${budget.maxFrameProcessingOverBudget ? 'over' : 'within'} the ${msCell(budget.frameBudgetMs)} frame budget.`
    : 'Mobile budget status is not present in this JSON.',
];

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HOL Full 3D Reconstruction Benchmark Report</title>
  <style>
    :root {
      color-scheme: light;
      --ink: oklch(0.19 0.018 247);
      --muted: oklch(0.46 0.018 247);
      --paper: oklch(0.98 0.006 247);
      --surface: oklch(1 0.004 247);
      --line: oklch(0.88 0.01 247);
      --low: oklch(0.56 0.12 155);
      --moderate: oklch(0.63 0.13 82);
      --high: oklch(0.59 0.18 45);
      --severe: oklch(0.52 0.2 25);
      --accent: oklch(0.43 0.11 238);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font: 15px/1.55 "Avenir Next", "Segoe UI", sans-serif;
    }

    main {
      width: min(1440px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 56px;
    }

    header {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr);
      gap: 32px;
      align-items: end;
      padding: 24px 0 32px;
      border-bottom: 1px solid var(--line);
    }

    h1, h2, h3, p { margin: 0; }

    h1 {
      max-width: 780px;
      font-size: clamp(2.25rem, 5vw, 5rem);
      line-height: 0.95;
      letter-spacing: 0;
    }

    h2 {
      margin-top: 48px;
      margin-bottom: 14px;
      font-size: 1.35rem;
      letter-spacing: 0;
    }

    h3 {
      margin: 28px 0 10px;
      font-size: 1rem;
      letter-spacing: 0;
    }

    .lede {
      max-width: 760px;
      margin-top: 18px;
      color: var(--muted);
      font-size: 1.05rem;
    }

    .meta {
      display: grid;
      gap: 8px;
      padding: 16px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .meta div {
      display: flex;
      justify-content: space-between;
      gap: 18px;
    }

    .muted { color: var(--muted); }

    .kpis {
      display: grid;
      grid-template-columns: repeat(5, minmax(160px, 1fr));
      gap: 12px;
      margin-top: 22px;
    }

    .kpi {
      padding: 16px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .kpi span {
      display: block;
      color: var(--muted);
      font-size: 0.8rem;
    }

    .kpi strong {
      display: block;
      margin-top: 4px;
      font-size: 1.8rem;
      line-height: 1.1;
    }

    .summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(320px, 0.55fr);
      gap: 18px;
      margin-top: 28px;
    }

    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }

    .panel ul, .panel ol {
      margin: 0;
      padding-left: 1.2rem;
    }

    .panel li + li { margin-top: 10px; }

    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }

    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    thead th {
      background: oklch(0.95 0.008 247);
      color: oklch(0.31 0.018 247);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    tbody tr:last-child th,
    tbody tr:last-child td {
      border-bottom: 0;
    }

    .table-wrap {
      overflow-x: auto;
      border-radius: 8px;
    }

    .risk, .band {
      display: inline-flex;
      min-width: 56px;
      justify-content: center;
      padding: 2px 8px;
      border-radius: 999px;
      color: oklch(0.99 0.004 247);
      font-weight: 700;
      font-size: 0.82rem;
    }

    .risk.low, .band.low { background: var(--low); }
    .risk.moderate, .band.moderate { background: var(--moderate); color: oklch(0.2 0.03 82); }
    .risk.high, .band.high { background: var(--high); }
    .risk.severe, .band.severe { background: var(--severe); }

    .bar {
      height: 5px;
      margin-top: 5px;
      background: oklch(0.92 0.008 247);
      border-radius: 999px;
      overflow: hidden;
    }

    .bar span {
      display: block;
      height: 100%;
      background: var(--accent);
    }

    .bar.fail span { background: var(--high); }
    .bar.riskbar span { background: var(--severe); }

    .grid-two {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }

    header > *,
    .summary > *,
    .grid-two > * {
      min-width: 0;
    }

    .note {
      margin-top: 14px;
      color: var(--muted);
      max-width: 82ch;
    }

    code {
      font-family: "SFMono-Regular", ui-monospace, monospace;
      background: oklch(0.94 0.008 247);
      padding: 1px 5px;
      border-radius: 4px;
    }

    @media (max-width: 980px) {
      header, .summary, .grid-two { grid-template-columns: 1fr; }
      .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 560px) {
      main { width: min(100% - 20px, 1440px); padding-top: 16px; }
      .kpis { grid-template-columns: 1fr; }
      th, td { padding: 8px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <section>
        <h1>HOL Full 3D Reconstruction Benchmark</h1>
        <p class="lede">A full synthetic stress sweep across all reconstruction modes, target geometries, backgrounds, motion profiles, and occlusion profiles. Lower risk is better; strict pass/fail uses the shared vision quality thresholds.</p>
      </section>
      <aside class="meta" aria-label="Benchmark metadata">
        <div><span>Input JSON</span><strong>${escapeHtml(inputPath)}</strong></div>
        <div><span>Matrix size</span><strong>${escapeHtml(benchmarkOutput.size)}</strong></div>
        <div><span>Scenarios</span><strong>${formatNumber(benchmarkOutput.scenarioCount)}</strong></div>
        <div><span>Modes</span><strong>${formatNumber(benchmarkOutput.modeCount)}</strong></div>
        <div><span>Replays</span><strong>${formatNumber(benchmarkOutput.replayCount)}</strong></div>
      </aside>
    </header>

    <section class="kpis" aria-label="Headline metrics">
      <div class="kpi"><span>Strict pass rate</span><strong>${formatPercent(quality.byStatus.pass, quality.total)}</strong></div>
      <div class="kpi"><span>Strict failures</span><strong>${formatNumber(quality.byStatus.fail)}</strong></div>
      <div class="kpi"><span>Mean risk</span><strong>${formatNumber(risk.meanRiskScore)}</strong></div>
      <div class="kpi"><span>High + severe risk</span><strong>${formatNumber(highSevereCount)}</strong></div>
      <div class="kpi"><span>Severe rate</span><strong>${formatPercent(risk.byRiskBand.severe, risk.total)}</strong></div>
      <div class="kpi"><span>Mean replay time</span><strong>${performance ? msCell(performance.aggregate.meanReplayWallTimeMs) : 'n/a'}</strong></div>
    </section>

    <section class="summary">
      <div class="panel">
        <h2>Executive Conclusions</h2>
        <ol>
          ${conclusions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
        </ol>
      </div>
      <div class="panel">
        <h2>Failure Shape</h2>
        <p>Strict quality failures affect ${formatNumber(quality.byStatus.fail)} of ${formatNumber(quality.total)} replays (${formatPercent(quality.byStatus.fail, quality.total)}). Stage failures overlap, but their counts show the priority order.</p>
        <h3>Failed stages</h3>
        <ul>
          <li>Tracking: ${formatNumber(quality.failedByStage.tracking)} (${formatPercent(quality.failedByStage.tracking, quality.total)})</li>
          <li>Reconstruction: ${formatNumber(quality.failedByStage.reconstruction)} (${formatPercent(quality.failedByStage.reconstruction, quality.total)})</li>
          <li>Head attachment: ${formatNumber(quality.failedByStage.headAttachment)} (${formatPercent(quality.failedByStage.headAttachment, quality.total)})</li>
        </ul>
        <h3>Risk bands</h3>
        <ul>
          <li>Low: ${formatNumber(risk.byRiskBand.low || 0)}</li>
          <li>Moderate: ${formatNumber(risk.byRiskBand.moderate || 0)}</li>
          <li>High: ${formatNumber(risk.byRiskBand.high || 0)}</li>
          <li>Severe: ${formatNumber(risk.byRiskBand.severe || 0)}</li>
        </ul>
      </div>
    </section>

    <h2>Mode Comparison</h2>
    <p class="note">Depth fusion is the best current direction by average risk and severe-case avoidance, but it inherits anchor quality from the same tracker spine.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Mode</th><th>Runs</th><th>Mean risk</th><th>Max risk</th><th>Severe</th><th>High</th><th>Strict failures</th><th>High + severe</th><th>Top weakness</th><th>Worst case</th>
          </tr>
        </thead>
        <tbody>${groupRows(modeRanking)}</tbody>
      </table>
    </div>

    ${performance ? `
    <h2>Performance Bottlenecks</h2>
    <p class="note">Wall time measures the Node synthetic replay loop. Frame processing time is measured around each <code>updateAnchor</code> call and is the closest synthetic proxy for app-side lag.</p>
    <div class="grid-two">
      <section>
        <h3>Modes By Runtime</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Mode</th><th>Runs</th><th>Mean replay</th><th>Max replay</th><th>Mean frame wall</th><th>Mean processing</th><th>Max processing</th><th>Mean budget</th></tr></thead>
            <tbody>${performanceRows(performance.byMode)}</tbody>
          </table>
        </div>
      </section>
      <section>
        <h3>Slowest Replays</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Scenario</th><th>Mode</th><th>Replay</th><th>Frame wall</th><th>Mean processing</th><th>Max processing</th></tr></thead>
            <tbody>${slowestRows(performance.slowestReports)}</tbody>
          </table>
        </div>
      </section>
    </div>
    <h3>Aggregate Stage Timings</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Stage</th><th>Mean</th><th>Max</th></tr></thead>
        <tbody>${stageTimingRows(performance.aggregate.stageTimings)}</tbody>
      </table>
    </div>
    ` : ''}

    <h2>Object And Geometry Weak Points</h2>
    <div class="grid-two">
      <section>
        <h3>Objects</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Object</th><th>Mean risk</th><th>Max risk</th><th>Failures</th><th>High + severe</th><th>Worst case</th></tr></thead>
            <tbody>${compactGroupRows(objectRanking)}</tbody>
          </table>
        </div>
      </section>
      <section>
        <h3>Geometry Families</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Geometry</th><th>Mean risk</th><th>Max risk</th><th>Failures</th><th>High + severe</th><th>Worst case</th></tr></thead>
            <tbody>${compactGroupRows(benchmark.weakPoints.byGeometry)}</tbody>
          </table>
        </div>
      </section>
    </div>

    <h2>Condition Weak Points</h2>
    <div class="grid-two">
      <section>
        <h3>Motion</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Motion</th><th>Mean risk</th><th>Max risk</th><th>Failures</th><th>High + severe</th><th>Worst case</th></tr></thead>
            <tbody>${compactGroupRows(motionRanking)}</tbody>
          </table>
        </div>
      </section>
      <section>
        <h3>Occlusion</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Occlusion</th><th>Mean risk</th><th>Max risk</th><th>Failures</th><th>High + severe</th><th>Worst case</th></tr></thead>
            <tbody>${compactGroupRows(occlusionRanking)}</tbody>
          </table>
        </div>
      </section>
    </div>

    <h2>Background And Lighting</h2>
    <div class="grid-two">
      <section>
        <h3>Backgrounds</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Background</th><th>Mean risk</th><th>Max risk</th><th>Failures</th><th>High + severe</th><th>Worst case</th></tr></thead>
            <tbody>${compactGroupRows(backgroundRanking)}</tbody>
          </table>
        </div>
      </section>
      <section>
        <h3>Lighting Proxies</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Lighting</th><th>Mean risk</th><th>Max risk</th><th>Failures</th><th>High + severe</th><th>Worst case</th></tr></thead>
            <tbody>${compactGroupRows(benchmark.weakPoints.byLighting)}</tbody>
          </table>
        </div>
      </section>
    </div>

    <h2>Worst Individual Replays</h2>
    <p class="note">These are the highest risk cases across all 1,200 replays. They are the best starting set for debugging because they combine the largest anchor errors with missing or unstable reconstruction support.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Scenario</th><th>Mode</th><th>Risk</th><th>Band</th><th>Primary weakness</th><th>Failed stages</th><th>Mean anchor</th><th>Max anchor</th><th>Ready frames</th>
          </tr>
        </thead>
        <tbody>${worstRows}</tbody>
      </table>
    </div>

    <h2>Recommended Engineering Focus</h2>
    <div class="panel">
      <ol>
        <li>Prioritize fast-motion and occlusion recovery in the tracking spine. Improve landmark reacquisition, local support preservation, and post-occlusion anchor correction before investing more in dense model complexity.</li>
        <li>Keep depth fusion as the preferred advanced mode candidate. It has the lowest mean risk and no severe cases in the full synthetic sweep, but it still needs tracker stability to reach production quality.</li>
        <li>Use handled mugs, laminated cards, cups, rigid boxes, and label bottles as the core regression set. These families expose the most geometry and texture failures.</li>
        <li>Add real iPhone capture fixtures for window backlight, shelf clutter, and busy moving backgrounds. Synthetic results show background is secondary to geometry and motion, but mobile camera noise may change that ranking.</li>
        <li>Add recovery-specific metrics: frames to recover after occlusion, anchor drift slope, and map pose reacquisition delay. The current benchmark identifies bad cases; these metrics would explain recovery behavior more directly.</li>
      </ol>
    </div>

    <h2>Method Notes</h2>
    <div class="panel">
      <ul>
        <li>Full matrix: 12 object cases x 5 background variants x 5 motion/occlusion profiles x 4 reconstruction modes.</li>
        <li>Depth fusion replays use the synthetic depth-frame harness so geometry fusion logic is exercised without timing browser ONNX inference.</li>
        <li>Risk targets are stricter than the curated release quality report; this report is intended to expose weak points, not to act as the normal pass/fail release gate.</li>
        <li>Worst-case and grouped rankings use mean risk first, then max risk. Lower is better.</li>
      </ul>
    </div>
  </main>
</body>
</html>`;

fs.writeFileSync(outputPath, html.replace(/[ \t]+$/gm, ''));
console.log(outputPath);
