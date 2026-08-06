import test from 'node:test';
import assert from 'node:assert/strict';

import { selectTapVidTracks, validateTapVidAnnotations } from './tapVidFixture.js';

const annotations = () => ({
  version: 1,
  coordinateSpace: 'normalized-raster',
  tracks: [
    {
      id: 'surface-point',
      queryFrame: 1,
      points: [
        [0.2, 0.3],
        [0.25, 0.35],
        [0.3, 0.4],
      ],
      occluded: [true, false, false],
    },
  ],
});

test('TAP-Vid annotations require first-visible causal queries and normalized raster points', () => {
  const result = validateTapVidAnnotations(annotations(), { frameCount: 3 });

  assert.equal(result.tracks[0].queryFrame, 1);
  assert.deepEqual(result.tracks[0].points[2], [0.3, 0.4]);
});

test('TAP-Vid annotations reject mismatched frames non-first queries and invalid coordinates', () => {
  assert.throws(
    () => validateTapVidAnnotations(annotations(), { frameCount: 4 }),
    /points must contain exactly 4 frames/,
  );

  const nonFirst = annotations();
  nonFirst.tracks[0].queryFrame = 2;
  assert.throws(
    () => validateTapVidAnnotations(nonFirst, { frameCount: 3 }),
    /queryFrame must be the first visible frame/,
  );

  const outsideRaster = annotations();
  outsideRaster.tracks[0].points[2][0] = 1.01;
  assert.throws(
    () => validateTapVidAnnotations(outsideRaster, { frameCount: 3 }),
    /points\[2\] must be inside the visible raster/,
  );

  const occludedOutsideRaster = annotations();
  occludedOutsideRaster.tracks[0].points[0] = [-0.2, 1.1];
  assert.deepEqual(
    validateTapVidAnnotations(occludedOutsideRaster, { frameCount: 3 }).tracks[0].points[0],
    [-0.2, 1.1],
  );
});

test('TAP-Vid annotations reject duplicate track ids and unknown fields', () => {
  const duplicate = annotations();
  duplicate.tracks.push({ ...duplicate.tracks[0] });
  assert.throws(() => validateTapVidAnnotations(duplicate, { frameCount: 3 }), /track ids must be unique/);

  assert.throws(
    () => validateTapVidAnnotations({ ...annotations(), queryMode: 'first' }, { frameCount: 3 }),
    /annotations contains unknown field: queryMode/,
  );
});

test('selected TAP-Vid queries preserve manifest order and reject missing ids', () => {
  const source = annotations();
  source.tracks.push({ ...source.tracks[0], id: 'second-point' });
  const validated = validateTapVidAnnotations(source, { frameCount: 3 });

  assert.deepEqual(
    selectTapVidTracks(validated, ['second-point', 'surface-point']).map((track) => track.id),
    ['second-point', 'surface-point'],
  );
  assert.throws(
    () => selectTapVidTracks(validated, ['missing']),
    /Selected TAP-Vid track is absent: missing/,
  );
});
