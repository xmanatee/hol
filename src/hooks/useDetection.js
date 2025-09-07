import { useRef, useCallback, useEffect, useState } from 'react';

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
      const modelUrl = '/models/yolo11n_480.onnx';
      console.log('Loading YOLO11n model from:', modelUrl);
      
      workerRef.current.postMessage({ 
        type: 'loadModel', 
        modelPath: modelUrl 
      });
    }
  }, [isInitialized, isModelLoaded]);

  const detectObjects = useCallback((imageData) => {
    if (!isModelLoaded || !workerRef.current) {
      return false;
    }

    // Send image data to worker for real YOLO inference
    workerRef.current.postMessage({
      type: 'detect',
      imageData: {
        data: Array.from(imageData.data), // Convert Uint8ClampedArray to regular array for transfer
        width: imageData.width,
        height: imageData.height
      }
    });
    
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
