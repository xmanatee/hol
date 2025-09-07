Below is a **sequential, copy-pasteable** plan. Each phase contains: **Context → Steps → Dependencies → Expected result / Acceptance tests**. Keep phases atomic; ship after each.

---

## DONE Phase 1 — Rear-camera capture (mobile-web)

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

**Metric (HUD):**

* **Capture FPS:** frames drawn to CV canvas per second.
  `fps = framesCount / elapsedSeconds` (rolling 2s). Target ≥ 28 FPS (720p).

---

## DONE Phase 2 — R3F overlay scene

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

**Metric (HUD):**

* **Render frame time (ms):** average R3F render duration.
  `t_render_avg = EMA( now() - lastFrameTime )`. Target ≤ 2.5 ms.

---

## DONE Phase 3 — Initial object detection for tap-to-select

**Context**
Use YOLO detection initially to identify objects, then transition to image-based anchoring on user tap.

**Steps**

1. Install `onnxruntime-web` (WebGPU build). Enable WebGPU feature check; fallback to WASM with warning.
2. Load a tiny YOLO-N ONNX model (COCO classes). Pre/postprocess in a WebWorker to avoid main-thread stalls.
3. Run detection every **N=4** frames on the **canvas** at 512 px long side. Filter classes {bottle, cup}.
4. Draw bboxes with confidence scores for user selection.
5. On user tap, choose the highest-score bbox under the tap and **STOP detection**.
6. **Switch to image-based anchoring mode** - detector is no longer needed after tap.

**Dependencies**
onnxruntime-web (webgpu build), a small YOLO ONNX, `offscreenCanvas` (fallback to main thread if not available).

**Expected result**

* Multiple bottles are detected and displayed as selectable regions.
* Tapping a bbox stops detection and switches to anchor mode.

**Acceptance**

* ≥20 FPS with detection every 4th frame on iPhone 16 Pro.
* Clean transition from detection mode to anchor mode on tap.

**Metric (HUD):**

* **Detection amortized cost (ms/frame):** `(sum(detector_ms) / totalFrames)`;
* **Detection active time (%):** % of session time spent in detection mode vs anchor mode.
  Target: detect cost ≤ 4 ms/frame amortized; detection time ≤ 20% after initial selection.

---

## REWORK Phase 4 — Template capture & keypoint extraction  

**Context**
On user tap, stop detection and create a robust image-based anchor using keypoints from the tapped region.

**Steps**

1. **Template Capture**: Capture high-resolution crop of tapped region (inflate by 20% for context).
2. **Library Setup**: Add OpenCV.js dependency (WebAssembly build ~2MB) for feature detection.
3. **Keypoint Extraction**: Extract 100-500 AKAZE/ORB keypoints from template region using WebWorker.
4. **Template Storage**: Store template image + keypoint descriptors + spatial layout for matching.
5. **Initial Tracking Setup**: Initialize Lucas-Kanade optical flow tracker with subset of strongest keypoints.
6. **Anchor State**: Mark anchor as `initializing` → `tracking` once keypoints are extracted.

**Dependencies**
OpenCV.js (WebAssembly), template storage, WebWorker for heavy computation.

**Expected result**

* High-quality template with 100+ keypoints extracted from tapped region.
* Smooth transition from detection mode to keypoint tracking mode.

**Acceptance**

* Template extraction completes in <500ms; keypoints distributed across object features.
* No UI blocking during keypoint extraction.

**Metric (HUD):**

* **Template quality score:** `keypoint_count * spatial_distribution_score * descriptor_uniqueness`
  where spatial_distribution prevents clustering, uniqueness measures descriptor variance.
  Target: Quality score ≥ 0.7.
* **Extraction time (ms):** Template capture + keypoint extraction time. Target ≤ 500ms.

---

## REWORK Phase 5 — Keypoint tracking & stability detection

**Context**
Track template keypoints frame-to-frame and determine when anchor is stable enough for 3D attachment.

**Steps**

1. **Optical Flow Tracking**: Use Lucas-Kanade pyramid to track 50-100 strongest keypoints from template.
2. **Outlier Filtering**: Remove keypoints with high tracking error or inconsistent motion (RANSAC consensus).
3. **Anchor Position**: Compute anchor center as median of tracked keypoint positions (robust to outliers).
4. **Stability Criteria**: Monitor keypoint cluster coherence, velocity, and tracking success rate:
   - ≥70% keypoints tracked successfully
   - Median keypoint velocity < 20 px/s  
   - Cluster standard deviation < 5% of template size
5. **Visual Confirmation**: Show **sparkles** when stable criteria met for 1.0s window.
6. **Keypoint Re-detection**: Re-detect keypoints every 15 frames to refresh tracking pool.

**Dependencies**
OpenCV.js Lucas-Kanade, keypoint clustering algorithms, template from Phase 4.

**Expected result**

* Smooth keypoint tracking with <30% tracking failures per frame.
* Stable anchor detection within 1s of object steadiness.

**Acceptance**

* Tracking survives 30° object rotation; sparkles appear reliably when object is steady.

**Metric (HUD):**

* **Tracking success rate (%):** % of keypoints tracked successfully each frame. Target ≥ 70%.
* **Anchor stability score (0-1):** Combined metric of velocity, coherence, tracking rate. Target ≥ 0.8 for "stable".

---

## REWORK Phase 6 — Homography estimation & surface normal recovery

**Context**
Estimate object pose and surface normal from tracked keypoints for 3D head attachment.

**Steps**

1. **Homography Estimation**: Use tracked keypoints to compute homography between current frame and template.
   - Require minimum 8 keypoint matches for robust estimation
   - Use RANSAC to filter outliers (threshold: 2.5px reprojection error)
   - Accept homography if ≥30 inlier matches found
2. **Surface Normal Recovery**: Decompose homography to recover surface orientation:
   - **Planar objects**: Use `cv.decomposeHomographyMat()` to get plane normal
   - **Cylindrical objects**: Combine homography with ellipse fitting for curved surface normal
   - **Assumption**: Initial template captured with object facing camera (normal ≈ [0,0,1])
3. **Pose Smoothing**: Apply One-Euro filter to position and normal to reduce jitter.
4. **Quality Assessment**: Monitor homography condition number and inlier ratio for stability.

**Dependencies**
OpenCV.js homography estimation, decomposition functions, One-Euro filter.

**Expected result**

* Stable 3D pose estimation surviving 45° object rotations.
* Surface normal pointing approximately toward camera initially.

**Acceptance**

* Normal estimation error <10° for planar objects; position jitter <3px during stability.

**Metric (HUD):**

* **Homography inliers:** Number of RANSAC inlier keypoints. Target ≥ 30.
* **Normal stability (°):** Standard deviation of surface normal over 1s window. Target ≤ 5°.

---

## NEW Phase 6.5 — Anchor persistence & recovery system

**Context**
Maintain anchor through occlusions and handle re-acquisition when object returns.

**Steps**

1. **Tracking Loss Detection**: Monitor keypoint tracking quality and homography estimation.
   - Mark anchor "lost" if <50% keypoints tracked or homography estimation fails
   - Maintain last known pose and template for recovery
2. **Template Matching Fallback**: When keypoint tracking fails:
   - Use normalized cross-correlation with stored template
   - Multi-scale search in expanded region around last known position
   - Accept match if correlation > 0.7 and position within reasonable bounds
3. **Re-acquisition Strategy**: For complete object loss:
   - Keep template active for 5 seconds after loss
   - Periodically attempt template matching in full frame
   - Re-initialize keypoint tracking when object found
4. **State Management**: Handle anchor states: `tracking` → `degraded` → `lost` → `recovered`.

**Dependencies**
Template storage, correlation matching, state machine from previous phases.

**Expected result**

* Brief occlusions (<1s) maintain anchor through fallback tracking.
* Object can be re-acquired after leaving and returning to frame.

**Acceptance**

* 90% success rate for recovery after 2-second occlusion in controlled tests.

**Metric (HUD):**

* **Recovery success rate (%):** Successful re-acquisitions / total loss events. Target ≥ 85%.
* **Persistence time (s):** Average time anchor maintained during partial occlusion. Target ≥ 3s.

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


**Metric (HUD):**

* **Mask IoU stability (%):** IoU between current mask and previous mask warped, over last 1s.
  `IoU = |M_t ∩ W(M_{t-1})| / |M_t ∪ W(M_{t-1})|`. Target ≥ 0.85.
* **Mask cost (ms):** per-frame GrabCut/ellipse SDF time. Target ≤ 6 ms.

---

## DONE Phase 8 — Load face model & attach to surface

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

**Metric (HUD):**

* **Attachment drift (% bbox):** pixel distance between head base and anchor center, normalized by bbox width.
  `drift = ||p_head - p_anchor|| / bbox_w`. Target ≤ 0.05 (5%).
* **Pose solve time (ms):** head pose update cost. Target ≤ 1.5 ms.

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

**Metric (HUD):**

* **Seam contrast ratio:** mean absolute color diff across seam ring (object side vs head side), 0–1.
  `C = mean( |videoRGB - headRGB| ) / 255` on a thin ring. Target ≤ 0.15 by end of animation.
* **Effect FPS:** average during 0–1s animation. Target ≥ 55 FPS.

---

## DONE Phase 10 — Personality bootstrap (vision + LLM)

**Context**
Detect object identity and generate a persona.

**Steps**

1. Capture a sharp ROI frame (pause head animation for 1 frame); upload to your backend.
2. calls a **vision API** (e.g., use image to text OpenAI model). Return `{category, brandOrTitle, textSnippets}`.
3. prompts LLM with a strict schema (JSON) to produce: `{voiceStyle, tone, quirks, 3 one-liners}`. Keep it < 300 tokens.
4. Store persona JSON on client; pick a one-liner as the **greeting**.

**Expected result**

* Persona JSON with deterministic keys; greeting line ready.

**Acceptance**

* Round-trip < 1.5 s on Wi-Fi; graceful fallback persona if vision fails.

**Metric (HUD):**

* **Persona RTT (ms):** vision + LLM end-to-end latency. Target ≤ 1500 ms.

---

## Phase 11 — Voice synthesis (ElevenLabs)

**Context**
Give the persona a voice; avoid exposing keys.

**Steps**

1. Use ElevenLabs WebSocket agent mode
3. Play via WebAudio; create an `AudioContext`, `MediaElementSource` or `AudioBufferSource`, and also a **ScriptProcessor/Analyser** for lip-sync signals (energy + rough spectrum).
4. Handle iOS autoplay by ensuring playback is triggered from the original tap.

**Dependencies**
ElevenLabs API, WebAudio.

**Expected result**

* You hear the greeting in ≤ 700 ms after request.
* Audio plays reliably on iOS.

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

**Metric (HUD):**

* **A/V sync error (ms):** cross-corr peak between envelope(audio) and mouth-open curve. Target |Δ| ≤ 80 ms.
* **Viseme stability (%):** % frames where only 1–2 visemes active (>0.1). Target ≥ 90% (low “mush”).

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

**Metric (HUD):**

* **Gaze error (°):** angle between head forward and camera direction (clamped). Target ≤ 8° during speech.
* **Micro-motion energy:** RMS of head pitch/yaw during speech, degrees. Target 1–3° (natural).

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

**Metric (HUD):**

* **Lost time ratio (%):** time in “lost” / total face-mode time (session). Target ≤ 10%.
* **Exit recovery path:** categorical status: `re-attach <1s` / `exit at 5s`. Target ≥ 80% re-attach.

---

## Phase 15 — Performance & QA hardening

**Context**
Hit consistent real-time budgets on iPhone.

**Steps**

1. Budget per frame (target 30–60 FPS):

   * **Detection mode** (initial): YOLO every 4th frame: 2–4 ms/frame amortized  
   * **Anchor mode** (post-tap): Keypoint tracking + homography: ≤ 6 ms/frame
   * Template matching fallback: ≤ 8 ms (when needed)
   * OpenCV operations (segmentation): ≤ 4 ms
   * R3F render + lip-sync: ≤ 6 ms
   * Margin: ≥ 2 ms
2. Add a perf HUD (stats of each stage).
3. Implement feature flags to disable GrabCut or depth if budgets are exceeded.
4. Memory: ensure workers and textures are disposed on unmount; prevent WebGL context loss.

**Dependencies**
Perf HUD (tiny overlay), metrics timers.

**Expected result**

* 45–60 FPS steady on iPhone 16 Pro with one active head.

**Acceptance**

* 95th percentile frame time < 22 ms; no leaks after 5 minutes.

**Metric (HUD):**

* **95p frame time (ms):** 95th percentile end-to-end per-frame time. Target ≤ 22 ms.
* **Thermal headroom:** average CPU (%) and GPU load proxy (RAF drift or WebGL timer ext), show warning if sustained >80% for 60s.
* **GC pressure:** JS heap used (MB), show delta/min over 5 min; Target: Δ ≤ +30 MB.

---

### Notes / Non-goals kept out of MVP

* **Monocular depth estimation**: MiDaS/Depth-Anything optional; homography-based normals should suffice.
* **Multi-object anchoring**: Single anchor only for MVP; multiple faces out of scope.  
* **Advanced CV libraries**: Speedy Vision could replace OpenCV.js later for performance gains.
* **Deep learning tracking**: Classical keypoint methods sufficient; avoid neural trackers for complexity.
* **Cloud keys**: All API keys via backend; no secrets in client code.

### New System Architecture - Image-Based Anchoring

**Key Changes from Original Plan:**
1. **YOLO Detection**: Only used for initial object selection, then disabled
2. **Keypoint Tracking**: Primary anchor mechanism using AKAZE/ORB + Lucas-Kanade
3. **Template Matching**: Fallback system for recovery and persistence  
4. **Homography Estimation**: Replaces bbox tracking for pose estimation
5. **Surface Normal**: Derived from homography decomposition, not ellipse fitting alone

**Performance Implications:**
- **Memory**: +2MB for OpenCV.js, +template storage per anchor
- **CPU**: Keypoint operations in WebWorker to avoid main thread blocking  
- **Robustness**: Much better survival of object movement, rotation, partial occlusion
- **Accuracy**: True object tracking vs bbox-based approximation

---

### Implementation notes for metrics

* Add a tiny `useHudMetrics()` store (Zustand or Context) with `tick(name, value)` helpers; render HUD top-left as fixed monospace.
* Use **EMA** (α≈0.15) for smoothing, and short rolling windows (1–2s) for stability/jitter metrics.
* Timestamp phases: store `performance.now()` at key events (tap, ElevenLabs WebSocket request, first audio callback).
* For A/V sync: compute per-frame mouth openness `M(t)=Σ visemeWeights` and use a 1D normalized audio envelope from `AnalyserNode`; a simple lag search over ±200 ms (step 10 ms) is sufficient.
* For seam contrast: sample along a precomputed ring UV set at the attachment area (N≈64 samples), avoid reading back the whole framebuffer—sample video texture + head albedo in shader with `EXT_disjoint_timer_query` off; or approximate in CPU using ROI readPixels at low resolution.

These metrics make each phase objectively testable and demo-friendly.

---

### Current folder structure (refactored for better maintainability)

```
/src
  /pages
    HomePage.jsx           # Top-level route
  /views  
    CameraView.jsx         # Main camera interface (refactored)
  /scenes
    OverlayScene.jsx       # R3F WebGL overlay
  /components
    /ui
      UnifiedControlPanel.jsx  # Combined metrics, controls, config, and alerts
    /organisms
      HeadAnchor.jsx       # 3D head positioning
    CameraVideo.jsx        # Video element component
    DetectionCanvas.jsx    # Canvas for CV processing overlay
    SparkleParticles.jsx   # Stability effect particles
  /services
    CameraService.js       # Camera stream management
    DetectionService.js    # YOLO detection (initial selection only)
    ImageAnchorService.js  # Image-based keypoint anchoring  
    AnchorManager.js       # Integrated anchor state management
  /cv
    detector.worker.js     # YOLO ONNX detection worker (initial)
    keypoint.worker.js     # OpenCV keypoint extraction and tracking
    template.worker.js     # Template matching and correlation
    anchor.keypoints.js    # AKAZE/ORB keypoint detection
    anchor.tracking.js     # Lucas-Kanade optical flow tracking
    anchor.homography.js   # Homography estimation and decomposition  
    anchor.persistence.js  # Template matching fallback system
    anchor.normal.js       # Surface normal from homography
    mask.grabcut.js        # Segmentation masking
    oneEuroFilter.js       # Temporal smoothing
  /audio
    ttsClient.js           # ElevenLabs WebSocket agent mode client
    lipSync.js             # Morph target lip-sync
  /hooks
    useAnimationFrame.js   # 30 FPS render loop utilities 
    usePerfHud.js          # Performance monitoring
    useHudMetrics.js       # Unified metrics system
    useCameraSystem.js     # Main camera system orchestration
  /utils
    detectionRenderer.js   # Canvas rendering utilities
```

### Key Architectural Improvements

**Service Layer Pattern**: Core functionality abstracted into service classes:
- `CameraService`: Stream management with event listeners
- `DetectionService`: YOLO detection for initial object selection only
- `ImageAnchorService`: Keypoint-based anchor tracking and pose estimation  
- `AnchorManager`: State management for anchor lifecycle and recovery

**Component Separation**: UI broken into focused, reusable components:
- `UnifiedControlPanel`: Single interface for all controls/metrics/config
- `CameraVideo`: Pure video element wrapper
- `DetectionCanvas`: Canvas with tap handling
- Styling migrated to Tailwind CSS classes

**State Management**: Centralized via `useCameraSystem` hook:
- Orchestrates all services with proper initialization
- Manages cross-service communication
- Provides unified interface to UI components  
- Handles cleanup and resource management

**Developer Experience**: 
- All linting errors resolved
- Modern React patterns (hooks, functional components)
- Proper separation of concerns
- Configurable detection intervals and features
- Collapsible UI sections to reduce screen clutter

### Technical Advantages of Image-Based Anchoring

**Robustness:**
- Survives object rotation up to 45-60° (vs 10-15° for bbox tracking)  
- Handles partial occlusion through keypoint redundancy
- Tracks actual object features, not just detection boundaries
- Recovery possible after complete loss using template matching

**Accuracy:**
- True 3D pose estimation via homography decomposition
- Surface normal derived from actual object geometry  
- Sub-pixel tracking precision with Lucas-Kanade
- Reduced dependency on detection model accuracy

**Performance:**
- YOLO detection only needed for initial selection (not continuous)
- Keypoint tracking ~6ms/frame vs detection ~12ms/frame  
- Better cache locality with template-based operations
- Graceful degradation through multiple fallback layers

### Key Challenges and Mitigations

**Texture Dependency:**
- Challenge: Plain/textureless objects fail keypoint detection
- Mitigation: Template matching fallback + multi-scale correlation

**Lighting Invariance:**  
- Challenge: Illumination changes break tracking
- Mitigation: AKAZE descriptors + normalized correlation + histogram equalization

**Memory Usage:**
- Challenge: Template storage + keypoint descriptors + OpenCV.js
- Mitigation: Single anchor limit + template compression + worker isolation

**Initial Assumption:**
- Challenge: Requires frontal object view for normal estimation  
- Mitigation: Clear UI guidance + validation of initial pose quality

This plan transitions from detection-based to image-based anchoring after user interaction, providing significantly more robust tracking while maintaining real-time performance constraints.
