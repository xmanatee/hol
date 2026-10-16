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
const outDir = outDirIndex === -1 ? 'artifacts/vision-benchmarks' : args[outDirIndex + 1];
const jsonPath = path.join(outDir, `${label}.json`);
const htmlPath = path.join(outDir, `${label}.html`);

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

fs.mkdirSync(outDir, { recursive: true });

runNode(benchmarkArgs);
const benchmarkJson = fs.readFileSync(jsonPath, 'utf8');
const benchmarkData = JSON.parse(benchmarkJson);
runNode(['scripts/generate-vision-benchmark-html.mjs', jsonPath, htmlPath]);

console.log(
  JSON.stringify(
    {
      size,
      jsonPath,
      htmlPath,
      replayCount: benchmarkData.replayCount,
      strictFailures: benchmarkData.qualitySummary.aggregate.byStatus.fail,
      meanRiskScore: benchmarkData.benchmark.aggregate.meanRiskScore,
    },
    null,
    2,
  ),
);
