import test from 'node:test';
import assert from 'node:assert/strict';

import { DemandRenderScheduler } from './overlayRenderScheduler.js';

test('overlay demand scheduler stops invalidating after its morph-settle window', () => {
  let now = 0;
  let invalidations = 0;
  let nextFrameId = 1;
  const callbacks = new Map();
  const scheduler = new DemandRenderScheduler({
    invalidate: () => {
      invalidations++;
    },
    requestFrame: (callback) => {
      const id = nextFrameId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame: (id) => callbacks.delete(id),
    now: () => now,
    settleDurationMs: 50,
  });

  scheduler.setActive(true);
  for (const timestamp of [0, 16, 32]) {
    now = timestamp;
    const [id, callback] = callbacks.entries().next().value;
    callbacks.delete(id);
    callback(timestamp);
  }
  scheduler.setActive(false);
  for (const timestamp of [48, 64, 80, 96]) {
    now = timestamp;
    const entry = callbacks.entries().next().value;
    if (!entry) break;
    const [id, callback] = entry;
    callbacks.delete(id);
    callback(timestamp);
  }

  const settledInvalidations = invalidations;
  assert.equal(callbacks.size, 0);
  for (let frame = 0; frame < 120; frame++) {
    now += 16;
  }
  assert.equal(invalidations, settledInvalidations);
});

test('overlay demand scheduler cancels its owned frame on disposal', () => {
  const cancelled = [];
  const scheduler = new DemandRenderScheduler({
    invalidate: () => {},
    requestFrame: () => 42,
    cancelFrame: (id) => cancelled.push(id),
    now: () => 0,
  });

  scheduler.setActive(true);
  scheduler.dispose();

  assert.deepEqual(cancelled, [42]);
});
