import { InteractiveSegmenter } from '@mediapipe/tasks-vision';
import { createInteractiveObjectSupportMask } from './interactiveSegmentationMask.js';
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

const getSegmenter = () => {
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

const segmentFrame = async (message) => {
  const segmenter = await getSegmenter();
  const image = new ImageData(message.imageData.data, message.imageData.width, message.imageData.height);
  const result = segmenter.segment(image, {
    keypoint: {
      x: message.tapPosition.x / message.imageData.width,
      y: message.tapPosition.y / message.imageData.height,
    },
  });
  try {
    const confidenceMask = result.confidenceMasks[FOREGROUND_MASK_INDEX];
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

    self.postMessage(
      {
        type: 'segment-result',
        requestId: message.requestId,
        objectSupportMask,
      },
      [objectSupportMask.data.buffer],
    );
  } finally {
    result.close();
  }
};

self.onmessage = (event) => {
  if (event.data.type === 'segment') {
    segmentFrame(event.data).catch((error) => {
      self.postMessage({
        type: 'segment-error',
        requestId: event.data.requestId,
        reason: error.message,
      });
    });
  }
};
