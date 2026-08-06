const CAPABILITY_CONTENT_TYPES = new Map([
  ['data', 'application/octet-stream'],
  ['glb', 'model/gltf-binary'],
  ['mjs', 'application/javascript'],
  ['onnx', 'application/octet-stream'],
  ['tflite', 'application/octet-stream'],
  ['wasm', 'application/wasm'],
]);

export const getCapabilityAssetContentType = (requestUrl) => {
  const pathname = new URL(requestUrl, 'http://vite.local').pathname;
  if (!pathname.startsWith('/assets/')) {
    return null;
  }

  const extension = pathname.slice(pathname.lastIndexOf('.') + 1);
  return CAPABILITY_CONTENT_TYPES.get(extension) || null;
};

const applyCapabilityAssetContentType = (request, response, next) => {
  const contentType = getCapabilityAssetContentType(request.url);
  if (contentType) {
    response.setHeader('Content-Type', contentType);
  }
  next();
};

export const capabilityAssetMime = () => ({
  name: 'hol-capability-asset-mime',
  configureServer: (server) => {
    server.middlewares.use(applyCapabilityAssetContentType);
  },
  configurePreviewServer: (server) => {
    server.middlewares.use(applyCapabilityAssetContentType);
  },
});
