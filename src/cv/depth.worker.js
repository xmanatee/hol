import * as ort from 'onnxruntime-web/webgpu';
import { createSerialExecutor } from '../utils/serialExecutor.js';
import {
  DEPTH_MODEL_DEFAULT_INPUT_SIZE,
  postprocessDepthTensor,
  preprocessDepthImageData,
} from './depthModelPreprocess.js';
import {
  DEPTH_ANYTHING_ASSET_URL,
  ORT_JSEP_LOADER_ASSET_URL,
  ORT_JSEP_WASM_ASSET_URL,
} from '../runtime/capabilityPacks.js';

const ortWasmMjsUrl = ORT_JSEP_LOADER_ASSET_URL;
const ortWasmUrl = ORT_JSEP_WASM_ASSET_URL;

const DEFAULT_MODEL_URL = DEPTH_ANYTHING_ASSET_URL;

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
  const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
  session = await ort.InferenceSession.create(modelConfig.modelUrl, {
    executionProviders: providers,
  });
  // The declared hybrid execution plan is not a per-kernel GPU residency claim.
  provider = providers.join('+');

  modelConfig = {
    ...modelConfig,
    inputName: session.inputNames[0],
    outputName: session.outputNames[0],
  };
};

const initialize = async ({ modelUrl, inputSize }) => {
  if (session) {
    throw new Error('Depth model is already initialized');
  }
  modelConfig.modelUrl = modelUrl;
  modelConfig.inputSize = inputSize;
  configureRuntime({
    crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });
  await createSession();
  postMessage({
    type: 'initialized',
    provider,
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
  const outputTensor = output[modelConfig.outputName];
  const depthMap = postprocessDepthTensor(outputTensor, preprocessInfo, {
    outputMaxSize: modelConfig.outputMaxSize,
  });

  postMessage(
    {
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
    },
    [depthMap.data.buffer],
  );
};

const executeSerially = createSerialExecutor();
self.onmessage = ({ data: message }) =>
  executeSerially(async () => {
    try {
      if (message.type === 'initialize') {
        await initialize(message.config);
      } else if (message.type === 'estimate') {
        await estimateDepth(message);
      } else {
        throw new Error(`Unsupported depth worker command: ${message.type}`);
      }
    } catch (error) {
      postMessage({
        type: 'error',
        stage: message.type,
        requestId: message.requestId,
        message: error.message,
      });
    }
  });
