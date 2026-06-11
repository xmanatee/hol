# HOL Vision Improvement Backlog

## Current Baseline

- `npm test` passes: 188 tests, 0 failures, about 138 seconds.
- Current runtime detects selectable objects with `public/models/yolo11n_480.onnx` in `src/cv/detector.worker.js` every fourth frame, then switches to OpenCV-based anchoring after a tap.
- Anchoring currently uses Shi-Tomasi keypoints, Lucas-Kanade optical flow, patch descriptor relocalization, homography/object-pose estimation, and selectable reconstruction engines.
- Primary target remains iPhone Safari/Chrome, where camera access requires HTTPS and the frame budget is 16.67 ms at 60 FPS.

## Implemented: Mask-Guided Anchor Ownership

- `ObjectSupportMask` is now a first-class internal contract for selected-object pixel ownership.
- MediaPipe Interactive Segmenter is integrated behind `InteractiveSegmenterService` and `interactiveSegmenter.worker.js` for tap-time masks.
- The official `ptm_512_hdt_ptm_woid.tflite` model and MediaPipe WASM runtime assets are served locally from `public/`.
- `KeypointDetector.extractKeypoints()` accepts an object-support mask and passes an OpenCV ROI mask into `goodFeaturesToTrack`.
- `ImageAnchorService.createAnchor()` threads object masks into template and tracking keypoint extraction and records mask diagnostics.
- Refresh/reinitialization paths use a cheap warped mask derived from the current anchor transform instead of rerunning segmentation every frame.
- `AnchorManager.createAnchorFromTap()` requests a tap-time mask before creating the image anchor.

## Research Note: DEIMv2-Wholebody49

- Source: https://github.com/PINTO0309/PINTO_model_zoo/tree/main/488_DEIMv2-Wholebody49
- Origin thread: https://github.com/PINTO0309/gazelle-dinov3/issues/8
- Status as of 2026-06-09: real model-zoo artifact, not just a social post.
- It is a human-centric unified model for detection, human-part/keypoint-style boxes, head orientation labels, and instance masks/contours.
- It outputs 49 classes such as body, head, eight head directions, face parts, limbs, side-specific limbs, foot/hand classes, and bone.
- It is not a drop-in replacement for HOL's object detector because it does not target HOL's selectable object classes such as bottles, cups, books, and cans.
- Its released demo path is Python ONNX Runtime with CPU/CUDA/TensorRT providers, not browser JavaScript. The resource tarball is about 956 MB, so direct mobile-web inclusion is not practical.
- Best use for HOL: a later optional human-awareness worker for head direction, person context, hand/body interaction, or "is someone engaging with the object?" signals.

## High-Value Improvements

### P1 - Evaluate YOLO Segmentation For Selectable Objects

- Sources:
  - https://docs.ultralytics.com/tasks/segment/
  - https://docs.ultralytics.com/models/yolo11/
  - https://docs.ultralytics.com/modes/export/
- Why it matters: HOL currently seeds anchors from boxes. Instance masks for COCO objects could seed keypoints only on the selected object, rejecting background corners that later cause drift.
- Proposed experiment:
  - Export a small YOLO segmentation model to ONNX.
  - Build a separate detector profile for segmentation outputs instead of modifying the current YOLO box decoder in place.
  - Use masks only at detection/tap time first, not every frame.
  - Compare anchor quality on book, can, cup, mug, and cluttered-background fixtures.
- Success criteria:
  - Model loads in `onnxruntime-web`.
  - Mask decoding stays within the detection budget when run every fourth frame or on tap.
  - Anchor creation uses fewer background keypoints and improves replay stability.

### P1 - Add A Tap-Time Segmentation Spike

- Sources:
  - MobileSAM: https://github.com/ChaoningZhang/MobileSAM
  - FastSAM: https://github.com/CASIA-LMC-Lab/FastSAM
  - SAM 2: https://github.com/facebookresearch/sam2
- Why it matters: promptable segmentation maps closely to HOL's tap interaction. A model can segment "the thing the user tapped" and produce a better template region than a rectangular box.
- Recommended scope:
  - Start with tap-time segmentation only.
  - Do not run SAM-style segmentation per frame on mobile.
  - Use the mask to constrain keypoint extraction and template recovery.
- Avoid for now:
  - Full SAM 2 video tracking in-browser. It is conceptually relevant but too heavy until proven on target phones.

### P1 - Investigate Learned Local Features For Relocalization

- Sources:
  - XFeat repository: https://github.com/verlab/accelerated_features
  - XFeat paper: https://arxiv.org/abs/2404.19174
- Why it matters: HOL's `PatchKeyframeRelocalizer` uses hand-built normalized patch descriptors. XFeat is designed for lightweight image matching and could be stronger under blur, lighting changes, scale, and viewpoint changes.
- Proposed experiment:
  - Keep Lucas-Kanade optical flow as the primary cheap tracker.
  - Add XFeat only for lost/degraded relocalization, not every frame.
  - Benchmark against the current patch descriptor path using the synthetic replay suite.
- Success criteria:
  - Better recovery rate after occlusion or fast motion.
  - No regression in the 60 FPS frame budget because learned matching runs only at recovery cadence.

### P1 - Split Raw Detection Time From Amortized Cost

- Source in repo: `src/views/CameraView.jsx` records `Detection amortized cost` from the raw detector processing time.
- Why it matters: detection runs every fourth frame, so raw inference time and amortized per-frame cost are different numbers. The HUD should show both to avoid wrong performance decisions.
- Proposed change:
  - Track raw detector time.
  - Track amortized detector cost as `rawTime / detectionInterval`.
  - Add replay or unit coverage for the metric calculation.

### P1 - Keep Model Runtime Abstractions Explicit

- Sources:
  - ONNX Runtime Web: https://onnxruntime.ai/docs/tutorials/web/
  - ONNX Runtime WebGPU EP: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- Why it matters: WebGPU can be faster, but operator support and browser availability vary. HOL currently uses a stable WASM execution provider.
- Proposed experiment:
  - Keep the current WASM detector profile.
  - Add a separate WebGPU compatibility probe for candidate segmentation or feature models.
  - Do not silently switch providers; expose the selected runtime in diagnostics.

### P2 - Add A Human-Awareness Worker Separately From Object Anchoring

- Sources:
  - MediaPipe Pose Landmarker: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker
  - MediaPipe Holistic Landmarker: https://ai.google.dev/edge/mediapipe/solutions/vision/holistic_landmarker
  - DEIMv2-Wholebody49: https://github.com/PINTO0309/PINTO_model_zoo/tree/main/488_DEIMv2-Wholebody49
- Why it matters: human pose/head/hand signals are useful, but they should not contaminate the object detector. HOL's core interaction is still object selection and anchoring.
- Possible uses:
  - Determine whether a person is facing the object.
  - Detect hand proximity before auto-starting object voice.
  - Drive gaze or expression behavior on the 3D face.
- Constraint:
  - Run at low cadence or only when enabled. This must not compete with anchor tracking on the main frame path.

### P2 - Move More Anchor CV Off The Main Thread

- Why it matters: detection is already in a worker, but anchor tracking/reconstruction runs from the camera frame loop. Heavy OpenCV and reconstruction modes can compete with canvas capture, React state updates, and R3F rendering.
- Proposed experiment:
  - Prototype an `anchor.worker.js` boundary for degraded/lost recovery and reconstruction-heavy paths first.
  - Keep synchronous main-thread work only for capture, overlay drawing, and cheap state projection.
- Success criteria:
  - Lower frame-time spikes on mobile during occlusion, relocalization, and reconstruction map growth.

### P2 - Build A Device Benchmark Harness

- Why it matters: synthetic replay tests are strong, but they run in Node and do not answer iPhone Safari timing questions.
- Proposed experiment:
  - Add a browser benchmark route or debug mode that records detector raw time, amortized time, anchor update time, render frame time, WebGL context loss, and orientation-change recovery.
  - Export a compact JSON report from real device runs.
  - Test HTTPS iPhone Safari/Chrome before accepting new model work.

## Segmentation And Reconstruction Research

### First-Principles Read

- Segmentation answers "which pixels belong to the selected object?"
- Tracking answers "where did those pixels move?"
- Reconstruction answers "what 2D/3D surface model explains the tracked object over time?"
- A mask by itself does not produce true 3D. It can produce a cleaner object support region, better foreground/background rejection, and a stronger silhouette prior.
- True monocular 3D reconstruction needs either multiple views/correspondences over time, known camera motion/intrinsics, or a learned shape/depth prior. HOL already has the multi-view path through tracked landmarks and reconstruction modes.
- The most useful near-term role for segmentation is therefore not "replace tracking"; it is "make tracking and reconstruction trust only the selected object's pixels."

### P1 - Add An Object Support Mask Contract

- Why it matters: every segmentation option should feed one clean internal shape instead of leaking model-specific tensors into anchoring.
- Proposed contract:
  - `mask`: binary or confidence mask in frame coordinates, possibly downsampled.
  - `bbox`: tight bounding box around the mask.
  - `source`: `interactive-segmenter`, `yolo-seg`, `warped-mask`, `manual-roi`, or `future-vos`.
  - `confidence`: object-support confidence, separate from detector confidence.
  - `createdAtFrame` and `updatedAtFrame`.
  - `referencePoint`: the original tap in mask coordinates.
- Consumers:
  - Keypoint extraction should accept an object mask and reject corners outside it.
  - Relocalization should prefer matches inside the current propagated mask.
  - Reconstruction should use the mask bounds/silhouette to choose plane/cylinder/cup/ellipsoid priors.

### P1 - Use MediaPipe Interactive Segmenter As The Cleanest Tap-Time Mask Spike

- Sources:
  - Overview: https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter
  - Web JS guide: https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter/web_js
- Why it fits HOL:
  - HOL already has a tap point.
  - The model is explicitly designed to segment the object at a selected point.
  - It supports web JavaScript through `@mediapipe/tasks-vision`.
- Important constraint:
  - MediaPipe documents `segment()` and `segmentForVideo()` as synchronous calls that block the UI thread, so this must run in a worker if used on camera frames.
- Recommended experiment:
  - Run interactive segmentation only when the user taps an object.
  - Store the mask as the anchor's initial object support.
  - Pass the mask into Shi-Tomasi keypoint extraction using OpenCV's `goodFeaturesToTrack` mask argument instead of the current empty mask.
  - Keep all existing tracking/reconstruction logic at first.
- Success criteria:
  - Higher template quality on cluttered backgrounds.
  - Fewer background keypoints.
  - Better replay stability through partial occlusion.

### P1 - Propagate The Mask With Existing Geometry Instead Of Segmenting Every Frame

- Sources:
  - MediaPipe object detection/tracking pattern: https://developers.googleblog.com/object-detection-and-tracking-using-mediapipe/
  - MediaPipe Instant Motion Tracking: https://developers.googleblog.com/instant-motion-tracking-with-mediapipe/
  - MediaPipe KNIFT: https://developers.googleblog.com/mediapipe-knift-template-based-feature-matching/
- Why it fits HOL:
  - HOL already estimates planar transforms, object pose, and reconstruction pose.
  - A warped mask is much cheaper than re-running segmentation.
  - Google/MediaPipe's long-running mobile pattern is also "run heavy perception sparsely, track cheaply between inferences."
- Proposed path:
  - On anchor creation, get a mask.
  - On each frame, warp the reference mask with the best available transform: planar homography first, then affine/object-pose transform, then tracker similarity.
  - Use the warped mask to reject tracked points that drift outside the object.
  - Trigger re-segmentation only when mask/keypoint agreement collapses.
- Success criteria:
  - Mask update cost is much lower than ML segmentation.
  - Anchor stays attached to the selected object instead of nearby background texture.
  - The mask remains useful even when the object is partly occluded.

### P1 - Evaluate YOLO Segment Models For Known Selectable Classes

- Sources:
  - Segmentation task: https://docs.ultralytics.com/tasks/segment/
  - Tracking mode with Detect/Segment/Pose models: https://docs.ultralytics.com/modes/track/
  - Export mode: https://docs.ultralytics.com/modes/export/
- Why it fits:
  - HOL already uses a YOLO-family ONNX detector.
  - Segment models are a natural replacement for the current box-only detector when the target classes are known.
- Limits:
  - This helps bottles/cups/books/persons if the model covers them.
  - It does not solve arbitrary tapped-object segmentation unless the model is trained for those objects.
  - Browser ONNX output decoding for masks is more complex than the current box-only tensor path.
- Recommended experiment:
  - Use a small segmentation model as a separate detector profile.
  - Decode masks at detection cadence or only on tap.
  - Compare against MediaPipe Interactive Segmenter for mask quality and mobile runtime.

### P2 - Treat SAM 2, XMem, And Cutie As Future VOS References, Not Immediate Mobile-Web Dependencies

- Sources:
  - SAM 2: https://ai.meta.com/research/sam2/
  - SAM 2 code: https://github.com/facebookresearch/sam2
  - XMem: https://github.com/hkchengrex/XMem
  - Cutie: https://github.com/hkchengrex/Cutie
- Why they matter:
  - These systems are closer to "nice segmentation on video" in the research sense: select an object and maintain its mask over time.
  - SAM 2 is promptable for images and videos and uses session memory for tracking objects across video frames.
  - XMem and Cutie show the memory-based VOS architecture that preserves object identity over long sequences.
- Why not first:
  - They are not shaped for lightweight iPhone Safari integration.
  - They introduce model memory, large feature tensors, and runtime complexity beyond HOL's current frame budget.
- Useful takeaway:
  - Copy the architecture idea, not the dependency: keep a compact object memory and update it only when confidence requires it.

### P2 - Use Depth Or Feed-Forward 3D Only As Priors, Not As The Main Mobile Path

- Sources:
  - Depth Anything V2: https://github.com/DepthAnything/Depth-Anything-V2
  - VGGT: https://github.com/facebookresearch/vggt
  - DUSt3R: https://github.com/naver/dust3r
  - MASt3R: https://github.com/naver/mast3r
- First-principles position:
  - "Reconstruction right away" from one RGB frame is only possible with a prior. It can estimate plausible depth or shape, not observed object geometry.
  - Depth Anything V2 can provide relative depth and edge-aware depth cues, but it is scene-level, not object-identity tracking.
  - VGGT/DUSt3R/MASt3R are important research directions for dense 3D, but they are too heavy for the current mobile web loop.
- Practical near-term use:
  - Use class/mask-driven parametric priors immediately: plane for books/screens, cylinder for cans, tapered cylinder for cups, ellipsoid for balls.
  - Let tracked multi-view evidence refine the prior over time.
  - Consider depth only as a low-cadence debug/research signal after segmentation and tracking are stable.

### Recommended Architecture: Mask-Guided Reconstruction

1. Detection mode keeps the existing YOLO box detector.
2. User taps a detection or free point.
3. A worker runs tap-time segmentation and returns an `ObjectSupportMask`.
4. `ImageAnchorService.createAnchor` extracts keypoints inside the mask, not inside the full rectangle.
5. The existing tracker/reconstructor runs as it does today.
6. Each frame warps the reference mask by the selected pose/transform.
7. Keypoints outside the warped mask are demoted or rejected.
8. Reconstruction uses mask shape to choose and constrain the surface prior.
9. When confidence drops, run re-segmentation or YOLO-seg refresh at low cadence.

This keeps the current architecture intact while giving it object ownership. It is the cleanest path to "keep reconstructing a specific segmented object" without betting the frame budget on full video segmentation.

## Ready/Open-Source Option Assessment

### Best Fit Now

| Option | What It Gives | Why It Fits HOL | Main Risk | Verdict |
|---|---|---|---|---|
| MediaPipe Interactive Segmenter | Point-prompted object mask in web JS | HOL's user tap is exactly the prompt this model expects | Synchronous calls block UI unless moved to worker | Best first segmentation spike |
| YOLO Segment via ONNX Runtime Web | Instance masks for known COCO/custom classes | HOL already uses YOLO ONNX and targets known objects | Mask postprocessing and model size are higher than box-only YOLO | Best detector-family upgrade |
| Mask propagation with OpenCV geometry | Per-frame object support from a cheap warped mask | Uses HOL's existing planar/object/reconstruction transforms | Mask drift if geometry is wrong | Best per-frame strategy |
| XFeat ONNX | Stronger feature matches/relocalization | Targets the weak point of hand-built patch descriptors | ONNX/browser integration needs proof | Best learned-feature spike |

### Useful But Secondary

| Option | What It Gives | Fit | Main Risk | Verdict |
|---|---|---|---|---|
| MediaPipe Object Detector + Model Maker | Ready/custom TFLite object detection | Could replace YOLO if TFLite Tasks are simpler on mobile | Does not solve masks unless paired with segmenter | Consider only if YOLO runtime becomes a problem |
| MediaPipe KNIFT | Learned template matching concept | Very relevant to relocalization | Legacy solution support ended in 2023 | Use concept/reference, not dependency |
| MediaPipe Objectron | 3D boxes for cups/chairs/shoes/cameras | Cup class overlaps HOL | Legacy solution support ended in 2023 and class coverage is narrow | Reference only |
| LightGlue/SuperPoint ONNX | High-quality image matching | Strong relocalization candidate | Heavier and less browser-stable than XFeat; WebGPU issues reported | Research after XFeat |
| Depth Anything V2 ONNX/Transformers.js | Relative depth prior | Can help choose rough object depth/occlusion hints | Not object-specific and not true reconstruction | Low-cadence research only |

### Powerful But Not First

| Option | What It Gives | Why It Is Tempting | Why It Is Not First |
|---|---|---|---|
| SAM 2 | Promptable image/video segmentation with memory | Closest to "click object and track mask through video" | Browser/mobile integration is nontrivial; much heavier than HOL's frame budget |
| XMem/Cutie | Dedicated video object segmentation with memory | Designed for keeping masks over time | Python/PyTorch research stack, not ready mobile web |
| VGGT/DUSt3R/MASt3R | Feed-forward dense 3D/geometry | Could bypass classical reconstruction someday | Too heavy for iPhone browser and not object-isolated by default |
| RMBG/U2-Net/saliency/background-removal models | Foreground masks | Easy browser demos exist | They segment salient foreground/background, not "the tapped object"; license can be restrictive |
| Human matting models such as MODNet/RVM | Stable person mattes/video mattes | Fast in the human-matting domain | Wrong target for object anchoring |

### Professional Recommendation

Do not chase full video segmentation first. The correct HOL-specific stack is:

1. Add an `ObjectSupportMask` data contract.
2. Add MediaPipe Interactive Segmenter in a worker for tap-time masks.
3. Modify `KeypointDetector.extractKeypoints` to accept an OpenCV mask.
4. Propagate that mask with the existing transform hierarchy.
5. Use mask/keypoint agreement as a tracking confidence signal.
6. Benchmark YOLO segmentation as an alternate mask source for known classes.
7. Only then test XFeat ONNX for relocalization.

This gives HOL most of the benefit of modern segmentation while preserving the current high-value reconstruction work.

## Do Not Do Yet

- Do not replace YOLO detection with DEIMv2-Wholebody49 for object selection.
- Do not download the 956 MB Wholebody49 resource bundle into `public/`.
- Do not add multiple vision models to the live frame path without a measured cadence and device benchmark.
- Do not mix human-body perception and object anchoring in the same worker contract.
- Do not run heavyweight video object segmentation every frame on mobile until a device benchmark proves it fits.
- Do not treat single-frame depth as true object reconstruction; use it only as a prior or diagnostic signal.
