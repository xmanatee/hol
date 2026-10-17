import test from 'node:test';
import assert from 'node:assert/strict';
import { normalForSurfaceModel, pointForSurfaceModel } from './anchor.parametricGeometry.js';
import { createObjectSupportMask, evaluateObjectSupportContinuity } from './objectSupportMask.js';

test('cylinder reference pixels recover the actual visible circular cross-section and material normal', () => {
  const radius = 70;
  const bounds = { min: { x: 30, y: 20 }, max: { x: 170, y: 220 } };
  // Independently project material points on a circle under the declared weak-perspective prior.
  for (const angle of [-1.5, -1, -0.6, 0, 0.6, 1, 1.5]) {
    const reference = { x: 100 + radius * Math.sin(angle), y: 85 };
    const point = pointForSurfaceModel(reference, bounds, 'cylinder');
    const normal = normalForSurfaceModel(reference, bounds, 'cylinder');
    assert.ok(Math.abs(point.x - radius * Math.sin(angle)) < 1e-9);
    assert.ok(Math.abs(point.y + 35) < 1e-9);
    assert.ok(Math.abs(point.z - radius * (Math.cos(angle) - 1)) < 1e-9);
    assert.ok(Math.abs(normal.x - Math.sin(angle)) < 1e-9);
    assert.ok(Math.abs(normal.z - Math.cos(angle)) < 1e-9);
  }
});

test('tapered surface normals agree with the surface derivative, including its axial component', () => {
  const bounds = { min: { x: 0, y: 0 }, max: { x: 120, y: 240 } };
  for (const reference of [
    { x: 35, y: 50 },
    { x: 60, y: 120 },
    { x: 90, y: 190 },
  ]) {
    const normal = normalForSurfaceModel(reference, bounds, 'tapered-cylinder');
    const point = pointForSurfaceModel(reference, bounds, 'tapered-cylinder');
    for (const direction of [
      { x: 0.001, y: 0 },
      { x: 0, y: 0.001 },
    ]) {
      const neighbor = pointForSurfaceModel(
        { x: reference.x + direction.x, y: reference.y + direction.y },
        bounds,
        'tapered-cylinder',
      );
      const dot =
        normal.x * (neighbor.x - point.x) +
        normal.y * (neighbor.y - point.y) +
        normal.z * (neighbor.z - point.z);
      assert.ok(Math.abs(dot) < 1e-7, `normal is not perpendicular: ${dot}`);
    }
    assert.ok(Math.abs(Math.hypot(normal.x, normal.y, normal.z) - 1) < 1e-9);
    assert.ok(normal.y < 0);
  }
});

const maskFor = (scenario, { dx = 0, dy = 0, merged = false } = {}) =>
  createObjectSupportMask({
    width: 240,
    height: 180,
    data: Uint8Array.from({ length: 240 * 180 }, (_, index) => {
      const x = (index % 240) - dx;
      const y = Math.floor(index / 240) - dy;
      const body =
        scenario === 'paper'
          ? y >= 45 && y < 125 && x >= 60 + (y - 45) * 0.2 && x < 165 - (y - 45) * 0.1
          : scenario === 'bottle-label'
            ? (x >= 88 && x < 143 && y >= 55 && y < 145) || (x >= 104 && x < 126 && y >= 22 && y < 55)
            : x >= 85 && x < 145 && y >= 30 && y < 145;
      const neighbor = merged && x >= 140 && x < 215 && y >= 30 && y < 145;
      return body || neighbor ? 255 : 0;
    }),
    source: 'interactive-segmenter',
    confidence: 0.95,
    referencePoint: { x: 120 + dx, y: 90 + dy },
    createdAtFrame: 1,
  });

test('whole-object refresh tolerates small hand shake but rejects adjacent-object merges for every demo shape', () => {
  for (const scenario of ['can', 'bottle-label', 'paper']) {
    const previous = maskFor(scenario);
    for (const dx of [-3, 0, 3]) {
      for (const dy of [-3, 0, 3]) {
        assert.equal(evaluateObjectSupportContinuity(previous, maskFor(scenario, { dx, dy })).accepted, true);
      }
    }
    const merged = maskFor(scenario, { merged: true });
    assert.equal(merged.data[90 * merged.width + 120], 255, 'a merge still contains the original anchor');
    assert.deepEqual(evaluateObjectSupportContinuity(previous, merged), {
      accepted: false,
      reason: 'expanded-mask',
    });
    assert.equal(evaluateObjectSupportContinuity(previous, maskFor(scenario, { dx: 90 })).accepted, false);
    assert.equal(evaluateObjectSupportContinuity(previous, { ...previous, pixelCount: 0 }).accepted, false);
  }
  assert.equal(evaluateObjectSupportContinuity(null, maskFor('can')).accepted, false);
  assert.throws(
    () => evaluateObjectSupportContinuity(maskFor('can'), { ...maskFor('can'), width: 120 }),
    /same source raster/,
  );
});
