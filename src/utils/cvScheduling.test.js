import test from 'node:test';
import assert from 'node:assert/strict';

import { ANCHOR_TRACKING_INTERVAL_MS, shouldRunTimedStep } from './cvScheduling.js';

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
