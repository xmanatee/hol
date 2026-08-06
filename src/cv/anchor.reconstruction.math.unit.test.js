import test from 'node:test';
import assert from 'node:assert/strict';

import { affineCameraObservability, solveLeastSquaresPair } from './anchor.reconstruction.math.js';

test('affine camera observability distinguishes volumetric support from planar degeneracy', () => {
  const observation = (x, y, z) => ({ point: { x, y, z } });
  const volumetric = [
    observation(-1, -1, -1),
    observation(1, -1, -1),
    observation(-1, 1, -1),
    observation(1, 1, -1),
    observation(-1, -1, 1),
    observation(1, -1, 1),
    observation(-1, 1, 1),
    observation(1, 1, 1),
  ];
  const shallow = volumetric.map(({ point }) => observation(point.x, point.y, point.z * 0.08));
  const planar = volumetric.map(({ point }) => observation(point.x, point.y, 0));

  assert.ok(affineCameraObservability(volumetric) > 0.99);
  assert.ok(affineCameraObservability(shallow) < 0.03);
  assert.equal(affineCameraObservability(planar), 0);
});

test('paired least-squares solve preserves the independent-solver baseline exactly', () => {
  const rows = [
    [12, 8, 1],
    [41, 9, 1],
    [15, 37, 1],
    [43, 39, 1],
    [28, 24, 1],
  ];
  const xValues = [21.4, 52.1, 28.8, 59.7, 40.2];
  const yValues = [9.7, 6.9, 37.4, 35.1, 22.3];

  const paired = solveLeastSquaresPair(rows, xValues, yValues);

  assert.deepEqual(paired, {
    left: [1.0716087232446654, 0.16329008730299238, 6.828288085250657],
    right: [-0.13985120519646063, 0.9586793022443191, 3.7347670849911196],
  });
});

test('paired least-squares solve preserves regularized degenerate solutions', () => {
  const rows = [
    [1, 2, 1],
    [1, 2, 1],
    [1, 2, 1],
  ];
  const xValues = [4, 4, 4];
  const yValues = [7, 7, 7];
  const paired = solveLeastSquaresPair(rows, xValues, yValues);

  assert.deepEqual(paired, {
    left: [0.6666666293829308, 1.3333332591210962, 0.666666630152667],
    right: [1.1666666021602776, 2.333333203165859, 1.1666666026191372],
  });
});

test('paired least-squares solve preserves four-column camera fits exactly', () => {
  const rows = [
    [1, 2, 3, 1],
    [4, 1, 2, 1],
    [2, 5, 1, 1],
    [6, 3, 4, 1],
    [3, 7, 5, 1],
    [8, 2, 6, 1],
  ];
  const paired = solveLeastSquaresPair(
    rows,
    [9.2, 8.1, 7.4, 14.3, 16.9, 19.6],
    [-2.1, 4.3, 1.8, 5.7, 3.2, 10.1],
  );

  assert.deepEqual(paired, {
    left: [0.5721532456756545, 0.5235351376222734, 2.0599131670689133, 1.3399069171641211],
    right: [1.7512419546942306, 0.33731452609011775, -0.3254006315305456, -3.157113502534821],
  });
});
