Below is a **sequential, copy-pasteable** plan. Each phase contains: **Context → Steps → Dependencies → Expected result / Acceptance tests**. Keep phases atomic; ship after each.

---

## Phase 1 — Rear-camera capture (mobile-web)

**Context**
Provide a full-screen, low-latency rear-camera feed that works on iOS Safari/Chrome.

**Steps**

1. Create `CameraView.jsx` that renders `<video playsInline muted autoplay>` and an offscreen `<canvas>` (same aspect).
2. Request `getUserMedia({ video: { facingMode:'environment', width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30} }, audio:false })`.
3. On iOS, require a user tap to start; call `video.play()` after `loadedmetadata`.
4. Add “Start” UI if autoplay is blocked.
5. Add `useAnimationFrame` hook to draw current frame into the canvas at 30 FPS (will be the CV input).
6. Emit frame timing stats (ms/frame) via `console.table`.

**Dependencies**
React 18, pure JS (js + jsx), Vite/Next, modern mobile Safari/Chrome.

**Expected result**

* Rear camera preview fills screen, correct orientation, stable 30 FPS.
* Canvas buffer updates per frame (verified by drawing a corner FPS counter).

**Acceptance**

* On iPhone, tapping “Start” begins stream; no permission loops; no mirrored feed.

---

## Phase 2 — R3F overlay scene

**Context**
We need a WebGL layer over the video for 3D content.

**Steps**

1. Install `three` and `@react-three/fiber` (R3F).
2. Create `OverlayScene.jsx` positioned absolutely over the video (same CSS size).
3. Use a **PerspectiveCamera** with `fov=63` (approx iPhone wide), `near=0.01`, `far=100`. Keep width/height and DPR synced to DOM size.
4. Render a simple axis gizmo at the screen center for sanity.
5. Export API to place objects via world → NDC helper (`project/unproject` utilities).

**Dependencies**
three, @react-three/fiber.

**Expected result**

* Transparent WebGL canvas overlays the video (pointer events pass through when needed).
* Axis gizmo visible, crisp; resizing/orientation changes keep alignment.

**Acceptance**

* No WebGL context loss; no scroll jank; < 2 ms/frame render cost idle.

---

## Phase 3 — Detector + tracker + tap-to-lock

**Context**
Detect bottles/cups, track them, and let user lock one instance.

**Steps**

1. Install `onnxruntime-web` (WebGPU build). Enable WebGPU feature check; fallback to WASM with warning.
2. Load a tiny YOLO-N ONNX model (COCO classes). Pre/postprocess in a WebWorker to avoid main-thread stalls.
3. Run detection every **N=4** frames on the **canvas** at 512 px long side. Filter classes {bottle, cup}.
4. Implement **SORT** tracker (Kalman + Hungarian). Persist `trackId` across frames.
5. Draw bboxes with track IDs.
6. On user tap, choose the highest-score bbox under the tap; set `activeTrackId`.
7. While locked, keep detection cadence; update lock to the matching track only.

**Dependencies**
onnxruntime-web (webgpu build), a small YOLO ONNX, `offscreenCanvas` (fallback to main thread if not available).

**Expected result**

* Multiple bottles are detected; IDs are stable across motion.
* Tapping a bbox locks selection; a badge “LOCKED #id” appears.

**Acceptance**

* ≥20 FPS with detection every 4th frame on iPhone 16 Pro.
* Lock persists when another bottle enters frame.

---

## Phase 4 — Anchor stability + visual confirmation

**Context**
We need a robust “anchor locked” signal before any 3D.

**Steps**

1. Maintain rolling stats for the locked track: center velocity (px/s), area change %, bbox IoU to EMA.
2. Define stable criteria for 1.0 s window: velocity < 30 px/s AND area delta < 10% AND detection confidence > 0.5 for ≥ 75% of frames.
3. When stable, emit `anchor.state = 'stable'` and spawn **sparkles** (R3F particles) centered on bbox center.
4. If criteria fail for 300 ms, revert `anchor.state = 'tracking'`.

**Dependencies**
None beyond previous.

**Expected result**

* Visual sparkles appear only after \~1 s of steadiness.
* Stability toggles correctly when user jiggles camera.

**Acceptance**

* No false positives during motion; recovery within 300 ms after motion stops.

---

## Phase 5 — Surface orientation (normal) estimation

**Context**
Orient the head correctly using a local surface normal; choose best of planar/cylindrical.

**Steps**

1. Crop ROI = bbox inflated by 15%. Use OpenCV.js on a **WebWorker**.
2. **Planar path:** detect FAST/ORB features; estimate homography H to previous ROI using RANSAC. If inliers ≥ 25 and reprojection err < 2.0, compute plane normal from `decomposeHomographyMat(H, K)`.
3. **Cylindrical path:** run Canny → findContours → fitEllipse. If ellipse valid (minor/major ≥ 0.35; area within \[1.5%, 25%] of ROI), derive tilt `acos(b/a)` and in-plane angle; synthesize an outward normal at bbox center.
4. Choose path by score: planar score = inliers; cylindrical score = `b/a * edgeSupport`. Keep winner; low-pass filter the normal (One-Euro filter).
5. Expose `{position_px, normal_camSpace, confidence}` to R3F.

**Dependencies**
opencv.js (WASM), camera intrinsics K (compute from `fov`, viewport).

**Expected result**

* For books/labels, planar wins; for cans, ellipse wins.
* Normal is temporally smooth; no wild flips.

**Acceptance**

* Normal jitter (angle stddev) < 6° during “stable” anchor.

---

## Phase 6 — Anchor persistence & re-acquisition

**Context**
Keep the anchor alive through brief losses; reattach when it returns.

**Steps**

1. Inside locked ROI, seed 80 Shi-Tomasi points; track with `calcOpticalFlowPyrLK` between frames.
2. If detector misses for ≤10 frames but flow keeps ≥35 points with low error, keep anchor “valid”.
3. If both miss, mark “lost”, freeze the last pose, and show a soft UI hint.
4. Run global detector; for each candidate, match ORB features to the last **template crop**; accept candidate if homography inliers ≥ 30 and IOU with predicted bbox ≥ 0.3; on accept, restore lock and re-init ROI.

**Dependencies**
opencv.js LK/ORB, existing detector/tracker worker.

**Expected result**

* Short occlusions (<⅓ s) don’t drop the anchor.
* After leaving/returning, the same object re-locks within \~1 s.

**Acceptance**

* Reacquisition success ≥90% in controlled tests (exit/enter frame).

---

## Phase 7 — Mask/seam (fast segmentation)

**Context**
We need a soft mask for blending/stretch effect.

**Steps**

1. Initialize **GrabCut** once per lock: foreground = inner 70% of ROI, background = outside.
2. Each frame: warp previous mask using affine from bbox motion; run 1 iter GrabCut refinement.
3. Build a feathered alpha mask (dilate+blur) and expose as a WebGL texture to R3F.
4. Fallback: if GrabCut is too slow (>6 ms), synthesize an elliptical SDF mask from fitted ellipse.

**Dependencies**
opencv.js, WebGL texture upload path.

**Expected result**

* Soft, stable mask around label/body, \~5–6 ms/frame overhead max.
* Mask follows small motions without popping.

**Acceptance**

* Visual seam hides minor misalignments; CPU stays < 70% total.

---

## Phase 8 — Load face model & attach to surface

**Context**
We have a **glTF face with 52 blendshapes** (OK; treat as morph targets).

**Steps**

1. Install `three-stdlib` GLTFLoader; load the model once; find skinned mesh(es); cache `morphTargetDictionary` and `morphTargetInfluences`.
2. Create `HeadAnchor` R3F component: takes `{position_px, normal_camSpace, depthHint}` and computes world pose:

   * Unproject `position_px` at `z = depthFromBox(bbox)` heuristic;
   * Align head’s +Z to the estimated surface normal;
   * Scale head based on bbox width (e.g., headWidth \~ 0.6 \* bboxWidth @ same depth).
3. Render head with PBR material; confirm orientation (eyes toward camera when normal faces camera).

**Dependencies**
three, GLTFLoader.

**Expected result**

* Head appears stuck to object, correct size/orientation.
* Moving phone slightly keeps believable attachment.

**Acceptance**

* Head lateral drift < 5% of bbox width during “stable” anchor.

---

## Phase 9 — “Grow from surface” intro (continuation effect v1)

**Context**
Visual effect: the face emerges from the object and inherits local color near the seam.

**Steps**

1. Add a **projective texturing** shader pass: use the real camera’s projection to sample the live video as a texture inside head’s base material.
2. Blend rule in fragment shader: `albedo = mix(videoSample, headAlbedo, seamMask)` where `seamMask` grows from 0→1 over 800 ms using an animated SDF/NOISE edge.
3. Animate slight vertex displacement along **head local −Z** (towards surface) while scale Y grows 0.1→1.0.
4. Optionally add a thin ring mesh (feathered alpha) to hide seam at start.

**Dependencies**
R3F custom shader material (ShaderMaterial), video texture from `<video>` element.

**Expected result**

* Face “grows out” and initially carries the object’s colors near the seam, then smoothly transitions to its own material.

**Acceptance**

* No visible hard seam; animation completes <1 s; 60 FPS during effect.

---

## Phase 10 — Personality bootstrap (vision + LLM)

**Context**
Detect object identity and generate a persona.

**Steps**

1. Capture a sharp ROI frame (pause head animation for 1 frame); upload to your backend.
2. Backend calls a **vision API** (e.g., Google Vision label + text detection). Return `{category, brandOrTitle, textSnippets}`.
3. Backend prompts LLM with a strict schema (JSON) to produce: `{voiceStyle, tone, quirks, 3 one-liners}`. Keep it < 300 tokens.
4. Store persona JSON on client; pick a one-liner as the **greeting**.

**Dependencies**
Your minimal backend (Next API route/Cloud Function) with API keys; fetch wrapper.

**Expected result**

* Persona JSON with deterministic keys; greeting line ready.

**Acceptance**

* Round-trip < 1.5 s on Wi-Fi; graceful fallback persona if vision fails.

---

## Phase 11 — Voice synthesis (ElevenLabs) with backend proxy

**Context**
Give the persona a voice; avoid exposing keys.

**Steps**

1. Backend: implement `/api/tts` → forwards text + voice params to ElevenLabs TTS; returns audio **stream** (or signed URL). Add simple rate limiting.
2. Client: on entering face mode, call `/api/tts` with the greeting.
3. Play via WebAudio; create an `AudioContext`, `MediaElementSource` or `AudioBufferSource`, and also a **ScriptProcessor/Analyser** for lip-sync signals (energy + rough spectrum).
4. Handle iOS autoplay by ensuring playback is triggered from the original tap.

**Dependencies**
ElevenLabs API, backend proxy route, WebAudio.

**Expected result**

* You hear the greeting in ≤ 700 ms after request.
* Audio plays reliably on iOS.

**Acceptance**

* No CORS/key leaks; < 100 ms jitter once playback starts.

---

## Phase 12 — Lip-sync (52 morphs)

**Context**
Animate mouth shapes from audio in real time.

**Steps**

1. Map your 52 morph names to a standard set (at minimum: `A, E, I, O, U`, plus `M` for closed lips). Build `VISemeMap` object `{visemeName → morphIndex[]}`.
2. From the **AnalyserNode**, compute 20 ms frames: RMS energy and 4-band spectral centroid.
3. Heuristic viseme picker:

   * energy < threshold → `M` (closed)
   * else map spectrum peaks to `A/E/I/O/U` with hysteresis; smooth with 120 ms EMA.
4. Drive morph influences each frame (R3F render loop), clamp sums ≤ 1.0, decay others toward 0.
5. Add **blink** timer (`Eyelid` morph) every 3–6 s random.
6. Expose `useLipSync(audioNode, morphController)` hook with start/stop.

**Dependencies**
WebAudio AnalyserNode; model morph indices.

**Expected result**

* Mouth opens/closes and approximates vowels in sync; no “chatter” when silent.

**Acceptance**

* Audio-video offset |Δ| < 80 ms; idle noise does not trigger mouth.

---

## Phase 13 — Face gaze + head follow

**Context**
The character should look toward the user/camera and subtly react.

**Steps**

1. Compute camera position in world; rotate head so its **eyes** look at camera (limit yaw/pitch to ±25° to avoid extremes).
2. Add micro head motion on voice energy (±2° nod).
3. Keep global normal/pose updated at 15 Hz; if anchor state != stable, freeze gaze but keep idle blinking.

**Dependencies**
R3F scene graph, lip-sync energy.

**Expected result**

* Face appears engaged; subtle nods on emphasized words.

**Acceptance**

* No gimbal flips; motion bounded; 60 FPS maintained.

---

## Phase 14 — Anchor loss & recovery UX

**Context**
Graceful behavior when the object is occluded or user walks away.

**Steps**

1. When `anchor.state = 'lost'` for >400 ms, pause lip-sync and show a small “Where’d you go?” subtitle; fade head opacity to 0.6.
2. Keep **detector** active at low cadence (every 6 frames). On re-attach, fade opacity back to 1.0 and resume speech/idle.
3. If not found in 5 s, exit face mode and return to detection mode with a toast “Tap an object to awaken it.”

**Dependencies**
Existing anchor manager from Phases 3–6.

**Expected result**

* No jarring pops; the app self-recovers or exits cleanly.

**Acceptance**

* Re-attach in ≤1 s when object returns; otherwise exit in 5 s.

---

## Phase 15 — Performance & QA hardening

**Context**
Hit consistent real-time budgets on iPhone.

**Steps**

1. Budget per frame (target 30–60 FPS):

   * Detector (every 4th frame): 8–16 ms amortized → 2–4 ms/frame
   * Tracking + LK/ORB: ≤ 4 ms
   * OpenCV ellipse/GrabCut: ≤ 6 ms
   * R3F render + lip-sync: ≤ 6 ms
   * Margin: ≥ 4 ms
2. Add a perf HUD (stats of each stage).
3. Implement feature flags to disable GrabCut or depth if budgets are exceeded.
4. Memory: ensure workers and textures are disposed on unmount; prevent WebGL context loss.

**Dependencies**
Perf HUD (tiny overlay), metrics timers.

**Expected result**

* 45–60 FPS steady on iPhone 16 Pro with one active head.

**Acceptance**

* 95th percentile frame time < 22 ms; no leaks after 5 minutes.

---

### Notes / Non-goals kept out of MVP

* Monocular depth normals (MiDaS/Depth-Anything) are optional; add later only if normals are too jittery.
* Multi-object simultaneous faces: out of scope for MVP; support one active head.
* Cloud keys always via backend; no keys in client code.

---

### Minimal folder structure (create up front)

```
/src
  /components
    CameraView.jsx
    OverlayScene.jsx
    HeadAnchor.jsx
  /cv
    detector.worker.js
    tracker.sort.js
    anchor.normal.js
    mask.grabcut.js
  /audio
    ttsClient.js
    lipSync.js
  /hooks
    useAnimationFrame.js
    usePerfHud.js
  /backend (if Next.js /api; else separate)
```

This plan is intentionally specific so a junior can implement each phase independently and you can demo at the end of **Phase 9** with a single witty line; Phases 10–12 add personality + voice + lip-sync; 13–15 polish behavior and perf.
