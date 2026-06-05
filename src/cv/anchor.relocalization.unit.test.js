import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchKeyframeRelocalizer } from './anchor.relocalization.js';

const descriptorFor = index => {
  const values = Array.from({ length: 16 }, (_, channel) => ((index + 1) * (channel + 3)) % 23 / 23);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map(value => value - mean);
  const norm = Math.hypot(...centered) || 1;
  return centered.map(value => value / norm);
};

const transformPoint = (point, transform) => {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.tx + transform.scale * (cos * point.x - sin * point.y),
    y: transform.ty + transform.scale * (sin * point.x + cos * point.y),
  };
};

test('patch keyframe relocalizer recovers a similarity transform from descriptor matches with outliers', () => {
  const relocalizer = new PatchKeyframeRelocalizer({
    minMatches: 8,
    minInliers: 8,
    ratioThreshold: 0.72,
    inlierThreshold: 3.5,
  });
  const transform = {
    tx: 38,
    ty: -19,
    scale: 1.28,
    rotation: 24 * Math.PI / 180,
  };

  const referenceEntries = Array.from({ length: 18 }, (_, index) => ({
    id: index,
    reference: {
      x: 80 + (index % 6) * 22,
      y: 70 + Math.floor(index / 6) * 24,
    },
    descriptor: descriptorFor(index),
    response: 1,
  }));

  relocalizer.setKeyframeEntries(referenceEntries);

  const queryEntries = [
    ...referenceEntries.map(entry => ({
      point: transformPoint(entry.reference, transform),
      descriptor: entry.descriptor,
      response: 1,
    })).reverse(),
    ...Array.from({ length: 12 }, (_, index) => ({
      point: { x: 240 + index * 3, y: 40 + index * 5 },
      descriptor: descriptorFor(index + 50),
      response: 0.2,
    })),
  ];

  const result = relocalizer.relocalizeEntries(queryEntries);

  assert.equal(result.success, true);
  assert.ok(Math.abs(result.transform.tx - transform.tx) < 1.2);
  assert.ok(Math.abs(result.transform.ty - transform.ty) < 1.2);
  assert.ok(Math.abs(result.transform.scale - transform.scale) < 0.04);
  assert.ok(Math.abs(result.transform.rotation - transform.rotation) < 0.04);
  assert.ok(result.inlierIds.length >= 14);
});

test('patch keyframe relocalizer rejects ambiguous descriptor matches', () => {
  const relocalizer = new PatchKeyframeRelocalizer({
    minMatches: 4,
    minInliers: 4,
    ratioThreshold: 0.7,
  });
  const sharedDescriptor = descriptorFor(2);
  relocalizer.setKeyframeEntries(Array.from({ length: 8 }, (_, index) => ({
    id: index,
    reference: { x: 20 + index * 8, y: 40 },
    descriptor: sharedDescriptor,
    response: 1,
  })));

  const result = relocalizer.relocalizeEntries(Array.from({ length: 8 }, (_, index) => ({
    point: { x: 50 + index * 8, y: 62 },
    descriptor: sharedDescriptor,
    response: 1,
  })));

  assert.equal(result.success, false);
  assert.match(result.reason, /matches/i);
});
