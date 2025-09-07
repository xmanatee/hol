import { useState, useEffect, useRef, useCallback } from 'react';

export function useNormalEstimation() {
  const workerRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const [normal, setNormal] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const worker = new Worker(new URL('../cv/normal.worker.js', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (e) => {
      const { type, payload, message } = e.data;
      if (type === 'loaded') {
        setIsReady(true);
      } else if (type === 'result') {
        setNormal(payload);
      } else if (type === 'no_result') {
        setNormal(null);
      } else if (type === 'error') {
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
      workerRef.current.postMessage({ type: 'estimate', payload: { imageData, bbox, cameraMatrix } });
    }
  }, [isReady]);

  return { estimate, normal, isReady, error };
}
