import XFeatWorker from './xfeat.worker.js?worker';
import { XFeatWorkerRelocalizer } from './xfeatWorkerClient.js';

export const createXFeatWorkerRelocalizer = () =>
  new XFeatWorkerRelocalizer({
    createWorker: () => new XFeatWorker(),
  });
