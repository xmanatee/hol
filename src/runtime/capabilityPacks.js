export const OPEN_CV_ASSET_URL = /* @__PURE__ */ new URL('../assets/runtime/opencv.js', import.meta.url).href;

export const OPEN_CV_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'opencv-tracking-runtime',
  kind: 'runtime',
  mediaType: 'application/javascript',
  url: OPEN_CV_ASSET_URL,
  bytes: 10_257_309,
  sha256: '4d7b85e2e12ea0bd088f491c311d620a45b53d1489b7f065b4492a230bda243a',
  license: 'Apache-2.0',
  source: 'https://github.com/opencv/opencv/tree/4.9.0',
  revision: '4.9.0',
  io: 'ImageData -> sparse keypoints, optical flow, descriptors, and pose geometry',
});

export const MAGIC_TOUCH_ASSET_URL = /* @__PURE__ */ new URL(
  '../assets/models/magic-touch-f32.tflite',
  import.meta.url,
).href;

export const MAGIC_TOUCH_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'mediapipe-magic-touch-f32',
  kind: 'model',
  mediaType: 'application/octet-stream',
  url: MAGIC_TOUCH_ASSET_URL,
  bytes: 18_000_426,
  sha256: '2baa1c9783d03dd26f91e3c49efbcab11dd1361ff80e40e7209e81f84f281b6a',
  license: 'Apache-2.0',
  source: 'https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MagicTouch.pdf',
  io: '512x512 RGB image plus point prompt -> 512x512 background and foreground confidence masks',
});

export const DEPTH_ANYTHING_ASSET_URL = /* @__PURE__ */ new URL(
  '../assets/models/depth-anything-v2-small-q4.onnx',
  import.meta.url,
).href;

export const DEPTH_ANYTHING_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'depth-anything-v2-small-q4',
  kind: 'model',
  mediaType: 'application/onnx',
  url: DEPTH_ANYTHING_ASSET_URL,
  bytes: 27_404_416,
  sha256: '5d55b02762e1907589158af3e366bd61ddf648155852a07bbf5e3a074639fcf8',
  license: 'Apache-2.0',
  source: 'https://huggingface.co/onnx-community/depth-anything-v2-small/blob/f7421df/onnx/model_q4.onnx',
  revision: 'f7421df',
  io: 'NCHW float32 RGB tensor -> relative float32 depth map',
});

export const XFEAT_ASSET_URL = /* @__PURE__ */ new URL(
  '../assets/models/xfeat_backbone.onnx',
  import.meta.url,
).href;

export const XFEAT_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'xfeat-recovery-backbone',
  kind: 'model',
  mediaType: 'application/onnx',
  url: XFEAT_ASSET_URL,
  bytes: 187_433,
  sha256: '86d7d549b380405f208933efb5202e1584d9762f3a72e06e7ed81ca1436972e0',
  license: 'Apache-2.0',
  source:
    'https://huggingface.co/kornia/xfeat/blob/f0137e3148b58402bba82960da4e46ded3a279f2/xfeat_backbone.onnx',
  revision: 'f0137e3148b58402bba82960da4e46ded3a279f2',
  io: '256x192 NCHW float32 RGB tensor -> XFeat descriptors, keypoint heatmap, and reliability',
});

export const XFEAT_DATA_ASSET_URL = /* @__PURE__ */ new URL(
  '../assets/models/xfeat_backbone.onnx.data',
  import.meta.url,
).href;

export const XFEAT_DATA_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'xfeat-recovery-backbone-data',
  kind: 'model-data',
  mediaType: 'application/octet-stream',
  url: XFEAT_DATA_ASSET_URL,
  bytes: 2_632_324,
  sha256: 'd4498528d37bf7c737cce9c135f9b0340d828bab7dc808339e50553ac8c1b7d9',
  license: 'Apache-2.0',
  source:
    'https://huggingface.co/kornia/xfeat/blob/f0137e3148b58402bba82960da4e46ded3a279f2/xfeat_backbone.onnx.data',
  revision: 'f0137e3148b58402bba82960da4e46ded3a279f2',
  io: 'External pretrained parameters for the XFeat recovery backbone',
});

export const HEAD_ASSET_URL = /* @__PURE__ */ new URL('../assets/3d/head.glb', import.meta.url).href;

export const HEAD_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'hol-face-meshopt',
  kind: 'model',
  mediaType: 'model/gltf-binary',
  url: HEAD_ASSET_URL,
  bytes: 374_660,
  sha256: 'f193d870737bf633cbd5cb0e39e19e96513d8d9e69bf33118245cf1c73101252',
  license: 'Apache-2.0',
  source: 'HOL repository contribution; optimized with glTF-Transform 4.4.2',
  io: 'glTF 2.0 mesh with 52 named facial morph targets',
});

export const MEDIAPIPE_LOADER_ASSET_URL = /* @__PURE__ */ new URL(
  '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js',
  import.meta.url,
).href;

export const MEDIAPIPE_LOADER_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'mediapipe-vision-wasm-loader',
  kind: 'runtime',
  mediaType: 'application/javascript',
  url: MEDIAPIPE_LOADER_ASSET_URL,
  bytes: 322_082,
  sha256: '1f1d6215324a1fe62f6742d49a3db911170987ca18ad8c1b75f1a1c82acf2b44',
  license: 'Apache-2.0',
  source: 'https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.35',
  revision: '0.10.35',
  io: 'Loads the MediaPipe Tasks Vision WebAssembly runtime',
});

export const MEDIAPIPE_WASM_ASSET_URL = /* @__PURE__ */ new URL(
  '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.wasm',
  import.meta.url,
).href;

export const MEDIAPIPE_WASM_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'mediapipe-vision-wasm',
  kind: 'runtime',
  mediaType: 'application/wasm',
  url: MEDIAPIPE_WASM_ASSET_URL,
  bytes: 11_153_641,
  sha256: '617b8e0248dbd27e9d7ece4218004eae4cefb499196d1bb4fa0e3fef21708756',
  license: 'Apache-2.0',
  source: 'https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.35',
  revision: '0.10.35',
  io: 'Executes MediaPipe Tasks Vision kernels in a worker',
});

export const ORT_JSEP_LOADER_ASSET_URL = /* @__PURE__ */ new URL(
  '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
  import.meta.url,
).href;

export const ORT_JSEP_LOADER_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'ort-webgpu-wasm-loader',
  kind: 'runtime',
  mediaType: 'application/javascript',
  url: ORT_JSEP_LOADER_ASSET_URL,
  bytes: 46_614,
  sha256: '3ee381d20a80f51a788a1c4a5872f6f1d047538dd4342f4af00062de5f9ea4c6',
  license: 'MIT',
  source: 'https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web',
  revision: '1.27.0',
  io: 'Loads the ONNX Runtime WebGPU JSEP WebAssembly runtime',
});

export const ORT_JSEP_WASM_ASSET_URL = /* @__PURE__ */ new URL(
  '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
  import.meta.url,
).href;

export const ORT_JSEP_WASM_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'ort-webgpu-wasm',
  kind: 'runtime',
  mediaType: 'application/wasm',
  url: ORT_JSEP_WASM_ASSET_URL,
  bytes: 26_827_543,
  sha256: '78feeeb3d08f6bcee94d938ed322f69073bb8076b5f9d34697a574ffba8deb48',
  license: 'MIT',
  source: 'https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web',
  revision: '1.27.0',
  io: 'Executes ONNX operators for the WebGPU JSEP provider and WASM fallback',
});

export const ORT_ASYNCIFY_WASM_ASSET_URL = /* @__PURE__ */ new URL(
  '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
  import.meta.url,
).href;

export const ORT_ASYNCIFY_WASM_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'ort-webgpu-asyncify-wasm',
  kind: 'runtime',
  mediaType: 'application/wasm',
  url: ORT_ASYNCIFY_WASM_ASSET_URL,
  bytes: 24_254_953,
  sha256: '7e83cd6cee77e478bc96a7e91b198144fb5e4126287daf1f9b54bb195ebcd55a',
  license: 'MIT',
  source: 'https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web',
  revision: '1.27.0',
  io: 'Executes ONNX CPU nodes used by the WebGPU bundle',
});

export const ORT_WASM_LOADER_ASSET_URL = /* @__PURE__ */ new URL(
  '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  import.meta.url,
).href;

export const ORT_WASM_LOADER_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'ort-wasm-loader',
  kind: 'runtime',
  mediaType: 'application/javascript',
  url: ORT_WASM_LOADER_ASSET_URL,
  bytes: 24_180,
  sha256: '0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3',
  license: 'MIT',
  source: 'https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web',
  revision: '1.27.0',
  io: 'Loads the single-threaded ONNX Runtime WebAssembly recovery runtime',
});

export const ORT_WASM_ASSET_URL = /* @__PURE__ */ new URL(
  '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  import.meta.url,
).href;

export const ORT_WASM_ASSET = /* @__PURE__ */ Object.freeze({
  id: 'ort-wasm',
  kind: 'runtime',
  mediaType: 'application/wasm',
  url: ORT_WASM_ASSET_URL,
  bytes: 13_479_978,
  sha256: 'd1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6',
  license: 'MIT',
  source: 'https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web',
  revision: '1.27.0',
  io: 'Executes the recovery-only XFeat backbone on one WebAssembly thread',
});

const definePack = (pack) =>
  /* @__PURE__ */ Object.freeze({
    schemaVersion: 1,
    dependencies: [],
    ...pack,
    totalBytes: pack.assets.reduce((total, asset) => total + asset.bytes, 0),
  });

export const CAPABILITY_PACKS = /* @__PURE__ */ Object.freeze({
  tracking: /* @__PURE__ */ definePack({
    id: 'tracking',
    version: '1.0.0',
    label: 'Core tracking',
    activation: 'first object tap',
    required: true,
    budget: 'tracking/CV <=4ms amortized per frame',
    runtimes: ['OpenCV.js worker'],
    assets: [OPEN_CV_ASSET],
  }),
  selection: /* @__PURE__ */ definePack({
    id: 'selection',
    version: '1.0.0',
    dependencies: ['tracking'],
    label: 'Tap object selection',
    activation: 'first object tap',
    required: true,
    budget: 'one-shot selection <=6000ms; refresh <=1400ms',
    runtimes: ['@mediapipe/tasks-vision 0.10.35'],
    assets: [MAGIC_TOUCH_ASSET, MEDIAPIPE_LOADER_ASSET, MEDIAPIPE_WASM_ASSET],
  }),
  'learned-recovery': /* @__PURE__ */ definePack({
    id: 'learned-recovery',
    version: '1.0.0',
    dependencies: ['tracking'],
    label: 'Learned appearance recovery',
    activation: 'proven plane at tap time or bounded initial/mature unknown/generic ORB keyframes',
    required: false,
    budget: 'recovery-only inference; zero steady-state frame cost',
    runtimes: ['dedicated nested worker; onnxruntime-web 1.27.0 single-threaded WASM'],
    assets: [XFEAT_ASSET, XFEAT_DATA_ASSET, ORT_WASM_LOADER_ASSET, ORT_WASM_ASSET],
  }),
  depth: /* @__PURE__ */ definePack({
    id: 'depth',
    version: '1.0.0',
    dependencies: ['tracking'],
    label: 'Depth-assisted reconstruction',
    activation: 'depth-fusion mode only',
    required: false,
    budget: 'inference outside hot path at >=260ms intervals',
    runtimes: ['onnxruntime-web 1.27.0; WebGPU then WASM'],
    assets: [DEPTH_ANYTHING_ASSET, ORT_JSEP_LOADER_ASSET, ORT_JSEP_WASM_ASSET, ORT_ASYNCIFY_WASM_ASSET],
  }),
  face: /* @__PURE__ */ definePack({
    id: 'face',
    version: '1.0.0',
    dependencies: ['tracking'],
    label: 'Animated face',
    activation: 'stable anchor only',
    required: true,
    budget: 'R3F render plus lip-sync <=6ms per frame',
    runtimes: ['three 0.180.0; EXT_meshopt_compression'],
    assets: [HEAD_ASSET],
  }),
});

export const getCapabilityPack = (id) => {
  const pack = CAPABILITY_PACKS[id];
  if (!pack) {
    throw new Error(`Unknown capability pack: ${id}`);
  }
  return pack;
};

export const getCapabilityAsset = (packId, assetId) => {
  const asset = getCapabilityPack(packId).assets.find((candidate) => candidate.id === assetId);
  if (!asset) {
    throw new Error(`Unknown asset ${assetId} in capability pack ${packId}`);
  }
  return asset;
};

export const listCapabilityPacks = () => Object.values(CAPABILITY_PACKS);
