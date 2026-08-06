import test from 'node:test';
import assert from 'node:assert/strict';
import { observeWebGLContext } from './webglContextLifecycle.js';

test('prevents default context disposal and reports loss and restoration', () => {
  const canvas = new EventTarget();
  const events = [];
  const stopObserving = observeWebGLContext(canvas, {
    onLost: () => events.push('lost'),
    onRestored: () => events.push('restored'),
  });

  const lostEvent = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(lostEvent);
  canvas.dispatchEvent(new Event('webglcontextrestored'));

  assert.equal(lostEvent.defaultPrevented, true);
  assert.deepEqual(events, ['lost', 'restored']);

  stopObserving();
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.deepEqual(events, ['lost', 'restored']);
});
