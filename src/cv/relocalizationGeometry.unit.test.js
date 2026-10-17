import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRelocalizationGeometry } from './relocalizationGeometry.js';

const grid = Array.from({ length: 12 }, (_, index) => ({
  x: 30 + (index % 4) * 30,
  y: 40 + Math.floor(index / 4) * 30,
}));
const fitFor = (rowX = [1, 0, 12], rowY = [0, 1, -7], points = grid) => ({
  transform: { rowX, rowY },
  inliers: points.map((reference) => ({
    reference: { ...reference },
    current: {
      x: rowX[0] * reference.x + rowX[1] * reference.y + rowX[2],
      y: rowY[0] * reference.x + rowY[1] * reference.y + rowY[2],
    },
  })),
  averageResidual: 0,
});

test('principal-scale checks reject shear collapse even when both transformed axes have similar length', () => {
  for (const yScale of [0.02, 0.6]) {
    const result = assessRelocalizationGeometry(fitFor([1, 1, 12], [0, yScale, -7]));
    assert.equal(result.valid, false);
    assert.match(result.reason, /scale|anisotropy/);
  }
});

test('principal-scale decisions are independent of input and output image rotation', () => {
  for (const ratio of [0.4, 0.5, 0.8, 1]) {
    for (const input of [0, 0.3, Math.PI / 4, 1.2]) {
      for (const output of [0, 0.7, 1.8]) {
        const ci = Math.cos(input);
        const si = Math.sin(input);
        const co = Math.cos(output);
        const so = Math.sin(output);
        const rowX = [co * ci - so * ratio * si, -co * si - so * ratio * ci, 12];
        const rowY = [so * ci + co * ratio * si, -so * si + co * ratio * ci, -7];
        const result = assessRelocalizationGeometry(fitFor(rowX, rowY));
        assert.equal(result.valid, ratio >= 0.5, result.reason);
        if (result.valid) {
          assert.ok(Math.abs(result.maxScale - 1) < 1e-12);
          assert.ok(Math.abs(result.minScale - ratio) < 1e-12);
          assert.ok(Math.abs(result.anisotropy - 1 / ratio) < 1e-12);
        }
      }
    }
  }
});

test('diagonal and nearly collinear inliers do not establish two-dimensional support', () => {
  for (const angle of [0, Math.PI / 4, 1.2]) {
    for (const thickness of [0, 0.2, 1]) {
      const points = Array.from({ length: 12 }, (_, index) => {
        const x = index * 10;
        const y = (index % 2) * thickness;
        return {
          x: 80 + Math.cos(angle) * x - Math.sin(angle) * y,
          y: 90 + Math.sin(angle) * x + Math.cos(angle) * y,
        };
      });
      const result = assessRelocalizationGeometry(fitFor([1, 0, 12], [0, 1, -7], points));
      assert.equal(result.valid, false);
      assert.match(result.reason, /two-dimensional support/);
    }
  }
});

test('both reference and query observations must supply real spatial support', () => {
  for (const side of ['reference', 'current']) {
    const fit = fitFor();
    fit.inliers.forEach((inlier, index) => {
      inlier[side] = { x: index * 12, y: index * 12 + (index % 2) * 0.1 };
    });
    assert.match(assessRelocalizationGeometry(fit).reason, /two-dimensional support/);
  }
  assert.equal(assessRelocalizationGeometry({ ...fitFor(), inliers: [] }).valid, false);
});

test('recovery rejects invalid translations, residuals and observed coordinates', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (const row of ['rowX', 'rowY']) {
      const fit = fitFor();
      fit.transform[row][2] = invalid;
      assert.match(assessRelocalizationGeometry(fit).reason, /non-finite affine/);
    }
    for (const side of ['reference', 'current']) {
      const fit = fitFor();
      fit.inliers[0][side].x = invalid;
      assert.match(assessRelocalizationGeometry(fit).reason, /non-finite inlier/);
    }
  }
  for (const residual of [NaN, Infinity, -1, 6]) {
    assert.equal(assessRelocalizationGeometry({ ...fitFor(), averageResidual: residual }).valid, false);
  }
});

test('rotated, translated two-dimensional support remains valid without a confidence floor', () => {
  const original = fitFor();
  const baseline = assessRelocalizationGeometry(original);
  assert.equal(baseline.valid, true);
  for (const angle of [0.2, 0.8, 1.6]) {
    const fit = fitFor();
    fit.transform.rowX[2] = Math.cos(angle) * 12 + Math.sin(angle) * 7;
    fit.transform.rowY[2] = Math.sin(angle) * 12 - Math.cos(angle) * 7;
    for (const inlier of fit.inliers) {
      for (const side of ['reference', 'current']) {
        const { x, y } = inlier[side];
        inlier[side] = {
          x: 10_000 + Math.cos(angle) * x - Math.sin(angle) * y,
          y: -10_000 + Math.sin(angle) * x + Math.cos(angle) * y,
        };
      }
    }
    const result = assessRelocalizationGeometry(fit);
    assert.equal(result.valid, true, result.reason);
    assert.ok(Math.abs(result.referenceMinorSpread - baseline.referenceMinorSpread) < 1e-9);
    assert.ok(Math.abs(result.queryMinorSpread - baseline.queryMinorSpread) < 1e-9);
  }
});
