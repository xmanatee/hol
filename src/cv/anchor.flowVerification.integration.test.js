import test from 'node:test';
import assert from 'node:assert/strict';
import { KeypointTracker } from './anchor.tracking.js';
import { loadOpenCvForNode } from './synthetic/opencvNodeLoader.js';

const keypoints = Array.from({ length: 24 }, (_, index) => ({
  pt: { x: 55 + (index % 6) * 38, y: 55 + Math.floor(index / 6) * 38 },
  response: 1,
}));

const fillTexture = (image) => {
  let state = 1234567;
  for (let index = 0; index < image.data.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    image.data[index] = 40 + (state >>> 25);
  }
};

for (const shift of [
  { x: 3.25, y: 2.5 },
  { x: 14, y: -9 },
]) {
  test(`real bidirectional LK retains textured motion (${shift.x}, ${shift.y}) under exposure change and mild blur`, async (t) => {
    const cv = await loadOpenCvForNode();
    const tracker = new KeypointTracker();
    tracker.initialize(cv);
    t.after(() => tracker.dispose());
    const reference = tracker.acquireGrayFrame(cv);
    reference.create(240, 320, cv.CV_8UC1);
    fillTexture(reference);
    cv.GaussianBlur(reference, reference, new cv.Size(3, 3), 0.6);
    tracker.initializeTracking(cv, keypoints, reference, { tapPosition: { x: 160, y: 120 } });
    const query = tracker.acquireGrayFrame(cv);
    const transform = cv.matFromArray(2, 3, cv.CV_64F, [1, 0, shift.x, 0, 1, shift.y]);
    t.after(() => transform.delete());
    cv.warpAffine(reference, query, transform, new cv.Size(320, 240), cv.INTER_LINEAR);
    cv.GaussianBlur(query, query, new cv.Size(3, 3), 0.4);
    for (let index = 0; index < query.data.length; index++) query.data[index] = query.data[index] * 0.85 + 15;
    const result = tracker.trackFrame(cv, query);
    assert.equal(result.success, true);
    assert.ok(
      tracker
        .getCorrespondences()
        .every(({ prev, curr }) => Math.hypot(curr.x - prev.x - shift.x, curr.y - prev.y - shift.y) < 1),
    );
  });
}

test('repeated letter patches cannot authorize a one-way alias that does not return to its source', async (t) => {
  const native = await loadOpenCvForNode();
  const cv = Object.create(native);
  let calls = 0;
  cv.calcOpticalFlowPyrLK = (_previous, _current, source, destination, status, error) => {
    const forward = calls++ === 0;
    for (let index = 0; index < source.rows; index++) {
      destination.data32F[index * 2] = source.data32F[index * 2] + (forward ? 38 : 0);
      destination.data32F[index * 2 + 1] = source.data32F[index * 2 + 1];
      status.data[index] = 1;
      error.data32F[index] = 0;
    }
  };
  const tracker = new KeypointTracker();
  tracker.initialize(cv);
  t.after(() => tracker.dispose());
  const reference = tracker.acquireGrayFrame(cv);
  reference.create(240, 320, cv.CV_8UC1);
  for (let y = 0; y < 240; y++) {
    for (let x = 0; x < 320; x++) {
      const u = x % 38;
      const v = y % 38;
      const letter =
        (u >= 15 && u <= 18 && v >= 10 && v <= 28) ||
        (u >= 15 && u <= 28 && ((v >= 10 && v <= 13) || (v >= 17 && v <= 20)));
      reference.data[y * 320 + x] = letter ? 220 : 30;
    }
  }
  tracker.initializeTracking(cv, keypoints, reference, { tapPosition: { x: 160, y: 120 } });
  const query = tracker.acquireGrayFrame(cv);
  reference.copyTo(query);
  const result = tracker.trackFrame(cv, query);
  assert.equal(calls, 2, 'Matching appearance must still receive the backward check');
  assert.equal(result.success, false);
  assert.equal(result.successRate, 0);
  assert.equal(tracker.getCorrespondences().length, 0);
});

for (const corruption of ['round-trip', 'reverse-status', 'reverse-error', 'reverse-coordinate']) {
  test(`low-error forward flow cannot admit ${corruption} failures into landmark history`, async (t) => {
    const native = await loadOpenCvForNode();
    const cv = Object.create(native);
    let calls = 0;
    cv.calcOpticalFlowPyrLK = (_previous, _current, source, destination, status, error) => {
      const reverse = calls++ % 2 === 1;
      for (let index = 0; index < source.rows; index++) {
        const rejected = reverse && index >= 20;
        destination.data32F[index * 2] =
          source.data32F[index * 2] + (rejected && corruption === 'round-trip' ? 6 : 0);
        destination.data32F[index * 2 + 1] =
          rejected && corruption === 'reverse-coordinate' ? NaN : source.data32F[index * 2 + 1];
        status.data[index] = rejected && corruption === 'reverse-status' ? 0 : 1;
        error.data32F[index] = rejected && corruption === 'reverse-error' ? NaN : reverse ? 2 : 1;
      }
    };
    const tracker = new KeypointTracker();
    tracker.initialize(cv);
    t.after(() => tracker.dispose());
    const reference = tracker.acquireGrayFrame(cv);
    reference.create(240, 320, cv.CV_8UC1);
    fillTexture(reference);
    tracker.initializeTracking(cv, keypoints, reference, { tapPosition: { x: 160, y: 120 } });
    const query = tracker.acquireGrayFrame(cv);
    reference.copyTo(query);
    const result = tracker.trackFrame(cv, query);
    assert.equal(result.success, true);
    assert.equal(result.successRate, 20 / 24);
    assert.equal(result.averageError, 1, 'Reverse error must not overwrite the measured forward error');
    assert.equal(tracker.getCorrespondences().length, 20);
    assert.ok(
      tracker.trackedPoints
        .slice(20)
        .every((point) => point.successfulTrackingStreak === 0 && point.totalSuccessfulFrames === 0),
    );
  });
}

for (const appearance of ['inverted', 'blank', 'edge', 'unrelated']) {
  for (const method of ['trackCandidate', 'trackFrame']) {
    test(`${method} rejects a coherent low-error ${appearance} appearance impostor`, async (t) => {
      const native = await loadOpenCvForNode();
      const cv = Object.create(native);
      let calls = 0;
      cv.calcOpticalFlowPyrLK = (_previous, _current, source, destination, status, error) => {
        calls++;
        for (let index = 0; index < source.rows; index++) {
          destination.data32F[index * 2] = source.data32F[index * 2];
          destination.data32F[index * 2 + 1] = source.data32F[index * 2 + 1];
          status.data[index] = 1;
          error.data32F[index] = 0;
        }
      };
      const tracker = new KeypointTracker();
      tracker.initialize(cv);
      t.after(() => tracker.dispose());
      const reference = tracker.acquireGrayFrame(cv);
      reference.create(240, 320, cv.CV_8UC1);
      fillTexture(reference);
      tracker.initializeTracking(cv, keypoints, reference, { tapPosition: { x: 160, y: 120 } });
      const query = tracker.acquireGrayFrame(cv);
      query.create(240, 320, cv.CV_8UC1);
      for (let index = 0; index < query.data.length; index++) {
        query.data[index] =
          appearance === 'inverted'
            ? 255 - reference.data[index]
            : appearance === 'blank'
              ? 90
              : appearance === 'edge'
                ? (index % 320) % 38 < 17
                  ? 30
                  : 220
                : reference.data[(index + 17) % reference.data.length];
      }
      const result = tracker[method](cv, query);
      assert.equal(result.success, false);
      assert.equal(result.successRate, 0);
      assert.equal(tracker.getCorrespondences().length, 0);
      assert.ok(tracker.trackedPoints.every((point) => point.totalSuccessfulFrames === 0));
      assert.equal(calls, 1, 'Appearance rejection must not spend a reverse LK pass');
    });
  }
}
