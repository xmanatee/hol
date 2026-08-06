import { useCallback } from 'react';
import { createCameraViewportTransform, viewportPointToSource } from '../utils/cameraViewport.js';

const CameraCanvas = ({
  cameraState,
  selectionMode,
  onSelect,
  onCanvasReady,
  mirrored = false,
  style = {},
}) => {
  const setCanvasRef = useCallback(
    (canvas) => {
      if (canvas) {
        canvas.getContext('2d');
        onCanvasReady(canvas);
      }
    },
    [onCanvasReady],
  );

  const selectViewportPoint = useCallback(
    (canvas, point) => {
      const rect = canvas.getBoundingClientRect();
      const transform = createCameraViewportTransform({
        sourceWidth: canvas.width,
        sourceHeight: canvas.height,
        viewportWidth: rect.width,
        viewportHeight: rect.height,
        mirrored,
      });
      const sourcePoint = viewportPointToSource({
        point,
        transform,
      });

      onSelect(sourcePoint);
    },
    [mirrored, onSelect],
  );

  const handlePointerUp = useCallback(
    (event) => {
      if (!event.isPrimary || event.button !== 0) {
        return;
      }

      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      selectViewportPoint(canvas, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    },
    [selectViewportPoint],
  );

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      selectViewportPoint(canvas, {
        x: rect.width / 2,
        y: rect.height / 2,
      });
    },
    [selectViewportPoint],
  );

  const isActive = cameraState === 'active';
  const accessibilityLabel =
    selectionMode === 'anchor' ? 'Clear the current object anchor' : 'Select the object at the camera center';

  return (
    <canvas
      ref={setCanvasRef}
      onPointerUp={handlePointerUp}
      onKeyDown={handleKeyDown}
      role={isActive ? 'button' : undefined}
      aria-label={isActive ? accessibilityLabel : undefined}
      aria-hidden={!isActive}
      tabIndex={isActive ? 0 : -1}
      className={`fixed top-0 left-0 w-screen h-screen object-cover z-20 bg-transparent touch-manipulation focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-blue-400 ${
        isActive ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none cursor-default'
      }`}
      style={style}
    />
  );
};

export default CameraCanvas;
