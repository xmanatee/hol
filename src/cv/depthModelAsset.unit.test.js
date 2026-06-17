import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';

const DEPTH_MODEL_MIN_BYTES = 50_000_000;
const DEPTH_MODEL_PATH = new URL('../../public/models/depth_anything_v2_small.onnx', import.meta.url);

test('browser depth-fusion model asset is installed', async () => {
  const model = await stat(DEPTH_MODEL_PATH);

  assert.ok(model.size >= DEPTH_MODEL_MIN_BYTES);
});
