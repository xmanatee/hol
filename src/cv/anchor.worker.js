import { AnchorManager } from '../services/AnchorManager.js';
import { ImageAnchorService } from '../services/ImageAnchorService.js';
import { loadOpenCVRuntimeInWorker } from './opencv.workerRuntime.js';
import { createWorkerCommandHandler } from '../utils/workerCommandHandler.js';
import { createAnchorWorkerSnapshot } from './anchorWorkerSnapshot.js';
import { createXFeatWorkerRelocalizer } from './xfeatWorkerProvider.js';
import { ObjectObservationSession } from '../services/ObjectObservationSession.js';

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
  await nextManager.setTrackingMode(trackingMode);
  manager = new ObjectObservationSession({
    manager: nextManager,
    width: viewportWidth,
    height: viewportHeight,
  });
  return true;
};

const handlers = {
  initialize: createManager,
  selectCandidate: (selection) => ensureManager().selectCandidate(selection),
  processFrame: (frame) => ensureManager().processFrame(frame),
  clearAnchor: () => {
    ensureManager().clearAnchor();
    return true;
  },
  setTrackingMode: async ({ mode }) => {
    await ensureManager().setTrackingMode(mode);
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

self.onmessage = createWorkerCommandHandler({
  handlers,
  getState: () => createAnchorWorkerSnapshot(manager?.getState() ?? null),
  postMessage: (message) => self.postMessage(message),
});
