import test from 'node:test';
import assert from 'node:assert/strict';

import { AnchorMotionPredictor } from './anchorMotionPredictor.js';
import { getRenderableAnchorOverlay } from './overlayVisibility.js';

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

test('demand presentation settles delayed observations after the extrapolation horizon', () => {
  for (const fps of [30, 60, 120]) {
    for (const deliveryAge of [0, 40, 80, 120]) {
      for (const direction of [1, -1]) {
        const predictor = new AnchorMotionPredictor();
        predictor.observe({ x: 0, y: 0, z: 0 }, 0);
        let position = predictor.project(0);
        assert.equal(predictor.needsRender, true);
        predictor.observe({ x: 21.6 * direction, y: 28.8 * direction, z: 0 }, 100);
        let now = 100 + deliveryAge;
        let previousTime = 0;
        let frames = 0;
        do {
          const previous = position;
          position = predictor.project(now);
          const step = Math.hypot(position.x - previous.x, position.y - previous.y);
          assert.ok(step <= 12 + 1e-9);
          assert.ok(step <= 0.36 * (now - previousTime) + 1e-9);
          previousTime = now;
          now += 1000 / fps;
          assert.ok(++frames < 40, 'demand rendering must stop after settling');
        } while (predictor.needsRender);
        assert.ok(frames > 1, 'the first bounded step must not end presentation');
        assert.ok(previousTime <= 400, 'this correction must finish before observation expiry');
        // Extrapolation is still capped at 24 px, even while delivery correction continues.
        assert.ok(Math.abs(position.x - 36 * direction) < 1e-9);
        assert.ok(Math.abs(position.y - 48 * direction) < 1e-9);
        assert.deepEqual(predictor.project(now + 1000), position);
        assert.equal(predictor.needsRender, false);
      }
    }
  }
});

test('demand presentation expires from capture time even while correcting a late observation', () => {
  const predictor = new AnchorMotionPredictor();
  predictor.observe({ x: 0, y: 0, z: 0 }, 0);
  predictor.project(0);
  predictor.observe({ x: 120, y: 0, z: 0 }, 100);
  const state = {
    sampledAt: 100,
    activeAnchor: { id: 'subject' },
    anchorState: { metrics: { poseModel: 'object-pose', targetPresent: true } },
  };
  let position;
  for (let now = 350; now <= 400; now += 10) {
    assert.equal(getRenderableAnchorOverlay(state, now), state.activeAnchor);
    position = predictor.project(now);
    assert.equal(predictor.needsRender, true);
  }
  assert.ok(position.x < 120, 'a large correction can still be unfinished at expiry');
  assert.equal(getRenderableAnchorOverlay(state, 401), null);
  predictor.reset();
  assert.equal(predictor.needsRender, false);
  assert.equal(predictor.project(401), null);
  predictor.observe({ x: -30, y: 40, z: 0 }, 500);
  assert.deepEqual(predictor.project(500), { x: -30, y: 40, z: 0 });
  assert.equal(predictor.needsRender, true);
  assert.deepEqual(predictor.project(600), { x: -30, y: 40, z: 0 });
  assert.equal(predictor.needsRender, false);
});

test('new stationary and reversing observations replace an unfinished presentation target', () => {
  for (const [nextX, expectedX] of [
    [120, 120],
    [0, -24],
  ]) {
    const predictor = new AnchorMotionPredictor();
    predictor.observe({ x: 0, y: 0, z: 0 }, 0);
    predictor.project(0);
    predictor.observe({ x: 120, y: 0, z: 0 }, 100);
    assert.equal(predictor.project(200).x, 12);
    assert.equal(predictor.needsRender, true);
    assert.equal(predictor.project(200).x, 12);
    predictor.observe({ x: nextX, y: 0, z: 0 }, 150);
    let position;
    let now = 220;
    do {
      position = predictor.project(now);
      now += 1000 / 60;
      assert.ok(now < 1000);
    } while (predictor.needsRender);
    assert.ok(Math.abs(position.x - expectedX) < 1e-9);
    assert.deepEqual(predictor.project(now + 1000), position);
  }
});
