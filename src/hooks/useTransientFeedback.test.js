import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransientFeedbackStore } from './useTransientFeedback.js';

const createScheduler = () => {
  let callback = null;
  const cancelled = [];
  return {
    schedule: (nextCallback, durationMs) => {
      callback = nextCallback;
      assert.equal(durationMs, 25);
      return 7;
    },
    cancel: (timeoutId) => {
      cancelled.push(timeoutId);
    },
    expire: () => callback(),
    cancelled,
  };
};

test('transient feedback replaces pending messages and clears exactly on expiry', () => {
  const scheduler = createScheduler();
  const store = createTransientFeedbackStore({
    durationMs: 25,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications++;
  });

  store.show('Preparing vision', 'warn');
  assert.deepEqual(store.getSnapshot(), { message: 'Preparing vision', severity: 'warn' });

  store.show('Ready', 'good');
  assert.deepEqual(store.getSnapshot(), { message: 'Ready', severity: 'good' });
  assert.deepEqual(scheduler.cancelled, [7]);

  scheduler.expire();
  assert.equal(store.getSnapshot(), null);
  assert.equal(notifications, 3);
  unsubscribe();
});

test('transient feedback rejects ambiguous messages, severities, and scheduling contracts', () => {
  assert.throws(() => createTransientFeedbackStore({ durationMs: 0 }), /positive finite number/);
  assert.throws(() => createTransientFeedbackStore({ schedule: null }), /callable schedule/);

  const store = createTransientFeedbackStore();
  assert.throws(() => store.subscribe(null), /subscriber must be a function/);
  assert.throws(() => store.show('', 'info'), /non-empty string/);
  assert.throws(() => store.show('Message', 'unknown'), /Unsupported feedback severity/);
});
