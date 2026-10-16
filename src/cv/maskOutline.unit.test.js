import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createObjectSupportMask,
  createObjectSupportMaskPreview,
  isPointInsideObjectSupport,
} from './objectSupportMask.js';

const makeMask = (width, height, contains) =>
  createObjectSupportMask({
    width,
    height,
    data: Uint8Array.from({ length: width * height }, (_, index) =>
      contains(index % width, Math.floor(index / width)) ? 255 : 0,
    ),
    source: 'interactive-segmenter',
    confidence: 0.9,
    referencePoint: { x: 0, y: 0 },
    createdAtFrame: 0,
    updatedAtFrame: 0,
  });

test('outline walks the entire silhouette in order, rather than accidentally sampling a few boundary pixels', () => {
  const mask = makeMask(80, 60, (x, y) => x >= 7 && x <= 72 && y >= 5 && y <= 54);
  const preview = createObjectSupportMaskPreview(mask, { maxPoints: 300 });
  assert.equal(preview.points.length, 2 * (65 + 49));
  for (let index = 0; index < preview.points.length; index++) {
    const current = preview.points[index];
    const next = preview.points[(index + 1) % preview.points.length];
    assert.ok(Math.max(Math.abs(next.x - current.x), Math.abs(next.y - current.y)) <= 1);
  }
  for (const corner of [
    [7, 5],
    [72, 5],
    [72, 54],
    [7, 54],
  ]) {
    assert.ok(preview.points.some(({ x, y }) => x === corner[0] && y === corner[1]));
  }
});

test('preview storage is bounded for concavity, isolated pixels, thin lines and frame-edge silhouettes', () => {
  for (const contains of [
    (x, y) => x === 20 && y === 20,
    (x) => x === 20,
    (x, y) => y === 0,
    (x, y) => x < 4 || x > 35 || y < 4,
    (x, y) => x > 2 && x < 38 && y > 2 && y < 38 && !(x > 12 && x < 28 && y > 15),
  ]) {
    const mask = makeMask(40, 40, contains);
    for (const maxPoints of [4, 16, 180]) {
      const preview = createObjectSupportMaskPreview(mask, { maxPoints });
      assert.ok(preview.points.length > 0 && preview.points.length <= maxPoints);
      assert.ok(preview.points.every((point) => isPointInsideObjectSupport(mask, point)));
    }
  }
  const empty = makeMask(40, 40, () => false);
  assert.deepEqual(createObjectSupportMaskPreview(empty).points, []);
  for (const maxPoints of [0, 1, 2.5, NaN]) {
    assert.throws(() => createObjectSupportMaskPreview(empty, { maxPoints }), /four points/);
  }
});
