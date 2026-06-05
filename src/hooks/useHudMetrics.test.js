import test from 'node:test';
import assert from 'node:assert/strict';

import { createHudMetricStore } from './useHudMetrics.js';

test('HUD metric store batches repeated updates into one subscriber flush', () => {
  const store = createHudMetricStore();
  const snapshots = [];

  store.subscribe(snapshot => snapshots.push(snapshot));
  store.updateMetric('Capture FPS', 55);
  store.updateMetric('Anchor processing time', 5);
  store.updateMetric('Capture FPS', 48);

  assert.equal(snapshots.length, 0);

  store.flush();

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]['Capture FPS'].value, 48);
  assert.equal(snapshots[0]['Anchor processing time'].value, 5);
});
