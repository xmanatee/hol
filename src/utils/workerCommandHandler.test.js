import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerCommandHandler } from './workerCommandHandler.js';

test('worker commands publish one correlated result and the post-command state', async () => {
  let state = 0;
  const messages = [];
  const handle = createWorkerCommandHandler({
    handlers: {
      increment: (amount) => {
        state += amount;
        return state;
      },
    },
    getState: () => state,
    postMessage: (message) => messages.push(message),
  });
  await handle({ data: { id: 7, command: 'increment', payload: 2 } });
  assert.deepEqual(messages, [{ type: 'response', id: 7, result: 2, state: 2 }]);
});

test('worker commands reject unknown and inherited methods without executing them', async () => {
  const messages = [];
  const handle = createWorkerCommandHandler({
    handlers: Object.create({ inherited: () => assert.fail('inherited method executed') }),
    postMessage: (message) => messages.push(message),
  });
  for (const command of ['missing', 'inherited', 'constructor', 'toString', '__proto__']) {
    await handle({ data: { id: command, command, payload: {} } });
    assert.deepEqual(messages.at(-1), {
      type: 'response',
      id: command,
      error: `Unsupported worker command: ${command}`,
    });
  }
  assert.equal(messages.length, 5);
});

test('worker command failures reply once and do not break FIFO ordering', async () => {
  let release;
  const calls = [];
  const messages = [];
  const handle = createWorkerCommandHandler({
    handlers: {
      store: () =>
        new Promise((resolve) => {
          calls.push('store');
          release = resolve;
        }),
      syncFailure: () => {
        throw new Error('sync failure');
      },
      asyncFailure: async () => {
        throw new Error('async failure');
      },
      clear: () => {
        calls.push('clear');
        return true;
      },
    },
    postMessage: (message) => messages.push(message),
  });
  const commands = ['store', 'syncFailure', 'asyncFailure', 'clear'];
  const pending = commands.map((command, id) => handle({ data: { id, command, payload: null } }));
  await Promise.resolve();
  assert.deepEqual(calls, ['store']);
  assert.deepEqual(messages, []);
  release(true);
  await Promise.all(pending);
  assert.deepEqual(calls, ['store', 'clear']);
  assert.deepEqual(messages, [
    { type: 'response', id: 0, result: true },
    { type: 'response', id: 1, error: 'sync failure' },
    { type: 'response', id: 2, error: 'async failure' },
    { type: 'response', id: 3, result: true },
  ]);
});

test('response transport failures propagate instead of attempting a second reply', async () => {
  let attempts = 0;
  const handle = createWorkerCommandHandler({
    handlers: { read: () => true },
    postMessage: () => {
      attempts++;
      throw new Error('DataCloneError');
    },
  });
  await assert.rejects(handle({ data: { id: 1, command: 'read' } }), /DataCloneError/);
  assert.equal(attempts, 1);
});
