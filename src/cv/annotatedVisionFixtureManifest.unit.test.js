import assert from 'node:assert/strict';
import test from 'node:test';

import {
  summarizeAnnotatedVisionFixtureManifest,
  validateAnnotatedVisionFixtureManifest,
} from './annotatedVisionFixtureManifest.js';

const SHA256 = 'a'.repeat(64);

const aggregateFloor = (overrides = {}) => ({
  minimumAverageJaccard: 0.1,
  minimumAveragePointsWithinThreshold: 0.2,
  minimumOcclusionAccuracy: 0.5,
  reDetection: {
    kind: 'eligible',
    minimumAverageJaccard: 0.08,
    minimumStableRecall: 0.25,
    maximumStableLatencyMs: 30,
  },
  ...overrides,
});

const queryFloor = (overrides = {}) => ({
  minimumAverageJaccard: 0.05,
  minimumAveragePointsWithinThreshold: 0.1,
  minimumOcclusionAccuracy: 0.4,
  maximumP95VisiblePointError: 80,
  maximumFalseVisibleDurationMs: 40,
  maximumMissedVisibleDurationMs: 50,
  maximumVisibleTrackFragmentationCount: 3,
  reDetection: {
    kind: 'eligible',
    minimumAverageJaccard: 0.03,
    minimumStableRecall: 0,
    maximumStableLatencyMs: 500,
  },
  ...overrides,
});

const query = (trackId, floorOverrides = {}) => ({
  trackId,
  qualityFloor: queryFloor(floorOverrides),
});

const querySet = (id, trackIds, overrides = {}) => ({
  id,
  aggregateFloor: aggregateFloor(),
  queries: trackIds.map((trackId) => query(trackId)),
  ...overrides,
});

const fixture = (overrides = {}) => ({
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
      sha256: 'b'.repeat(64),
    },
    annotations: {
      url: 'https://storage.googleapis.com/dm-tapnet/tapvid_rgb_stacking.zip',
      byteLength: 187_291_581,
      sha256: 'b'.repeat(64),
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
    byteLength: 4_123_456,
    sha256: SHA256,
  },
  annotations: {
    path: 'tapvid-rgb-stacking/34.tracks.json',
    format: 'tapvid-normalized-v1',
    byteLength: 350_000,
    sha256: SHA256,
  },
  querySets: [querySet('primary', ['1', '12', '16']), querySet('occlusion-stress', ['6', '9', '18'])],
  ...overrides,
});

const manifest = (fixtureOverrides = {}) => ({ version: 9, fixtures: [fixture(fixtureOverrides)] });

test('fixture manifest validates explicit provenance and per-query contracts', () => {
  const result = validateAnnotatedVisionFixtureManifest(manifest());
  assert.equal(result.version, 9);
  assert.equal(result.fixtures[0].sources.sampleId, '34');
  assert.equal(result.fixtures[0].provenance.video.license, 'CC-BY-4.0');
  assert.equal(result.fixtures[0].querySets[0].queries[0].qualityFloor.reDetection.kind, 'eligible');
  assert.deepEqual(
    result.fixtures[0].querySets.map(({ id }) => id),
    ['primary', 'occlusion-stress'],
  );
});

test('fixture manifest rejects every previous shape and unknown fields', () => {
  for (const version of [2, 4, 5, 6, 7, 8]) {
    assert.throws(
      () => validateAnnotatedVisionFixtureManifest({ ...manifest(), version }),
      /version must be 9/,
    );
  }
  assert.throws(
    () => validateAnnotatedVisionFixtureManifest(manifest({ license: 'CC-BY-4.0', attribution: 'legacy' })),
    /fixtures\[0\] contains unknown field: license/,
  );
  assert.throws(
    () => validateAnnotatedVisionFixtureManifest(manifest({ tasks: ['pointTracking'] })),
    /fixtures\[0\] contains unknown field: tasks/,
  );
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest(
        manifest({
          querySets: [
            {
              id: 'primary',
              trackIds: ['1'],
              qualityFloor: { ...aggregateFloor(), ...queryFloor() },
            },
          ],
        }),
      ),
    /querySets\[0\] contains unknown field: trackIds/,
  );
});

test('fixture provenance independently validates video and annotations', () => {
  const tearsOfSteel = fixture({
    provenance: {
      video: {
        license: 'CC-BY-3.0',
        attribution: 'Blender Foundation, Tears of Steel (2012)',
        sourceUrl: 'https://mango.blender.org/about/',
      },
      annotations: fixture().provenance.annotations,
    },
  });
  assert.equal(
    validateAnnotatedVisionFixtureManifest({ version: 9, fixtures: [tearsOfSteel] }).fixtures[0].provenance
      .video.license,
    'CC-BY-3.0',
  );
  for (const component of ['video', 'annotations']) {
    assert.throws(
      () =>
        validateAnnotatedVisionFixtureManifest(
          manifest({
            provenance: {
              ...fixture().provenance,
              [component]: { ...fixture().provenance[component], license: 'Proprietary' },
            },
          }),
        ),
      new RegExp(`provenance\\.${component}\\.license must be an approved fixture license`),
    );
  }
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest(
        manifest({
          provenance: {
            ...fixture().provenance,
            video: { ...fixture().provenance.video, sourceUrl: 'http://example.test/video' },
          },
        }),
      ),
    /provenance.video.sourceUrl must be an HTTPS URL/,
  );
});

test('recovery floors use exact eligible, segment-only, or not-applicable variants', () => {
  const noRecoveryFloor = queryFloor({ reDetection: { kind: 'not-applicable' } });
  assert.equal(
    validateAnnotatedVisionFixtureManifest(
      manifest({
        querySets: [
          querySet('primary', ['7'], { queries: [{ trackId: '7', qualityFloor: noRecoveryFloor }] }),
        ],
      }),
    ).fixtures[0].querySets[0].queries[0].qualityFloor.reDetection.kind,
    'not-applicable',
  );
  const segmentOnly = queryFloor({
    reDetection: { kind: 'segment-only', minimumAverageJaccard: 0.02 },
  });
  assert.equal(
    validateAnnotatedVisionFixtureManifest(
      manifest({
        querySets: [
          querySet('stress', ['24'], {
            aggregateFloor: {
              ...aggregateFloor(),
              reDetection: { kind: 'segment-only', minimumAverageJaccard: 0.01 },
            },
            queries: [{ trackId: '24', qualityFloor: segmentOnly }],
          }),
        ],
      }),
    ).fixtures[0].querySets[0].queries[0].qualityFloor.reDetection.kind,
    'segment-only',
  );
  for (const reDetection of [
    { kind: 'unknown' },
    { kind: 'not-applicable', minimumStableRecall: 0 },
    { kind: 'segment-only' },
    { kind: 'segment-only', minimumAverageJaccard: 0, maximumStableLatencyMs: 1 },
    { kind: 'eligible', minimumAverageJaccard: 0, minimumStableRecall: 0, maximumStableLatencyMs: 1 },
    { kind: 'eligible', minimumAverageJaccard: 0.1, minimumStableRecall: -1, maximumStableLatencyMs: 1 },
    { kind: 'eligible', minimumAverageJaccard: 0.1, minimumStableRecall: 0, maximumStableLatencyMs: -1 },
  ]) {
    assert.throws(() =>
      validateAnnotatedVisionFixtureManifest(
        manifest({
          querySets: [
            querySet('primary', ['1'], {
              queries: [query('1', { reDetection })],
            }),
          ],
        }),
      ),
    );
  }
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest(
        manifest({
          querySets: [
            querySet('primary', ['1'], {
              queries: [query('1', { minimumReDetectionAverageJaccard: 0.1 })],
            }),
          ],
        }),
      ),
    /qualityFloor contains unknown field: minimumReDetectionAverageJaccard/,
  );
});

test('fixture quality floors reject vacuous or permissive values', () => {
  for (const [field, value, message] of [
    ['minimumAverageJaccard', 0, /minimumAverageJaccard/],
    ['minimumAveragePointsWithinThreshold', 1.1, /minimumAveragePointsWithinThreshold/],
    ['minimumOcclusionAccuracy', Number.NaN, /minimumOcclusionAccuracy/],
  ]) {
    assert.throws(
      () =>
        validateAnnotatedVisionFixtureManifest(
          manifest({
            querySets: [querySet('primary', ['1'], { aggregateFloor: aggregateFloor({ [field]: value }) })],
          }),
        ),
      message,
    );
  }
  for (const [field, value, message] of [
    ['minimumAverageJaccard', 0, /minimumAverageJaccard/],
    ['minimumStableRecall', 0, /minimumStableRecall/],
    ['maximumStableLatencyMs', -1, /maximumStableLatencyMs/],
  ]) {
    assert.throws(
      () =>
        validateAnnotatedVisionFixtureManifest(
          manifest({
            querySets: [
              querySet('primary', ['1'], {
                aggregateFloor: aggregateFloor({
                  reDetection: { ...aggregateFloor().reDetection, [field]: value },
                }),
              }),
            ],
          }),
        ),
      message,
    );
  }
  for (const [field, value, message] of [
    ['minimumAverageJaccard', 0, /minimumAverageJaccard/],
    ['maximumP95VisiblePointError', -1, /maximumP95VisiblePointError/],
    ['maximumVisibleTrackFragmentationCount', 1.5, /maximumVisibleTrackFragmentationCount/],
  ]) {
    assert.throws(
      () =>
        validateAnnotatedVisionFixtureManifest(
          manifest({
            querySets: [querySet('primary', ['1'], { queries: [query('1', { [field]: value })] })],
          }),
        ),
      message,
    );
  }
});

test('fixture manifest rejects unsafe paths and incomplete source pins', () => {
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest(
        manifest({ frames: { ...fixture().frames, path: '../34.rgb.gz' } }),
      ),
    /frames.path must be a safe relative path/,
  );
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest(
        manifest({ frames: { ...fixture().frames, sha256: undefined } }),
      ),
    /frames.sha256 must be a SHA-256 digest/,
  );
  const sources = fixture().sources;
  assert.throws(
    () => validateAnnotatedVisionFixtureManifest(manifest({ sources: { ...sources, sampleId: '' } })),
    /sources.sampleId must be a non-empty trimmed string/,
  );
  for (const component of ['video', 'annotations']) {
    for (const [overrides, message] of [
      [
        { url: 'http://example.test/source.zip' },
        new RegExp(`sources\\.${component}\\.url must be an HTTPS URL`),
      ],
      [{ sha256: 'unpinned' }, new RegExp(`sources\\.${component}\\.sha256 must be a SHA-256 digest`)],
    ]) {
      assert.throws(
        () =>
          validateAnnotatedVisionFixtureManifest(
            manifest({
              sources: { ...sources, [component]: { ...sources[component], ...overrides } },
            }),
          ),
        message,
      );
    }
  }
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest(
        manifest({
          source: {
            url: sources.video.url,
            byteLength: sources.video.byteLength,
            sha256: sources.video.sha256,
            sampleId: sources.sampleId,
          },
          sources: undefined,
        }),
      ),
    /fixtures\[0\] contains unknown field: source/,
  );
});

test('fixture frame derivation owns source raster and exact resize semantics', () => {
  const resized = validateAnnotatedVisionFixtureManifest(
    manifest({
      frameDerivation: {
        kind: 'resize',
        sourceWidth: 1152,
        sourceHeight: 480,
        resampler: 'pillow-lanczos-per-channel',
      },
    }),
  ).fixtures[0].frameDerivation;
  assert.deepEqual(resized, {
    kind: 'resize',
    sourceWidth: 1152,
    sourceHeight: 480,
    resampler: 'pillow-lanczos-per-channel',
  });

  for (const [frameDerivation, message] of [
    [{ kind: 'identity', sourceWidth: 1152, sourceHeight: 480 }, /identity raster must match frames raster/],
    [
      {
        kind: 'resize',
        sourceWidth: 256,
        sourceHeight: 256,
        resampler: 'pillow-lanczos-per-channel',
      },
      /resize must change the source raster/,
    ],
    [
      { kind: 'resize', sourceWidth: 1152, sourceHeight: 480, resampler: 'bilinear' },
      /resampler must be pillow-lanczos-per-channel/,
    ],
    [
      {
        kind: 'resize',
        sourceWidth: 16_385,
        sourceHeight: 480,
        resampler: 'pillow-lanczos-per-channel',
      },
      /sourceWidth must not exceed 16384/,
    ],
    [{ kind: 'crop', sourceWidth: 1152, sourceHeight: 480 }, /kind must be identity or resize/],
  ]) {
    assert.throws(() => validateAnnotatedVisionFixtureManifest(manifest({ frameDerivation })), message);
  }
});

test('fixture manifest rejects duplicate ownership and resource exhaustion', () => {
  assert.throws(
    () => validateAnnotatedVisionFixtureManifest(manifest({ querySets: [querySet('primary', ['1', '1'])] })),
    /queries must contain unique trackIds/,
  );
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest(
        manifest({ querySets: [querySet('primary', ['1']), querySet('stress', ['1'])] }),
      ),
    /Track id is owned by multiple query sets: 1/,
  );
  assert.throws(
    () => validateAnnotatedVisionFixtureManifest(manifest({ frames: { ...fixture().frames, count: 4097 } })),
    /decoded RGB payload must not exceed/,
  );
  assert.throws(
    () =>
      validateAnnotatedVisionFixtureManifest({
        version: 9,
        fixtures: [fixture(), fixture({ id: 'rgb-stacking-35', querySets: [querySet('primary', ['2'])] })],
      }),
    /Asset path is owned by multiple fixtures/,
  );
});

test('fixture manifest summary reports executable frames and independent queries', () => {
  assert.deepEqual(
    summarizeAnnotatedVisionFixtureManifest(validateAnnotatedVisionFixtureManifest(manifest())),
    {
      fixtures: 1,
      frames: 250,
      independentQueries: 6,
      byDataset: { 'TAP-Vid-RGB-Stacking': 1 },
    },
  );
});
