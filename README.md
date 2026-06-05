# HOL (High on Life)

Mobile-first camera app that detects selectable objects, switches to image-based anchoring after a tap, and renders an animated talking 3D face over the camera feed.

## Runtime Flow

1. `CameraView` starts the rear camera and draws each frame into the processing canvas.
2. `DetectionService` runs YOLO in `detector.worker.js` every fourth frame while the app is in detection mode.
3. `AnchorManager` stores selectable detections and switches to `ImageAnchorService` when the user taps an object.
4. `ImageAnchorService` tracks the selected region with Shi-Tomasi keypoints, Lucas-Kanade optical flow, a persistent object-pose model, homography evidence, and template-matching recovery.
5. `OverlayScene` loads `/3d/untitled.gltf` and drives morph targets through idle morphing, microphone lip sync, and ElevenLabs agent speech state.
6. `UnifiedControlPanel` contains status, metrics, object controls, mesh visibility, logging controls, microphone tuning, and personality actions.

## Commands

```bash
npm run dev
npm run build
npm run lint
npm run preview
```

Camera access on iPhone requires HTTPS. For local device testing, expose the Vite dev server through a trusted HTTPS tunnel or local certificate.

## Required Assets

- `public/models/yolo11n_480.onnx`
- `public/opencv.js`
- `public/ort-wasm-simd-threaded.wasm`
- `public/ort-wasm-simd-threaded.jsep.wasm`
- `public/3d/untitled.gltf`
- `public/3d/untitled.bin`
- `public/3d/textures/lambert5_baseColor.png`

## Optional Services

Personality generation uses OpenAI only when requested. Voice playback lazy-loads the ElevenLabs Conversational AI runtime at the first conversation boundary. Copy `.env.example` to `.env.local` and fill the service values for those paths.

Without service configuration, the camera, detection, anchoring, model rendering, and microphone lip-sync paths still load.

## Current Limits

- The face model is positioned, scaled, rolled, and tilted from the stabilized object-pose model.
- ElevenLabs agent lip-sync uses output audio analysis and alignment events from the Conversational AI SDK.
- The OpenAI key is read by browser code through Vite env variables. Use a backend proxy before shipping publicly.
