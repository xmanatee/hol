export const observeWebGLContext = (canvas, { onLost, onRestored }) => {
  const handleLost = (event) => {
    event.preventDefault();
    onLost();
  };
  const handleRestored = () => onRestored();

  canvas.addEventListener('webglcontextlost', handleLost);
  canvas.addEventListener('webglcontextrestored', handleRestored);

  return () => {
    canvas.removeEventListener('webglcontextlost', handleLost);
    canvas.removeEventListener('webglcontextrestored', handleRestored);
  };
};
