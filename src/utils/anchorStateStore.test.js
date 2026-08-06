import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnchorStateStore } from './anchorStateStore.js';

const createState = ({ mode = 'anchor', createdAt = 1, x = 0, poseSource = 'planar-homography' } = {}) => ({
  mode,
  activeAnchor: mode === 'anchor' ? { createdAt, position: { x, y: 20 } } : null,
  anchorState:
    mode === 'anchor'
      ? {
          anchored: true,
          state: 'tracking',
          position: { x, y: 20 },
          metrics: {
            poseModel: 'sparse-reconstruction',
            poseSource,
          },
        }
      : null,
  trackingMode: 'sparse-reconstruction',
  initialized: true,
});

const createManualScheduler = () => {
  const tasks = [];
  return {
    schedule(callback) {
      const task = { callback, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    runNext() {
      const task = tasks.shift();
      if (task && !task.cancelled) {
        task.callback();
      }
    },
    tasks,
  };
};

test('anchor state store exposes live pose immediately and coalesces UI snapshots', () => {
  const scheduler = createManualScheduler();
  const initialState = createState({ x: 10 });
  const store = createAnchorStateStore(initialState, scheduler.schedule);
  const snapshots = [];
  store.subscribe(() => snapshots.push(store.getSnapshot()));

  store.update(createState({ x: 11 }));
  store.update(createState({ x: 12 }));

  assert.equal(store.getLatest().anchorState.position.x, 12);
  assert.equal(store.getSnapshot().anchorState.position.x, 10);
  assert.equal(scheduler.tasks.length, 1);
  assert.equal(snapshots.length, 0);

  scheduler.runNext();

  assert.equal(store.getSnapshot().anchorState.position.x, 12);
  assert.equal(snapshots.length, 1);
});

test('anchor state store publishes every live pose without forcing React snapshots', () => {
  const scheduler = createManualScheduler();
  const store = createAnchorStateStore(createState({ x: 10 }), scheduler.schedule);
  const liveStates = [];
  const removeLiveListener = store.subscribeLatest((state) => liveStates.push(state));

  store.update(createState({ x: 11 }));
  store.update(createState({ x: 12 }));

  assert.deepEqual(
    liveStates.map((state) => state.anchorState.position.x),
    [11, 12],
  );
  assert.equal(store.getSnapshot().anchorState.position.x, 10);

  removeLiveListener();
  store.update(createState({ x: 13 }));
  assert.equal(liveStates.length, 2);
});

test('anchor state store publishes structural and visibility transitions immediately', () => {
  const scheduler = createManualScheduler();
  const store = createAnchorStateStore(createState({ x: 10 }), scheduler.schedule);
  const snapshots = [];
  store.subscribe(() => snapshots.push(store.getSnapshot()));

  store.update(createState({ x: 11 }));
  store.update(createState({ x: 12, poseSource: null }));

  assert.equal(store.getSnapshot().anchorState.position.x, 12);
  assert.equal(snapshots.length, 1);
  assert.equal(scheduler.tasks[0].cancelled, true);

  store.update(createState({ mode: 'selection' }));

  assert.equal(store.getSnapshot().mode, 'selection');
  assert.equal(snapshots.length, 2);
});

test('anchor state store disposal cancels pending UI publication', () => {
  const scheduler = createManualScheduler();
  const store = createAnchorStateStore(createState({ x: 10 }), scheduler.schedule);
  let publicationCount = 0;
  store.subscribe(() => publicationCount++);

  store.update(createState({ x: 11 }));
  store.dispose();
  scheduler.runNext();

  assert.equal(publicationCount, 0);
});

test('anchor state store ignores duplicate wrappers around the same service state', () => {
  const scheduler = createManualScheduler();
  const initialState = createState({ mode: 'selection' });
  const store = createAnchorStateStore(initialState, scheduler.schedule);
  const anchorState = createState({ x: 10 });
  let publicationCount = 0;
  store.subscribe(() => publicationCount++);

  store.update(anchorState);
  store.update({ ...anchorState });

  assert.equal(publicationCount, 1);
  assert.equal(scheduler.tasks.length, 0);
});
