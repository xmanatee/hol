export const DETECTOR_WASM_PATHS = Object.freeze({
  'ort-wasm.wasm': '/ort-wasm-simd-threaded.wasm',
  'ort-wasm-threaded.wasm': '/ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd.wasm': '/ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.wasm': '/ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.wasm': '/ort-wasm-simd-threaded.jsep.wasm'
});

export const DETECTOR_EXECUTION_PROVIDERS = Object.freeze(['wasm']);

export function getDetectorWasmThreadCount({ crossOriginIsolated, hardwareConcurrency }) {
  if (!crossOriginIsolated) return 1;
  return Math.max(1, Math.min(4, Math.floor((hardwareConcurrency || 2) / 2)));
}

export function configureDetectorRuntime(env, runtime) {
  env.wasm.simd = true;
  env.wasm.numThreads = getDetectorWasmThreadCount(runtime);
  env.wasm.wasmPaths = DETECTOR_WASM_PATHS;

  return {
    executionProviders: [...DETECTOR_EXECUTION_PROVIDERS],
    wasmThreads: env.wasm.numThreads,
    crossOriginIsolated: Boolean(runtime.crossOriginIsolated)
  };
}

export function createDetectorSessionOptions() {
  return {
    executionProviders: [...DETECTOR_EXECUTION_PROVIDERS]
  };
}
