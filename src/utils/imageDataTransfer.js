export const copyImageData = (imageData) => ({
  width: imageData.width,
  height: imageData.height,
  data: new Uint8ClampedArray(imageData.data),
});

export const prepareImageDataTransfer = (imageData) => ({
  imageData: {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data,
  },
  transferList: [imageData.data.buffer],
});
