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
          normal: { x: 0, y: 0, z: 1 },
          metrics: {
            targetPresent: true,
            poseModel: 'sparse-reconstruction',
            poseSource,
            readiness: { poseReady: true, attachmentReady: true, faceReady: true },
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

test('candidate readiness and identity changes publish immediately without exposing an active anchor', () => {
  const scheduler = createManualScheduler();
  const initial = createState({ mode: 'selection' });
  const store = createAnchorStateStore(initial, scheduler.schedule);
  const segmented = { ...initial, candidate: { id: 1, status: 'segmented' } };
  store.update(segmented);
  assert.equal(store.getSnapshot(), segmented);
  const ready = { ...initial, candidate: { id: 1, status: 'ready' } };
  store.update(ready);
  assert.equal(store.getSnapshot(), ready);
  const lost = { ...initial, candidate: { id: 1, status: 'lost' } };
  store.update(lost);
  assert.equal(store.getSnapshot(), lost);
  assert.equal(store.getSnapshot().activeAnchor, null);
  assert.equal(scheduler.tasks.length, 0);
});

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

test('missing current authorization bypasses UI throttling even when the anchor identity is unchanged', () => {
  for (const field of ['targetPresent', 'poseSource', 'readiness']) {
    const scheduler = createManualScheduler();
    const store = createAnchorStateStore(createState(), scheduler.schedule);
    store.update(createState({ x: 1 }));
    const unproven = createState({ x: 2 });
    delete unproven.anchorState.metrics[field];
    store.update(unproven);
    assert.equal(store.getSnapshot(), unproven);
    assert.equal(scheduler.tasks[0].cancelled, true);
  }
});

test('a runtime error publishes immediately even without an anchor or another state transition', () => {
  const scheduler = createManualScheduler();
  const initial = { ...createState({ mode: 'selection' }), error: null };
  const store = createAnchorStateStore(initial, scheduler.schedule);
  const failed = { ...initial, error: 'Segmentation model unavailable' };
  store.update(failed);
  assert.equal(store.getSnapshot(), failed);
  assert.equal(scheduler.tasks.length, 0);
});

test('expiry publishes immediately while a timestamp-only observation is not discarded as a duplicate', () => {
  const scheduler = createManualScheduler();
  const initial = { ...createState(), sampledAt: 100, observationExpired: false };
  const store = createAnchorStateStore(initial, scheduler.schedule);
  const refreshed = { ...initial, sampledAt: 150 };
  store.update(refreshed);
  assert.equal(store.getLatest(), refreshed);
  const expired = { ...refreshed, observationExpired: true };
  store.update(expired);
  assert.equal(store.getSnapshot(), expired);
  assert.equal(scheduler.tasks[0].cancelled, true);
  const recovered = { ...expired, sampledAt: 500, observationExpired: false };
  store.update(recovered);
  assert.equal(store.getSnapshot(), recovered);
});

test('anchor state store coalesces duplicate snapshots without dropping changed refresh diagnostics', () => {
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

  const refresh = {
    ...anchorState,
    segmentationRefresh: { status: 'rejected', errorMessage: 'Model unavailable' },
  };
  store.update(refresh);
  scheduler.runNext();
  assert.equal(publicationCount, 2);
  assert.equal(store.getSnapshot().segmentationRefresh.errorMessage, 'Model unavailable');
});
