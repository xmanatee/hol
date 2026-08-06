import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-web/wasm';
import { createXFeatFeatureExtractor } from '../xfeat.relocalization.js';
import { XFEAT_ASSET_URL, XFEAT_DATA_ASSET_URL } from '../../runtime/capabilityPacks.js';

let modelFilesPromise = null;

const loadModelFiles = () => {
  if (!modelFilesPromise) {
    modelFilesPromise = Promise.all([
      readFile(new URL(XFEAT_ASSET_URL)),
      readFile(new URL(XFEAT_DATA_ASSET_URL)),
    ]);
  }
  return modelFilesPromise;
};

export const createXFeatFeatureExtractorForNode = async () => {
  const [model, modelData] = await loadModelFiles();
  return createXFeatFeatureExtractor({ ort, model, modelData });
};
