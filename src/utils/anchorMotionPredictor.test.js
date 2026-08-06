import test from 'node:test';
import assert from 'node:assert/strict';

import { AnchorMotionPredictor } from './anchorMotionPredictor.js';

const FRAME_INTERVAL_MS = 1000 / 30;
const UPDATE_INTERVAL_MS = 1000 / 15;

test('anchor motion predictor rejects invalid motion budgets', () => {
  assert.throws(() => new AnchorMotionPredictor({ maxPredictionAgeMs: 0 }), /positive/);
  assert.throws(
    () => new AnchorMotionPredictor({ maxPresentationSpeedPxPerMs: Number.POSITIVE_INFINITY }),
    /positive/,
  );
  assert.throws(() => new AnchorMotionPredictor({ maxPresentationStepPx: -1 }), /positive/);
});

test('anchor motion predictor fills held frames with bounded constant-velocity motion', () => {
  const predictor = new AnchorMotionPredictor();

  predictor.observe({ x: 0, y: 20, z: 0 }, 0);
  assert.deepEqual(predictor.project(0), { x: 0, y: 20, z: 0 });
  assert.deepEqual(predictor.project(FRAME_INTERVAL_MS), { x: 0, y: 20, z: 0 });

  predictor.observe({ x: 12, y: 20, z: 0 }, UPDATE_INTERVAL_MS);
  assert.deepEqual(predictor.project(UPDATE_INTERVAL_MS), { x: 12, y: 20, z: 0 });
  assert.ok(Math.abs(predictor.project(UPDATE_INTERVAL_MS + FRAME_INTERVAL_MS).x - 18) < 1e-9);

  predictor.observe({ x: 24, y: 20, z: 0 }, UPDATE_INTERVAL_MS * 2);
  assert.ok(Math.abs(predictor.project(UPDATE_INTERVAL_MS * 2).x - 24) < 1e-9);
});

test('anchor motion predictor caps speed, per-frame displacement, and prediction age', () => {
  const predictor = new AnchorMotionPredictor();

  predictor.observe({ x: 0, y: 0, z: 0 }, 0);
  predictor.project(0);
  predictor.observe({ x: 120, y: 0, z: 0 }, UPDATE_INTERVAL_MS);

  assert.equal(predictor.project(UPDATE_INTERVAL_MS).x, 12);
  assert.equal(predictor.project(UPDATE_INTERVAL_MS + FRAME_INTERVAL_MS).x, 24);
  assert.equal(predictor.project(UPDATE_INTERVAL_MS * 3).x, 36);
  assert.equal(predictor.project(UPDATE_INTERVAL_MS * 4).x, 48);

  const horizonPredictor = new AnchorMotionPredictor();
  horizonPredictor.observe({ x: 0, y: 0, z: 0 }, 0);
  horizonPredictor.project(0);
  horizonPredictor.observe({ x: 12, y: 0, z: 0 }, UPDATE_INTERVAL_MS);
  assert.equal(horizonPredictor.project(UPDATE_INTERVAL_MS).x, 12);
  assert.equal(horizonPredictor.project(UPDATE_INTERVAL_MS * 2).x, 24);
  assert.equal(horizonPredictor.project(UPDATE_INTERVAL_MS * 3).x, 24);
});

test('anchor motion predictor resets identity and rejects non-monotonic samples', () => {
  const predictor = new AnchorMotionPredictor();
  predictor.observe({ x: 4, y: 5, z: 0 }, 10);

  assert.throws(() => predictor.observe({ x: 5, y: 5, z: 0 }, 10), /increase/);
  predictor.reset();

  assert.equal(predictor.project(20), null);
  predictor.observe({ x: 30, y: 40, z: 0 }, 20);
  assert.deepEqual(predictor.project(20), { x: 30, y: 40, z: 0 });
});
