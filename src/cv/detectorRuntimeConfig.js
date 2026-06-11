export const DETECTOR_WASM_PATHS = Object.freeze({
  mjs: '/ort-wasm-simd-threaded.mjs',
  wasm: '/ort-wasm-simd-threaded.wasm'
});

export const DETECTOR_EXECUTION_PROVIDERS = Object.freeze(['wasm']);

export function getDetectorWasmThreadCount({ crossOriginIsolated, hardwareConcurrency }) {
  if (!crossOriginIsolated) return 1;
  return Math.max(1, Math.min(4, Math.floor((hardwareConcurrency || 2) / 2)));
}

export function configureDetectorRuntime(env, runtime) {
  env.wasm.simd = true;
  env.wasm.numThreads = getDetectorWasmThreadCount(runtime);
  if (runtime.wasmPaths) {
    env.wasm.wasmPaths = runtime.wasmPaths;
  } else {
    env.wasm.wasmPaths = DETECTOR_WASM_PATHS;
  }

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
