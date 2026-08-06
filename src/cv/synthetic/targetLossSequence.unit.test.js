import test from 'node:test';
import assert from 'node:assert/strict';

import { createFullLossReentrySequence } from './targetLossSequence.js';

test('full-loss replay renders a deterministic decoy-only gap and distant re-entry', () => {
  const create = () =>
    createFullLossReentrySequence({
      frameCount: 36,
      backgroundVariant: 'window',
      backgroundSeed: 4091,
    });
  const first = create();
  const repeated = create();
  const absentFrames = first.frames.filter((frame) => frame.targetVisible === false);
  const decoyFrames = absentFrames.filter((frame) => frame.decoyBoundingBox);
  const lastVisibleBeforeLoss = first.frames[9];
  const firstReentry = first.frames[22];
  const decoy = first.frames[14];
  const source = first.frames[0];

  assert.equal(first.frames.length, 36);
  assert.deepEqual(
    absentFrames.map((_, index) => index + 10),
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  );
  assert.equal(decoyFrames.length, 8);
  assert.ok(absentFrames.every((frame) => frame.occluded === true));
  assert.ok(absentFrames.every((frame) => frame.corners.length === 0));
  assert.ok(absentFrames.every((frame) => frame.objectMask.data.every((value) => value === 0)));
  let differentPixels = 0;
  const sourceX = Math.floor(source.boundingBox.x1);
  const sourceY = Math.floor(source.boundingBox.y1);
  for (let y = 0; y < decoy.decoyBoundingBox.height; y++) {
    for (let x = 0; x < decoy.decoyBoundingBox.width; x++) {
      const sourceOffset = ((sourceY + y) * source.imageData.width + sourceX + x) * 4;
      const decoyOffset =
        ((decoy.decoyBoundingBox.y1 + y) * decoy.imageData.width + decoy.decoyBoundingBox.x1 + x) * 4;
      if (
        source.imageData.data[sourceOffset] !== decoy.imageData.data[decoyOffset] ||
        source.imageData.data[sourceOffset + 1] !== decoy.imageData.data[decoyOffset + 1] ||
        source.imageData.data[sourceOffset + 2] !== decoy.imageData.data[decoyOffset + 2]
      ) {
        differentPixels++;
      }
    }
  }
  assert.ok(differentPixels > decoy.decoyBoundingBox.width * decoy.decoyBoundingBox.height * 0.35);
  assert.ok(
    Math.hypot(
      firstReentry.groundTruth.anchor.x - lastVisibleBeforeLoss.groundTruth.anchor.x,
      firstReentry.groundTruth.anchor.y - lastVisibleBeforeLoss.groundTruth.anchor.y,
    ) >= 100,
  );
  assert.deepEqual(first.frames[16].imageData.data, repeated.frames[16].imageData.data);
  assert.deepEqual(first.frames[22].groundTruth, repeated.frames[22].groundTruth);
  assert.equal(first.metadata.targetLoss.absentStartFrame, 10);
  assert.equal(first.metadata.targetLoss.reentryFrame, 22);
});
