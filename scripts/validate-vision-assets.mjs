import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const DIST_ASSETS = join(DIST, 'assets');
const DIST_MODELS = join(DIST, 'models');

const minimumBytes = {
  interactiveWorker: 100_000,
  mediaPipeLoader: 100_000,
  mediaPipeWasm: 1_000_000,
  onnxWasm: 1_000_000,
  yoloModel: 1_000_000,
  interactiveModel: 1_000_000,
  depthModel: 50_000_000,
};

const listFiles = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter(entry => entry.isFile()).map(entry => entry.name);
};

const requireFile = async (directory, fileName, label, minBytes, files = null) => {
  if (files && !files.includes(fileName)) {
    throw new Error(`${label} missing from ${directory}: ${fileName}`);
  }

  const filePath = join(directory, fileName);
  const fileStat = await stat(filePath);
  if (fileStat.size < minBytes) {
    throw new Error(`${label} is too small: ${fileName} (${fileStat.size} bytes)`);
  }

  return filePath;
};

const requireMatchingFile = async (directory, files, pattern, label, minBytes) => {
  const matches = await Promise.all(
    files
      .filter(file => pattern.test(file))
      .map(async fileName => ({
        fileName,
        size: (await stat(join(directory, fileName))).size,
      }))
  );
  if (matches.length === 0) {
    throw new Error(`${label} missing from ${directory}`);
  }

  matches.sort((left, right) => right.size - left.size);
  return requireFile(directory, matches[0].fileName, label, minBytes);
};

const main = async () => {
  const assetFiles = await listFiles(DIST_ASSETS);
  const modelFiles = await listFiles(DIST_MODELS);

  await requireMatchingFile(
    DIST_ASSETS,
    assetFiles,
    /^interactiveSegmenter\.worker-[\w-]+\.js$/,
    'interactive segmenter production worker',
    minimumBytes.interactiveWorker
  );
  await requireMatchingFile(
    DIST_ASSETS,
    assetFiles,
    /^vision_wasm_module_internal-[\w-]+\.js$/,
    'MediaPipe module wasm loader',
    minimumBytes.mediaPipeLoader
  );
  await requireMatchingFile(
    DIST_ASSETS,
    assetFiles,
    /^vision_wasm_module_internal-[\w-]+\.wasm$/,
    'MediaPipe module wasm binary',
    minimumBytes.mediaPipeWasm
  );
  await requireMatchingFile(
    DIST_ASSETS,
    assetFiles,
    /^ort-wasm-simd-threaded-[\w-]+\.wasm$/,
    'ONNX runtime wasm binary',
    minimumBytes.onnxWasm
  );
  await requireFile(
    DIST_MODELS,
    'yolo11n_480.onnx',
    'YOLO detector model',
    minimumBytes.yoloModel,
    modelFiles
  );
  await requireFile(
    DIST_MODELS,
    'ptm_512_hdt_ptm_woid.tflite',
    'MediaPipe interactive segmenter model',
    minimumBytes.interactiveModel,
    modelFiles
  );
  await requireFile(
    DIST_MODELS,
    'depth_anything_v2_small.onnx',
    'Depth Anything V2 Small depth model',
    minimumBytes.depthModel,
    modelFiles
  );

  console.log('Vision assets validated');
};

main();
