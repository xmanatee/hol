import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  formatAnnotatedVisionBenchmarkOutput,
  parseAnnotatedVisionBenchmarkArgs,
} from '../src/cv/annotatedVisionBenchmarkCli.js';
import { replayImageAnchorSequence } from '../src/cv/synthetic/anchorReplayHarness.js';
import { loadOpenCvForNode } from '../src/cv/synthetic/opencvNodeLoader.js';
import { selectTapVidTracks, validateTapVidAnnotations } from '../src/cv/tapVidFixture.js';
import {
  assertTapVidAggregateQualityFloor,
  assertTapVidQueryQualityFloor,
  computeTapVidMetrics,
} from '../src/cv/tapVidMetrics.js';
import {
  summarizeAnnotatedVisionFixtureManifest,
  validateAnnotatedVisionFixtureManifest,
} from '../src/cv/annotatedVisionFixtureManifest.js';
import { aggregateAnnotatedVisionFixtureMetrics } from '../src/cv/annotatedVisionAggregateMetrics.js';
import { decodeAnnotatedVisionRgbDeltaInPlace } from '../src/cv/annotatedVisionFrameCodec.js';
import { ANCHOR_TRACKING_INTERVAL_MS } from '../src/utils/cvScheduling.js';

const fixtureDir = fileURLToPath(new URL('../tests/fixtures/annotated-vision/', import.meta.url));
const manifestPath = join(fixtureDir, 'manifest.json');
const RGB_CHANNELS = 3;
const RGBA_CHANNELS = 4;
const DEFAULT_NORMAL = Object.freeze({ x: 0, y: 0, z: 1 });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const readVerifiedAsset = async (metadata) => {
  const path = join(fixtureDir, metadata.path);
  const fileStat = await stat(path);
  if (fileStat.size !== metadata.byteLength) {
    throw new Error(`${metadata.path} must be exactly ${metadata.byteLength} bytes; found ${fileStat.size}`);
  }
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  if (digest !== metadata.sha256) {
    throw new Error(`${metadata.path} sha256 mismatch: ${digest}`);
  }
  return bytes;
};

const decodeRgbFrames = (compressed, frames) => {
  const frameByteLength = frames.width * frames.height * RGB_CHANNELS;
  const expectedByteLength = frameByteLength * frames.count;
  const rgb = gunzipSync(compressed, { maxOutputLength: expectedByteLength });
  if (rgb.byteLength !== expectedByteLength) {
    throw new Error(
      `${frames.path} expands to ${rgb.byteLength} bytes; expected ${expectedByteLength} RGB bytes`,
    );
  }
  decodeAnnotatedVisionRgbDeltaInPlace(rgb, {
    frameByteLength,
    frameCount: frames.count,
  });

  return Array.from({ length: frames.count }, (_, frameIndex) => {
    const rgba = new Uint8ClampedArray(frames.width * frames.height * RGBA_CHANNELS);
    const sourceStart = frameIndex * frameByteLength;
    const sourceEnd = sourceStart + frameByteLength;
    for (let source = sourceStart, target = 0; source < sourceEnd; source += 3, target += 4) {
      rgba[target] = rgb[source];
      rgba[target + 1] = rgb[source + 1];
      rgba[target + 2] = rgb[source + 2];
      rgba[target + 3] = 255;
    }
    return { width: frames.width, height: frames.height, data: rgba };
  });
};

const rasterPoint = (point, width, height) => ({ x: point[0] * width, y: point[1] * height });

const createReplaySequence = ({ fixture, imageFrames, track }) => {
  const { width, height } = fixture.frames;
  const frames = imageFrames.slice(track.queryFrame).map((imageData, localIndex) => {
    const sourceIndex = track.queryFrame + localIndex;
    return {
      imageData,
      occluded: track.occluded[sourceIndex],
      targetVisible: !track.occluded[sourceIndex],
      groundTruth: {
        anchor: rasterPoint(track.points[sourceIndex], width, height),
        scale: 1,
        roll: 0,
        normal: DEFAULT_NORMAL,
      },
    };
  });
  return {
    kind: `${fixture.id}/${track.id}`,
    width,
    height,
    targetClass: null,
    tap: frames[0].groundTruth.anchor,
    boundingBox: { x1: 0, y1: 0, x2: width, y2: height },
    frames,
  };
};

const metricTrackFromReplay = ({ sequence, replay }) => {
  const queryPoint = [sequence.tap.x, sequence.tap.y];
  const predictedPoints = [queryPoint];
  const predictedOccluded = [false];
  let lastPoint = queryPoint;
  for (let frameIndex = 1; frameIndex < sequence.frames.length; frameIndex++) {
    const replayFrame = replay.frames[frameIndex - 1];
    if (Number.isFinite(replayFrame?.predicted?.x) && Number.isFinite(replayFrame?.predicted?.y)) {
      lastPoint = [replayFrame.predicted.x, replayFrame.predicted.y];
    }
    predictedPoints.push(lastPoint);
    predictedOccluded.push(!(replayFrame?.success === true && replayFrame.targetPresent === true));
  }

  return {
    queryFrame: 0,
    groundTruthPoints: sequence.frames.map((frame) => [
      frame.groundTruth.anchor.x,
      frame.groundTruth.anchor.y,
    ]),
    groundTruthOccluded: sequence.frames.map((frame) => frame.targetVisible === false),
    predictedPoints,
    predictedOccluded,
  };
};

const meanFinite = (frames, select) => {
  const values = frames.map(select).filter(Number.isFinite);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
};

const maxFinite = (frames, select) => {
  const values = frames.map(select).filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : null;
};

const percentileFinite = (frames, select, percentile) => {
  const values = frames
    .map(select)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (values.length === 0) return null;
  const index = (values.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
};

const countValues = (frames, select) =>
  frames.reduce((counts, frame) => {
    const value = select(frame);
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});

const summarizeReplayEvidence = (frames, targetVisible) => {
  const selected = frames.filter((frame) => frame.targetVisible === targetVisible);
  const relocalizationAttempts = selected.filter(
    (frame) => frame.runtime.admittedUpdate && (frame.runtime.stageTimings?.relocalizationMs || 0) > 0,
  );
  const learnedRelocalizationAttempts = relocalizationAttempts.filter(
    (frame) => frame.metrics.learnedRelocalizationAttempted === true,
  );
  return {
    frames: selected.length,
    predictedVisible: selected.filter((frame) => frame.success === true && frame.targetPresent === true)
      .length,
    meanTrackingSuccessRate: meanFinite(selected, (frame) => frame.metrics.trackingSuccessRate),
    meanActiveLandmarks: meanFinite(selected, (frame) => frame.metrics.activeLandmarkCount),
    maxActiveLandmarks: maxFinite(selected, (frame) => frame.metrics.activeLandmarkCount),
    meanTemplateQuality: meanFinite(selected, (frame) => frame.metrics.templateQuality),
    maxTemplateQuality: maxFinite(selected, (frame) => frame.metrics.templateQuality),
    meanPoseInliers: meanFinite(selected, (frame) => frame.metrics.poseInliers),
    meanTrackerResidual: meanFinite(selected, (frame) => frame.metrics.trackerLocalReferenceResidual),
    meanAnchorError: meanFinite(selected, (frame) => frame.anchorError),
    admittedUpdates: selected.filter((frame) => frame.runtime.admittedUpdate).length,
    meanUpdateWallTimeMs: meanFinite(selected, (frame) => frame.runtime.updateWallTimeMs),
    p95UpdateWallTimeMs: percentileFinite(selected, (frame) => frame.runtime.updateWallTimeMs, 0.95),
    meanBootstrapUpdateMs: meanFinite(selected, (frame) => frame.runtime.stageTimings?.bootstrapUpdateMs),
    p95BootstrapUpdateMs: percentileFinite(
      selected,
      (frame) => frame.runtime.stageTimings?.bootstrapUpdateMs,
      0.95,
    ),
    relocalizationAttempts: relocalizationAttempts.length,
    learnedRelocalizationAttempts: learnedRelocalizationAttempts.length,
    relocalizationSuccesses: relocalizationAttempts.filter(
      (frame) => frame.metrics.relocalizationResult === 'success',
    ).length,
    firstRelocalizationAttemptFrame: relocalizationAttempts[0]?.index ?? null,
    successfulRelocalizationFrames: relocalizationAttempts
      .filter((frame) => frame.metrics.relocalizationResult === 'success')
      .map((frame) => frame.index),
    maxRelocalizationQueryKeypoints: maxFinite(
      relocalizationAttempts,
      (frame) => frame.metrics.relocalizationQueryKeypoints,
    ),
    maxRelocalizationMatches: maxFinite(
      relocalizationAttempts,
      (frame) => frame.metrics.relocalizationMatches,
    ),
    maxRelocalizationInliers: maxFinite(
      relocalizationAttempts,
      (frame) => frame.metrics.relocalizationInliers,
    ),
    maxRelocalizationKeyframes: maxFinite(selected, (frame) => frame.metrics.relocalizationKeyframes),
    maxRelocalizationDescriptors: maxFinite(selected, (frame) => frame.metrics.relocalizationDescriptors),
    storedRelocalizationKeyframeFrames: selected
      .filter(
        (frame) => frame.runtime.admittedUpdate && frame.metrics.relocalizationKeyframeResult === 'stored',
      )
      .map((frame) => ({
        frame: frame.index,
        keyframes: frame.metrics.relocalizationKeyframes,
        descriptors: frame.metrics.relocalizationDescriptors,
      })),
    relocalizationResults: countValues(
      relocalizationAttempts,
      (frame) => frame.metrics.relocalizationResult || 'none',
    ),
    relocalizationReasons: countValues(
      relocalizationAttempts,
      (frame) => frame.metrics.relocalizationReason || 'none',
    ),
    learnedRelocalizationResults: countValues(
      learnedRelocalizationAttempts,
      (frame) => frame.metrics.relocalizationResult || 'none',
    ),
    methods: countValues(selected, (frame) => frame.method || 'none'),
    states: countValues(selected, (frame) => frame.anchorState),
    readinessReasons: countValues(selected, (frame) => frame.metrics.readiness?.reason || 'ready'),
  };
};

const evaluateQuerySet = async ({ fixture, querySet, annotations, imageFrames, openCv }) => {
  const tracks = selectTapVidTracks(
    annotations,
    querySet.queries.map(({ trackId }) => trackId),
  );
  const metricTracks = [];
  const queries = [];

  for (const [trackIndex, track] of tracks.entries()) {
    const sequence = createReplaySequence({ fixture, imageFrames, track });
    const replay = await replayImageAnchorSequence({
      cv: openCv,
      sequence,
      trackingMode: 'sparse-reconstruction',
      useObjectSupportMask: false,
      sourceFrameIntervalMs: 1000 / fixture.frames.framesPerSecond,
      updateIntervalMs: ANCHOR_TRACKING_INTERVAL_MS,
    });
    const metricTrack = metricTrackFromReplay({ sequence, replay });
    metricTracks.push(metricTrack);
    const queryMetrics = computeTapVidMetrics({
      width: fixture.frames.width,
      height: fixture.frames.height,
      framesPerSecond: fixture.frames.framesPerSecond,
      tracks: [metricTrack],
    });
    assertTapVidQueryQualityFloor(
      `${fixture.id}/${querySet.id}/${track.id}`,
      queryMetrics,
      querySet.queries[trackIndex].qualityFloor,
    );
    queries.push({
      id: track.id,
      anchorCreated: replay.anchorCreated,
      createFailure: replay.createFailure || null,
      evaluatedFrames: sequence.frames.length - 1,
      admittedUpdates: replay.cadence.admittedUpdateCount,
      visiblePredictions: replay.frames.filter(
        (frame) => frame.success === true && frame.targetPresent === true,
      ).length,
      metrics: queryMetrics,
      evidence: {
        visible: summarizeReplayEvidence(replay.frames, true),
        occluded: summarizeReplayEvidence(replay.frames, false),
      },
    });
  }

  const metrics = computeTapVidMetrics({
    width: fixture.frames.width,
    height: fixture.frames.height,
    framesPerSecond: fixture.frames.framesPerSecond,
    tracks: metricTracks,
  });
  assertTapVidAggregateQualityFloor(metrics, querySet.aggregateFloor);
  return { id: querySet.id, metrics, queries, metricTracks };
};

const evaluateFixture = async ({ fixture }) => {
  const [compressedFrames, annotationBytes, openCv] = await Promise.all([
    readVerifiedAsset(fixture.frames),
    readVerifiedAsset(fixture.annotations),
    loadOpenCvForNode(),
  ]);
  const imageFrames = decodeRgbFrames(compressedFrames, fixture.frames);
  const annotations = validateTapVidAnnotations(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(annotationBytes)),
    { frameCount: fixture.frames.count },
  );
  const evaluatedQuerySets = [];
  for (const querySet of fixture.querySets) {
    evaluatedQuerySets.push(await evaluateQuerySet({ fixture, querySet, annotations, imageFrames, openCv }));
  }
  const metrics = computeTapVidMetrics({
    width: fixture.frames.width,
    height: fixture.frames.height,
    framesPerSecond: fixture.frames.framesPerSecond,
    tracks: evaluatedQuerySets.flatMap(({ metricTracks }) => metricTracks),
  });
  return {
    id: fixture.id,
    dataset: fixture.dataset,
    frameDerivation: fixture.frameDerivation,
    frames: {
      width: fixture.frames.width,
      height: fixture.frames.height,
      count: fixture.frames.count,
      framesPerSecond: fixture.frames.framesPerSecond,
    },
    metrics,
    querySets: evaluatedQuerySets.map(({ id, metrics: querySetMetrics, queries }) => ({
      id,
      metrics: querySetMetrics,
      queries,
    })),
  };
};

const { outputPath } = parseAnnotatedVisionBenchmarkArgs(process.argv.slice(2));
const manifest = validateAnnotatedVisionFixtureManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
const reports = [];
for (const fixture of manifest.fixtures) reports.push(await evaluateFixture({ fixture }));

const output = {
  summary: summarizeAnnotatedVisionFixtureManifest(manifest),
  aggregate: aggregateAnnotatedVisionFixtureMetrics(reports),
  reports,
};
console.log(await formatAnnotatedVisionBenchmarkOutput(output, { outputPath }));
