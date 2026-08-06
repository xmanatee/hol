import { OPEN_CV_ASSET_URL } from '../runtime/capabilityPacks.js';

let openCVWorkerRuntimePromise = null;

const isReady = (cv) =>
  typeof cv?.Mat === 'function' &&
  typeof cv.goodFeaturesToTrack === 'function' &&
  typeof cv.calcOpticalFlowPyrLK === 'function' &&
  typeof cv.findHomography === 'function' &&
  typeof cv.matFromImageData === 'function';

const makePromiseSafe = (cv) => {
  if (typeof cv.then === 'function') {
    Object.defineProperty(cv, 'then', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }
  return cv;
};

const waitForOpenCVRuntime = ({ cv, timeoutMs, pollIntervalMs }) =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now();

    const poll = () => {
      if (isReady(cv)) {
        resolve(makePromiseSafe(cv));
        return;
      }

      if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error(`Worker OpenCV runtime did not initialize within ${timeoutMs}ms`));
        return;
      }

      setTimeout(poll, pollIntervalMs);
    };

    poll();
  });

export const loadOpenCVRuntimeInWorker = ({
  scriptSrc = OPEN_CV_ASSET_URL,
  timeoutMs = 10000,
  pollIntervalMs = 10,
} = {}) => {
  if (openCVWorkerRuntimePromise) {
    return openCVWorkerRuntimePromise;
  }

  openCVWorkerRuntimePromise = fetch(scriptSrc)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load OpenCV worker script: ${response.status}`);
      }
      return response.text();
    })
    .then((source) => {
      const evaluateOpenCV = new Function(`${source}\nreturn this.cv;`);
      const cv = evaluateOpenCV.call(globalThis);
      return waitForOpenCVRuntime({ cv, timeoutMs, pollIntervalMs });
    })
    .catch((error) => {
      openCVWorkerRuntimePromise = null;
      throw error;
    });

  return openCVWorkerRuntimePromise;
};
