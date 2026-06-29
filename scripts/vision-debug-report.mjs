import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import {
  createCylindricalCanSequence,
  createPlanarBookSequence,
  createRigidBoxSequence,
} from '../src/cv/synthetic/visionFixtures.js';
import {
  createSyntheticDepthFrame,
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';
import { createVisionBenchmarkMatrix } from '../src/cv/synthetic/visionBenchmarkMatrix.js';
import {
  VISION_QUALITY_THRESHOLDS,
  scoreVisionPipelineQuality,
} from '../src/cv/stageQualityScoring.js';
import {
  filterVisionBenchmarkRuns,
  parseVisionBenchmarkArgs,
} from '../src/cv/synthetic/visionBenchmarkCli.js';
import {
  debugReportUsesBenchmarkMatrix,
  selectedDebugFrameIndexes,
} from '../src/cv/synthetic/visionDebugReportCli.js';
import { RECONSTRUCTION_MODES } from '../src/cv/anchor.reconstructionModes.js';

const REPORT_PATH = '/tmp/hol-vision-debug-report.html';
const SYNTHETIC_OBJECT_SUPPORT = 'synthetic-object-mask';

const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const round = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';

const metric = (label, value, digits = 3) => `
  <span class="metric"><strong>${escapeHtml(label)}</strong>${escapeHtml(round(value, digits))}</span>
`;

const textMetric = (label, value) => `
  <span class="metric"><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</span>
`;

const vectorLine = ({ point, normal, color, label }) => {
  if (!point || !normal) return '';
  const length = 46;
  const end = {
    x: point.x + normal.x * length,
    y: point.y + normal.y * length,
  };
  return `
    <line x1="${point.x}" y1="${point.y}" x2="${end.x}" y2="${end.y}" stroke="${color}" stroke-width="3" />
    <text x="${end.x + 5}" y="${end.y - 5}" fill="${color}" font-size="13">${escapeHtml(label)}</text>
  `;
};

const sampledCornerMarkers = corners => {
  const step = Math.max(1, Math.ceil(corners.length / 48));
  return corners
    .filter((_, index) => index % step === 0)
    .map(point => `<circle cx="${point.x}" cy="${point.y}" r="2.2" fill="#7dd3fc" opacity="0.62" />`)
    .join('');
};

const frameSvg = ({ sequence, replayFrame, scoreFrame }) => {
  const frame = sequence.frames[replayFrame.index];
  const box = frame.boundingBox;
  const predicted = replayFrame.predicted;
  const groundTruth = frame.groundTruth.anchor;

  return `
    <figure>
      <svg viewBox="0 0 ${sequence.width} ${sequence.height}" role="img" aria-label="${escapeHtml(sequence.kind)} frame ${replayFrame.index}">
        <rect width="${sequence.width}" height="${sequence.height}" fill="#15171d" />
        <rect x="${box.x1}" y="${box.y1}" width="${box.width}" height="${box.height}" fill="#262a34" stroke="#94a3b8" stroke-width="2" opacity="0.92" />
        ${sampledCornerMarkers(frame.corners || [])}
        <circle cx="${groundTruth.x}" cy="${groundTruth.y}" r="7" fill="#22c55e" />
        ${predicted ? `<circle cx="${predicted.x}" cy="${predicted.y}" r="6" fill="#ef4444" />` : ''}
        ${vectorLine({ point: groundTruth, normal: frame.groundTruth.normal, color: '#22c55e', label: 'truth' })}
        ${vectorLine({ point: predicted, normal: replayFrame.normal, color: '#ef4444', label: 'pred' })}
      </svg>
      <figcaption>
        <strong>Frame ${replayFrame.index}</strong>
        <span>${escapeHtml(replayFrame.poseSource || replayFrame.method || 'no pose')}</span>
        <span>pos ${round(scoreFrame.worldPositionError)}</span>
        <span>rot ${round(scoreFrame.rotationError)}</span>
        <span>scale ${round(scoreFrame.scaleLogError)}</span>
      </figcaption>
    </figure>
  `;
};

const worstTrackingFrames = replay => [...replay.frames]
  .filter(frame => Number.isFinite(frame.anchorError))
  .sort((left, right) => right.anchorError - left.anchorError)
  .slice(0, 6);

const selectedFrameIndexes = (replay, headPose) => {
  return selectedDebugFrameIndexes({
    frameCount: replay.frames.length,
    trackingWorstFrames: worstTrackingFrames(replay),
    headWorstFrames: headPose.summary.worstFrames,
  });
};

const sequenceSection = ({ title, sequence, replay, rawSummary, headPose, quality }) => {
  const framesByIndex = new Map(replay.frames.map(frame => [frame.index, frame]));
  const scoresByIndex = new Map(headPose.frames.map(frame => [frame.index, frame]));
  const selected = selectedFrameIndexes(replay, headPose)
    .map(index => frameSvg({
      sequence,
      replayFrame: framesByIndex.get(index),
      scoreFrame: scoresByIndex.get(index),
    }))
    .join('');

  return `
    <section>
      <h2>${escapeHtml(title || sequence.kind)}</h2>
      <div class="metrics">
        ${quality ? textMetric('quality', quality.overallStatus) : ''}
        ${metric('anchor max px', rawSummary.maxAnchorError, 2)}
        ${metric('anchor mean px', rawSummary.meanAnchorError, 2)}
        ${metric('head max world', headPose.summary.maxWorldPositionError)}
        ${metric('head max rot', headPose.summary.maxRotationError)}
        ${metric('head max scale', headPose.summary.maxScaleLogError)}
        ${metric('head jump excess', headPose.summary.maxHeadJumpExcess)}
        ${metric('planar use', rawSummary.planarPoseUsage, 2)}
        ${metric('sparse use', rawSummary.sparsePoseUsage, 2)}
      </div>
      <div class="frames">${selected}</div>
    </section>
  `;
};

const legacyDebugRuns = () => [
  {
    title: 'sparse-reconstruction / planar-book',
    mode: RECONSTRUCTION_MODES.find(mode => mode.id === 'sparse-reconstruction'),
    sequence: createPlanarBookSequence({
      kind: 'planar-book',
      frameCount: 32,
      occlusionFrames: [14, 15, 16, 17],
    }),
  },
  {
    title: 'sparse-reconstruction / dark-book',
    mode: RECONSTRUCTION_MODES.find(mode => mode.id === 'sparse-reconstruction'),
    sequence: createPlanarBookSequence({
      kind: 'dark-book',
      frameCount: 32,
      occlusionFrames: [14, 15, 16, 17],
    }),
  },
  {
    title: 'sparse-reconstruction / cylindrical-can',
    mode: RECONSTRUCTION_MODES.find(mode => mode.id === 'sparse-reconstruction'),
    sequence: createCylindricalCanSequence({
      frameCount: 30,
      occlusionFrames: [12, 13, 14],
    }),
  },
  {
    title: 'sparse-reconstruction / rigid-box',
    mode: RECONSTRUCTION_MODES.find(mode => mode.id === 'sparse-reconstruction'),
    sequence: createRigidBoxSequence({
      frameCount: 28,
      occlusionFrames: [10, 11, 12],
    }),
  },
];

const benchmarkDebugRuns = ({ size, filters }) => {
  const { scenarios, modes } = filterVisionBenchmarkRuns({
    scenarios: createVisionBenchmarkMatrix({ size }),
    modes: RECONSTRUCTION_MODES,
    filters,
  });

  return scenarios.flatMap(scenario => modes.map(mode => ({
    title: `${mode.id} / ${scenario.name}`,
    mode,
    scenario,
    sequence: scenario.create(),
    targetClassOverride: scenario.targetClassOverride,
  })));
};

const debugRunsFor = ({ size, filters }) => (
  debugReportUsesBenchmarkMatrix({ size, filters })
    ? benchmarkDebugRuns({ size, filters })
    : legacyDebugRuns()
);

const qualityForRun = ({ title, replay, rawSummary, headPose }) => scoreVisionPipelineQuality({
  name: title,
  replay,
  summary: rawSummary,
  headPose,
  thresholds: VISION_QUALITY_THRESHOLDS,
});

const args = parseVisionBenchmarkArgs(process.argv.slice(2));
const reportPath = args.outputPath || REPORT_PATH;
const cv = await loadOpenCvForNode();
const sections = [];
const runs = debugRunsFor(args);

for (const run of runs) {
  const replay = await replayImageAnchorSequence({
    cv,
    sequence: run.sequence,
    trackingMode: run.mode.id,
    targetClassOverride: run.targetClassOverride,
    useObjectSupportMask: true,
    refreshObjectSupportMask: true,
    depthFrameForFrame: run.mode.requiresDepthFrame ? createSyntheticDepthFrame : null,
  });
  const rawSummary = summarizeReplay(replay);
  const headPose = scoreHeadPoseReplay({ replay, sequence: run.sequence });
  const quality = qualityForRun({
    title: run.title,
    replay,
    rawSummary,
    headPose,
  });
  sections.push(sequenceSection({
    title: run.title,
    sequence: run.sequence,
    replay,
    rawSummary,
    headPose,
    quality,
  }));
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>HOL Vision Debug Report</title>
  <style>
    body { margin: 0; padding: 28px; background: #0f1117; color: #e5e7eb; font: 14px/1.45 system-ui, sans-serif; }
    h1 { margin: 0 0 6px; font-size: 26px; }
    h2 { margin: 32px 0 12px; font-size: 20px; }
    p { color: #a8b0bd; margin: 0 0 18px; }
    section { border-top: 1px solid #273041; padding-top: 18px; }
    .metrics { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .metric { display: inline-flex; gap: 8px; align-items: baseline; border: 1px solid #334155; background: #171b24; border-radius: 6px; padding: 6px 8px; }
    .metric strong { color: #93c5fd; font-weight: 600; }
    .frames { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; }
    figure { margin: 0; border: 1px solid #334155; border-radius: 8px; overflow: hidden; background: #171b24; }
    svg { display: block; width: 100%; height: auto; background: #15171d; }
    figcaption { display: flex; flex-wrap: wrap; gap: 8px 12px; padding: 8px 10px; color: #cbd5e1; }
    figcaption strong { color: #f8fafc; }
  </style>
</head>
<body>
  <h1>HOL Vision Debug Report</h1>
  <p>Green is synthetic ground truth, red is the tracker/head input. The SVGs show anchor position and image-plane normal direction on sampled frames plus worst tracking and head-pose frames.</p>
  <p>${escapeHtml(runs.length)} replay${runs.length === 1 ? '' : 's'} · ${escapeHtml(SYNTHETIC_OBJECT_SUPPORT)}</p>
  ${sections.join('')}
</body>
</html>
`;

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, html, 'utf8');
console.log(reportPath);
