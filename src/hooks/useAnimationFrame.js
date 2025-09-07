import { useRef, useEffect, useCallback } from 'react';

export function useAnimationFrame(callback) {
  const requestRef = useRef();
  const previousTimeRef = useRef();
  const callbackRef = useRef(callback);

  // Keep callback reference up to date
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const animate = useCallback((time) => {
    if (previousTimeRef.current !== undefined) {
      const deltaTime = time - previousTimeRef.current;
      callbackRef.current(deltaTime);
    }
    previousTimeRef.current = time;
    requestRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    };
  }, [animate]);
}

export function useFrameRate(targetFPS = 30) {
  const frameTimeRef = useRef(0);
  const fpsRef = useRef(targetFPS);
  const lastFrameRef = useRef(performance.now());
  const frameInterval = 1000 / targetFPS;

  return useCallback((callback) => {
    const now = performance.now();
    const deltaTime = now - lastFrameRef.current;

    if (deltaTime >= frameInterval) {
      frameTimeRef.current = deltaTime;
      fpsRef.current = 1000 / deltaTime;
      lastFrameRef.current = now - (deltaTime % frameInterval);
      
      callback({
        deltaTime,
        fps: fpsRef.current,
        frameTime: frameTimeRef.current
      });
    }
  }, [frameInterval]);
}
