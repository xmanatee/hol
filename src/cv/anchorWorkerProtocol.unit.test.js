import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnchorWorkerMessageHandler, createAnchorWorkerSnapshot } from './anchorWorkerProtocol.js';

const createWorkerState = () => {
  const objectSupportMask = {
    width: 1280,
    height: 720,
    data: new Uint8Array(1280 * 720),
    source: 'interactive-segmenter',
    confidence: 0.91,
    referencePoint: { x: 640, y: 360 },
    bbox: { x: 400, y: 220, width: 480, height: 310 },
  };

  return {
    mode: 'anchor',
    activeAnchor: {
      createdAt: 12,
      position: { x: 640, y: 360, z: 0 },
      selectionRegion: {
        surfaceHint: 'cup',
        confidence: 0.88,
        x1: 400,
        y1: 220,
        x2: 880,
        y2: 530,
        objectSupportMask,
      },
    },
    anchorState: {
      anchored: true,
      state: 'tracking',
      metrics: {
        currentObjectSupportMaskPreview: {
          bbox: objectSupportMask.bbox,
          points: [{ x: 400, y: 220 }],
        },
      },
    },
    trackingMode: 'sparse-reconstruction',
    initialized: true,
  };
};

test('anchor worker snapshots keep UI mask evidence without cloning worker-owned mask pixels', () => {
  const state = createWorkerState();
  const sourceMask = state.activeAnchor.selectionRegion.objectSupportMask;
  const snapshot = createAnchorWorkerSnapshot(state);
  const snapshotMask = snapshot.activeAnchor.selectionRegion.objectSupportMask;

  assert.equal(sourceMask.data.byteLength, 1280 * 720);
  assert.equal('data' in snapshotMask, false);
  assert.deepEqual(snapshotMask.bbox, sourceMask.bbox);
  assert.equal(snapshotMask.source, 'interactive-segmenter');
  assert.equal(snapshot.activeAnchor.selectionRegion.surfaceHint, 'cup');
  assert.deepEqual(snapshot.anchorState.metrics.currentObjectSupportMaskPreview.points, [{ x: 400, y: 220 }]);
});

test('anchor worker protocol emits one response with the post-command snapshot', async () => {
  const state = createWorkerState();
  const messages = [];
  const onMessage = createAnchorWorkerMessageHandler({
    handlers: {
      processFrame: ({ frameIndex }) => {
        state.anchorState.metrics.frameIndex = frameIndex;
        return { success: true };
      },
    },
    getState: () => state,
    postMessage: (message) => messages.push(message),
  });

  await onMessage({
    data: {
      id: 7,
      command: 'processFrame',
      payload: { frameIndex: 42 },
    },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'response');
  assert.equal(messages[0].id, 7);
  assert.deepEqual(messages[0].result, { success: true });
  assert.equal(messages[0].state.anchorState.metrics.frameIndex, 42);
  assert.equal('data' in messages[0].state.activeAnchor.selectionRegion.objectSupportMask, false);
});

test('anchor worker protocol reports failures through the same single response channel', async () => {
  const messages = [];
  const onMessage = createAnchorWorkerMessageHandler({
    handlers: {
      processFrame: () => {
        throw new Error('tracking failed');
      },
    },
    getState: () => createWorkerState(),
    postMessage: (message) => messages.push(message),
  });

  await onMessage({ data: { id: 9, command: 'processFrame', payload: {} } });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 9);
  assert.equal(messages[0].error, 'tracking failed');
  assert.equal(messages[0].state.anchorState.state, 'tracking');
});

test('anchor worker protocol serializes every state mutation in arrival order', async () => {
  let releaseFirstCommand;
  const calls = [];
  const messages = [];
  const onMessage = createAnchorWorkerMessageHandler({
    handlers: {
      processFrame: ({ frameIndex }) => {
        calls.push(`frame:${frameIndex}:start`);
        return new Promise((resolve) => {
          releaseFirstCommand = () => {
            calls.push(`frame:${frameIndex}:end`);
            resolve({ success: true });
          };
        });
      },
      clearAnchor: () => {
        calls.push('clear');
        return { success: true };
      },
    },
    getState: () => createWorkerState(),
    postMessage: (message) => messages.push(message),
  });

  const frame = onMessage({
    data: { id: 1, command: 'processFrame', payload: { frameIndex: 8 } },
  });
  const clear = onMessage({
    data: { id: 2, command: 'clearAnchor', payload: {} },
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls, ['frame:8:start']);
  assert.deepEqual(messages, []);

  releaseFirstCommand();
  await Promise.all([frame, clear]);

  assert.deepEqual(calls, ['frame:8:start', 'frame:8:end', 'clear']);
  assert.deepEqual(
    messages.map((message) => message.id),
    [1, 2],
  );
});
