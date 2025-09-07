import { useRef, useCallback, useEffect, useState } from 'react';

const YOLO_MODEL_URL = 'https://github.com/onnx/models/raw/main/validated/vision/object_detection_segmentation/yolov4/model/yolov4.onnx';

export function useDetection() {
  const workerRef = useRef(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [detections, setDetections] = useState([]);
  const [processingTime, setProcessingTime] = useState(0);

  // Initialize worker
  useEffect(() => {
    const worker = new Worker(new URL('../cv/detector.worker.js', import.meta.url), {
      type: 'module'
    });

    worker.onmessage = (event) => {
      const { type, ...data } = event.data;
      
      switch (type) {
        case 'initialized':
          setIsInitialized(true);
          setError(null);
          break;
          
        case 'modelLoaded':
          setIsModelLoaded(true);
          console.log('YOLO model loaded successfully');
          break;
          
        case 'detections':
          setDetections(data.detections);
          setProcessingTime(data.processingTime);
          break;
          
        case 'error':
          setError(data.message);
          console.error('Detection worker error:', data.message);
          break;
          
        case 'warning':
          console.warn('Detection worker warning:', data.message);
          break;
          
        case 'log':
          console.log('Detection worker:', data.message);
          break;
          
        default:
          console.warn('Unknown worker message type:', type);
      }
    };

    worker.onerror = (error) => {
      setError(`Worker error: ${error.message}`);
    };

    workerRef.current = worker;

    // Initialize ONNX
    worker.postMessage({ type: 'initialize' });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Load model after initialization
  useEffect(() => {
    if (isInitialized && !isModelLoaded && workerRef.current) {
      // For testing without a model, we'll use mock detections
      // In production, use: const modelUrl = '/models/yolov8n.onnx';
      
      // Simulate model loading for testing
      setTimeout(() => {
        setIsModelLoaded(true);
        console.log('Mock model loaded for testing (no real YOLO model)');
      }, 1000);
    }
  }, [isInitialized, isModelLoaded]);

  const detectObjects = useCallback((imageData) => {
    if (!isModelLoaded) {
      return false;
    }

    // For testing without a real model, generate mock detections
    setTimeout(() => {
      const mockDetections = [
        {
          x1: imageData.width * 0.2,
          y1: imageData.height * 0.3,
          x2: imageData.width * 0.4,
          y2: imageData.height * 0.7,
          confidence: 0.85,
          class: 39,
          className: 'bottle'
        },
        {
          x1: imageData.width * 0.6,
          y1: imageData.height * 0.2,
          x2: imageData.width * 0.8,
          y2: imageData.height * 0.5,
          confidence: 0.72,
          class: 41,
          className: 'cup'
        }
      ];
      
      setDetections(mockDetections);
      setProcessingTime(Math.random() * 5 + 2); // 2-7ms mock processing time
    }, 10);
    
    return true;
  }, [isModelLoaded]);

  return {
    detectObjects,
    detections,
    isInitialized,
    isModelLoaded,
    error,
    processingTime
  };
}
