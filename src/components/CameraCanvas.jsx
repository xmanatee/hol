import { useCallback, useEffect, useRef } from 'react';
import { createCameraViewportTransform, viewportPointToSource } from '../utils/cameraViewport.js';

const MAX_TAP_MOVEMENT = 10;

const CameraCanvas = ({
  cameraState,
  selectionMode,
  onSelect,
  onCanvasReady,
  mirrored = false,
  style = {},
}) => {
  const isActive = cameraState === 'active';
  const canSelect = isActive && selectionMode === 'selection';
  const pendingTap = useRef(null);

  useEffect(() => {
    pendingTap.current = null;
  }, [canSelect]);

  const setCanvasRef = useCallback(
    (canvas) => {
      if (canvas) {
        canvas.getContext('2d');
        onCanvasReady(canvas);
      }
    },
    [onCanvasReady],
  );

  const selectViewportPoint = (canvas, point) => {
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
  };

  const handlePointerUp = (event) => {
    const start = pendingTap.current;
    pendingTap.current = null;
    if (
      !canSelect ||
      !start ||
      !event.isPrimary ||
      event.button !== 0 ||
      event.pointerId !== start.id ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > MAX_TAP_MOVEMENT
    ) {
      return;
    }

    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      return;
    }
    selectViewportPoint(canvas, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const handlePointerDown = (event) => {
    pendingTap.current =
      canSelect && event.isPrimary && event.button === 0
        ? { id: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
  };

  const cancelTap = () => {
    pendingTap.current = null;
  };

  const handlePointerMove = (event) => {
    const start = pendingTap.current;
    if (
      start &&
      event.pointerId === start.id &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > MAX_TAP_MOVEMENT
    ) {
      pendingTap.current = null;
    }
  };

  const handleClick = (event) => {
    if (!canSelect || event.detail !== 0) {
      return;
    }

    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    selectViewportPoint(canvas, {
      x: rect.width / 2,
      y: rect.height / 2,
    });
  };

  const handleKeyDown = (event) => {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) {
      return;
    }
    event.preventDefault();
    event.currentTarget.click();
  };

  return (
    <canvas
      ref={setCanvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelTap}
      onPointerLeave={cancelTap}
      onLostPointerCapture={cancelTap}
      onBlur={cancelTap}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={isActive ? 'button' : undefined}
      aria-label={isActive ? 'Select the object at the camera center' : undefined}
      aria-disabled={isActive ? !canSelect : undefined}
      aria-hidden={!isActive}
      tabIndex={canSelect ? 0 : -1}
      className={`fixed top-0 left-0 w-screen h-screen object-cover z-20 bg-transparent touch-manipulation focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-blue-400 ${
        canSelect ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none cursor-default'
      }`}
      style={style}
    />
  );
};

export default CameraCanvas;
