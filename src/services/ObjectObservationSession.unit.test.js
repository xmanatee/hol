import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectObservationSession } from './ObjectObservationSession.js';

const frame = (capturedAt) => ({
  capturedAt,
  imageData: { width: 320, height: 240 },
  update: true,
  refreshSegmentation: false,
  depthContext: {},
});

const fixture = () => {
  let creations = 0;
  let activeAnchor = null;
  let present = true;
  let focused = true;
  let source = 'interactive-segmenter';
  let pendingRefresh = Promise.resolve();
  const manager = {
    prepareObjectAtPoint: async () => {
      creations++;
      activeAnchor = {
        position: { x: 160, y: 120 },
        createdAt: 123,
        objectSupportMaskSource: source,
        selectionRegion: { objectSupportMask: { data: new Uint8Array(320 * 240) } },
      };
      return { success: true, objectSupportMaskSource: source };
    },
    processFrame: async (_imageData, { refreshSegmentation }) => {
      if (refreshSegmentation) await pendingRefresh;
      return { updateResult: { success: present, targetPresent: present } };
    },
    containsSourcePoint: ({ x, y }) => focused && x >= 80 && x <= 240 && y >= 60 && y <= 180,
    getState: () => ({
      initialized: true,
      mode: activeAnchor ? 'anchor' : 'selection',
      activeAnchor,
      anchorState: activeAnchor
        ? { metrics: { targetPresent: present, readiness: { faceReady: true } } }
        : null,
    }),
    clearAnchor: () => {
      activeAnchor = null;
    },
    dispose: () => {},
  };
  const session = new ObjectObservationSession({ manager, width: 320, height: 240 });
  return {
    session,
    creations: () => creations,
    setPresent: (value) => {
      present = value;
    },
    setFocused: (value) => {
      focused = value;
    },
    setSource: (value) => {
      source = value;
    },
    setRefresh: (value) => {
      pendingRefresh = value;
    },
  };
};

const prepare = async (session) => {
  for (const time of [1000, 1100, 1200, 1300]) await session.processFrame(frame(time));
};

test('selection commits the prepared subject without recreating landmarks or keyframes', async () => {
  const { session, creations } = fixture();
  await session.processFrame(frame(1000));
  assert.equal(session.getState().candidate.status, 'segmented');
  assert.equal(session.getState().nextObservationAt, 0);
  assert.equal(session.getState().activeAnchor, null);
  assert.equal(session.selectCandidate({ tapPosition: { x: 160, y: 120 }, capturedAt: 1001 }).success, false);
  for (const time of [1100, 1200, 1300]) await session.processFrame(frame(time));
  const id = session.getState().candidate.id;
  assert.equal(session.getState().candidate.status, 'ready');
  const result = session.selectCandidate({ tapPosition: { x: 160, y: 120 }, capturedAt: 1310 });
  assert.equal(result.success, true);
  assert.equal(result.id, id);
  assert.equal(result.createdAt, 123);
  assert.equal('selectionRegion' in result, false, 'selection cannot clone full worker-owned masks');
  assert.equal(creations(), 1);
  assert.equal(session.getState().mode, 'anchor');
  assert.equal(session.getState().candidate, null);
  assert.equal(session.getState().nextObservationAt, 0);
});

test('provisional support cannot become an object candidate and retries are bounded', async () => {
  const { session, setSource, creations } = fixture();
  setSource('tap-local');
  await session.processFrame(frame(1000));
  assert.equal(session.getState().candidate, null);
  assert.equal(session.getState().nextObservationAt, 1750);
  await session.processFrame(frame(1100));
  assert.equal(creations(), 1);
  await session.processFrame(frame(1800));
  assert.equal(creations(), 2);
});

test('selection rejects stale observations and a tap on a neighboring object', async () => {
  const { session } = fixture();
  await prepare(session);
  assert.equal(session.selectCandidate({ tapPosition: { x: 20, y: 20 }, capturedAt: 1310 }).success, false);
  assert.equal(session.selectCandidate({ tapPosition: { x: 160, y: 120 }, capturedAt: 1700 }).success, false);
  assert.equal(session.selectCandidate({ tapPosition: { x: 160, y: 120 }, capturedAt: 1200 }).success, false);
  assert.equal(session.getState().mode, 'selection');
});

test('loss revokes readiness immediately and recovery needs fresh continuous evidence', async () => {
  const { session, setPresent } = fixture();
  await prepare(session);
  setPresent(false);
  await session.processFrame(frame(1400));
  assert.equal(session.getState().candidate.status, 'lost');
  setPresent(true);
  await session.processFrame(frame(1500));
  assert.notEqual(session.getState().candidate.status, 'ready');
  for (const time of [1600, 1700]) await session.processFrame(frame(time));
  assert.equal(session.getState().candidate.status, 'ready');
});

test('moving the camera away releases an unselected subject but preserves a selected identity', async () => {
  const f = fixture();
  await prepare(f.session);
  f.setFocused(false);
  for (const time of [1400, 1700, 2100]) await f.session.processFrame(frame(time));
  assert.equal(f.session.getState().candidate, null);
  const selected = fixture();
  await prepare(selected.session);
  selected.session.selectCandidate({ tapPosition: { x: 160, y: 120 }, capturedAt: 1310 });
  selected.setFocused(false);
  selected.setPresent(false);
  for (const time of [1400, 1700, 2100]) await selected.session.processFrame(frame(time));
  assert.equal(selected.session.getState().activeAnchor.id, 1);
  assert.equal(selected.creations(), 1);
});

test('mask completion owns its source-frame transaction and disposal wins delayed inference', async () => {
  const f = fixture();
  await prepare(f.session);
  let resolve;
  f.setRefresh(
    new Promise((resolveRefresh) => {
      resolve = resolveRefresh;
    }),
  );
  let finished = false;
  const pending = f.session.processFrame({ ...frame(1400), refreshSegmentation: true });
  pending.then(
    () => {
      finished = true;
    },
    () => {},
  );
  await Promise.resolve();
  assert.equal(finished, false);
  f.session.dispose();
  resolve();
  await assert.rejects(pending, /disposed/);
});

test('duplicate frames do not manufacture readiness and a raster change fails explicitly', async () => {
  const { session } = fixture();
  await session.processFrame(frame(1000));
  for (let index = 0; index < 5; index++) {
    assert.equal((await session.processFrame(frame(1000))).success, false);
  }
  assert.equal(session.getState().candidate.status, 'segmented');
  await assert.rejects(
    session.processFrame({ ...frame(1100), imageData: { width: 240, height: 320 } }),
    /raster/,
  );
});

test('slow initial segmentation and background gaps retain identity but require fresh readiness', async () => {
  const { session, creations } = fixture();
  await session.processFrame(frame(1000));
  await session.processFrame(frame(3000));
  assert.equal(creations(), 1);
  assert.notEqual(session.getState().candidate.status, 'ready');
  for (const time of [3100, 3200]) await session.processFrame(frame(time));
  assert.equal(session.getState().candidate.status, 'ready');
  await session.processFrame(frame(5000));
  assert.notEqual(session.getState().candidate.status, 'ready');
});
