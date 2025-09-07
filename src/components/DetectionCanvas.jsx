import { useRef, useCallback } from 'react';

const DetectionCanvas = ({ 
  cameraState, 
  onTap, 
  onDraw,
  style = {}
}) => {
  const canvasRef = useRef(null);

  const setCanvasRef = useCallback((canvas) => {
    canvasRef.current = canvas;
    if (canvas) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.willReadFrequently = true;
      }
    }
  }, []);

  const handleTap = useCallback((event) => {
    if (onTap) {
      onTap(event, canvasRef.current);
    }
  }, [onTap]);

  // Expose canvas ref to parent via onDraw callback
  if (onDraw && canvasRef.current) {
    onDraw(canvasRef.current);
  }

  return (
    <canvas
      ref={setCanvasRef}
      onClick={handleTap}
      onTouchEnd={handleTap}
      className={`fixed top-0 left-0 w-screen h-screen object-cover z-20 bg-transparent touch-manipulation ${
        cameraState === 'active' 
          ? 'pointer-events-auto cursor-pointer' 
          : 'pointer-events-none cursor-default'
      }`}
      style={style}
    />
  );
};

export default DetectionCanvas;