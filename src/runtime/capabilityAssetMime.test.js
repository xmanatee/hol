import test from 'node:test';
import assert from 'node:assert/strict';

import { getCapabilityAssetContentType } from './capabilityAssetMime.js';

test('Vite serves capability binaries with the production MIME contract', () => {
  assert.equal(
    getCapabilityAssetContentType('/assets/xfeat_backbone.onnx-hash.data'),
    'application/octet-stream',
  );
  assert.equal(getCapabilityAssetContentType('/assets/depth-anything-hash.onnx'), 'application/octet-stream');
  assert.equal(getCapabilityAssetContentType('/assets/magic-touch-hash.tflite'), 'application/octet-stream');
  assert.equal(getCapabilityAssetContentType('/assets/runtime-hash.wasm'), 'application/wasm');
  assert.equal(getCapabilityAssetContentType('/assets/head-hash.glb'), 'model/gltf-binary');
});

test('Vite capability MIME policy ignores application and non-asset paths', () => {
  assert.equal(getCapabilityAssetContentType('/assets/index-hash.js'), null);
  assert.equal(getCapabilityAssetContentType('/api/model.onnx'), null);
});
