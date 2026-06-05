import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import {
  createCylindricalCanSequence,
  createPlanarBookSequence,
  createRigidBoxSequence,
  createSyntheticObjectSuite,
} from '../src/cv/synthetic/visionFixtures.js';
import {
  replayImageAnchorSequence,
  summarizeReplay,
} from '../src/cv/synthetic/anchorReplayHarness.js';
import { scoreHeadPoseReplay } from '../src/cv/synthetic/headPoseReplayHarness.js';

const cv = await loadOpenCvForNode();
const replaySequences = [
  createPlanarBookSequence({
    kind: 'planar-book',
    frameCount: 32,
    occlusionFrames: [14, 15, 16, 17],
  }),
  createPlanarBookSequence({
    kind: 'dark-book',
    frameCount: 32,
    occlusionFrames: [14, 15, 16, 17],
  }),
  createCylindricalCanSequence({
    frameCount: 30,
    occlusionFrames: [12, 13, 14],
  }),
  createRigidBoxSequence({
    frameCount: 28,
    occlusionFrames: [10, 11, 12],
  }),
];
const replaySummaries = [];

for (const sequence of replaySequences) {
  const replay = await replayImageAnchorSequence({
    cv,
    sequence,
    trackingMode: 'sparse-reconstruction',
  });
  replaySummaries.push({
    kind: sequence.kind,
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
  hasBackground: sequence.metadata.hasBackground,
  hasDarkRegions: sequence.metadata.hasDarkRegions,
  hasFineTexture: sequence.metadata.hasFineTexture,
  hasLightingVariation: sequence.metadata.hasLightingVariation,
  hasOcclusion: sequence.metadata.hasOcclusion,
}));

console.log(JSON.stringify({
  generatedFixtures,
  replaySummaries,
}, null, 2));
