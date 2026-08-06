import { AnchorManager } from '../services/AnchorManager.js';
import { ImageAnchorService } from '../services/ImageAnchorService.js';
import { loadOpenCVRuntimeInWorker } from './opencv.workerRuntime.js';
import { createAnchorWorkerMessageHandler } from './anchorWorkerProtocol.js';
import { createXFeatWorkerRelocalizer } from './xfeatWorkerProvider.js';

let manager = null;
let initializationStarted = false;

const ensureManager = () => {
  if (!manager) {
    throw new Error('Anchor worker is not initialized');
  }
  return manager;
};

const createManager = async ({ viewportWidth, viewportHeight, fov, trackingMode }) => {
  if (initializationStarted) {
    throw new Error('Anchor worker initialization already started');
  }
  initializationStarted = true;

  const cv = await loadOpenCVRuntimeInWorker();
  const nextManager = new AnchorManager({
    imageAnchorService: new ImageAnchorService({
      learnedRelocalizer: createXFeatWorkerRelocalizer(),
    }),
  });
  await nextManager.initialize(cv, viewportWidth, viewportHeight, fov);
  nextManager.setTrackingMode(trackingMode);
  manager = nextManager;
  return true;
};

const handlers = {
  initialize: createManager,
  createAnchorFromTap: ({ tapPosition, imageData }) =>
    ensureManager().createAnchorFromTap(tapPosition, imageData),
  processFrame: async ({ imageData, update, refreshSegmentation, depthContext }) => {
    const anchorManager = ensureManager();
    return {
      updateResult: update ? await anchorManager.updateAnchor(imageData, depthContext) : null,
      segmentationRefreshStarted: refreshSegmentation
        ? anchorManager.refreshSegmentationIfNeeded(imageData)
        : false,
    };
  },
  clearAnchor: () => {
    ensureManager().clearAnchor();
    return true;
  },
  setTrackingMode: ({ mode }) => {
    ensureManager().setTrackingMode(mode);
    return true;
  },
  dispose: () => {
    if (manager) {
      manager.dispose();
      manager = null;
    }
    return true;
  },
};

self.onmessage = createAnchorWorkerMessageHandler({
  handlers,
  getState: () => manager?.getState() ?? null,
  postMessage: (message) => self.postMessage(message),
});
