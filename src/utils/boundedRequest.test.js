import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedRequest } from './boundedRequest.js';

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createManualScheduler = () => {
  let task = null;
  let cancelCount = 0;
  return {
    schedule(callback, timeoutMs) {
      assert.equal(task, null, 'bounded request scheduled more than one deadline');
      task = { callback, timeoutMs, cancelled: false };
      return () => {
        if (!task.cancelled) {
          task.cancelled = true;
          cancelCount++;
        }
      };
    },
    expire() {
      assert.notEqual(task, null, 'bounded request did not schedule a deadline');
      task.callback();
    },
    get task() {
      return task;
    },
    get cancelCount() {
      return cancelCount;
    },
  };
};

test('bounded request resolves work and cancels its deadline', async () => {
  const scheduler = createManualScheduler();
  let requestSignal = null;

  const result = await runBoundedRequest({
    timeoutMs: 500,
    timeoutMessage: 'request timed out',
    scheduleTimeout: scheduler.schedule,
    execute: async (signal) => {
      requestSignal = signal;
      return 'complete';
    },
  });

  assert.equal(result, 'complete');
  assert.equal(requestSignal.aborted, false);
  assert.equal(scheduler.task.timeoutMs, 500);
  assert.equal(scheduler.cancelCount, 1);
});

test('bounded request rejects stalled work with one exact timeout reason', async () => {
  const scheduler = createManualScheduler();
  const stalled = createDeferred();
  let requestSignal = null;

  const request = runBoundedRequest({
    timeoutMs: 1200,
    timeoutMessage: 'local model timed out after 1200ms',
    scheduleTimeout: scheduler.schedule,
    execute: (signal) => {
      requestSignal = signal;
      return stalled.promise;
    },
  });
  await Promise.resolve();
  scheduler.expire();

  await assert.rejects(request, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'TimeoutError');
    assert.equal(error.message, 'local model timed out after 1200ms');
    assert.equal(error.timeoutMs, 1200);
    assert.equal(requestSignal.reason, error);
    return true;
  });
  assert.equal(scheduler.cancelCount, 1);
});

test('caller cancellation retires work even when the operation ignores AbortSignal', async () => {
  const scheduler = createManualScheduler();
  const caller = new AbortController();
  const stalled = createDeferred();
  const reason = new DOMException('subject retired', 'AbortError');
  let requestSignal = null;

  const request = runBoundedRequest({
    signal: caller.signal,
    timeoutMs: 1000,
    timeoutMessage: 'request timed out',
    scheduleTimeout: scheduler.schedule,
    execute: (signal) => {
      requestSignal = signal;
      return stalled.promise;
    },
  });
  await Promise.resolve();
  caller.abort(reason);

  await assert.rejects(request, (error) => error === reason);
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason, reason);
  assert.equal(scheduler.cancelCount, 1);
});

test('caller reason wins when abort makes the transport reject with a different error', async () => {
  const scheduler = createManualScheduler();
  const caller = new AbortController();
  const callerReason = new DOMException('subject retired', 'AbortError');

  const request = runBoundedRequest({
    signal: caller.signal,
    timeoutMs: 1000,
    timeoutMessage: 'request timed out',
    scheduleTimeout: scheduler.schedule,
    execute: (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('transport replaced the reason', 'AbortError')),
          { once: true },
        );
      }),
  });
  await Promise.resolve();
  caller.abort(callerReason);

  await assert.rejects(request, (error) => error === callerReason);
  assert.equal(scheduler.cancelCount, 1);
});

test('bounded request rejects invalid contracts before scheduling or executing work', () => {
  let executions = 0;
  const execute = () => {
    executions++;
  };

  assert.throws(
    () => runBoundedRequest({ timeoutMs: 0, timeoutMessage: 'timeout', execute }),
    /positive finite number/,
  );
  assert.throws(
    () => runBoundedRequest({ timeoutMs: 1.5, timeoutMessage: 'timeout', execute }),
    /whole milliseconds/,
  );
  assert.throws(
    () => runBoundedRequest({ timeoutMs: 2_147_483_648, timeoutMessage: 'timeout', execute }),
    /no greater than 2147483647/,
  );
  assert.throws(
    () => runBoundedRequest({ timeoutMs: 100, timeoutMessage: '  ', execute }),
    /non-empty string/,
  );
  assert.throws(
    () => runBoundedRequest({ timeoutMs: 100, timeoutMessage: 'timeout', execute: null }),
    /execute must be a function/,
  );
  assert.throws(
    () =>
      runBoundedRequest({
        signal: null,
        timeoutMs: 100,
        timeoutMessage: 'timeout',
        execute,
      }),
    /signal must be an AbortSignal/,
  );
  assert.equal(executions, 0);
});

test('an already-aborted caller fails before scheduling or executing work', () => {
  const caller = new AbortController();
  const reason = new DOMException('already retired', 'AbortError');
  caller.abort(reason);
  let scheduled = false;
  let executed = false;

  assert.throws(
    () =>
      runBoundedRequest({
        signal: caller.signal,
        timeoutMs: 100,
        timeoutMessage: 'timeout',
        scheduleTimeout: () => {
          scheduled = true;
          return () => {};
        },
        execute: () => {
          executed = true;
        },
      }),
    (error) => error === reason,
  );
  assert.equal(scheduled, false);
  assert.equal(executed, false);
});

test('operation failure remains exact and cancels the unused deadline', async () => {
  const scheduler = createManualScheduler();
  const failure = new Error('provider offline');
  const request = runBoundedRequest({
    timeoutMs: 100,
    timeoutMessage: 'request timed out',
    scheduleTimeout: scheduler.schedule,
    execute: async () => {
      throw failure;
    },
  });

  await assert.rejects(request, (error) => error === failure);
  assert.equal(scheduler.cancelCount, 1);
});
