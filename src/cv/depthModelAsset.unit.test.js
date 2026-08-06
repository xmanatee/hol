import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { getCapabilityAsset } from '../runtime/capabilityPacks.js';

test('quantized browser depth model matches its capability manifest', async () => {
  const asset = getCapabilityAsset('depth', 'depth-anything-v2-small-q4');
  const model = await stat(new URL(asset.url));

  assert.equal(model.size, asset.bytes);
  assert.equal(asset.revision, 'f7421df');
});
