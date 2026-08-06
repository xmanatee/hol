import test from 'node:test';
import assert from 'node:assert/strict';

import { createSerialExecutor } from './serialExecutor.js';

test('serial executor preserves submission order across asynchronous operations', async () => {
  let releaseFirst;
  const calls = [];
  const execute = createSerialExecutor();
  const first = execute(
    () =>
      new Promise((resolve) => {
        calls.push('first:start');
        releaseFirst = () => {
          calls.push('first:end');
          resolve('first');
        };
      }),
  );
  const second = execute(() => {
    calls.push('second');
    return 'second';
  });
  await Promise.resolve();

  assert.deepEqual(calls, ['first:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(calls, ['first:start', 'first:end', 'second']);
});

test('serial executor continues after one operation rejects', async () => {
  const execute = createSerialExecutor();

  await assert.rejects(
    execute(() => Promise.reject(new Error('failed'))),
    /failed/,
  );
  assert.equal(await execute(() => 'recovered'), 'recovered');
});

test('serial executor rejects invalid operations synchronously', () => {
  const execute = createSerialExecutor();

  assert.throws(() => execute(null), {
    name: 'TypeError',
    message: 'Serial executor operation must be a function',
  });
});
