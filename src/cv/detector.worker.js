import * as ort from 'onnxruntime-web';

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

const TARGET_CLASSES = new Set([39, 41]); // bottle, cup

async function initializeONNX() {
  try {
    // Configure ONNX Runtime Web environment
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = 1;
    
    // Try WebGPU first if available
    if ('gpu' in navigator) {
      try {
        ort.env.webgpu = { 
          powerPreference: 'high-performance' 
        };
        postMessage({ type: 'log', message: 'WebGPU configured for ONNX' });
      } catch (e) {
        postMessage({ type: 'warning', message: 'WebGPU configuration failed, using WASM' });
      }
    } else {
      postMessage({ type: 'warning', message: 'WebGPU not available, using WASM' });
    }
    
    isInitialized = true;
    postMessage({ type: 'initialized' });
  } catch (error) {
    postMessage({ type: 'error', message: `ONNX initialization failed: ${error.message}` });
  }
}

async function loadModel(modelPath) {
  try {
    // Create session with explicit execution provider configuration
    const sessionOptions = {
      executionProviders: []
    };
    
    // Try WebGPU first, fallback to WASM
    if ('gpu' in navigator) {
      try {
        sessionOptions.executionProviders.push('webgpu');
      } catch (e) {
        // WebGPU not available
      }
    }
    
    // Always add WASM as fallback
    sessionOptions.executionProviders.push('wasm');
    
    session = await ort.InferenceSession.create(modelPath, sessionOptions);
    postMessage({ 
      type: 'modelLoaded', 
      inputNames: session.inputNames,
      outputNames: session.outputNames,
      executionProviders: sessionOptions.executionProviders
    });
  } catch (error) {
    postMessage({ type: 'error', message: `Model loading failed: ${error.message}` });
  }
}

function preprocessImage(imageData, targetSize = 512) {
  const { data, width, height } = imageData;
  
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

function postprocessDetections(output, preprocessInfo, confidenceThreshold = 0.5) {
  const { scale, padX, padY, originalWidth, originalHeight } = preprocessInfo;
  const detections = [];
  
  // Output format: [1, num_detections, 85] where 85 = [x, y, w, h, conf, ...80 class scores]
  const outputData = output[0];
  const numDetections = outputData.dims[1];
  const numClasses = outputData.dims[2] - 5; // 80 classes for COCO
  
  for (let i = 0; i < numDetections; i++) {
    const detection = outputData.data.slice(i * (5 + numClasses), (i + 1) * (5 + numClasses));
    
    const [centerX, centerY, width, height, objectConfidence] = detection;
    
    if (objectConfidence < confidenceThreshold) continue;
    
    // Find best class
    let maxClassScore = 0;
    let bestClass = -1;
    
    for (let c = 0; c < numClasses; c++) {
      const classScore = detection[5 + c];
      if (classScore > maxClassScore) {
        maxClassScore = classScore;
        bestClass = c;
      }
    }
    
    // Only keep bottles and cups
    if (!TARGET_CLASSES.has(bestClass)) continue;
    
    const finalConfidence = objectConfidence * maxClassScore;
    if (finalConfidence < confidenceThreshold) continue;
    
    // Convert from normalized coordinates back to original image space
    const x1 = ((centerX - width / 2) * 512 - padX) / scale;
    const y1 = ((centerY - height / 2) * 512 - padY) / scale;
    const x2 = ((centerX + width / 2) * 512 - padX) / scale;
    const y2 = ((centerY + height / 2) * 512 - padY) / scale;
    
    // Clamp to image bounds
    const bbox = {
      x1: Math.max(0, Math.min(originalWidth, x1)),
      y1: Math.max(0, Math.min(originalHeight, y1)),
      x2: Math.max(0, Math.min(originalWidth, x2)),
      y2: Math.max(0, Math.min(originalHeight, y2)),
      confidence: finalConfidence,
      class: bestClass,
      className: COCO_CLASSES[bestClass]
    };
    
    // Filter out very small bboxes
    if (bbox.x2 - bbox.x1 > 10 && bbox.y2 - bbox.y1 > 10) {
      detections.push(bbox);
    }
  }
  
  // Sort by confidence and apply NMS
  return applyNMS(detections, 0.4);
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
    postMessage({ type: 'error', message: 'Model not loaded' });
    return;
  }
  
  try {
    const startTime = performance.now();
    
    // Preprocess image
    const preprocessed = preprocessImage(imageData, 512);
    
    // Create input tensor
    const inputTensor = new ort.Tensor('float32', preprocessed.tensor, [1, 3, 512, 512]);
    
    // Run inference
    const outputs = await session.run({ images: inputTensor });
    
    // Postprocess results
    const detections = postprocessDetections(outputs.output0, preprocessed);
    
    const processingTime = performance.now() - startTime;
    
    postMessage({
      type: 'detections',
      detections,
      processingTime,
      timestamp: Date.now()
    });
    
  } catch (error) {
    postMessage({ type: 'error', message: `Detection failed: ${error.message}` });
  }
}

// Message handler
self.onmessage = async (event) => {
  const { type, ...data } = event.data;
  
  switch (type) {
    case 'initialize':
      await initializeONNX();
      break;
      
    case 'loadModel':
      await loadModel(data.modelPath);
      break;
      
    case 'detect':
      await detectObjects(data.imageData);
      break;
      
    default:
      postMessage({ type: 'error', message: `Unknown message type: ${type}` });
  }
};
