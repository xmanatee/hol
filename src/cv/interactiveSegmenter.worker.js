import { InteractiveSegmenter } from '@mediapipe/tasks-vision';
import { createInteractiveObjectSupportMask } from './interactiveSegmentationMask.js';
import { assertSegmentationInput, getSegmentationBackend } from './segmentationBackend.js';
import { createSerialExecutor } from '../utils/serialExecutor.js';
import {
  MAGIC_TOUCH_ASSET_URL,
  MEDIAPIPE_LOADER_ASSET_URL,
  MEDIAPIPE_WASM_ASSET_URL,
} from '../runtime/capabilityPacks.js';

const MODEL_PATH = MAGIC_TOUCH_ASSET_URL;
const visionWasmBinaryPath = MEDIAPIPE_WASM_ASSET_URL;
const visionWasmLoaderPath = MEDIAPIPE_LOADER_ASSET_URL;
const MASK_THRESHOLD = 0.5;
const FOREGROUND_MASK_INDEX = 1;
const WASM_FILESET = {
  wasmLoaderPath: visionWasmLoaderPath,
  wasmBinaryPath: visionWasmBinaryPath,
};

let segmenterPromise = null;
let activeBackendId = null;
let backendInfo = null;

const getSegmenter = (backendId) => {
  const backend = getSegmentationBackend(backendId);
  if (activeBackendId !== null && activeBackendId !== backendId)
    throw new Error('A segmentation worker cannot switch execution backend');
  if (!segmenterPromise) {
    activeBackendId = backendId;
    const canvas = new OffscreenCanvas(1, 1);
    backendInfo = { execution: backend.execution, webgl: null };
    if (backend.delegate === 'GPU') {
      const gl = canvas.getContext('webgl2');
      if (!gl)
        throw Object.assign(new Error('Worker WebGL2 is unavailable for the requested GPU delegate'), {
          code: 'BACKEND_UNAVAILABLE',
        });
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      backendInfo.webgl = {
        renderer: gl.getParameter(gl.RENDERER),
        vendor: gl.getParameter(gl.VENDOR),
        version: gl.getParameter(gl.VERSION),
        unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      };
    }
    segmenterPromise = InteractiveSegmenter.createFromOptions(WASM_FILESET, {
      baseOptions: {
        modelAssetPath: MODEL_PATH,
        delegate: backend.delegate,
      },
      canvas,
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  }

  return segmenterPromise;
};

const segmentFrame = async (message) => {
  assertSegmentationInput(message);
  const startedAt = performance.now();
  const cold = segmenterPromise === null;
  const segmenter = await getSegmenter(message.backendId);
  const initializedAt = performance.now();
  const image = new ImageData(message.imageData.data, message.imageData.width, message.imageData.height);
  const result = segmenter.segment(image, {
    keypoint: {
      x: message.tapPosition.x / message.imageData.width,
      y: message.tapPosition.y / message.imageData.height,
    },
  });
  const segmentReturnedAt = performance.now();
  try {
    const confidenceMask = result.confidenceMasks[FOREGROUND_MASK_INDEX];
    const confidenceData = confidenceMask.getAsFloat32Array();
    const maskReadAt = performance.now();
    const objectSupportMask = createInteractiveObjectSupportMask({
      confidenceData,
      maskWidth: confidenceMask.width,
      maskHeight: confidenceMask.height,
      frameWidth: message.imageData.width,
      frameHeight: message.imageData.height,
      threshold: MASK_THRESHOLD,
      referencePoint: message.tapPosition,
      createdAtFrame: message.createdAtFrame,
      maxRadius: message.maxRadius,
    });

    self.postMessage(
      {
        type: 'segment-result',
        backendId: activeBackendId,
        backendInfo: cold ? backendInfo : null,
        requestId: message.requestId,
        timings: {
          cold,
          initializationMs: cold ? initializedAt - startedAt : 0,
          // GPU segment() can enqueue work: only CPU-readable mask latency includes completion.
          segmentCallMs: segmentReturnedAt - initializedAt,
          maskReadbackAndSyncMs: maskReadAt - segmentReturnedAt,
          maskPostprocessMs: performance.now() - maskReadAt,
          totalMs: performance.now() - startedAt,
        },
        objectSupportMask,
      },
      [objectSupportMask.data.buffer],
    );
  } finally {
    result.close();
  }
};

const executeSerially = createSerialExecutor();
self.onmessage = (event) =>
  executeSerially(async () => {
    try {
      if (event.data.type !== 'segment')
        throw new Error(`Unsupported segmentation command: ${event.data.type}`);
      await segmentFrame(event.data);
    } catch (error) {
      self.postMessage({
        type: 'segment-error',
        backendId: event.data.backendId,
        backendInfo,
        requestId: event.data.requestId,
        code: error instanceof Error && typeof error.code === 'string' ? error.code : 'SEGMENTATION_FAILED',
        reason: error instanceof Error ? error.message || error.name : String(error),
      });
    }
  });
