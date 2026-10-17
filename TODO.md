# Open work

P1: demo correctness, safety, and accessibility. P2: consolidation and measured optimization. Research items require evidence before adoption.
Targets: iPad Pro M4 and Xiaomi Chrome; retain iPhone Safari compatibility. Keep the visual demo local and backend-free.

## Tracking and surface attachment

### Observation validity

- **P1 · Objectness:** Reject background-only discovery using independently labelled negative videos; a confident point-prompt mask is not proof of a distinct object.
  [MediaPipe segmentation](https://ai.google.dev/edge/mediapipe/solutions/vision/interactive_segmenter/web_js)
- **P1 · Feature validity:** Evaluate forward–backward LK checks and patch conditioning; grid seeds, low texture, and long straight edges must not inflate attachment evidence.
  [OpenCV optical flow](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html)
- **P1 · Reflections:** Reject moving glare on printed cans using persistent appearance and geometric agreement; test clipping separately from exposure changes.
  [Specular motion](https://www.cs.cmu.edu/~ILIM/projects/IM/aagrawal/cvpr10/Specular/SpecularSurfaceReconstruction.pdf)
- **P1 · Transparency:** Distinguish glass-surface evidence from refracted/background features; mask membership alone must not establish landmark ownership.
  [Transparent-object geometry](https://sites.google.com/view/cleargrasp)
- **P1 · Local visibility:** Hide or clip the attachment when a hand covers its surface patch, even while other parts of the object remain tracked.
  [Video segmentation](https://github.com/facebookresearch/sam2)

### Geometry and observability

- **P1 · Plane coordinates:** Separate reference-image pixels from Euclidean plane coordinates; rectify oblique references before claiming physical PnP orientation or scale.
  [PnP coordinate requirements](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html)
- **P1 · Camera model:** Quantify the fixed 63° FOV/zero-distortion error on target cameras; support measured intrinsics or explicitly bounded approximate attachment.
  [Camera calibration](https://docs.opencv.org/4.x/dc/dbb/tutorial_py_calibration.html)
- **P1 · Shape selection:** Replace class/aspect-only plane/cylinder decisions with measured fit evidence and an explicit unknown state; avoid forcing arbitrary objects into primitives.
  [Object-pose evaluation](https://bop.felk.cvut.cz/datasets/)
- **P1 · Blank planes:** Add quadrilateral/edge tracking for paper and one laptop surface, with persistent corner identities and readiness independent of generic eight-landmark thresholds.
  [Planar geometry](https://docs.opencv.org/4.x/d9/dab/tutorial_homography.html)
- **P1 · Curved attachments:** Preserve a material-point reference through cylinder rotation, feature turnover, and hand occlusion; whole-object affine motion is not cylinder 6DoF.
  [PnP and surface coordinates](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html)
- **P1 · Ambiguity:** Represent planar flip ambiguity and unobservable rotation on symmetric textureless objects; smoothing or silhouette agreement must not invent missing evidence.
  [IPPE ambiguity](https://github.com/tobycollins/IPPE#resolving-the-flip-ambiguity), [Symmetry-aware pose evaluation](https://bop.felk.cvut.cz/challenges/bop-challenge-2019/)

### Temporal estimation and recovery

- **P1 · Uncertainty:** Replace overlapping smoothing with covariance-aware prediction/update after validating measurements; account for shared evidence and grow uncertainty during visual outages.
  [Kalman estimation](https://homepages.inf.ed.ac.uk/rbf/CVonline/LOCAL_COPIES/WELCH/kalman.1.html)
- **P1 · Readiness:** Calibrate projected attachment/normal uncertainty on held-out clips; heuristic confidence and point count must not masquerade as probability or independent evidence.
  [Measurement uncertainty](https://homepages.inf.ed.ac.uk/rbf/CVonline/LOCAL_COPIES/WELCH/kalman.1.html)
- **P1 · Reference continuity:** Correct refreshed-mask bases jointly with landmark and surface references; retain the original attachment through reinitialization and verified relocalization.
  [Projective reference transforms](https://docs.opencv.org/4.x/d9/dab/tutorial_homography.html)
- **P1 · Identity recovery:** Test similar-object crossings, repeated logos, full turns, and distant re-entry; verify material-point identity, not merely a plausible ORB/XFeat match.
  [XFeat](https://github.com/verlab/accelerated_features), [TAP-Vid](https://github.com/google-deepmind/tapnet/blob/main/tapnet/tapvid/README.md)
- **P1 · Selection under load:** Reproduce green-to-tap rejections in concurrent browser flows; measure queue/observation age and prioritize commitment without accepting stale evidence.
  [Frame timestamps](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)

## Benchmarks and acceptance

### Independent quality evidence

- **P1 · Full funnel:** Add licensed real can, glass, paper, and laptop clips with independent masks, points, visibility, and negative scenes; exercise discovery through face placement without oracle masks.
  [TAP-Vid](https://github.com/google-deepmind/tapnet/blob/main/tapnet/tapvid/README.md), [Pose/mask datasets](https://bop.felk.cvut.cz/datasets/)
- **P1 · Physical rendering:** Generate sequences with independent camera/object/light motion, material-point ground truth, reflections, refraction, and calibrated projection; keep render tooling outside the app runtime.
  [BlenderProc](https://github.com/DLR-RM/BlenderProc)
- **P1 · Product targets:** Define acceptance limits for false green, attachment drift/jitter, wrong identity, outages, and recovery latency; preserve regression floors without treating them as product readiness.
  [Tracking metrics](https://github.com/google-deepmind/tapnet/blob/main/tapnet/tapvid/README.md)
- **P1 · Known replay gaps:** Improve Perception Test `video_5032` tracks `35` (false visibility), `3` (outage), and `0` (re-entry), preserving every query floor.
  [Fixture protocol](tests/fixtures/annotated-vision/README.md), [TAP-Vid evaluation](https://github.com/google-deepmind/tapnet/blob/main/tapnet/tapvid/README.md)
- **P1 · Held-out evaluation:** Separate tuning clips from acceptance clips; ablate class-specific thresholds and recovery exceptions, retaining only improvements that generalize across surfaces and modes.
  [Benchmark protocol](https://github.com/google-deepmind/tapnet/blob/main/tapnet/tapvid/README.md)
- **P2 · Geometry properties:** Add generated invariance tests for reference changes, crop/mirror/resize, irregular frame intervals, and calibration perturbations; check rendered attachment footprints against independent projections.
  [Property-based testing](https://fast-check.dev/docs/introduction/)

### Physical-device acceptance

- **P1 · Sustained latency:** Measure cold/warm camera-to-green, capture-to-display age, tap commitment, frame p95, memory, and thermals for 10 minutes with face/audio active.
  [Frame timing](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [ORT profiling](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
- **P1 · Device lifecycle:** Exercise real permission denial/retry, orientation, browser chrome, camera interruption, background/sleep/resume, and GPU/audio restoration without identity switches.
  [Camera settings](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/getSettings), [WebGL guidance](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- **P1 · Assistive input:** Test VoiceOver/TalkBack, external keyboard, enlarged text, and reduced motion on physical devices; WebKit shell tests do not certify iPad/iPhone camera E2E.
  [Evaluation limits](https://www.w3.org/WAI/test-evaluate/tools/selecting/)

## UI and UX

### Camera interaction

- **P1 · Accidental reset:** Keep selected objects locked through incidental canvas taps/drags; clear through the explicit control and distinguish deliberate taps from cancelled gestures.
  [Pointer cancellation](https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation.html)
- **P1 · Recovery guidance:** Show and announce concise selected-object loss/recovery instructions outside diagnostics; avoid repeated announcements during steady tracking.
  [Status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- **P2 · Placement intent:** Show the prepared attachment point and make clear that tapping selects the object; evaluate explicit surface placement without rebuilding its tracking identity.
  [System/real-world match](https://www.nngroup.com/articles/ten-usability-heuristics/)

### Adaptive controls and visual consistency

- **P1 · Text reflow:** Fix clipped start-screen content and offscreen HUD Stop Camera at 200% text/320px and short landscape; assert viewport bounds and hit-testing, not just scroll width.
  [WCAG reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
- **P1 · Sheet focus:** Prevent mobile drawer focus from reaching covered HUD controls; use coherent modal/inert behavior while preserving useful desktop nonmodal interaction.
  [Unobscured focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html), [Modal dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- **P2 · Task grouping:** Separate Tracking from Face controls; collapse experimental modes, rig tools, and microphone diagnostics, with plain-language capability/cost labels.
  [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- **P2 · Shared controls:** Reuse existing button/color/focus primitives for persona and speech actions; align touch sizing and disabled/error states without adding another UI kit.
  [Touch targets](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)
- **P2 · Speech control:** Expose cancel synthesis and stop playback without clearing the object or camera; keep ownership, feedback, and keyboard access consistent.
  [User control](https://www.nngroup.com/articles/ten-usability-heuristics/)

## Architecture and contracts

- **P2 · Owned mechanisms:** Decompose `ImageAnchorService` around observation, estimation, and recovery ownership; replace cross-service private access with narrow public results, not a generic plugin framework.
  [State ownership](https://react.dev/learn/choosing-the-state-structure)
- **P1 · Explicit eligibility:** Consolidate selection/render readiness into a positive contract; missing presence, pose, or readiness must never authorize an overlay.
  [Avoid contradictory state](https://react.dev/learn/choosing-the-state-structure)
- **P2 · Snapshot semantics:** Unify worker/UI diagnostic fields, reference IDs, timestamps, units, and unavailable values; remove duplicated projections and fabricated zero/success defaults.
  [State normalization](https://react.dev/learn/choosing-the-state-structure)
- **P2 · Error contracts:** Distinguish rejected observations, ordinary target loss, unsupported capability, and runtime faults at worker boundaries; avoid exception-to-low-confidence conversions.
  [Worker ownership and transport](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)

## Efficiency and scheduling

- **P1 · Segmentation isolation:** Decouple slow segmentation from tracking/selection using immutable source-frame ownership, reference-aware mask reprojection, and stale-result rejection; removing `await` alone is unsafe.
  [MediaPipe worker execution](https://ai.google.dev/edge/mediapipe/solutions/vision/interactive_segmenter/web_js)
- **P2 · Frame transport:** Profile canvas readback, RGBA copies, and nested-worker transfers; compare transferable `VideoFrame`/worker capture only where device support and end-to-end latency justify it.
  [VideoFrame](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame), [Transfer ownership](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
- **P1 · Time semantics:** Distinguish presented-frame time from available capture/media timestamps; evaluate delayed delivery, rolling shutter, and stabilization before using motion or IMU priors.
  [Video timestamps](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
- **P2 · Bounded priorities:** Benchmark motion/load-aware CV cadence and resolution; let optional depth/recovery work yield to fresh tracking without weakening evidence or freshness limits.
  [ORT performance diagnosis](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
- **P2 · Render contention:** Profile face/audio and CV together on target GPUs; tune DPR and render scheduling from measured frame age, not isolated model FPS.
  [R3F performance](https://r3f.docs.pmnd.rs/advanced/scaling-performance), [WebGL budgets](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)

## Reliability, assets, and security

- **P1 · Learned-runtime faults:** Expose XFeat initialization/inference failures as capability errors with explicit retry; current warning-only conversion must not look like an ordinary missed match.
  [ORT diagnosis](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
- **P2 · Resource endurance:** Stress repeated camera/mode/retry/context-loss cycles; verify WASM Mats, workers, GPU assets, bitmaps, streams, and audio contexts return to a bounded baseline.
  [WebGL resource lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- **P2 · Deployment transitions:** Extend asset-cache coverage to old tabs across releases, private-mode eviction, interrupted downloads, and offline full-funnel restarts; preserve actionable errors without caching the app shell.
  [Service-worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
- **P2 · CSP:** Replace the eval-based OpenCV loader with a supported module/WASM build before removing `unsafe-eval`; restrict network destinations to the configured AI origin.
  [CSP script execution](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src)
- **P2 · Optional endpoint setup:** Reject unusable HTTPS/loopback configurations early and explain CORS; distinguish configuration from service health before capturing an object image.
  [Mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content), [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)
- **P2 · Local diagnostics:** Validate persisted logger settings and expose bounded fault/stage summaries independently of debug tags; never retain camera/audio payloads or enable remote telemetry.
  [Runtime error reporting](https://developer.mozilla.org/en-US/docs/Web/API/Worker/error_event)

## Checks and development practices

- **P2 · Semantic lint:** Add ESLint-compatible JSX accessibility checks mapped to shared primitives; retain browser axe checks for behavior static rules cannot establish.
  [JSX accessibility lint](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y)
- **P2 · Import boundaries:** Enforce main/worker/renderer ownership with AST/import checks; retain lazy-bundle budgets and avoid adding overlapping linters or a language migration.
  [ESLint import restrictions](https://eslint.org/docs/latest/rules/no-restricted-imports)
- **P2 · Behavioral tests:** Replace source-string/private-method assertions with public outcomes where possible; remove fixed sleeps/`networkidle` readiness while retaining explicit fault injection and asset/policy checks.
  [Playwright testing practices](https://playwright.dev/docs/best-practices)

## Face and audio quality

- **P2 · Lip-sync evidence:** Benchmark the spectral-centroid heuristic against labelled speech or provider phoneme timing; measure audio-output-to-mouth offset rather than calling energy-driven animation phoneme recognition.
  [Audio output timestamps](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp)
- **P2 · Rig acceptance:** Add rendered close-up checks for blink/gaze, extreme combined morphs, neutral recovery, and clipping across attachment angles; named morph targets alone do not establish visual quality.
  [Morph-target animation](https://threejs.org/docs/#api/en/objects/Mesh.morphTargetInfluences)

## Bounded research experiments

- **Research · Point segmentation:** Compare the pinned MagicTouch F32 baseline with current INT8/stateful exports; verify API/output parity and device latency, without mistaking same-image embedding reuse for temporal tracking.
  [MediaPipe models and APIs](https://ai.google.dev/edge/mediapipe/solutions/vision/interactive_segmenter)
- **Research · Temporal masks:** Compare EdgeTAM with SAM 2 as reference only after temporal-memory export parity, permissive asset licensing, and target-device memory/latency measurements.
  [EdgeTAM](https://github.com/facebookresearch/EdgeTAM), [SAM 2](https://github.com/facebookresearch/sam2)
- **Research · Learned points:** Compare an online TAP-family tracker with LK/ORB/XFeat on identical unseen clips; require bounded history, visibility outputs, and a viable browser graph before integration.
  [Tracking Any Point](https://github.com/google-deepmind/tapnet)
- **Research · Depth fusion:** Validate production-size Q4 inference on each execution plan, upstream output parity, and cross-frame relative-depth alignment; per-frame normalization is not consistent metric geometry.
  [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2), [ORT quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)
- **Research · Camera/IMU:** Collect synchronized camera/gyro recordings and calibrate timing/bases before fusion; gyro cannot establish independent object motion, depth, or renewed visual evidence.
  [Device-motion specification](https://w3c.github.io/deviceorientation/)
- **Research · Photometric preprocessing:** Compare exposure normalization and robust patch descriptors on low light/glare; retain only gains without extra false locks, excessive copies, or lost image detail.
  [LK appearance assumptions](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html)

Commands and executable thresholds remain in [README.md](README.md#verification); model/export acceptance details remain in [the experiment protocol](docs/vision-experimentation.md).
