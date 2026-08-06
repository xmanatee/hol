export const createCameraViewportTransform = ({
  sourceWidth,
  sourceHeight,
  viewportWidth,
  viewportHeight,
  mirrored = false,
}) => {
  const scale = Math.max(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;

  return {
    scale,
    offsetX: (viewportWidth - renderedWidth) / 2,
    offsetY: (viewportHeight - renderedHeight) / 2,
    renderedWidth,
    renderedHeight,
    sourceWidth,
    sourceHeight,
    mirrored,
  };
};

const mirrorSourceX = (x, transform) => (transform.mirrored ? transform.sourceWidth - x : x);

export const sourcePointToViewport = ({ point, transform }) => ({
  x: mirrorSourceX(point.x, transform) * transform.scale + transform.offsetX,
  y: point.y * transform.scale + transform.offsetY,
});

export const viewportPointToSource = ({ point, transform }) => ({
  x: mirrorSourceX((point.x - transform.offsetX) / transform.scale, transform),
  y: (point.y - transform.offsetY) / transform.scale,
});

export const sourceLengthToViewport = ({ length, transform }) => length * transform.scale;
