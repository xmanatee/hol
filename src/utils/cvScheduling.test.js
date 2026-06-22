import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldRunTimedStep } from './cvScheduling.js';

test('timed CV scheduling runs immediately before first recorded execution', () => {
  assert.equal(shouldRunTimedStep({
    now: 100,
    lastRunAt: 0,
    intervalMs: 250,
  }), true);
});

test('timed CV scheduling waits until the interval elapses', () => {
  assert.equal(shouldRunTimedStep({
    now: 240,
    lastRunAt: 100,
    intervalMs: 250,
  }), false);
  assert.equal(shouldRunTimedStep({
    now: 350,
    lastRunAt: 100,
    intervalMs: 250,
  }), true);
});
