import { estimateNormal } from './anchor.normal.js';

let cv = null;

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'load') {
    try {
      // Dynamically import OpenCV.js
      importScripts('https://docs.opencv.org/4.9.0/opencv.js');
      cv = await globalThis.cv;
      self.postMessage({ type: 'loaded' });
    } catch (error) {
      self.postMessage({ type: 'error', message: 'Failed to load OpenCV' });
    }
    return;
  }

  if (type === 'estimate') {
    if (!cv) {
      self.postMessage({ type: 'error', message: 'OpenCV not loaded' });
      return;
    }
    const result = estimateNormal(cv, payload.imageData, payload.bbox, payload.cameraMatrix);
    if (result) {
      self.postMessage({ type: 'result', payload: result });
    } else {
      self.postMessage({ type: 'no_result' });
    }
  }
};
