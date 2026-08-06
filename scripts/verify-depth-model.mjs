import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-web';
import { getCapabilityAsset } from '../src/runtime/capabilityPacks.js';

const MODEL_SIZE = 56;

const main = async () => {
  ort.env.wasm.numThreads = 1;
  const asset = getCapabilityAsset('depth', 'depth-anything-v2-small-q4');
  const model = await readFile(new URL(asset.url));
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });

  if (session.inputNames[0] !== 'pixel_values' || session.outputNames[0] !== 'predicted_depth') {
    throw new Error(`Unexpected depth model contract: ${session.inputNames} -> ${session.outputNames}`);
  }

  const input = new ort.Tensor('float32', new Float32Array(3 * MODEL_SIZE * MODEL_SIZE), [
    1,
    3,
    MODEL_SIZE,
    MODEL_SIZE,
  ]);
  const output = (await session.run({ pixel_values: input })).predicted_depth;
  if (output.type !== 'float32' || output.data.length !== MODEL_SIZE * MODEL_SIZE) {
    throw new Error(`Unexpected depth output: ${output.type} ${output.dims.join('x')}`);
  }
  if (!output.data.every(Number.isFinite)) {
    throw new Error('Depth model produced non-finite output');
  }

  await session.release();
  console.log(`Verified depth model inference contract at ${MODEL_SIZE}x${MODEL_SIZE}`);
};

main();
