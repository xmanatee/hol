import test from 'node:test';
import assert from 'node:assert/strict';

import { createHudMetricStore } from './useHudMetrics.js';

const createManualScheduler = () => {
  let callback = null;

  return {
    schedule: (nextCallback) => {
      assert.equal(callback, null, 'metric store scheduled more than one flush');
      callback = nextCallback;
      return () => {
        callback = null;
      };
    },
    hasPendingTask: () => callback !== null,
    run: () => {
      assert.notEqual(callback, null, 'metric store did not schedule a flush');
      const scheduledCallback = callback;
      callback = null;
      scheduledCallback();
    },
  };
};

test('HUD metric store stays idle without subscribers and exposes the latest values on subscribe', () => {
  const scheduler = createManualScheduler();
  const store = createHudMetricStore(scheduler.schedule);
  const snapshots = [];

  store.updateMetric('Capture FPS', 55);
  store.updateMetric('Anchor processing time', 5);
  store.updateMetric('Capture FPS', 48);

  assert.equal(store.hasSubscribers(), false);
  assert.equal(scheduler.hasPendingTask(), false);
  const unsubscribe = store.subscribe((snapshot) => snapshots.push(snapshot));
  assert.equal(store.hasSubscribers(), true);
  assert.equal(store.getSnapshot()['Capture FPS'].value, 48);
  assert.equal(store.getSnapshot()['Anchor processing time'].value, 5);
  assert.equal(snapshots.length, 0);

  store.updateMetric('Capture FPS', 47);
  store.updateMetric('Anchor processing time', 4);
  assert.equal(scheduler.hasPendingTask(), true);
  assert.equal(snapshots.length, 0);

  scheduler.run();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]['Capture FPS'].value, 47);
  assert.equal(snapshots[0]['Anchor processing time'].value, 4);
  unsubscribe();
  assert.equal(store.hasSubscribers(), false);
});

test('HUD metric store does not schedule or publish unchanged values', () => {
  const scheduler = createManualScheduler();
  const store = createHudMetricStore(scheduler.schedule);
  let publicationCount = 0;
  const unsubscribe = store.subscribe(() => publicationCount++);

  store.updateMetric('Object Count', 1);
  scheduler.run();
  store.updateMetric('Object Count', 1);

  assert.equal(scheduler.hasPendingTask(), false);
  assert.equal(publicationCount, 1);
  unsubscribe();
});

test('HUD metric store cancels idle publication while retaining pending values for the next subscriber', () => {
  const scheduler = createManualScheduler();
  const store = createHudMetricStore(scheduler.schedule);
  const unsubscribe = store.subscribe(() => {});

  store.updateMetric('Object Count', 1);
  assert.equal(scheduler.hasPendingTask(), true);
  unsubscribe();

  assert.equal(scheduler.hasPendingTask(), false);
  assert.equal(store.getSnapshot()['Object Count'], undefined);

  const unsubscribeNext = store.subscribe(() => {});
  assert.equal(store.getSnapshot()['Object Count'].value, 1);
  unsubscribeNext();
});
