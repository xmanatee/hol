import { AnchorManager } from '../services/AnchorManager.js';
import { loadOpenCVRuntimeInWorker } from './opencv.workerRuntime.js';

let manager = null;

const ensureManager = () => {
  if (!manager) {
    throw new Error('Anchor worker is not initialized');
  }
  return manager;
};

const postState = () => {
  if (manager) {
    self.postMessage({ type: 'state', state: manager.getState() });
  }
};

const createManager = async ({ viewportWidth, viewportHeight, fov, trackingMode }) => {
  const cv = await loadOpenCVRuntimeInWorker();
  manager = new AnchorManager();
  manager.addListener(state => self.postMessage({ type: 'state', state }));
  await manager.initialize(cv, viewportWidth, viewportHeight, fov);
  manager.setTrackingMode(trackingMode);
  return manager.getState();
};

const handlers = {
  initialize: createManager,
  processDetections: ({ detections }) => ensureManager().processDetections(detections),
  createAnchorFromTap: ({ tapPosition, imageData }) => ensureManager().createAnchorFromTap(tapPosition, imageData),
  updateAnchor: ({ imageData, depthContext }) => ensureManager().updateAnchor(imageData, depthContext),
  refreshSegmentationIfNeeded: ({ imageData }) => ensureManager().refreshSegmentationIfNeeded(imageData),
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

self.onmessage = event => {
  const { id, command, payload } = event.data;
  const handler = handlers[command];
  if (!handler) {
    self.postMessage({ type: 'response', id, error: `Unsupported anchor worker command: ${command}` });
    return;
  }

  Promise.resolve(handler(payload || {}))
    .then(result => {
      self.postMessage({
        type: 'response',
        id,
        result,
        state: manager ? manager.getState() : null,
      });
      postState();
    })
    .catch(error => {
      self.postMessage({
        type: 'response',
        id,
        error: error.message,
        state: manager ? manager.getState() : null,
      });
    });
};
