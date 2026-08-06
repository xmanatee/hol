export const samplePatchDescriptor = (grayImage, point, radius = 3) => {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (
    !grayImage ||
    x - radius < 1 ||
    y - radius < 1 ||
    x + radius + 1 >= grayImage.cols ||
    y + radius + 1 >= grayImage.rows
  ) {
    return null;
  }

  const values = [];
  let gradient = 0;
  for (let row = y - radius; row <= y + radius; row++) {
    for (let column = x - radius; column <= x + radius; column++) {
      const center = grayImage.data[row * grayImage.cols + column];
      const gx =
        grayImage.data[row * grayImage.cols + column + 1] - grayImage.data[row * grayImage.cols + column - 1];
      const gy =
        grayImage.data[(row + 1) * grayImage.cols + column] -
        grayImage.data[(row - 1) * grayImage.cols + column];
      values.push(center / 255);
      gradient += Math.hypot(gx, gy);
    }
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  const norm = Math.hypot(...centered) || 1;

  return {
    values: centered.map((value) => value / norm),
    gradient: gradient / values.length,
  };
};

export const descriptorDistance = (left, right) => {
  let sum = 0;
  for (let index = 0; index < left.length; index++) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
};
