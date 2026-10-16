import test from 'node:test';
import assert from 'node:assert/strict';

import { ANCHOR_TRACKING_INTERVAL_MS, isObjectObservationFresh, shouldRunTimedStep } from './cvScheduling.js';

test('object observations expire after 300 ms, never before their capture time', () => {
  for (const [capturedAt, now, expected] of [
    [0, 0, true],
    [100, 100, true],
    [100, 400, true],
    [100, 401, false],
    [100, 99, false],
    [null, 100, false],
    [undefined, 100, false],
    [NaN, 100, false],
    [Infinity, Infinity, false],
  ]) {
    assert.equal(isObjectObservationFresh(capturedAt, now), expected, `${capturedAt} at ${now}`);
  }
});

test('timed CV scheduling runs immediately before first recorded execution', () => {
  assert.equal(
    shouldRunTimedStep({
      now: 100,
      lastRunAt: 0,
      intervalMs: 250,
    }),
    true,
  );
});

test('timed CV scheduling waits until the interval elapses', () => {
  assert.equal(
    shouldRunTimedStep({
      now: 240,
      lastRunAt: 100,
      intervalMs: 250,
    }),
    false,
  );
  assert.equal(
    shouldRunTimedStep({
      now: 350,
      lastRunAt: 100,
      intervalMs: 250,
    }),
    true,
  );
});

test('timed CV scheduling admits an exact 15 Hz cadence from a 30 Hz source timeline', () => {
  let lastRunAt = 0;
  let admittedUpdates = 0;

  for (let frame = 1; frame <= 30; frame++) {
    const now = 1000 + (frame * 1000) / 30;
    if (
      shouldRunTimedStep({
        now,
        lastRunAt,
        intervalMs: ANCHOR_TRACKING_INTERVAL_MS,
      })
    ) {
      admittedUpdates++;
      lastRunAt = now;
    }
  }

  assert.equal(admittedUpdates, 15);
});
