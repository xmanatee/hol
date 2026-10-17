import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverMatchedKeyframe, selectRelocalizationResult } from './relocalizationConsensus.js';

const keyframe = { id: 7, anchorPoint: { x: 70, y: 65 } };
const observationsFor = (sx, sy) =>
  Array.from({ length: 24 }, (_, id) => {
    const reference = { x: 20 + (id % 6) * 24, y: 20 + Math.floor(id / 6) * 30 };
    return {
      id,
      reference,
      current: { x: sx * reference.x + 12, y: sy * reference.y - 7 },
      landmarkReference: { x: reference.x + 2, y: reference.y - 3 },
      referenceOffset: { x: 2, y: -3 },
      quality: 1,
      response: 0.8,
    };
  });

test('recovery uses the simpler motion model for equivalent support and restores material-point offsets', () => {
  const result = recoverMatchedKeyframe(keyframe, observationsFor(1, 1));
  assert.equal(result.success, true, result.reason);
  assert.equal(result.transform.model, 'similarity');
  assert.equal(result.keyframeId, 7);
  assert.ok(Math.hypot(result.anchorPoint.x - 82, result.anchorPoint.y - 58) < 1e-5);
  const match = result.inlierMatches[0];
  assert.equal(match.id, 0);
  assert.deepEqual(match.reference, { x: 22, y: 17 });
  assert.ok(Math.hypot(match.point.x - 34, match.point.y - 10) < 1e-5);
  assert.equal(match.response, 0.8);
});

test('recovery retains affine motion when anisotropic deformation earns additional support', () => {
  const result = recoverMatchedKeyframe(keyframe, observationsFor(1.8, 0.8));
  assert.equal(result.success, true, result.reason);
  assert.equal(result.transform.model, 'affine');
  assert.equal(result.inlierCount, 24);
  assert.ok(Math.abs(result.anchorPoint.x - 138) < 1e-5);
  assert.ok(Math.abs(result.anchorPoint.y - 45) < 1e-5);
});

test('failed consensus retains the actual rejection and cannot publish recovered coordinates', () => {
  const observations = observationsFor(1, 1).map((observation, index) => ({
    ...observation,
    current: { x: index * 10, y: index * 10 },
  }));
  const result = recoverMatchedKeyframe(keyframe, observations, { methodLabel: 'XFeat' });
  assert.equal(result.success, false);
  assert.match(result.reason, /^XFeat:/);
  assert.ok(result.reason.length > 'XFeat:'.length);
  assert.equal(result.anchorPoint, undefined);
  assert.equal(result.transform, undefined);
  assert.equal(result.matchCount, 24);
});

test('keyframe selection prioritizes accepted geometry over more numerous rejected matches', () => {
  const accepted = { success: true, inlierCount: 8, inlierRatio: 0.8, averageResidual: 1 };
  const rejected = { success: false, inlierCount: 40, matchCount: 50, reason: 'Collapsed geometry' };
  assert.equal(selectRelocalizationResult([rejected, accepted]), accepted);
  assert.equal(selectRelocalizationResult([]), null);
  const unsupported = { success: false, inlierCount: 0, matchCount: 5, reason: 'No consensus' };
  assert.equal(selectRelocalizationResult([unsupported, rejected]), rejected);
});
