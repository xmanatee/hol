console.log('[Worker] Starting detector worker...');
import * as ort from 'onnxruntime-web';

console.log('[Worker] ONNX Runtime imported successfully');
postMessage({ type: 'worker_loaded', message: 'Worker script executed successfully' });

let session = null;
let isInitialized = false;

// COCO class names - we'll filter for bottle (39) and cup (41)
const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple'
];

const TARGET_CLASSES = new Set([0, 39, 41]); // person, bottle, cup

async function initializeONNX() {
  console.log('[Worker] initializeONNX called, current state:', isInitialized);
  if (isInitialized) {
    console.log('[Worker] Already initialized, sending initialized message');
    postMessage({ type: 'initialized' });
    return;
  }
  
  try {
    // Configure ONNX Runtime Web environment
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = 1;
    
    // Set WASM paths to public directory
    ort.env.wasm.wasmPaths = {
      'ort-wasm.wasm': '/ort-wasm-simd-threaded.wasm',
      'ort-wasm-threaded.wasm': '/ort-wasm-simd-threaded.wasm',
      'ort-wasm-simd.wasm': '/ort-wasm-simd-threaded.wasm',
      'ort-wasm-simd-threaded.wasm': '/ort-wasm-simd-threaded.wasm',
      'ort-wasm-simd-threaded.jsep.wasm': '/ort-wasm-simd-threaded.jsep.wasm'
    };
    console.log('[Worker] WASM paths configured');
    
    
    // Try WebGPU first if available, but prefer WASM for stability
    const executionProviders = ['wasm'];
    
    if ('gpu' in navigator) {
      console.log('[Worker] WebGPU available, configuring...');
      ort.env.webgpu = { 
        powerPreference: 'high-performance' 
      };
      executionProviders.unshift('webgpu');
    } else {
      console.log('[Worker] WebGPU not available, using WASM only');
    }
    
    isInitialized = true;
    console.log('[Worker] ONNX initialization complete');
    postMessage({ type: 'initialized', executionProviders });
  } catch (error) {
    console.error('[Worker] ONNX initialization failed:', error);
    postMessage({ type: 'error', message: `ONNX initialization failed: ${error.message}` });
  }
}

async function loadModel(modelPath) {
  console.log('[Worker] Loading model:', modelPath);
  try {
    // Create session with explicit execution provider configuration
    const sessionOptions = {
      executionProviders: []
    };
    
    // Try WebGPU first, fallback to WASM
    if ('gpu' in navigator) {
      if ('gpu' in navigator) {
        sessionOptions.executionProviders.push('webgpu');
      }
    }
    
    // Always add WASM as fallback
    sessionOptions.executionProviders.push('wasm');
    
    console.log('[Worker] Creating inference session with providers:', sessionOptions.executionProviders);
    session = await ort.InferenceSession.create(modelPath, sessionOptions);
    console.log('[Worker] Model loaded successfully. Inputs:', session.inputNames, 'Outputs:', session.outputNames);
    postMessage({ 
      type: 'modelLoaded', 
      inputNames: session.inputNames,
      outputNames: session.outputNames,
      executionProviders: sessionOptions.executionProviders
    });
  } catch (error) {
    console.error('[Worker] Model loading failed:', error);
    postMessage({ type: 'error', message: `Model loading failed: ${error.message}` });
  }
}

function preprocessImage(imageData, targetSize = 480) {
  // Handle both direct ImageData and transferred array data
  const data = imageData.data instanceof Array ? new Uint8ClampedArray(imageData.data) : imageData.data;
  const { width, height } = imageData;
  
  // Calculate scale to fit targetSize while maintaining aspect ratio
  const scale = targetSize / Math.max(width, height);
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);
  
  // Create input tensor [1, 3, targetSize, targetSize] with padding
  const input = new Float32Array(1 * 3 * targetSize * targetSize);
  
  // Calculate padding offsets to center the image
  const padX = Math.floor((targetSize - newWidth) / 2);
  const padY = Math.floor((targetSize - newHeight) / 2);
  
  // Resize and normalize to [0, 1], convert BGR to RGB
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const srcX = Math.floor(x / scale);
      const srcY = Math.floor(y / scale);
      const srcIdx = (srcY * width + srcX) * 4;
      
      const dstY = y + padY;
      const dstX = x + padX;
      
      if (dstY < targetSize && dstX < targetSize) {
        // RGB channels - normalize to [0, 1]
        input[0 * targetSize * targetSize + dstY * targetSize + dstX] = data[srcIdx] / 255.0;     // R
        input[1 * targetSize * targetSize + dstY * targetSize + dstX] = data[srcIdx + 1] / 255.0; // G
        input[2 * targetSize * targetSize + dstY * targetSize + dstX] = data[srcIdx + 2] / 255.0; // B
      }
    }
  }
  
  return {
    tensor: input,
    scale,
    padX,
    padY,
    originalWidth: width,
    originalHeight: height
  };
}

function postprocessDetections(output, preprocessInfo, confidenceThreshold = 0.1) {
  const { scale, padX, padY, originalWidth, originalHeight } = preprocessInfo;
  const detections = [];
  
  const outputTensor = Object.values(output)[0];
  const outputData = outputTensor.data;
  const dims = outputTensor.dims;
  
  let numClasses, numDetections;
  let dataFormat;
  
  if (dims.length === 3 && dims[0] === 1) {
    if (dims[1] === 84) {
      // Format: [1, 84, 8400] - standard YOLO11n
      numClasses = 80;
      numDetections = dims[2];
      dataFormat = 'channels_first';
    } else if (dims[2] === 84) {
      // Format: [1, 8400, 84] - transposed
      numClasses = 80;
      numDetections = dims[1];
      dataFormat = 'channels_last';
    }
  }
  
  
  let _totalDetectionsAboveThreshold = 0;
  let _bottleCupDetections = 0;
  let classStats = {};
  
  for (let i = 0; i < numDetections; i++) {
    let centerX, centerY, width, height;
    let classScores = [];
    
    if (dataFormat === 'channels_first') {
      // [1, 84, 8400] format
      centerX = outputData[0 * numDetections + i];
      centerY = outputData[1 * numDetections + i];
      width = outputData[2 * numDetections + i];
      height = outputData[3 * numDetections + i];
      
      for (let c = 0; c < numClasses; c++) {
        classScores[c] = outputData[(4 + c) * numDetections + i];
      }
    } else {
      // [1, 8400, 84] format  
      const offset = i * 84;
      centerX = outputData[offset + 0];
      centerY = outputData[offset + 1];
      width = outputData[offset + 2];
      height = outputData[offset + 3];
      
      for (let c = 0; c < numClasses; c++) {
        classScores[c] = outputData[offset + 4 + c];
      }
    }
    
    // Find best class
    let maxClassScore = 0;
    let bestClass = -1;
    
    for (let c = 0; c < numClasses; c++) {
      if (classScores[c] > maxClassScore) {
        maxClassScore = classScores[c];
        bestClass = c;
      }
    }
    
    // Count all detections above threshold for debugging
    if (maxClassScore >= confidenceThreshold) {
      _totalDetectionsAboveThreshold++;
      
      // Track class statistics
      const className = COCO_CLASSES[bestClass] || `class_${bestClass}`;
      classStats[className] = (classStats[className] || 0) + 1;
      
      if (TARGET_CLASSES.has(bestClass)) {
        _bottleCupDetections++;
      }
    }
    
    // Only keep person, bottles and cups above threshold
    if (!TARGET_CLASSES.has(bestClass) || maxClassScore < confidenceThreshold) continue;
    
    // YOLO11n outputs coordinates in pixel space for the 480x480 input
    // Convert back to original image space
    const x1 = (centerX - width / 2 - padX) / scale;
    const y1 = (centerY - height / 2 - padY) / scale;
    const x2 = (centerX + width / 2 - padX) / scale;
    const y2 = (centerY + height / 2 - padY) / scale;
    
    // Clamp to image bounds
    const bbox = {
      x1: Math.max(0, Math.min(originalWidth, x1)),
      y1: Math.max(0, Math.min(originalHeight, y1)),
      x2: Math.max(0, Math.min(originalWidth, x2)),
      y2: Math.max(0, Math.min(originalHeight, y2)),
      confidence: maxClassScore,
      class: bestClass,
      className: COCO_CLASSES[bestClass]
    };
    
    // Check bbox validity and size
    const bboxWidth = bbox.x2 - bbox.x1;
    const bboxHeight = bbox.y2 - bbox.y1;
    const isValidSize = bboxWidth > 10 && bboxHeight > 10;
    const isValidCoords = bbox.x1 >= 0 && bbox.y1 >= 0 && bbox.x2 <= originalWidth && bbox.y2 <= originalHeight;
    
    
    if (isValidSize && isValidCoords) {
      detections.push(bbox);
    }
  }
  
  const filteredDetections = applyNMS(detections, 0.4);
  
  return filteredDetections;
}

function applyNMS(boxes, iouThreshold) {
  if (boxes.length === 0) return [];
  
  // Sort by confidence (descending)
  boxes.sort((a, b) => b.confidence - a.confidence);
  
  const keep = [];
  const suppress = new Set();
  
  for (let i = 0; i < boxes.length; i++) {
    if (suppress.has(i)) continue;
    
    keep.push(boxes[i]);
    
    for (let j = i + 1; j < boxes.length; j++) {
      if (suppress.has(j)) continue;
      
      const iou = calculateIoU(boxes[i], boxes[j]);
      if (iou > iouThreshold) {
        suppress.add(j);
      }
    }
  }
  
  return keep;
}

function calculateIoU(box1, box2) {
  const x1 = Math.max(box1.x1, box2.x1);
  const y1 = Math.max(box1.y1, box2.y1);
  const x2 = Math.min(box1.x2, box2.x2);
  const y2 = Math.min(box1.y2, box2.y2);
  
  if (x2 <= x1 || y2 <= y1) return 0;
  
  const intersection = (x2 - x1) * (y2 - y1);
  const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
  const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
  const union = area1 + area2 - intersection;
  
  return intersection / union;
}

async function detectObjects(imageData) {
  if (!session || !isInitialized) {
    console.error('[Worker] Detection called but not ready. Session:', !!session, 'Initialized:', isInitialized);
    postMessage({ type: 'error', message: 'Model not loaded' });
    return;
  }
  
  try {
    const startTime = performance.now();
    
    // Preprocess image for YOLO11n (480x480)
    const preprocessed = preprocessImage(imageData, 480);
    
    // Create input tensor
    const inputTensor = new ort.Tensor('float32', preprocessed.tensor, [1, 3, 480, 480]);
    
    
    // Run inference - use the actual input name from the model
    const inputName = session.inputNames[0];
    const inputs = {};
    inputs[inputName] = inputTensor;
    
    const outputs = await session.run(inputs);
    
    
    // Postprocess results
    const detections = postprocessDetections(outputs, preprocessed);
    
    const processingTime = performance.now() - startTime;
    console.log('[Worker] Detection complete:', detections.length, 'objects in', processingTime.toFixed(1), 'ms');
    
    postMessage({
      type: 'detections',
      detections,
      processingTime,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('[Worker] Detection error:', error);
    postMessage({ type: 'error', message: `Detection failed: ${error.message}` });
  }
}

self.onmessage = async (event) => {
  const { type, ...data } = event.data;
  console.log('[Worker] Received message:', type);
  
  switch (type) {
    case 'test':
      console.log('[Worker] Test message received');
      postMessage({ type: 'test_response', message: 'Worker is alive' });
      break;
      
    case 'initialize':
      console.log('[Worker] Initialize message received');
      await initializeONNX();
      break;
      
    case 'loadModel':
      console.log('[Worker] Load model message received:', data.modelPath);
      await loadModel(data.modelPath);
      break;
      
    case 'detect':
      await detectObjects(data.imageData);
      break;
      
    default:
      console.warn('[Worker] Unknown message type:', type);
      postMessage({ type: 'error', message: `Unknown message type: ${type}` });
  }
};
