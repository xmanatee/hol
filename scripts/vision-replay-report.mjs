import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import { createSyntheticObjectSuite } from '../src/cv/synthetic/visionFixtures.js';
import { reportReplayScenarios } from '../src/cv/synthetic/visionReplayScenarios.js';
import {
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';

const cv = await loadOpenCvForNode();
const replaySummaries = [];

for (const scenario of reportReplayScenarios) {
  const sequence = scenario.create();
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
  });
  replaySummaries.push({
    name: scenario.name,
    kind: sequence.kind,
    backgroundVariant: sequence.metadata.backgroundVariant,
    anchorCreated: replay.anchorCreated,
    createFailure: replay.createFailure || null,
    ...summarizeReplay(replay),
    headPose: scoreHeadPoseReplay({ replay, sequence }).summary,
  });
}

const generatedFixtures = createSyntheticObjectSuite().map(sequence => ({
  kind: sequence.kind,
  frames: sequence.frames.length,
  width: sequence.width,
  height: sequence.height,
  targetModel: sequence.metadata.targetModel,
  backgroundVariant: sequence.metadata.backgroundVariant,
  hasBackground: sequence.metadata.hasBackground,
  hasDarkRegions: sequence.metadata.hasDarkRegions,
  hasFineTexture: sequence.metadata.hasFineTexture,
  hasLightingVariation: sequence.metadata.hasLightingVariation,
  hasOcclusion: sequence.metadata.hasOcclusion,
  hasMovingBackground: sequence.metadata.hasMovingBackground,
}));

console.log(JSON.stringify({
  generatedFixtures,
  replaySummaries,
}, null, 2));
