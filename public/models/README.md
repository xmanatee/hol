# Vision Models

This directory contains browser-served model assets for detection, tap-time segmentation, and depth-fusion reconstruction.

## Required Files

- `yolo11n_480.onnx` - YOLO11 nano model exported for 480x480 web inference.
- `ptm_512_hdt_ptm_woid.tflite` - MediaPipe Interactive Segmenter model used for tap-time object support masks.
- `depth_anything_v2_small.onnx` - Depth Anything V2 Small ONNX model used by the `depth-fusion` reconstruction mode. Source: `onnx-community/depth-anything-v2-small`, `onnx/model.onnx`.

The detector filters COCO classes for person, bottle, cup, and book in `src/cv/detector.worker.js`.
The interactive segmenter runs in `src/cv/interactiveSegmenter.worker.js` and feeds `ObjectSupportMask` into image anchoring.
Depth inference defaults to a 322px square tensor in `src/cv/depthModelPreprocess.js` to keep live browser inference below the original 518px model cost.
