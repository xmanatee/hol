import * as ort from 'onnxruntime-web/webgpu';
import {
  DEPTH_MODEL_DEFAULT_INPUT_SIZE,
  postprocessDepthTensor,
  preprocessDepthImageData,
} from './depthModelPreprocess.js';

const ortWasmMjsUrl = new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href;
const ortWasmUrl = new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href;

const DEFAULT_MODEL_URL = '/models/depth_anything_v2_small.onnx';

let session = null;
let modelConfig = {
  modelUrl: DEFAULT_MODEL_URL,
  inputSize: DEPTH_MODEL_DEFAULT_INPUT_SIZE,
  outputMaxSize: DEPTH_MODEL_DEFAULT_INPUT_SIZE,
  inputName: null,
  outputName: null,
};
let provider = 'uninitialized';

const configureRuntime = ({ crossOriginIsolated, hardwareConcurrency }) => {
  ort.env.logLevel = 'error';
  ort.env.wasm.simd = true;
  ort.env.wasm.numThreads = crossOriginIsolated
    ? Math.max(1, Math.min(4, Math.floor((hardwareConcurrency || 2) / 2)))
    : 1;
  ort.env.wasm.wasmPaths = {
    mjs: ortWasmMjsUrl,
    wasm: ortWasmUrl,
  };
};

const createSession = async () => {
  const webgpuAvailable = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  const providerAttempts = webgpuAvailable
    ? [['webgpu', 'wasm'], ['wasm']]
    : [['wasm']];
  let lastError = null;

  for (const providers of providerAttempts) {
    try {
      session = await ort.InferenceSession.create(modelConfig.modelUrl, {
        executionProviders: providers,
      });
      provider = providers[0];
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!session) {
    throw new Error(`Depth model load failed: ${lastError?.message || 'No execution provider available'}`);
  }

  modelConfig = {
    ...modelConfig,
    inputName: session.inputNames[0],
    outputName: session.outputNames[0],
  };
};

const initialize = async config => {
  modelConfig = {
    ...modelConfig,
    ...config,
  };
  configureRuntime({
    crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });
  await createSession();
  postMessage({
    type: 'initialized',
    provider,
    inputName: modelConfig.inputName,
    outputName: modelConfig.outputName,
    inputSize: modelConfig.inputSize,
    modelUrl: modelConfig.modelUrl,
  });
};

const estimateDepth = async ({ requestId, imageData, timestamp }) => {
  if (!session) {
    throw new Error('Depth model has not initialized');
  }

  const startedAt = performance.now();
  const preprocessInfo = preprocessDepthImageData(imageData, {
    inputSize: modelConfig.inputSize,
  });
  const inputTensor = new ort.Tensor('float32', preprocessInfo.tensor, preprocessInfo.dims);
  const output = await session.run({ [modelConfig.inputName]: inputTensor });
  const outputTensor = output[modelConfig.outputName] || Object.values(output)[0];
  const depthMap = postprocessDepthTensor(outputTensor, preprocessInfo, {
    outputMaxSize: modelConfig.outputMaxSize,
  });

  postMessage({
    type: 'depth',
    requestId,
    timestamp,
    provider,
    modelUrl: modelConfig.modelUrl,
    processingTime: performance.now() - startedAt,
    width: depthMap.width,
    height: depthMap.height,
    sourceWidth: depthMap.sourceWidth,
    sourceHeight: depthMap.sourceHeight,
    data: depthMap.data,
  }, [depthMap.data.buffer]);
};

self.onmessage = event => {
  const message = event.data;

  if (message.type === 'initialize') {
    initialize(message.config).catch(error => {
      postMessage({ type: 'error', stage: 'initialize', message: error.message });
    });
    return;
  }

  if (message.type === 'estimate') {
    estimateDepth(message).catch(error => {
      postMessage({
        type: 'error',
        stage: 'estimate',
        requestId: message.requestId,
        message: error.message,
      });
    });
  }
};
