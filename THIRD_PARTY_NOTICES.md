# Third-party notices

HOL source code is distributed under Apache-2.0. The following binary capability assets are distributed with the application:

| Asset | Revision | License | Source | SHA-256 |
| --- | --- | --- | --- | --- |
| OpenCV.js | 4.9.0 | Apache-2.0 | https://github.com/opencv/opencv/tree/4.9.0 | 4d7b85e2e12ea0bd088f491c311d620a45b53d1489b7f065b4492a230bda243a |
| MediaPipe MagicTouch | model-card release | Apache-2.0 | https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MagicTouch.pdf | 2baa1c9783d03dd26f91e3c49efbcab11dd1361ff80e40e7209e81f84f281b6a |
| MediaPipe Tasks Vision loader | 0.10.35 | Apache-2.0 | https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.35 | 1f1d6215324a1fe62f6742d49a3db911170987ca18ad8c1b75f1a1c82acf2b44 |
| MediaPipe Tasks Vision WASM | 0.10.35 | Apache-2.0 | https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.35 | 617b8e0248dbd27e9d7ece4218004eae4cefb499196d1bb4fa0e3fef21708756 |
| Depth Anything V2 Small Q4 ONNX | f7421df | Apache-2.0 | https://huggingface.co/onnx-community/depth-anything-v2-small/blob/f7421df/onnx/model_q4.onnx | 5d55b02762e1907589158af3e366bd61ddf648155852a07bbf5e3a074639fcf8 |
| XFeat recovery backbone ONNX | f0137e3148b58402bba82960da4e46ded3a279f2 | Apache-2.0 | https://huggingface.co/kornia/xfeat/blob/f0137e3148b58402bba82960da4e46ded3a279f2/xfeat_backbone.onnx | 86d7d549b380405f208933efb5202e1584d9762f3a72e06e7ed81ca1436972e0 |
| XFeat recovery backbone data | f0137e3148b58402bba82960da4e46ded3a279f2 | Apache-2.0 | https://huggingface.co/kornia/xfeat/blob/f0137e3148b58402bba82960da4e46ded3a279f2/xfeat_backbone.onnx.data | d4498528d37bf7c737cce9c135f9b0340d828bab7dc808339e50553ac8c1b7d9 |
| ONNX Runtime Web WASM loader | 1.27.0 | MIT | https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web | 0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3 |
| ONNX Runtime Web WASM | 1.27.0 | MIT | https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web | d1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6 |
| ONNX Runtime Web JSEP loader | 1.27.0 | MIT | https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web | 3ee381d20a80f51a788a1c4a5872f6f1d047538dd4342f4af00062de5f9ea4c6 |
| ONNX Runtime Web JSEP WASM | 1.27.0 | MIT | https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web | 78feeeb3d08f6bcee94d938ed322f69073bb8076b5f9d34697a574ffba8deb48 |
| ONNX Runtime Web Asyncify WASM | 1.27.0 | MIT | https://github.com/microsoft/onnxruntime/tree/v1.27.0/js/web | 7e83cd6cee77e478bc96a7e91b198144fb5e4126287daf1f9b54bb195ebcd55a |
| HOL face GLB | repository contribution | Apache-2.0 | this repository | f193d870737bf633cbd5cb0e39e19e96513d8d9e69bf33118245cf1c73101252 |

The production bundle also includes code from npm dependencies, notably React, Three.js, React Three Fiber, MediaPipe Tasks Vision, ONNX Runtime Web, Tailwind CSS, and their transitive dependencies. npm run sbom generates the complete CycloneDX inventory from the exact lockfile. npm run verify:licenses rejects missing or non-approved dependency and capability-asset licenses.

The face GLB was optimized with glTF-Transform 4.4.2 and Meshopt compression. The build tool is not a runtime dependency; the Meshopt decoder distributed through Three.js is covered by the dependency SBOM.

The repository includes three test-only annotated benchmark fixtures. Google DeepMind releases TAP-Vid RGB-Stacking videos and annotations under CC-BY-4.0. TAP-Vid-DAVIS `shooting` combines the CC-BY-3.0 *Tears of Steel* video with CC-BY-4.0 DeepMind annotations. Perception Test point-tracking videos and annotations are CC-BY-4.0. The fixture manifest separately pins each complete upstream video and annotation archive, sample id, component provenance, and every derived asset by byte length and SHA-256. All fixtures are excluded from the production application.
