import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import {
  DETECTOR_WASM_PATHS,
  configureDetectorRuntime,
  createDetectorSessionOptions,
  getDetectorWasmThreadCount
} from './detectorRuntimeConfig.js';

test('detector session uses stable WASM execution only', () => {
  assert.deepEqual(createDetectorSessionOptions(), {
    executionProviders: ['wasm']
  });
});

test('detector runtime configures ONNX WASM paths and thread count', () => {
  const env = { wasm: {} };

  const config = configureDetectorRuntime(env, {
    crossOriginIsolated: true,
    hardwareConcurrency: 16
  });

  assert.equal(env.wasm.simd, true);
  assert.equal(env.wasm.numThreads, 4);
  assert.deepEqual(env.wasm.wasmPaths, {
    mjs: '/ort-wasm-simd-threaded.mjs',
    wasm: '/ort-wasm-simd-threaded.wasm'
  });
  assert.equal(env.wasm.wasmPaths, DETECTOR_WASM_PATHS);
  assert.deepEqual(config, {
    executionProviders: ['wasm'],
    wasmThreads: 4,
    crossOriginIsolated: true
  });
});

test('detector runtime stays single threaded without cross-origin isolation', () => {
  assert.equal(getDetectorWasmThreadCount({
    crossOriginIsolated: false,
    hardwareConcurrency: 16
  }), 1);
});

test('detector runtime files are available from the public root', async () => {
  await access(new URL('../../public/ort-wasm-simd-threaded.mjs', import.meta.url));
  await access(new URL('../../public/ort-wasm-simd-threaded.wasm', import.meta.url));
});
