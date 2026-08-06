import test from 'node:test';
import assert from 'node:assert/strict';

import { ANCHOR_SELECTION_IN_PROGRESS_REASON, AnchorSelectionGate } from './AnchorSelectionGate.js';

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

test('anchor selection gate admits one transaction and never invokes a competing capture', async () => {
  const gate = new AnchorSelectionGate();
  const firstResult = createDeferred();
  let captureCount = 0;

  const first = gate.run(() => {
    captureCount++;
    return firstResult.promise;
  });
  const competing = await gate.run(() => {
    captureCount++;
    return { success: true };
  });

  assert.deepEqual(competing, {
    success: false,
    reason: ANCHOR_SELECTION_IN_PROGRESS_REASON,
  });
  assert.equal(captureCount, 1);

  firstResult.resolve({ success: true, id: 'first' });
  assert.deepEqual(await first, { success: true, id: 'first' });
  assert.deepEqual(await gate.run(() => ({ success: true, id: 'next' })), {
    success: true,
    id: 'next',
  });
});

test('anchor selection reset lets a new session start without stale completion releasing its owner', async () => {
  const gate = new AnchorSelectionGate();
  const retiredResult = createDeferred();
  const currentResult = createDeferred();

  const retired = gate.run(() => retiredResult.promise);
  gate.reset();
  const current = gate.run(() => currentResult.promise);

  retiredResult.resolve({ success: false, reason: 'Camera session ended' });
  await retired;

  assert.deepEqual(await gate.run(() => ({ success: true })), {
    success: false,
    reason: ANCHOR_SELECTION_IN_PROGRESS_REASON,
  });

  currentResult.resolve({ success: true, id: 'current' });
  assert.deepEqual(await current, { success: true, id: 'current' });
});

test('anchor selection gate releases ownership after a failed transaction', async () => {
  const gate = new AnchorSelectionGate();

  await assert.rejects(
    gate.run(() => {
      throw new Error('capture failed');
    }),
    /capture failed/,
  );

  assert.deepEqual(await gate.run(() => ({ success: true })), { success: true });
});
