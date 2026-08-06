import test from 'node:test';
import assert from 'node:assert/strict';

import { assertWorkerRequestTimeout, WorkerRequestRegistry } from './workerRequestRegistry.js';

const createManualScheduler = () => {
  const tasks = new Map();
  let nextTaskId = 1;

  return {
    schedule: (callback, timeoutMs) => {
      const id = nextTaskId++;
      tasks.set(id, { callback, timeoutMs });
      return () => tasks.delete(id);
    },
    get pendingCount() {
      return tasks.size;
    },
    run: (id = tasks.keys().next().value) => {
      const task = tasks.get(id);
      assert.ok(task, 'worker request timeout was not scheduled');
      tasks.delete(id);
      task.callback();
    },
  };
};

test('worker request registry resolves requests and cancels their deadlines', async () => {
  const scheduler = createManualScheduler();
  const registry = new WorkerRequestRegistry({ scheduleTimeout: scheduler.schedule });
  let sends = 0;
  const request = registry.start({
    id: 1,
    timeoutMs: 500,
    timeoutMessage: 'request timed out',
    send: () => sends++,
    onTimeout: () => assert.fail('settled request timed out'),
  });

  assert.equal(sends, 1);
  assert.equal(registry.size, 1);
  assert.equal(scheduler.pendingCount, 1);
  assert.equal(registry.resolve(1, { success: true }), true);
  assert.deepEqual(await request, { success: true });
  assert.equal(registry.size, 0);
  assert.equal(scheduler.pendingCount, 0);
  assert.equal(registry.resolve(1, null), false);
});

test('worker request timeout rejects the stalled request and lets the owner retire sibling work', async () => {
  const scheduler = createManualScheduler();
  const registry = new WorkerRequestRegistry({ scheduleTimeout: scheduler.schedule });
  const timedOut = [];
  const first = registry.start({
    id: 'initialize',
    timeoutMs: 1000,
    timeoutMessage: 'initialization timed out',
    send: () => {},
    onTimeout: (error) => {
      timedOut.push(error);
      registry.rejectAll('worker runtime retired');
    },
  });
  const sibling = registry.start({
    id: 2,
    timeoutMs: 2000,
    timeoutMessage: 'sibling timed out',
    send: () => {},
    onTimeout: () => assert.fail('retired sibling timed out independently'),
  });

  scheduler.run();

  await assert.rejects(first, { name: 'TimeoutError' });
  await assert.rejects(sibling, /worker runtime retired/);
  assert.equal(timedOut.length, 1);
  assert.equal(timedOut[0].message, 'initialization timed out');
  assert.equal(registry.size, 0);
  assert.equal(scheduler.pendingCount, 0);
});

test('worker request registry rejects invalid contracts before sending work', async () => {
  assert.throws(() => new WorkerRequestRegistry({ scheduleTimeout: null }), /scheduleTimeout/);

  assert.throws(() => assertWorkerRequestTimeout(0, 'Worker request timeout'), /positive finite number/);

  const registry = new WorkerRequestRegistry();
  const first = registry.start({
    id: 1,
    timeoutMs: 1000,
    timeoutMessage: 'request timed out',
    send: () => {},
    onTimeout: () => {},
  });
  assert.throws(
    () =>
      registry.start({
        id: 1,
        timeoutMs: 1000,
        timeoutMessage: 'duplicate timed out',
        send: () => assert.fail('duplicate request was sent'),
        onTimeout: () => {},
      }),
    /Duplicate worker request/,
  );
  registry.rejectAll('test complete');
  await assert.rejects(first, /test complete/);
});

test('worker request registry does not retain requests when postMessage throws', async () => {
  const scheduler = createManualScheduler();
  const registry = new WorkerRequestRegistry({ scheduleTimeout: scheduler.schedule });
  const request = registry.start({
    id: 1,
    timeoutMs: 1000,
    timeoutMessage: 'request timed out',
    send: () => {
      throw new Error('DataCloneError');
    },
    onTimeout: () => {},
  });

  await assert.rejects(request, /DataCloneError/);
  assert.equal(registry.size, 0);
  assert.equal(scheduler.pendingCount, 0);
});
