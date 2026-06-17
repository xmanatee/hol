# HOL (High on Life)

Mobile-first camera app that lets a user tap an object in the camera feed, segments that object, builds an image anchor from object-owned landmarks, and renders an animated talking 3D face attached to the selected surface.

## Runtime Flow

1. `CameraView` starts the rear camera and draws each frame into the processing canvas.
2. `AnchorManager` accepts a tap without requiring a detector result and asks `InteractiveSegmenterService` for an object mask around the tapped point.
3. If segmentation succeeds, the connected object mask owns keypoint extraction, tracking refresh, reconstruction support, and overlay readiness. If segmentation is unavailable, a small tap-local mask creates a weak candidate anchor.
4. `ImageAnchorService` tracks object-owned Shi-Tomasi landmarks with Lucas-Kanade optical flow, rejects landmarks outside the warped/refreshed mask, and grows the landmark map from the current anchor position.
5. Reconstruction can use sparse landmark structure, semantic parametric surface fitting, direct photometric surfel tracking, or depth-assisted surfel fusion. Auto mode keeps these controls behind the debug UI for normal use.
6. `OverlayScene` loads `/3d/untitled.gltf` and drives morph targets through idle morphing, microphone lip sync, and ElevenLabs agent speech state.
7. `FieldControls` presents a compact field UI by default, with diagnostics, reconstruction preview, mesh visibility, and logging controls in the debug drawer.

## Commands

```bash
npm run dev
npm test
npm run test:vision
npm run vision:quality
npm run vision:benchmark:quick
npm run build
npm run lint
npm run preview
```

Camera access on iPhone requires HTTPS. For local device testing, expose the Vite dev server through a trusted HTTPS tunnel or local certificate.

## Required Assets

- `public/models/yolo11n_480.onnx`
- `public/models/depth_anything_v2_small.onnx`
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

- The face model is positioned, scaled, rolled, and tilted from the selected tracking/reconstruction model.
- ElevenLabs agent lip-sync uses output audio analysis and alignment events from the Conversational AI SDK.
- The OpenAI key is read by browser code through Vite env variables. Use a backend proxy before shipping publicly.
