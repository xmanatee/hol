# Vision Models

This directory contains browser-served model assets for detection and tap-time segmentation.

## Required Files

- `yolo11n_480.onnx` - YOLO11 nano model exported for 480x480 web inference.
- `ptm_512_hdt_ptm_woid.tflite` - MediaPipe Interactive Segmenter model used for tap-time object support masks.

The detector filters COCO classes for person, bottle, cup, and book in `src/cv/detector.worker.js`.
The interactive segmenter runs in `src/cv/interactiveSegmenter.worker.js` and feeds `ObjectSupportMask` into image anchoring.

## Optional Files

- `depth_anything_v2_small.onnx` - monocular depth model used by the `depth-fusion` reconstruction mode.

When this file is absent, `depth-fusion` reports a depth model readiness error and the other reconstruction modes continue to run.
