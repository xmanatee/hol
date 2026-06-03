# HOL (High on Life)

Mobile-first camera app that detects selectable objects, switches to image-based anchoring after a tap, and renders an animated talking 3D face over the camera feed.

## Runtime Flow

1. `CameraView` starts the rear camera and draws each frame into the processing canvas.
2. `DetectionService` runs YOLO in `detector.worker.js` every fourth frame while the app is in detection mode.
3. `AnchorManager` stores selectable detections and switches to `ImageAnchorService` when the user taps an object.
4. `ImageAnchorService` tracks the selected region with Shi-Tomasi keypoints, Lucas-Kanade optical flow, homography scoring, and template-matching recovery.
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

Personality generation uses OpenAI and is lazy-loaded only when requested:

```bash
VITE_OPENAI_API_KEY=...
VITE_OPENAI_VISION_MODEL=gpt-4.1-mini
VITE_OPENAI_CHAT_MODEL=gpt-4.1-mini
```

Voice playback uses ElevenLabs Conversational AI:

```bash
VITE_ELEVENLABS_AGENT_ID=...
```

Without these values, the camera, detection, anchoring, model rendering, and microphone lip-sync paths still load.

## Current Limits

- The face model currently renders in a fixed overlay position while the 2D anchor is tracked on the processing canvas.
- ElevenLabs agent audio playback is controlled by the SDK; microphone lip-sync is real, while agent lip-sync uses speech-state simulation.
- The OpenAI key is read by browser code through Vite env variables. Use a backend proxy before shipping publicly.
