import test from 'node:test';
import assert from 'node:assert/strict';

import { createDepthStateStore } from './depthStateStore.js';

const createIdleState = () => ({
  state: 'idle',
  provider: null,
  error: null,
  processingTime: 0,
  lastFrameAt: 0,
});

test('depth state store publishes changed worker state without owning React lifecycle state', () => {
  const idleState = createIdleState();
  const store = createDepthStateStore(idleState);
  let publicationCount = 0;
  const unsubscribe = store.subscribe(() => publicationCount++);

  store.update({ ...idleState });
  assert.equal(publicationCount, 0);

  const readyState = {
    ...idleState,
    state: 'ready',
    provider: 'webgpu',
    processingTime: 8.4,
    lastFrameAt: 1200,
  };
  store.update(readyState);

  assert.equal(store.getSnapshot(), readyState);
  assert.equal(publicationCount, 1);
  unsubscribe();
});

test('depth state store retains worker updates without subscribers and supports explicit reset', () => {
  const idleState = createIdleState();
  const store = createDepthStateStore(idleState);
  const loadingState = { ...idleState, state: 'loading' };

  store.update(loadingState);
  assert.equal(store.getSnapshot(), loadingState);

  store.reset(idleState);
  assert.equal(store.getSnapshot(), idleState);
});
