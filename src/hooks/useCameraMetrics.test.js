import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraMetricsStore } from './useCameraMetrics.js';

const createManualScheduler = () => {
  let callback = null;
  return {
    schedule: (nextCallback) => {
      assert.equal(callback, null, 'only one publication should be pending');
      callback = nextCallback;
      return () => {
        callback = null;
      };
    },
    hasPendingTask: () => callback !== null,
    run: () => {
      assert.notEqual(callback, null, 'a publication should be pending');
      const scheduledCallback = callback;
      callback = null;
      scheduledCallback();
    },
  };
};

test('camera metrics stay idle without readers and expose the latest complete frame on subscribe', () => {
  const scheduler = createManualScheduler();
  const store = createCameraMetricsStore(scheduler.schedule);
  const idle = store.getSnapshot();
  assert.deepEqual(idle, { captureFps: null, frameWorkMs: null });
  store.recordFrame(60, 1);
  store.recordFrame(30, 2);
  assert.equal(scheduler.hasPendingTask(), false);
  let publications = 0;
  const unsubscribe = store.subscribe(() => publications++);
  assert.deepEqual(store.getSnapshot(), { captureFps: 30, frameWorkMs: 2 });
  assert.equal(store.getSnapshot(), store.getSnapshot());
  assert.deepEqual(idle, { captureFps: null, frameWorkMs: null });
  assert.equal(publications, 0);
  unsubscribe();
});

test('camera metrics coalesce complete frames without mutating a published snapshot', () => {
  const scheduler = createManualScheduler();
  const store = createCameraMetricsStore(scheduler.schedule);
  const snapshots = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
  store.recordFrame(60, 1);
  store.recordFrame(30, 2);
  scheduler.run();
  assert.deepEqual(snapshots, [{ captureFps: 30, frameWorkMs: 2 }]);
  store.recordFrame(null, 0);
  assert.equal(store.getSnapshot(), snapshots[0]);
  scheduler.run();
  assert.deepEqual(snapshots, [
    { captureFps: 30, frameWorkMs: 2 },
    { captureFps: null, frameWorkMs: 0 },
  ]);
  store.recordFrame(null, 0);
  assert.equal(scheduler.hasPendingTask(), false);
  unsubscribe();
});

test('closing diagnostics cancels publication but reopening reads the most recent frame', () => {
  const scheduler = createManualScheduler();
  const store = createCameraMetricsStore(scheduler.schedule);
  const unsubscribe = store.subscribe(() => assert.fail('closed reader was notified'));
  store.recordFrame(30, 2);
  unsubscribe();
  store.recordFrame(24, 3);
  assert.equal(scheduler.hasPendingTask(), false);
  const unsubscribeNext = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { captureFps: 24, frameWorkMs: 3 });
  unsubscribeNext();
});

test('reset clears both measurements and cancels pending work across camera sessions', () => {
  const scheduler = createManualScheduler();
  const store = createCameraMetricsStore(scheduler.schedule);
  const snapshots = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
  store.recordFrame(30, 2);
  scheduler.run();
  store.recordFrame(24, 3);
  store.reset();
  assert.equal(scheduler.hasPendingTask(), false);
  assert.deepEqual(snapshots.at(-1), { captureFps: null, frameWorkMs: null });
  store.recordFrame(null, 0);
  scheduler.run();
  assert.deepEqual(snapshots.at(-1), { captureFps: null, frameWorkMs: 0 });
  store.recordFrame(24, 1);
  const publicationCount = snapshots.length;
  store.dispose();
  assert.deepEqual(store.getSnapshot(), { captureFps: null, frameWorkMs: null });
  assert.equal(scheduler.hasPendingTask(), false);
  assert.equal(snapshots.length, publicationCount);
  unsubscribe();
});

test('camera metrics reject invalid measurements without changing or scheduling a snapshot', () => {
  const scheduler = createManualScheduler();
  const store = createCameraMetricsStore(scheduler.schedule);
  store.recordFrame(30, 1);
  const unsubscribe = store.subscribe(() => assert.fail('invalid measurements were published'));
  const snapshot = store.getSnapshot();
  for (const fps of [undefined, '30', 0, -1, NaN, Infinity]) {
    assert.throws(() => store.recordFrame(fps, 1), /capture FPS/);
  }
  for (const work of [undefined, null, '1', -1, NaN, Infinity]) {
    assert.throws(() => store.recordFrame(30, work), /frame work/);
  }
  assert.equal(store.getSnapshot(), snapshot);
  assert.equal(scheduler.hasPendingTask(), false);
  unsubscribe();
});

test('a frame recorded during publication is delivered in the next bounded publication', () => {
  const scheduler = createManualScheduler();
  const store = createCameraMetricsStore(scheduler.schedule);
  const snapshots = [];
  const unsubscribe = store.subscribe(() => {
    snapshots.push(store.getSnapshot());
    if (snapshots.length === 1) store.recordFrame(24, 3);
  });
  store.recordFrame(30, 2);
  scheduler.run();
  scheduler.run();
  assert.deepEqual(snapshots, [
    { captureFps: 30, frameWorkMs: 2 },
    { captureFps: 24, frameWorkMs: 3 },
  ]);
  unsubscribe();
});
