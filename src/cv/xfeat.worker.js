import { XFeatKeyframeRelocalizer } from './xfeat.relocalization.js';
import { createWorkerCommandHandler } from '../utils/workerCommandHandler.js';

const relocalizer = new XFeatKeyframeRelocalizer();
const handlers = {
  storeReference: (payload) => relocalizer.storeReference(payload),
  relocalize: ({ imageData }) => relocalizer.relocalize(imageData),
  clear: () => {
    relocalizer.clear();
    return true;
  },
};

self.onmessage = createWorkerCommandHandler({
  handlers,
  postMessage: (message) => self.postMessage(message),
});
