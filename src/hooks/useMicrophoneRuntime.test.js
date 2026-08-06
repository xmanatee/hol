import test from 'node:test';
import assert from 'node:assert/strict';

import { createMicrophoneTelemetryStore } from './useMicrophoneRuntime.js';

const createManualScheduler = () => {
  let callback = null;

  return {
    schedule: (nextCallback) => {
      assert.equal(callback, null, 'microphone store scheduled more than one flush');
      callback = nextCallback;
      return () => {
        callback = null;
      };
    },
    hasPendingTask: () => callback !== null,
    run: () => {
      assert.notEqual(callback, null, 'microphone store did not schedule a flush');
      const scheduledCallback = callback;
      callback = null;
      scheduledCallback();
    },
  };
};

test('microphone telemetry publishes changing lip-sync data without lifecycle state', () => {
  const scheduler = createManualScheduler();
  const store = createMicrophoneTelemetryStore(scheduler.schedule);
  const snapshots = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));

  const sourceSnapshot = {
    currentViseme: 'A',
    audioEnergy: 0.72,
    isVoiceActive: true,
    microphoneActive: true,
  };
  store.publish(sourceSnapshot);
  store.publish(sourceSnapshot);

  assert.equal(snapshots.length, 0);
  assert.equal(scheduler.hasPendingTask(), true);
  scheduler.run();
  assert.deepEqual(store.getSnapshot(), {
    currentViseme: 'A',
    audioEnergy: 0.72,
    voiceActive: true,
  });
  assert.equal(snapshots.length, 1);

  store.reset();
  assert.deepEqual(store.getSnapshot(), {
    currentViseme: 'M',
    audioEnergy: 0,
    voiceActive: false,
  });
  assert.equal(snapshots.length, 2);
  unsubscribe();
});

test('microphone telemetry keeps its latest snapshot without notifying removed consumers', () => {
  const store = createMicrophoneTelemetryStore();
  let publicationCount = 0;
  const unsubscribe = store.subscribe(() => publicationCount++);
  unsubscribe();

  store.publish({
    currentViseme: 'O',
    audioEnergy: 0.4,
    isVoiceActive: true,
    microphoneActive: true,
  });

  assert.equal(publicationCount, 0);
  const unsubscribeNext = store.subscribe(() => publicationCount++);
  assert.equal(store.getSnapshot().currentViseme, 'O');
  unsubscribeNext();
});

test('microphone telemetry cancels idle publication and promotes pending data for the next subscriber', () => {
  const scheduler = createManualScheduler();
  const store = createMicrophoneTelemetryStore(scheduler.schedule);
  const unsubscribe = store.subscribe(() => {});

  store.publish({
    currentViseme: 'U',
    audioEnergy: 0.58,
    isVoiceActive: true,
  });
  assert.equal(scheduler.hasPendingTask(), true);
  unsubscribe();

  assert.equal(scheduler.hasPendingTask(), false);
  assert.equal(store.getSnapshot().currentViseme, 'M');

  const unsubscribeNext = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), {
    currentViseme: 'U',
    audioEnergy: 0.58,
    voiceActive: true,
  });
  unsubscribeNext();
});
