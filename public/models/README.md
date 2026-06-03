# YOLO Model

This directory contains the ONNX model used by `DetectionService`.

## Required File

- `yolo11n_480.onnx` - YOLO11 nano model exported for 480x480 web inference.

The detector filters COCO classes for person, bottle, cup, and book in `src/cv/detector.worker.js`.
