import {
  InteractiveSegmenter,
} from '@mediapipe/tasks-vision';
import visionWasmBinaryPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.wasm?url';
import visionWasmLoaderPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js?url';
import { createInteractiveObjectSupportMask } from './interactiveSegmentationMask.js';

const MODEL_PATH = '/models/ptm_512_hdt_ptm_woid.tflite';
const MASK_THRESHOLD = 0.5;
const WASM_FILESET = {
  wasmLoaderPath: visionWasmLoaderPath,
  wasmBinaryPath: visionWasmBinaryPath,
};

let segmenterPromise = null;

const getSegmenter = async () => {
  if (!segmenterPromise) {
    segmenterPromise = InteractiveSegmenter.createFromOptions(WASM_FILESET, {
      baseOptions: {
        modelAssetPath: MODEL_PATH,
        delegate: 'CPU',
      },
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  }

  return segmenterPromise;
};

const segmentFrame = async message => {
  const segmenter = await getSegmenter();
  const image = new ImageData(message.imageData.data, message.imageData.width, message.imageData.height);
  const result = segmenter.segment(image, {
    keypoint: {
      x: message.tapPosition.x / message.imageData.width,
      y: message.tapPosition.y / message.imageData.height,
    },
  });
  const confidenceMask = result.confidenceMasks[0];
  const confidenceData = confidenceMask.getAsFloat32Array();
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

  result.close();

  self.postMessage({
    type: 'segment-result',
    requestId: message.requestId,
    objectSupportMask,
  }, [objectSupportMask.data.buffer]);
};

self.onmessage = event => {
  if (event.data.type === 'segment') {
    segmentFrame(event.data).catch(error => {
      self.postMessage({
        type: 'segment-error',
        requestId: event.data.requestId,
        reason: error.message,
      });
    });
  }
};
