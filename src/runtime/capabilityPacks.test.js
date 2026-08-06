import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEPTH_ANYTHING_ASSET,
  DEPTH_ANYTHING_ASSET_URL,
  getCapabilityAsset,
  HEAD_ASSET,
  HEAD_ASSET_URL,
  listCapabilityPacks,
  MAGIC_TOUCH_ASSET,
  MAGIC_TOUCH_ASSET_URL,
  MEDIAPIPE_LOADER_ASSET,
  MEDIAPIPE_LOADER_ASSET_URL,
  MEDIAPIPE_WASM_ASSET,
  MEDIAPIPE_WASM_ASSET_URL,
  OPEN_CV_ASSET,
  OPEN_CV_ASSET_URL,
  ORT_ASYNCIFY_WASM_ASSET,
  ORT_ASYNCIFY_WASM_ASSET_URL,
  ORT_JSEP_LOADER_ASSET,
  ORT_JSEP_LOADER_ASSET_URL,
  ORT_JSEP_WASM_ASSET,
  ORT_JSEP_WASM_ASSET_URL,
  ORT_WASM_ASSET,
  ORT_WASM_ASSET_URL,
  ORT_WASM_LOADER_ASSET,
  ORT_WASM_LOADER_ASSET_URL,
  XFEAT_ASSET,
  XFEAT_ASSET_URL,
  XFEAT_DATA_ASSET,
  XFEAT_DATA_ASSET_URL,
} from './capabilityPacks.js';

test('direct runtime assets are the exact immutable records owned by capability packs', () => {
  const directAssetEntries = [
    [OPEN_CV_ASSET, OPEN_CV_ASSET_URL],
    [MAGIC_TOUCH_ASSET, MAGIC_TOUCH_ASSET_URL],
    [MEDIAPIPE_LOADER_ASSET, MEDIAPIPE_LOADER_ASSET_URL],
    [MEDIAPIPE_WASM_ASSET, MEDIAPIPE_WASM_ASSET_URL],
    [XFEAT_ASSET, XFEAT_ASSET_URL],
    [XFEAT_DATA_ASSET, XFEAT_DATA_ASSET_URL],
    [ORT_WASM_LOADER_ASSET, ORT_WASM_LOADER_ASSET_URL],
    [ORT_WASM_ASSET, ORT_WASM_ASSET_URL],
    [DEPTH_ANYTHING_ASSET, DEPTH_ANYTHING_ASSET_URL],
    [ORT_JSEP_LOADER_ASSET, ORT_JSEP_LOADER_ASSET_URL],
    [ORT_JSEP_WASM_ASSET, ORT_JSEP_WASM_ASSET_URL],
    [ORT_ASYNCIFY_WASM_ASSET, ORT_ASYNCIFY_WASM_ASSET_URL],
    [HEAD_ASSET, HEAD_ASSET_URL],
  ];
  const directAssets = directAssetEntries.map(([asset]) => asset);
  const packedAssets = listCapabilityPacks().flatMap((pack) => pack.assets);

  assert.deepEqual(packedAssets, directAssets);
  assert.equal(new Set(directAssets.map((asset) => asset.id)).size, directAssets.length);
  for (const [asset, runtimeUrl] of directAssetEntries) {
    assert.equal(asset.url, runtimeUrl);
  }
  for (const pack of listCapabilityPacks()) {
    for (const asset of pack.assets) {
      assert.equal(getCapabilityAsset(pack.id, asset.id), asset);
      assert.equal(Object.isFrozen(asset), true);
    }
  }
});
