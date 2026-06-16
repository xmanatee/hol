# HOL Vision Improvement Backlog

## Current Truth

- The normal flow is tap-first object anchoring. YOLO is retained as optional/debug context, not the geometry authority.
- Tap-time object support is already implemented with `ObjectSupportMask`, MediaPipe Interactive Segmenter in a worker, tap-local fallback masks, warped mask propagation, and object-owned keypoint filtering.
- Anchor tracking combines Shi-Tomasi keypoints, Lucas-Kanade optical flow, patch keyframe relocalization, homography/object-pose estimation, and three reconstruction modes.
- Latest verified checks in this pass: `node --test src/services/ImageAnchorService.unit.test.js`, `node --test src/cv/anchor.tracking.unit.test.js`, `npm run lint`, `npm run build`, and `git diff --check` pass.
- Latest OpenCV replay status in this pass: `node --test src/cv/syntheticVisionReplay.unit.test.js` still fails on sparse tapered-cup max anchor error and off-center parametric can max anchor error. These are the next reconstruction-quality targets.
- Latest quality matrix from the backlog research pass: `scripts/vision-quality-report.mjs` reported 35/54 passing and 19 failing. Remaining failures are mostly tracking drift and reconstruction/pose-source instability under occlusion, glare, curved surfaces, and busy backgrounds.
- Primary runtime target is still iPhone Safari/Chrome. Heavy CV/model work belongs in workers, with the 16.67 ms frame budget protected.

## Improvement Order

Work through these in order. Each item should be implemented with a focused regression, replay comparison, and cleanup of any redundant older path it replaces.

## P0 - Object-Owned Landmark Quality Model

- Research basis: classical SLAM systems such as COLMAP and ORB-SLAM3 succeed by ranking observations, rejecting outliers, and using long-lived high-quality landmarks; learned trackers such as CoTracker show the value of jointly reasoning over point tracks.
- Current weakness: HOL counts object-owned landmarks but does not yet score each landmark as a durable map element. A point that is old, mask-owned, low residual, spatially useful, and parallax-rich should not be treated like a fresh weak corner.
- Proposed change:
  - Add per-landmark quality fields: mask ownership history, age, successful observations, reprojection/flow residual, descriptor stability, parallax contribution, spatial cell, recovery count, and recent dropout state.
  - Prefer landmarks by quality when estimating planar/object/reconstruction poses.
  - Demote or retire points that repeatedly leave the object mask or only agree with weak similarity fallback.
- Acceptance:
  - Tests prove low-quality background-like points cannot dominate pose selection.
  - Vision quality report has no new failures.
  - At least one existing drift-heavy scenario improves numerically.
- Sources: [COLMAP](https://github.com/colmap/colmap), [ORB-SLAM3](https://github.com/UZ-SLAMLab/ORB_SLAM3), [CoTracker](https://github.com/facebookresearch/co-tracker)

## P0 - Pose Candidate Arbitration Cleanup

- Research basis: robust visual odometry/SLAM systems separate frontend tracking, pose hypotheses, quality scoring, and backend map updates. HOL currently has the pieces, but pose source selection has accumulated many local gates.
- Current weakness: planar homography, object affine pose, sparse reconstruction, parametric surface, direct photometric, centroid recovery, and reference similarity each compete through scattered conditional logic.
- Proposed change:
  - Introduce a single pose candidate scoring function with explicit candidate records: source, position, transform, normal, inliers, residual, confidence, object-owned ratio, map maturity, continuity, and allowed overlay ownership.
  - Keep source-specific estimators separate; centralize only selection and readiness.
  - Delete redundant local gates once their logic is represented in the candidate score.
- Acceptance:
  - Existing source-selection unit tests move to candidate scoring.
  - No swallowed/implicit fallback: rejected candidates carry a reason.
  - `reference_similarity_transform` cannot own overlay readiness in reconstruction modes.
- Sources: [DROID-SLAM](https://github.com/princeton-vl/droid-slam), [ORB-SLAM3 paper](https://ar5iv.labs.arxiv.org/html/2007.11898)

## P0 - Occlusion-Aware Recovery State

- Research basis: video object segmentation systems such as SAM 2, XMem, and Cutie preserve object identity through memory and explicitly handle mask/visibility changes. HOL should copy the state idea, not the heavy model dependency.
- Current weakness: occlusion is inferred indirectly from point counts and residuals. The app needs a clear state for visible, partially occluded, recovering, and lost.
- Proposed change:
  - Derive occlusion state from object-owned ratio, active landmark count, mask coverage continuity, residual spikes, and pose-source dropouts.
  - During partial occlusion, freeze map growth, avoid adding new landmarks, preserve mature landmarks, and prefer conservative recovery poses.
  - After recovery, require a short stable window before new landmarks affect reconstruction.
- Acceptance:
  - Unit tests cover repeated occlusion, glare, and moving-background cases.
  - Busy-background replays do not add background points during occlusion.
  - Overlay readiness remains hidden when pose is background-driven.
- Sources: [SAM 2](https://github.com/facebookresearch/sam2), [XMem](https://github.com/hkchengrex/XMem), [Cutie](https://github.com/hkchengrex/Cutie)

## P1 - Progressive Full-Object Map Growth

- Research basis: multi-view reconstruction depends on view diversity and stable correspondences. A tap-local region is a safe bootstrap, but full-object reconstruction needs controlled expansion.
- Current weakness: growth still sometimes behaves like “more points near the initial support” instead of deliberate object-wide coverage.
- Proposed change:
  - Divide the current object mask/bounds into spatial cells and track coverage per cell.
  - Refresh keypoints preferentially in under-covered object-owned cells.
  - Add growth phases: bootstrap local patch, expand within mask, mature full-object map, lock mature landmarks.
  - Block expansion into cells whose points repeatedly fail mask/pose consistency.
- Acceptance:
  - Tests prove detection/debug boxes do not expand default support.
  - Replay diagnostics show coverage growth across the object, not only near the tap.
  - Full-object growth does not increase background-rejected point counts.
- Sources: [COLMAP MVS docs](https://colmap.github.io/tutorial.html), [DUSt3R](https://github.com/naver/dust3r), [MASt3R](https://github.com/naver/mast3r)

## P1 - Better Keyframe Relocalization

- Research basis: LightGlue/SuperPoint and LoFTR-style matchers outperform hand-built patch descriptors under larger viewpoint and lighting changes, while classical LK flow remains cheaper for normal frames.
- Current weakness: patch relocalization is lightweight but limited under glare, blur, scale change, and repeated texture.
- Proposed change:
  - Keep LK optical flow as the primary frame path.
  - Add a stronger keyframe matcher only for degraded/lost recovery or low-cadence validation.
  - First evaluate an ONNX/browser route for LightGlue/SuperPoint or XFeat-like features in a worker; do not put it on every frame.
  - Compare against the existing patch relocalizer on occlusion and glare fixtures.
- Acceptance:
  - Recovery improves without increasing steady-state frame cost.
  - Worker boundaries are explicit; runtime/provider selection is visible in diagnostics.
  - If learned matching is not mobile-safe, keep the experiment out of production.
- Sources: [LightGlue](https://github.com/cvg/lightglue), [LightGlue paper](https://openaccess.thecvf.com/content/ICCV2023/html/Lindenberger_LightGlue_Local_Feature_Matching_at_Light_Speed_ICCV_2023_paper.html), [LoFTR](https://github.com/zju3dv/LoFTR)

## P1 - Segmentation Refresh Quality Gates

- Research basis: promptable segmentation is best used sparsely on mobile. Google documents MediaPipe web segmentation calls as synchronous, so worker/throttled use is required.
- Current weakness: segmentation refresh exists, but it should become more explicit about why a refreshed mask is accepted, rejected, or ignored.
- Proposed change:
  - Score refresh masks by tap/current-position continuity, coverage bounds, connected component stability, overlap with warped mask, and object-owned landmark agreement.
  - Store the last accepted and last rejected refresh reason for diagnostics.
  - Trigger immediate refresh only when occlusion/recovery state says the existing mask is stale.
- Acceptance:
  - Tests cover empty, oversized, discontinuous, shifted, and good masks.
  - No more than one pending segmentation request.
  - Refresh does not create new object support from debug detections.
- Sources: [MediaPipe Interactive Segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter), [MediaPipe Web Guide](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter/web_js)

## P1 - Surface Prior Selection And Validation

- Research basis: monocular live reconstruction needs priors. Depth/geometry foundation models can infer plausible shape, but observed tracked geometry must remain the authority for AR attachment.
- Current weakness: plane/cylinder/ellipsoid/tapered-surface choices exist, but their validation can be clearer and more tied to observed evidence.
- Proposed change:
  - Make surface prior selection explicit: target class, mask aspect, silhouette curvature, parallax, depth consistency, and reconstruction residual.
  - Add a confidence/rationale object for the selected surface model.
  - Allow fallback from curved prior to planar only when observed geometry supports it, not because the curved model temporarily drops.
- Acceptance:
  - Tests cover book/card/phone, can/bottle, tapered cup, mug, pouch, and ball.
  - Rigid planar targets do not get curved normals from unstable fits.
  - Curved objects do not collapse to planar attachment during brief dropout.
- Sources: [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2), [UniDepth](https://github.com/lpiccinelli-eth/unidepth), [Metric3D](https://github.com/yvanyin/metric3d)

## P2 - Optional Server/Cloud Reconstruction Track

- Research basis: VGGT, DUSt3R/MASt3R, MonST3R, Gaussian Splatting, and modern image-to-3D models are powerful but too heavy for reliable iPhone browser real-time use.
- Current weakness: HOL is a live mobile app, but “perfect full object reconstruction” may require an offline/cloud tier for high-quality assets.
- Proposed change:
  - Add a capture-mode concept separate from live anchoring: collect selected-object keyframes, masks, camera/frame metadata, and quality diagnostics.
  - Export a reconstruction bundle that can be processed by a server pipeline later.
  - Keep generated/offline meshes or splats separate from live pose truth.
- Acceptance:
  - Capture quality tells the user when there is enough view diversity.
  - Live tracking works without the server path.
  - Offline results cannot silently replace live object pose unless calibrated back to tracked landmarks.
- Sources: [VGGT](https://github.com/facebookresearch/vggt), [DUSt3R](https://github.com/naver/dust3r), [MASt3R](https://github.com/naver/mast3r), [MonST3R](https://github.com/junyi42/monst3r), [3D Gaussian Splatting](https://github.com/graphdeco-inria/gaussian-splatting), [gsplat](https://github.com/nerfstudio-project/gsplat)

## P2 - Device Benchmark Harness

- Research basis: browser ML runtime support varies quickly. WebGPU is increasingly available, including Safari 26/iOS 26, but ONNX Runtime WebGPU and mobile stability still need feature probes and fallbacks.
- Current weakness: Node replay tests verify behavior, but not iPhone Safari frame budget, WebGL context stability, camera policy issues, or worker latency.
- Proposed change:
  - Add a debug benchmark route/panel that records camera frame time, anchor update time, segmentation worker latency, detector raw/amortized time, R3F render time, dropped frames, and WebGL context loss.
  - Export compact JSON from real device sessions.
  - Gate new models by device benchmark, not desktop assumptions.
- Acceptance:
  - Browser QA covers desktop and iPhone-sized viewport.
  - HTTPS camera flow is verified.
  - Benchmark output is stable enough to compare before/after changes.
- Sources: [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html), [ONNX WebGPU EP](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html), [WebGPU implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)

## P2 - Model Runtime Profiles

- Research basis: modern browser CV may use WASM, WebGL, WebGPU, WebNN, or server inference. Runtime choice should be explicit and diagnosable.
- Current weakness: adding models ad hoc risks hidden fallbacks, duplicated workers, and unclear performance tradeoffs.
- Proposed change:
  - Define runtime profiles for each model family: detector, interactive segmentation, learned matcher, depth prior, and future cloud/offline path.
  - Each profile should declare provider, cadence, worker ownership, model assets, expected memory, and mobile support.
  - Do not silently switch providers; surface selected runtime in diagnostics.
- Acceptance:
  - No duplicate model loading paths.
  - Runtime failures report actionable reasons.
  - `.env.local` and secrets remain untouched.
- Sources: [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html), [MediaPipe Tasks Vision](https://developers.google.com/edge/mediapipe/solutions/vision)

## P3 - Optional Known-Class Segmentation Profile

- Research basis: YOLO segmentation models can provide masks for known classes at detection/tap cadence, but they do not solve arbitrary tapped-object segmentation.
- Current weakness: detection boxes are still useful debug context, but box geometry should not guide object support.
- Proposed change:
  - Evaluate a small YOLO segmentation model as a separate debug/profile path.
  - Decode masks without changing the existing box detector contract.
  - Compare known-class masks against MediaPipe tap masks on bottles, cups, books, phones, and cans.
- Acceptance:
  - If mask quality/runtime loses to MediaPipe Interactive Segmenter, do not ship it.
  - If shipped, it remains optional and does not re-authorize detection-box geometry.
- Sources: [Ultralytics segmentation](https://docs.ultralytics.com/tasks/segment/), [YOLO11](https://docs.ultralytics.com/models/yolo11/), [Ultralytics export](https://docs.ultralytics.com/modes/export/)

## P3 - Generative 3D Asset Experiments

- Research basis: TripoSR, Stable Fast 3D, InstantMesh, Wonder3D, and Hunyuan3D can synthesize plausible object meshes from one or a few images, but they hallucinate hidden geometry.
- Current weakness: user expectations around “full object reconstruction” can blur observed reconstruction and generated plausible assets.
- Proposed change:
  - Treat image-to-3D as an optional asset-generation mode, not live reconstruction.
  - Use generated meshes only after explicit user action and calibration to tracked object landmarks.
  - Never let generated hidden geometry drive live pose confidence.
- Acceptance:
  - Generated asset state is visually and architecturally separate from observed reconstruction.
  - Tests/diagnostics label generated geometry as inferred, not measured.
- Sources: [TripoSR](https://github.com/VAST-AI-Research/TripoSR), [Stable Fast 3D](https://github.com/Stability-AI/stable-fast-3d), [InstantMesh](https://github.com/tencentarc/instantmesh), [Wonder3D](https://github.com/xxlong0/Wonder3D), [Hunyuan3D 2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2)

## Cleanup Rules For Every Step

- Remove obsolete branches, duplicate helpers, and redundant gates while touching the owning module.
- Prefer one explicit contract over parallel special cases.
- Keep heavy CV in workers or low-cadence paths.
- Add a regression before production behavior changes.
- Compare `scripts/vision-quality-report.mjs` before/after for tracking, reconstruction, and head attachment deltas.
- Keep UI diagnostics compact: operational controls by default, details in debug surfaces.
- Do not add a new model family to the live frame path without a device benchmark and rollback path.

## Do Not Do Yet

- Do not replace tap-first segmentation with detection-box geometry.
- Do not run SAM 2, DUSt3R, VGGT, Gaussian Splatting, or image-to-3D models in the live mobile frame loop.
- Do not mix human-body perception and object anchoring in the same worker contract.
- Do not treat monocular depth or generated meshes as measured object geometry.
- Do not commit model assets or large runtime bundles without measured mobile value.
