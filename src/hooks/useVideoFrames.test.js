import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeToVideoFrames } from './useVideoFrames.js';

const createVideoFrameDriver = () => {
  const callbacks = new Map();
  const cancelled = [];
  let nextId = 1;

  return {
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
