import test from 'node:test';
import assert from 'node:assert/strict';

import { createXFeatWorkerMessageHandler } from './xfeatWorkerProtocol.js';

test('XFeat worker protocol orders clear after in-flight feature extraction', async () => {
  let releaseStore;
  const calls = [];
  const messages = [];
  const onMessage = createXFeatWorkerMessageHandler({
    handlers: {
      storeReference: () =>
        new Promise((resolve) => {
          calls.push('store:start');
          releaseStore = () => {
            calls.push('store:end');
            resolve({ success: true });
          };
        }),
      clear: () => {
        calls.push('clear');
        return true;
      },
    },
    postMessage: (message) => messages.push(message),
  });

  const store = onMessage({ data: { id: 1, command: 'storeReference', payload: {} } });
  const clear = onMessage({ data: { id: null, command: 'clear', payload: null } });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls, ['store:start']);
  releaseStore();
  await Promise.all([store, clear]);
  assert.deepEqual(calls, ['store:start', 'store:end', 'clear']);
  assert.deepEqual(
    messages.map((message) => message.id),
    [1, null],
  );
});
