import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAnnotatedVisionFixtureManifest } from './annotatedVisionFixtureManifest.js';

const aggregateFloor = () => ({
  minimumAverageJaccard: 0.2,
  minimumAveragePointsWithinThreshold: 0.3,
  minimumOcclusionAccuracy: 0.6,
  reDetection: {
    kind: 'eligible',
    minimumAverageJaccard: 0.1,
    minimumStableRecall: 0.5,
    maximumStableLatencyMs: 400,
  },
});

const queryFloor = () => ({
  minimumAverageJaccard: 0.1,
  minimumAveragePointsWithinThreshold: 0.2,
  minimumOcclusionAccuracy: 0.5,
  maximumP95VisiblePointError: 80,
  maximumFalseVisibleDurationMs: 1000,
  maximumMissedVisibleDurationMs: 1500,
  maximumVisibleTrackFragmentationCount: 3,
  reDetection: {
    kind: 'eligible',
    minimumAverageJaccard: 0.05,
    minimumStableRecall: 0,
    maximumStableLatencyMs: 1800,
  },
});

const query = (trackId) => ({ trackId, qualityFloor: queryFloor() });

const fixture = (querySets) => ({
  id: 'rgb-stacking-34',
  dataset: 'TAP-Vid-RGB-Stacking',
  provenance: {
    video: {
      license: 'CC-BY-4.0',
      attribution: 'Google DeepMind TAP-Vid RGB-Stacking dataset',
      sourceUrl: 'https://github.com/google-deepmind/tapnet/blob/main/tapnet/tapvid/README.md',
    },
    annotations: {
      license: 'CC-BY-4.0',
      attribution: 'Google DeepMind TAP-Vid annotations',
      sourceUrl: 'https://github.com/google-deepmind/tapnet/blob/main/tapnet/tapvid/README.md',
    },
  },
  sources: {
    sampleId: '34',
    video: {
      url: 'https://storage.googleapis.com/dm-tapnet/tapvid_rgb_stacking.zip',
      byteLength: 187_291_581,
      sha256: 'a'.repeat(64),
    },
    annotations: {
      url: 'https://storage.googleapis.com/dm-tapnet/tapvid_rgb_stacking.zip',
      byteLength: 187_291_581,
      sha256: 'a'.repeat(64),
    },
  },
  frameDerivation: {
    kind: 'identity',
    sourceWidth: 256,
    sourceHeight: 256,
  },
  frames: {
    path: 'tapvid-rgb-stacking/34.rgb.gz',
    encoding: 'rgb24-xor-delta-gzip',
    width: 256,
    height: 256,
    count: 250,
    framesPerSecond: 30,
    byteLength: 4_154_289,
    sha256: 'b'.repeat(64),
  },
  annotations: {
    path: 'tapvid-rgb-stacking/34.tracks.json',
    format: 'tapvid-normalized-v1',
    byteLength: 352_805,
    sha256: 'c'.repeat(64),
  },
  querySets,
});

test('every selected track owns one explicit current quality contract', () => {
  const manifest = validateAnnotatedVisionFixtureManifest({
    version: 9,
    fixtures: [
      fixture([
        {
          id: 'primary',
          aggregateFloor: aggregateFloor(),
          queries: [query('1'), query('12')],
        },
      ]),
    ],
  });

  assert.deepEqual(
    manifest.fixtures[0].querySets[0].queries.map(({ trackId }) => trackId),
    ['1', '12'],
  );
  assert.equal(
    manifest.fixtures[0].querySets[0].queries[1].qualityFloor.reDetection.maximumStableLatencyMs,
    1800,
  );
});

test('shared query floors and duplicate ownership are rejected', () => {
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest({
        version: 9,
        fixtures: [
          fixture([
            {
              id: 'primary',
              trackIds: ['1', '12'],
              qualityFloor: { ...aggregateFloor(), ...queryFloor() },
            },
          ]),
        ],
      }),
    /querySets\[0\] contains unknown field: trackIds/,
  );
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest({
        version: 9,
        fixtures: [
          fixture([
            { id: 'primary', aggregateFloor: aggregateFloor(), queries: [query('1')] },
            { id: 'stress', aggregateFloor: aggregateFloor(), queries: [query('1')] },
          ]),
        ],
      }),
    /Track id is owned by multiple query sets: 1/,
  );
});

test('the previous manifest shape is rejected outright', () => {
  assert.throws(
    () => validateAnnotatedVisionFixtureManifest({ version: 6, fixtures: [] }),
    /version must be 9/,
  );
});
