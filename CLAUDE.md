# HOL (High on Life) - AI Object Personality App

## Project Overview
A fun viral web app inspired by the "High on Life" game where everyday objects get personalities and talk to you through your phone's camera. Users point their camera at objects (bottles, cans, etc.) and animated faces appear to chat with unique personalities.

## Tech Stack
- **Frontend**: React 19 + Vite
- **3D Graphics**: Three.js + React Three Fiber (R3F)
- **Computer Vision**: ONNX Runtime Web (WebGPU/WASM) + OpenCV.js
- **Audio**: Web Audio API + ElevenLabs TTS (via backend proxy)
- **Camera**: getUserMedia with rear camera focus for mobile

## Architecture
```
/src
  /pages
    HomePage.jsx           # Top-level route
  /views
    CameraView.jsx         # Camera capture + canvas overlay
  /scenes
    OverlayScene.jsx       # R3F WebGL overlay
  /components
    /organisms
      HeadAnchor.jsx       # 3D head positioning
  /cv
    detector.worker.js     # Object detection (YOLO)
    tracker.sort.js        # Multi-object tracking
    anchor.normal.js       # Surface normal estimation
    mask.grabcut.js        # Segmentation masking
  /audio
    ttsClient.js           # ElevenLabs backend proxy
    lipSync.js             # Morph target lip-sync
  /hooks
    useAnimationFrame.js   # 30 FPS render loop
    usePerfHud.js          # Performance monitoring
```

## Development Phases
Following the 15-phase plan:
1. **Phase 1-3**: Camera capture → R3F overlay → Object detection
2. **Phase 4-7**: Anchor tracking → Surface normals → Segmentation
3. **Phase 8-12**: 3D head → Face animation → Voice synthesis
4. **Phase 13-15**: Gaze tracking → UX polish → Performance

## Key Technical Requirements
- **Performance**: 30-60 FPS on iPhone, detection every 4th frame
- **Camera**: Rear-facing (`facingMode: 'environment'`)
- **WebGL**: Transparent overlay with correct depth/NDC projection
- **Audio**: iOS-compatible playback with lip-sync morph targets
- **CV Pipeline**: WebWorker-based to avoid main thread blocking

## Development Commands
```bash
npm run dev          # Start development server
npm run build        # Production build
npm run lint         # ESLint with --fix
npm run preview      # Preview build
```

## Mobile Testing
- Primary target: iPhone Safari/Chrome
- Requires HTTPS for camera access
- Test autoplay policies and user gesture requirements
- Verify WebGL context stability during orientation changes

## API Integration
- Backend proxy for ElevenLabs TTS (no client-side keys)
- Vision API for object identification and personality generation
- Rate limiting and error handling for external services

## Performance Budget (per frame @ 60 FPS = 16.67ms)
- Detection (every 4th): 2-4ms amortized
- Tracking/CV: ≤4ms
- OpenCV operations: ≤6ms
- R3F render + lip-sync: ≤6ms
- Safety margin: ≥4ms

## Code Style
- JavaScript only (ES modules). No TypeScript.
- 2-space indentation
- Prefer functional components with hooks
- WebWorkers for heavy CV operations
- Proper cleanup for WebGL/audio resources
- Avoid defensive logic, try-catch blocks, and ambiguous inputs; everything should be predictable and work as expected.
- **No Mocking Logic**: All critical logic must be fully implemented. Only cosmetic changes or follow-ups can be omitted with a `#todo` tag in comments.
