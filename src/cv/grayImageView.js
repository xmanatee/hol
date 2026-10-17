export const grayImageView = (image) => {
  const data = image.data;
  const stride = image.step[0];
  return {
    width: image.cols,
    height: image.rows,
    stride,
    data: new Uint8Array(data.buffer, data.byteOffset, (image.rows - 1) * stride + image.cols),
  };
};
