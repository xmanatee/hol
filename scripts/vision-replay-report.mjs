import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import { createSyntheticObjectSuite } from '../src/cv/synthetic/visionFixtures.js';
import { reportReplayScenarios } from '../src/cv/synthetic/visionReplayScenarios.js';
import {
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';
import { RECONSTRUCTION_MODES } from '../src/cv/anchor.reconstructionModes.js';

const SYNTHETIC_OBJECT_SUPPORT = 'synthetic-object-mask';
const cv = await loadOpenCvForNode();
const replaySummaries = [];

for (const scenario of reportReplayScenarios) {
  for (const mode of RECONSTRUCTION_MODES) {
    const sequence = scenario.create();
    const replay = await replayImageAnchorSequence({
      cv,
      sequence,
      trackingMode: mode.id,
      useObjectSupportMask: true,
    });
    const lastFrame = replay.frames.at(-1);
    const preview = lastFrame?.metrics?.reconstructionPreview;
    replaySummaries.push({
      name: scenario.name,
      kind: sequence.kind,
      mode: mode.id,
      targetClass: sequence.targetClass,
      objectSupportMask: SYNTHETIC_OBJECT_SUPPORT,
      surfaceModel: preview?.surface?.model || null,
      surfaceFaces: preview?.surface?.faces?.length || 0,
      geometricConsistency: preview?.statistics?.geometricConsistency || 0,
      backgroundVariant: sequence.metadata.backgroundVariant,
      anchorCreated: replay.anchorCreated,
      createFailure: replay.createFailure || null,
      ...summarizeReplay(replay),
      headPose: scoreHeadPoseReplay({ replay, sequence }).summary,
    });
  }
}

const generatedFixtures = createSyntheticObjectSuite().map(sequence => ({
  kind: sequence.kind,
  frames: sequence.frames.length,
  width: sequence.width,
  height: sequence.height,
  targetModel: sequence.metadata.targetModel,
  targetClass: sequence.targetClass,
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
