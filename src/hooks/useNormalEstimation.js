import { useState, useEffect, useRef, useCallback } from 'react';

export function useNormalEstimation() {
  const workerRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const [normal, setNormal] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const worker = new Worker(new URL('../cv/normal.worker.js', import.meta.url));

    worker.onmessage = (e) => {
      const { type, payload, message } = e.data;
      if (type === 'loaded') {
        console.log('[NormalEstimation] OpenCV worker loaded successfully');
        setIsReady(true);
      } else if (type === 'result') {
        console.log('[NormalEstimation] Normal estimation result:', payload);
        setNormal(payload);
      } else if (type === 'no_result') {
        console.log('[NormalEstimation] No normal estimation result');
        setNormal(null);
      } else if (type === 'error') {
        console.error('[NormalEstimation] Worker error:', message);
        setError(message);
      }
    };

    worker.postMessage({ type: 'load' });
    workerRef.current = worker;

    return () => {
      worker.terminate();
    };
  }, []);

  const estimate = useCallback((imageData, bbox, cameraMatrix) => {
    if (isReady && workerRef.current) {
      // Convert ImageData to transferable format
      const transferableImageData = {
        data: Array.from(imageData.data),
        width: imageData.width,
        height: imageData.height
      };
      
      console.log('[NormalEstimation] Starting estimation for bbox:', bbox);
      workerRef.current.postMessage({ 
        type: 'estimate', 
        payload: { 
          imageData: transferableImageData, 
          bbox, 
          cameraMatrix 
        } 
      });
    } else {
      console.log('[NormalEstimation] Cannot estimate - worker not ready:', { isReady, hasWorker: !!workerRef.current });
    }
  }, [isReady]);

  return { estimate, normal, isReady, error };
}
