import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeToVideoFrames } from './useVideoFrames.js';

const createVideoFrameDriver = (initiallyVisible = true) => {
  const callbacks = new Map();
  const cancelled = [];
  let nextId = 1;
  let visible = initiallyVisible;
  const visibilityListeners = new Set();

  return {
    visibility: {
      getSnapshot: () => visible,
      subscribe: (listener) => {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
    },
    setVisible(value) {
      visible = value;
      visibilityListeners.forEach((listener) => {
        listener();
      });
    },
    videoElement: {
      requestVideoFrameCallback(callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      cancelVideoFrameCallback(id) {
        cancelled.push(id);
        callbacks.delete(id);
      },
    },
    fire(id, now, metadata) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback(now, metadata);
    },
    callbacks,
    cancelled,
  };
};

test('video frame subscription runs only for presented video frames and reports media cadence', () => {
  const driver = createVideoFrameDriver();
  const frames = [];
  const unsubscribe = subscribeToVideoFrames({
    videoElement: driver.videoElement,
    visibility: driver.visibility,
    onFrame: (frame) => {
      frames.push(frame);
      assert.equal(driver.callbacks.size, 1, 'the next frame is armed before consumer work starts');
    },
  });

  assert.deepEqual([...driver.callbacks.keys()], [1]);
  driver.fire(1, 100, { mediaTime: 2, presentedFrames: 10 });
  driver.fire(2, 133, { mediaTime: 2.033333333, presentedFrames: 11 });

  assert.equal(frames.length, 2);
  assert.equal(frames[0].captureFps, null);
  assert.ok(Math.abs(frames[1].captureFps - 30) < 0.001);
  assert.equal(frames[1].metadata.presentedFrames, 11);

  unsubscribe();
});

test('video frame subscription cancels the latest callback and ignores a late delivery', () => {
  const driver = createVideoFrameDriver();
  const frames = [];
  const unsubscribe = subscribeToVideoFrames({
    videoElement: driver.videoElement,
    visibility: driver.visibility,
    onFrame: (frame) => frames.push(frame),
  });

  driver.fire(1, 100, { mediaTime: 1, presentedFrames: 1 });
  const lateCallback = driver.callbacks.get(2);
  unsubscribe();
  lateCallback(133, { mediaTime: 1.033, presentedFrames: 2 });

  assert.deepEqual(driver.cancelled, [2]);
  assert.equal(frames.length, 1);
  assert.equal(driver.callbacks.size, 0);
});

test('video frame subscription rejects browsers without the standard callback pair', () => {
  assert.throws(
    () => subscribeToVideoFrames({ videoElement: {}, onFrame: () => {} }),
    /Video frame callbacks are not supported/,
  );
});

test('hidden video subscriptions cancel queued work and resume only new callbacks with fresh cadence', () => {
  const driver = createVideoFrameDriver();
  const frames = [];
  const unsubscribe = subscribeToVideoFrames({
    videoElement: driver.videoElement,
    visibility: driver.visibility,
    onFrame: (frame) => frames.push(frame),
  });
  driver.fire(1, 100, { mediaTime: 1 });
  const retiredCallback = driver.callbacks.get(2);
  driver.setVisible(false);
  assert.equal(driver.callbacks.size, 0);
  retiredCallback(120, { mediaTime: 1.02 });
  assert.equal(frames.length, 1);
  driver.setVisible(true);
  retiredCallback(140, { mediaTime: 1.04 });
  assert.equal(frames.length, 1, 'a pre-hide callback cannot run after resume');
  assert.equal(driver.callbacks.size, 1);
  driver.fire(3, 2000, { mediaTime: 3 });
  assert.equal(frames.at(-1).captureFps, null, 'hidden time is not a camera cadence sample');
  driver.fire(4, 2033, { mediaTime: 3 + 1 / 30 });
  assert.ok(Math.abs(frames.at(-1).captureFps - 30) < 0.001);
  unsubscribe();
  driver.setVisible(false);
  driver.setVisible(true);
  assert.equal(driver.callbacks.size, 0, 'cleanup also removes the visibility subscription');
});

test('a subscription created while hidden waits for visibility before requesting its first frame', () => {
  const driver = createVideoFrameDriver(false);
  const unsubscribe = subscribeToVideoFrames({
    videoElement: driver.videoElement,
    visibility: driver.visibility,
    onFrame: () => {},
  });
  assert.equal(driver.callbacks.size, 0);
  driver.setVisible(true);
  assert.equal(driver.callbacks.size, 1);
  driver.setVisible(false);
  unsubscribe();
  assert.equal(driver.callbacks.size, 0);
});
