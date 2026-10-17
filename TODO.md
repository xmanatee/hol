# Open work

P1: demo correctness, safety, and accessibility. P2: consolidation and measured optimization. Research items require evidence before adoption.
Targets: iPad Pro M4 and Xiaomi Chrome; retain iPhone Safari compatibility. Keep the visual demo local and backend-free.
Resolve observation validity before geometry, uncertainty, and device acceptance. Research is an experiment, not a commitment to another framework, model, or backend.

## Tracking and surface attachment

### Observation validity

- **P1 · Independent ownership:** Track segmentation observation age/source separately from mask reprojection age; tracker-propagated masks may gate points but must not independently confirm the same motion or mature its map.
  [Self-update drift](https://www.robots.ox.ac.uk/~tvg/publications/2016/staple.pdf)
- **P1 · Objectness:** Reject background-only discovery using independently labelled negative videos; a confident point-prompt mask is not proof of a distinct object.
  [MediaPipe segmentation](https://ai.google.dev/edge/mediapipe/solutions/vision/interactive_segmenter/web_js)
- **P1 · Feature conditioning:** In `anchor.keypointExtraction.js`, distinguish detected corners from grid seeds; require measured patch conditioning before either can establish attachment evidence.
  [LK conditioning](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html)
- **P1 · Flow verification:** Add bounded forward–backward and appearance checks to `anchor.tracking.js`; test long edges, repetitive letters, blur, exposure changes, and large inter-frame motion.
  [OpenCV optical flow](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html)
- **P1 · Patch ownership:** Account for the whole LK/descriptor patch, not just its center's mask membership; prevent paper edges, handles, and thin objects from tracking background texture.
  [LK windows](https://docs.opencv.org/4.x/dc/d6b/group__video__track.html)
- **P1 · Consensus integrity:** In `_filterOutliers`, use surface-appropriate motion and remove history-based immunity from current outlier rejection; verify small point sets too, and report post-consensus retention.
  [Robust estimation](https://docs.opencv.org/4.x/de/d3e/tutorial_usac.html)
- **P1 · Reflections:** Reject moving glare on printed cans using persistent appearance and geometric agreement; test clipping separately from exposure changes.
  [Specular motion](https://www.cs.cmu.edu/~ILIM/projects/IM/aagrawal/cvpr10/Specular/SpecularSurfaceReconstruction.pdf)
- **P1 · Transparency:** Distinguish glass-surface evidence from refracted/background features; mask membership alone must not establish landmark ownership.
  [Transparent-object geometry](https://sites.google.com/view/cleargrasp)
- **P1 · Local visibility:** Hide or clip the attachment when a hand covers its surface patch, even while other parts of the object remain tracked.
  [Video segmentation](https://github.com/facebookresearch/sam2)
- **P1 · Rigid support:** Test an opening laptop, flexible packaging, and a hand holding a can; select one coherent surface patch rather than treating every point inside one instance mask as one rigid body.
  [Planar-motion assumptions](https://docs.opencv.org/4.x/d9/dab/tutorial_homography.html)

### Geometry and observability

- **P1 · Reconstruction evidence:** Separate primitive-imposed depth from observed geometry; require informative view change and conditioning, and bound the orthographic factorization's perspective error before claiming reconstructed shape.
  [Shape/motion factorization](https://publications.ri.cmu.edu/shape-and-motion-from-image-streams-under-orthography-a-factorization-method)
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
- **P1 · Local pose support:** Gate the face footprint against correspondence geometry and projection sensitivity; a high inlier count on a tiny or nearly collinear patch must not authorize a large extrapolated attachment.
  [Pose geometry](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html), [Degenerate samples](https://docs.opencv.org/4.x/de/d3e/tutorial_usac.html)
- **P2 · Resolution semantics:** Define residual thresholds against working-raster scale and localization noise; test equivalent motion across resolutions rather than assuming fixed pixel thresholds mean equal confidence.
  [Reprojection thresholds](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html)

### Temporal estimation and recovery

- **P1 · Temporal estimation:** Measure lag from stacked position/normal filters and presentation prediction; compare one time-aware estimator, adopting covariance updates only with validated noise and correlated-evidence handling.
  [Kalman estimation](https://homepages.inf.ed.ac.uk/rbf/CVonline/LOCAL_COPIES/WELCH/kalman.1.html)
- **P1 · Readiness:** Calibrate projected attachment/normal uncertainty on held-out clips; heuristic confidence and point count must not masquerade as probability or independent evidence.
  [Measurement uncertainty](https://homepages.inf.ed.ac.uk/rbf/CVonline/LOCAL_COPIES/WELCH/kalman.1.html)
- **P1 · Evidence metrics:** Keep post-consensus LK retention, descriptor inlier ratio, and pose confidence distinct; remove relocalization's ≥50% substitute and bootstrap's fabricated flow-success values from quality decisions.
  [Optical-flow output semantics](https://docs.opencv.org/4.x/dc/d6b/group__video__track.html)
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
- **P1 · Replay failure diagnosis:** Reproduce Perception Test false visibility, long outages, and re-entry fragmentation against current code before tuning; preserve every query floor rather than relying on historical reports or aggregate gains.
  [Fixture protocol](tests/fixtures/annotated-vision/README.md), [TAP-Vid evaluation](https://github.com/google-deepmind/tapnet/blob/main/tapnet/tapvid/README.md)
- **P1 · Held-out evaluation:** Separate tuning clips from acceptance clips; ablate class-specific thresholds and recovery exceptions, retaining only improvements that generalize across surfaces and modes.
  [Benchmark protocol](https://github.com/google-deepmind/tapnet/blob/main/tapnet/tapvid/README.md)
- **P2 · Geometry properties:** Check oblique-reference, crop/mirror/resize, timing, and calibration invariance against independently calibrated projections; avoid testing PnP with the same reference-pixel-as-plane assumption as production.
  [Property-based testing](https://fast-check.dev/docs/introduction/)
- **P1 · Causal ablations:** Vary object, camera, lighting, and background motion independently, including static frames and camera-only rotation; identify which cue actually supports each recovered surface point.
  [Physical rendering](https://github.com/DLR-RM/BlenderProc), [Homography limitations](https://docs.opencv.org/4.x/d9/dab/tutorial_homography.html)

### Physical-device acceptance

- **P1 · Sustained latency:** Measure cold/warm camera-to-green, capture-to-display age, tap commitment, frame p95, memory, and thermals for 10 minutes with face/audio active.
  [Frame timing](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [ORT profiling](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
- **P1 · Device lifecycle:** Exercise real permission denial/retry, orientation, browser chrome, camera interruption, background/sleep/resume, and GPU/audio restoration without identity switches.
  [Camera settings](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/getSettings), [WebGL guidance](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- **P1 · Assistive input:** Test VoiceOver/TalkBack, external keyboard, enlarged text, and reduced motion on physical devices; WebKit shell tests do not certify iPad/iPhone camera E2E.
  [Evaluation limits](https://www.w3.org/WAI/test-evaluate/tools/selecting/)
- **P2 · Dynamic viewport:** Unify the remaining `100vh` camera/video/canvas/3D surfaces against the actual visible viewport; verify browser chrome, pinch zoom, safe areas, and orientation keep image coordinates aligned.
  [Viewport units](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/length), [Visual viewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)

## UI and UX

### Camera interaction

- **P1 · Recovery guidance:** Show and announce concise selected-object loss/recovery instructions outside diagnostics; avoid repeated announcements during steady tracking.
  [Status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- **P2 · Placement intent:** Clarify that tapping selects the object rather than the exact tapped surface pixel; evaluate explicit placement without rebuilding its tracking identity.
  [System/real-world match](https://www.nngroup.com/articles/ten-usability-heuristics/)

### Adaptive controls and visual consistency

- **P2 · Live-scene legibility:** Test candidate outlines and attachment markers on bright, dark, and same-hue footage; provide contrasting boundaries and redundant readiness cues where existing overlays disappear.
  [Non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), [Use of color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- **P2 · Task grouping:** Separate Tracking from Face controls in the current drawer; collapse rig tools and experimental modes, and replace debug vocabulary with task-oriented labels and capability/cost explanations.
  [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- **P2 · Shared controls:** Bring persona actions, 40px mode buttons, mesh labels, and sliders onto shared focus/disabled/error and 44px touch conventions; retain readable text without adding another UI kit.
  [Touch targets](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)
- **P2 · Native dark controls:** Declare the dark color scheme and consolidate semantic status/action colors; align native sliders, checkboxes, and scrollbars with the camera overlay instead of adding decorative themes.
  [Native color scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme), [Interface guidelines](https://github.com/vercel-labs/web-interface-guidelines)
- **P2 · Action prerequisites:** Explain unavailable microphone/persona/depth actions before the user attempts them; distinguish missing selection, missing configuration, unsupported execution, and work in progress.
  [Interaction states](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_disabled_controls)

## Architecture and contracts

### Tracking ownership

- **P2 · Owned mechanisms:** Decompose `ImageAnchorService` around observation, estimation, and recovery ownership; replace cross-service private access with narrow public results, not a generic plugin framework.
  [State ownership](https://react.dev/learn/choosing-the-state-structure)
- **P2 · Mode objectives:** Describe patch-scored geometry separately from direct photometric pose optimization; ablate reconstruction modes against shared acceptance criteria and remove those without independent benefit.
  [Direct photometric estimation](https://cvg.cit.tum.de/research/vslam/dso)

### Observation contracts

- **P2 · Snapshot semantics:** Unify worker/UI diagnostic fields, reference IDs, timestamps, units, and unavailable values; remove duplicated projections and fabricated zero/success defaults.
  [State normalization](https://react.dev/learn/choosing-the-state-structure)
- **P1 · Observation expiry:** Share selected-observation expiry across 3D, HUD, diagnostics, and optional image capture; the renderer expires after 300ms but selected status currently has no equivalent expiry notification.
  [Frame timing](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [Consistent state](https://react.dev/learn/choosing-the-state-structure)
- **P1 · Live image ROI:** Replace `CameraView`'s original selection-region/persona crop with a fresh current-object ROI; reject lost/stale observations before capturing pixels or sending an optional vision request.
  [Canvas source cropping](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage)

- **P2 · Error contracts:** Distinguish rejected observations, ordinary target loss, unsupported capability, and runtime faults at worker boundaries; avoid exception-to-low-confidence conversions.
  [Worker ownership and transport](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)

## Efficiency and scheduling

- **P1 · Budget accounting:** Reconcile the documented 4+6+6+4ms limits with the 16.67ms frame target; separate inclusive/exclusive work, active worker latency, display-amortized cost, and browser/GPU headroom.
  [Browser frame budget](https://web.dev/articles/rendering-performance)
- **P1 · Segmentation isolation:** Decouple slow segmentation from tracking/selection using immutable source-frame ownership, reference-aware mask reprojection, and stale-result rejection; removing `await` alone is unsafe.
  [MediaPipe worker execution](https://ai.google.dev/edge/mediapipe/solutions/vision/interactive_segmenter/web_js)
- **P2 · Frame transport:** Profile canvas readback, RGBA copies, and nested-worker transfers; compare transferable `VideoFrame`/worker capture only where device support and end-to-end latency justify it.
  [VideoFrame](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame), [Transfer ownership](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
- **P1 · Time semantics:** Distinguish presented-frame time from available capture/media timestamps; evaluate delayed delivery, rolling shutter, and stabilization before using motion or IMU priors.
  [Video timestamps](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
- **P2 · Bounded priorities:** Benchmark motion/load-aware cadence and resolution; prioritize fresh tracking while visible and bounded global recovery when lost, with optional depth blocking neither.
  [ORT performance diagnosis](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
- **P2 · Render contention:** Profile face/audio and CV together on target GPUs; tune DPR and render scheduling from measured frame age, not isolated model FPS.
  [R3F performance](https://r3f.docs.pmnd.rs/advanced/scaling-performance), [WebGL budgets](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- **P2 · Snapshot cost:** Measure worker structured-clone bytes and preview construction with the drawer closed; avoid rebuilding/transmitting rich reconstruction diagnostics when only the live pose and compact status are consumed.
  [Structured cloning](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)
- **Research · WASM threads:** Compare single-threaded XFeat and bounded depth thread counts under simultaneous tracking, isolated and non-isolated hosting; choose from end-to-end latency and thermals, not core count alone.
  [ORT runtime flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)

## Reliability, assets, and security

### Runtime health

- **P1 · Learned-runtime faults:** Expose XFeat initialization/inference failures as capability errors with explicit retry; current warning-only conversion must not look like an ordinary missed match.
  [ORT diagnosis](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
- **P2 · Resource endurance:** Stress repeated camera/mode/retry/context-loss cycles; verify WASM Mats, workers, GPU assets, bitmaps, streams, and audio contexts return to a bounded baseline.
  [WebGL resource lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- **P2 · Background scheduling:** Stop optional inference and animation while hidden, discard aged results on return, and resume only after fresh visual evidence; verify this separately from media-track interruption handling.
  [Page visibility](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- **P2 · Local diagnostics:** Validate persisted logger settings and expose bounded fault/stage summaries independently of debug tags; never retain camera/audio payloads or enable remote telemetry.
  [Runtime error reporting](https://developer.mozilla.org/en-US/docs/Web/API/Worker/error_event)

### Distribution and optional services

- **P2 · Deployment transitions:** Extend asset-cache coverage to old tabs across releases, private-mode eviction, interrupted downloads, and offline full-funnel restarts; preserve actionable errors without caching the app shell.
  [Service-worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
- **P2 · CSP:** Replace the eval-based OpenCV loader with a supported module/WASM build before removing `unsafe-eval`; restrict network destinations to the configured AI origin.
  [CSP script execution](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src)
- **P2 · Optional endpoint setup:** Share `localAISetup`/`localAIClient` URL validation; reject mixed content and credential/query/hash mistakes, preserve proxy paths, and explain device-local loopback/CORS before image capture without claiming provider health.
  [Mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content), [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)

## Checks and development practices

### Static contracts

- **P2 · Semantic lint:** Add ESLint-compatible JSX accessibility checks mapped to shared primitives; retain browser axe checks for behavior static rules cannot establish.
  [JSX accessibility lint](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y)
- **P2 · Import boundaries:** Enforce main/worker/renderer ownership with AST/import checks; retain lazy-bundle budgets and avoid adding overlapping linters or a language migration.
  [ESLint import restrictions](https://eslint.org/docs/latest/rules/no-restricted-imports)
- **P2 · Unused surfaces:** Add entry-aware Knip analysis for lazy UI, workers, scripts, and tests; remove verified dead exports/dependencies rather than treating dynamic entry points as unused.
  [Knip entry points](https://knip.dev/overview/getting-started)
- **P2 · Toolchain reproducibility:** Replace `.nvmrc`'s moving `22` selector with a supported patch; pin and verify npm locally and in CI, retaining the current lockfile and strict install policy.
  [Node release policy](https://nodejs.org/en/about/previous-releases), [npm packageManager](https://nodejs.org/api/packages.html#packagemanager)

### Behavioral verification

- **P2 · Behavioral tests:** Replace source-string/private-method assertions with public outcomes where possible; remove fixed sleeps/`networkidle` readiness while retaining explicit fault injection and asset/policy checks.
  [Playwright testing practices](https://playwright.dev/docs/best-practices)
- **P2 · Configured-service UI:** Add bounded browser cases for persona/speech success, provider rejection, pending cancellation, and missing setup using real app services with controlled transport; the default face demo proves only the unconfigured path.
  [Browser network control](https://playwright.dev/docs/network)

## Face and audio quality

### Media lifecycle and ownership

- **P1 · Microphone liveness:** Propagate track end/mute and suspended/interrupted audio states into UI; provide gesture-based resume where needed and never label an interrupted microphone runtime as live.
  [Audio states](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state), [Track termination](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/ended_event)
- **P1 · Playback liveness:** Observe TTS context suspension/interruption after playback starts; expose paused/unavailable output with a gesture-based recovery instead of leaving `isPlaying` and mouth animation active for inaudible speech.
  [Audio context states](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state)
- **P1 · Speech driver ownership:** In `useLipSync`, prioritize the agent's audible TTS over simultaneous microphone mode; restore microphone-driven animation on completion/cancellation and test both sources together.
  [Web Audio analysis](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode)

### Animation evidence

- **P2 · Lip-sync evidence:** Benchmark the spectral-centroid heuristic against labelled speech or provider phoneme timing; measure audio-output-to-mouth offset rather than calling energy-driven animation phoneme recognition.
  [Audio output timestamps](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp)
- **P2 · Rig acceptance:** Check blink/gaze, combined morphs, neutral recovery, and angled clipping in rendered close-ups; schedule idle blink/morph settling independently of CV updates without permanent rendering.
  [Morph targets](https://threejs.org/docs/#api/en/objects/Mesh.morphTargetInfluences), [Demand rendering](https://r3f.docs.pmnd.rs/advanced/scaling-performance)
- **P2 · Surface emergence:** Define appearance/clipping for supported nonplanar attachments, which currently bypass planar emergence; use verified local geometry rather than pretending to provide full object occlusion.
  [Material clipping](https://threejs.org/docs/pages/Material.html)

## Bounded research experiments

- **Research · Point segmentation:** Compare pinned MagicTouch F32 with current INT8/v2 exports; verify the package/model/API tuple (`segment` versus `setImage`+`segment`), licensing and output parity before device timing or adoption.
  [MediaPipe models and APIs](https://ai.google.dev/edge/mediapipe/solutions/vision/interactive_segmenter)
- **Research · Temporal masks:** Compare EdgeTAM with SAM 2 as reference only after temporal-memory export parity, permissive asset licensing, and target-device memory/latency measurements.
  [EdgeTAM](https://github.com/facebookresearch/EdgeTAM), [SAM 2](https://github.com/facebookresearch/sam2)
- **Research · Learned points:** Compare an online TAP-family tracker with LK/ORB/XFeat on identical unseen clips; require bounded history, visibility outputs, and a viable browser graph before integration.
  [Tracking Any Point](https://github.com/google-deepmind/tapnet)
- **Research · Depth fusion:** Validate production-size Q4 output parity, invalid-pixel support, and cross-frame scale/offset alignment on each execution plan; per-frame min/max normalization must not become metric geometry.
  [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2), [ORT quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)
- **Research · Camera/IMU:** Collect synchronized camera/gyro recordings and calibrate timing/bases before fusion; gyro cannot establish independent object motion, depth, or renewed visual evidence.
  [Device-motion specification](https://w3c.github.io/deviceorientation/)
- **Research · Photometric preprocessing:** Compare exposure normalization and robust patch descriptors on low light/glare; retain only gains without extra false locks, excessive copies, or lost image detail.
  [LK appearance assumptions](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html)

Commands and executable thresholds remain in [README.md](README.md#verification); model/export acceptance details remain in [the experiment protocol](docs/vision-experimentation.md).
