import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { OPEN_CV_ASSET_URL } from '../../runtime/capabilityPacks.js';

let cachedOpenCv = null;

const PROCESS_ERROR_EVENTS = Object.freeze(['uncaughtException', 'unhandledRejection']);

const opencvPath = fileURLToPath(OPEN_CV_ASSET_URL);
const opencvDir = dirname(opencvPath);
const requireFromOpenCv = createRequire(opencvPath);

const createSandbox = () => {
  const sandbox = {
    console,
    require: requireFromOpenCv,
    process,
    Buffer,
    WebAssembly,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    TextDecoder,
    TextEncoder,
    performance,
    module: { exports: {} },
    exports: {},
    __dirname: opencvDir,
    __filename: opencvPath,
    Module: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };

  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
};

const isReady = (cv) =>
  typeof cv.Mat === 'function' &&
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

const waitForReady = (cv) =>
  new Promise((resolveOpenCv) => {
    if (isReady(cv)) {
      resolveOpenCv(makePromiseSafe(cv));
      return;
    }

    const interval = setInterval(() => {
      if (isReady(cv)) {
        clearInterval(interval);
        resolveOpenCv(makePromiseSafe(cv));
      }
    }, 5);
  });

const snapshotProcessErrorListeners = () =>
  new Map(PROCESS_ERROR_EVENTS.map((eventName) => [eventName, new Set(process.listeners(eventName))]));

const removeRuntimeProcessErrorListeners = (listenersBeforeLoad) => {
  for (const eventName of PROCESS_ERROR_EVENTS) {
    const existingListeners = listenersBeforeLoad.get(eventName);
    for (const listener of process.listeners(eventName)) {
      if (!existingListeners.has(listener)) process.removeListener(eventName, listener);
    }
  }
};

export const loadOpenCvForNode = () => {
  if (cachedOpenCv) return cachedOpenCv;

  const code = readFileSync(opencvPath, 'utf8');
  const sandbox = createSandbox();
  const processErrorListeners = snapshotProcessErrorListeners();
  vm.runInNewContext(code, sandbox, { filename: opencvPath });
  removeRuntimeProcessErrorListeners(processErrorListeners);
  const cv = sandbox.module.exports || sandbox.cv;

  cachedOpenCv = waitForReady(cv);

  return cachedOpenCv;
};
