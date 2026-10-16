import * as ort from 'onnxruntime-web/webgpu';
import { createWorkerCommandHandler } from '../utils/workerCommandHandler.js';
import {
  DEPTH_MODEL_DEFAULT_INPUT_SIZE,
  postprocessDepthTensor,
  preprocessDepthImageData,
} from './depthModelPreprocess.js';
import { ORT_JSEP_LOADER_ASSET_URL, ORT_JSEP_WASM_ASSET_URL } from '../runtime/capabilityPacks.js';

let session = null;
let modelConfig = null;
let provider = null;

const configureRuntime = ({ crossOriginIsolated, hardwareConcurrency }) => {
  ort.env.logLevel = 'error';
  ort.env.wasm.simd = true;
  ort.env.wasm.numThreads = crossOriginIsolated
    ? Math.max(1, Math.min(4, Math.floor((hardwareConcurrency || 2) / 2)))
    : 1;
  ort.env.wasm.wasmPaths = {
    mjs: ORT_JSEP_LOADER_ASSET_URL,
    wasm: ORT_JSEP_WASM_ASSET_URL,
  };
};

const initialize = async ({ modelUrl, inputSize }) => {
  if (session) {
    throw new Error('Depth model is already initialized');
  }
  configureRuntime({
    crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });
  const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
  session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: providers,
  });
  // The declared hybrid execution plan is not a per-kernel GPU residency claim.
  provider = providers.join('+');

  modelConfig = {
    modelUrl,
    inputSize,
    inputName: session.inputNames[0],
    outputName: session.outputNames[0],
  };
  return { provider, inputSize, modelUrl };
};

const estimateDepth = async ({ imageData, timestamp }) => {
  if (!session) {
    throw new Error('Depth model has not initialized');
  }

  const startedAt = performance.now();
  const preprocessInfo = preprocessDepthImageData(imageData, {
    inputSize: modelConfig.inputSize,
  });
  const inputTensor = new ort.Tensor('float32', preprocessInfo.tensor, preprocessInfo.dims);
  const output = await session.run({ [modelConfig.inputName]: inputTensor });
  const outputTensor = output[modelConfig.outputName];
  const depthMap = postprocessDepthTensor(outputTensor, preprocessInfo, {
    outputMaxSize: DEPTH_MODEL_DEFAULT_INPUT_SIZE,
  });

  return {
    ...depthMap,
    timestamp,
    provider,
    modelUrl: modelConfig.modelUrl,
    processingTime: performance.now() - startedAt,
  };
};

self.onmessage = createWorkerCommandHandler({
  handlers: { initialize, estimate: estimateDepth },
  postMessage: (message) =>
    self.postMessage(message, message.result?.data ? [message.result.data.buffer] : []),
});
