import { XFeatKeyframeRelocalizer } from './xfeat.relocalization.js';
import { createXFeatWorkerMessageHandler } from './xfeatWorkerProtocol.js';

const relocalizer = new XFeatKeyframeRelocalizer();
const handlers = {
  storeReference: (payload) => relocalizer.storeReference(payload),
  relocalize: ({ imageData }) => relocalizer.relocalize(imageData),
  clear: () => {
    relocalizer.clear();
    return true;
  },
};

self.onmessage = createXFeatWorkerMessageHandler({
  handlers,
  postMessage: (message) => self.postMessage(message),
});
