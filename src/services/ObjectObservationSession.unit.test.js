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

const selectionAt = (candidateId, capturedAt) => ({
  candidateId,
  capturedAt,
  tapPosition: { x: 160, y: 120 },
  timeOrigin: 0,
});

const fixture = () => {
  let creations = 0;
  let activeAnchor = null;
  let present = true;
  let focused = true;
  let source = 'interactive-segmenter';
  let pendingRefresh = Promise.resolve();
  let now = 1310;
  let trackingMode = 'sparse-reconstruction';
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
    setTrackingMode: async (mode) => {
      trackingMode = mode;
    },
    getState: () => ({
      trackingMode,
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
  const session = new ObjectObservationSession({ manager, width: 320, height: 240, now: () => now });
  return {
    session,
    creations: () => creations,
    setNow: (value) => {
      now = value;
    },
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
  assert.equal(session.selectCandidate(selectionAt(1, 1001)).success, false);
  for (const time of [1100, 1200, 1300]) await session.processFrame(frame(time));
  const id = session.getState().candidate.id;
  assert.equal(session.getState().candidate.status, 'ready');
  const result = session.selectCandidate(selectionAt(id, 1310));
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
  assert.equal(
    session.selectCandidate({
      candidateId: 1,
      timeOrigin: 0,
      tapPosition: { x: 20, y: 20 },
      capturedAt: 1310,
    }).success,
    false,
  );
  assert.equal(session.selectCandidate(selectionAt(1, 1700)).success, false);
  assert.equal(session.selectCandidate(selectionAt(1, 1200)).success, false);
  assert.equal(session.getState().mode, 'selection');
});

test('loss revokes readiness immediately and recovery needs fresh continuous evidence', async () => {
  const { session, setPresent } = fixture();
  await prepare(session);
  setPresent(false);
  await session.processFrame(frame(1400));
  assert.equal(session.getState().candidate.status, 'lost');
  assert.equal(session.getState().candidate.reason, 'Keep the object visible');
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
  selected.session.selectCandidate(selectionAt(1, 1310));
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

test('a tap cannot commit a replacement object at the same point', async () => {
  const { session, creations, setNow } = fixture();
  await prepare(session);
  const oldId = session.getState().candidate.id;
  session.clearAnchor();
  for (const time of [2000, 2100, 2200, 2300]) await session.processFrame(frame(time));
  setNow(2310);
  const currentId = session.getState().candidate.id;
  assert.notEqual(currentId, oldId);
  const selection = { timeOrigin: 0, tapPosition: { x: 160, y: 120 }, capturedAt: 2310 };
  assert.equal(session.selectCandidate({ ...selection, candidateId: oldId }).success, false);
  assert.equal(session.getState().candidate.id, currentId);
  assert.equal(session.selectCandidate({ ...selection, candidateId: currentId }).id, currentId);
  assert.equal(creations(), 2);
});

test('mask-only refreshes cannot bridge a gap in tracking evidence', async () => {
  const { session, setNow } = fixture();
  await prepare(session);
  const id = session.getState().candidate.id;
  for (const time of [1500, 1700, 1900, 2100]) {
    await session.processFrame({ ...frame(time), update: false, refreshSegmentation: true });
    assert.equal(session.getState().candidate.capturedAt, 1300);
  }
  await session.processFrame(frame(2200));
  assert.notEqual(session.getState().candidate.status, 'ready');
  for (const time of [2300, 2400]) await session.processFrame(frame(time));
  setNow(2410);
  assert.equal(session.getState().candidate.status, 'ready');
  assert.equal(session.selectCandidate(selectionAt(id, 2410)).id, id);
});

test('a tap that was fresh when sent cannot commit after its observation expires in the queue', async () => {
  const { session, setNow } = fixture();
  await prepare(session);
  const id = session.getState().candidate.id;
  setNow(1610);
  const selection = selectionAt(id, 1310);
  assert.equal(session.selectCandidate(selection).success, false);
  await session.processFrame(frame(1600));
  assert.equal(
    session.selectCandidate(selection).success,
    false,
    'an older tap cannot borrow a newer observation',
  );
  assert.equal(session.selectCandidate({ ...selection, capturedAt: 1610 }).id, id);
});

test('selection enforces the commit-time freshness boundary without clock-domain guesses', async () => {
  for (const [age, accepted] of [
    [-1, false],
    [0, true],
    [299.999, true],
    [300, true],
    [300.001, false],
  ]) {
    const { session, setNow } = fixture();
    await prepare(session);
    setNow(1300 + age);
    assert.equal(session.selectCandidate(selectionAt(1, 1300)).success, accepted, `age=${age}`);
  }
});

test('selection translates page-relative observation time, not the worker-relative clock', async () => {
  for (const timeOrigin of [0, 1_700_000_000_000.125, 1_800_000_000_000]) {
    for (const [age, accepted] of [
      [10, true],
      [301, false],
    ]) {
      const { session, setNow } = fixture();
      await prepare(session);
      const selection = { ...selectionAt(1, 1310), timeOrigin };
      setNow(timeOrigin + 1300 + age);
      assert.equal(session.selectCandidate(selection).success, accepted);
    }
  }
});

test('invalid selection ownership and time-origin inputs fail before changing the subject', async () => {
  const { session } = fixture();
  await prepare(session);
  const selection = selectionAt(1, 1310);
  for (const candidateId of [null, undefined, 0, -1, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => session.selectCandidate({ ...selection, candidateId }), /candidate ID/);
  }
  for (const timeOrigin of [null, undefined, -1, NaN, Infinity, '0']) {
    assert.throws(() => session.selectCandidate({ ...selection, timeOrigin }), /time origin/);
  }
  assert.equal(session.getState().candidate.id, 1);
  assert.equal(session.selectCandidate(selection).id, 1);
});

test('presence loss between motion updates cannot advertise a ready selection', async () => {
  const { session, setPresent } = fixture();
  await prepare(session);
  setPresent(false);
  assert.equal(session.getState().candidate.status, 'lost');
  assert.equal(session.getState().candidate.reason, 'Keep the object visible');
});

test('tracking continuity uses the last measurement at every gap boundary and refresh cadence', async () => {
  for (const gap of [599, 600, 600.001]) {
    for (const refreshCount of [0, 1, 8]) {
      const { session, creations } = fixture();
      await prepare(session);
      for (let index = 1; index <= refreshCount; index++) {
        await session.processFrame({
          ...frame(1300 + (gap * index) / (refreshCount + 1)),
          update: false,
          refreshSegmentation: true,
        });
      }
      await session.processFrame(frame(1300 + gap));
      assert.equal(
        session.getState().candidate.status === 'ready',
        gap <= 600,
        `gap=${gap}, refreshes=${refreshCount}`,
      );
      assert.equal(session.getState().candidate.id, 1);
      assert.equal(creations(), 1);
    }
  }
});

test('a changed reconstruction mode requires fresh preparation evidence, not a new object', async () => {
  const { session, creations, setNow } = fixture();
  await prepare(session);
  await session.setTrackingMode('depth-fusion');
  assert.notEqual(session.getState().candidate.status, 'ready');
  assert.equal(session.getState().candidate.id, 1);
  for (const time of [1400, 1500, 1600]) await session.processFrame(frame(time));
  assert.equal(session.getState().candidate.status, 'ready');
  await session.setTrackingMode('depth-fusion');
  assert.equal(
    session.getState().candidate.status,
    'ready',
    'the same mode cannot discard valid preparation',
  );
  setNow(1610);
  assert.equal(session.selectCandidate(selectionAt(1, 1610)).success, true);
  assert.equal(creations(), 1);
});
