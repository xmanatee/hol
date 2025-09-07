# YOLO Models

This directory should contain ONNX model files for object detection.

## Required Model
- `yolov8n.onnx` - YOLOv8 Nano model optimized for web inference

## How to get the model
1. Download YOLOv8n from Ultralytics: https://github.com/ultralytics/ultralytics
2. Export to ONNX format: `yolo export model=yolov8n.pt format=onnx`
3. Place the exported `yolov8n.onnx` file in this directory

## Alternative
For development/testing, you can use any YOLO ONNX model that supports COCO classes.
The detector.worker.js expects bottle (class 39) and cup (class 41) from COCO dataset.