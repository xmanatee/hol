# Vision Quality Roadmap

The user-visible goal is not "create an anchor". The goal is:

1. Select the intended object.
2. Preserve that object's identity through motion, occlusion, rotation, and scale change.
3. Build a trustworthy object-local surface or pose model.
4. Attach the head to that object-local model so it moves with the object and hides when the model is not trustworthy.

"Perfect" quality has to mean perfect on a measured acceptance suite, not a universal guarantee on arbitrary camera video. The current architecture can pass tests while still looking poor because it does not yet score each stage independently.

## Current Diagnosis

### Object Detection

Current runtime uses a YOLO box detector in `src/cv/detector.worker.js` with `public/models/yolo11n_480.onnx`, filtered by `TARGET_CLASS_NAMES` in `src/cv/cocoClasses.js`.

The target filter now keeps COCO classes that match the intended selectable object set where COCO has coverage:

- `person`
- `sports ball`
- `bottle`
- `wine glass`
- `cup`
- `bowl`
- `tv`
- `laptop`
- `mouse`
- `remote`
- `keyboard`
- `cell phone`
- `book`
- `clock`
- `vase`

COCO still cannot directly cover every intended object. Posters/signs, cans, mugs, and arbitrary printed objects need the free-tap segmentation path or a future custom/open-vocabulary detector. This is a recall boundary before tracking or reconstruction starts.

The detector is also box-first. Boxes are acceptable for drawing selectable regions, but they are weak ownership masks because they include textured background around the object.

### Object Tracking

Current anchoring uses:

- MediaPipe Interactive Segmenter at tap time.
- A selected-object support mask.
- Shi-Tomasi/GFTT keypoints.
- Lucas-Kanade optical flow.
- Mask-based landmark rejection.
- Patch-descriptor keyframe relocalization.
- Template recovery.
- Reference homography attachment when the tracked point set supports a coherent perspective transform.

This is a reasonable mobile-web baseline. The weak spots are predictable:

- Low-texture and glossy objects do not produce enough stable corners.
- Background corners inside the detection box can be stronger than object corners.
- LK drifts under large viewpoint changes, fast motion, motion blur, specular highlights, and 90-degree turns.
- Reference-similarity fallback is still the dominant measured tracking-error source when reconstruction pose is unavailable or not yet trusted.
- The current mask is mostly propagated from geometry; there is no periodic learned object-mask correction.
- Bootstrap/grid points help start tracking, but they are not enough to recover object identity after real appearance change.

### Object 3D Reconstruction

Current reconstruction modes are:

- Sparse landmark reconstruction.
- Parametric surface fitting.
- Direct photometric surfel tracking.

This is best understood as object-local pose and surface-prior estimation, not full dense object reconstruction. That is the right near-term mobile path, but readiness must be scored honestly:

- How many object-owned landmarks are mature?
- How much view baseline has been observed?
- How stable is depth or surface normal?
- Is the pose residual bounded?
- Is the map confidence calibrated against head-attachment drift?

The current class priors cover the common mobile targets:

- Flat targets: books, posters, phones, cards, labels, documents, screens.
- Curved targets: cans, bottles, jars, cups, mugs, vases.
- Ellipsoid targets: faces, heads, balls.
- Shallow box targets: shelves, bookcases, cabinets, drawers, crates, boxes.

The current synthetic tests allow errors that are visibly bad: many scenarios permit double-digit pixel anchor error, large frame jumps, and rotation errors near a radian. The tests verify robustness, but not polished attachment quality.

### Head Merge

The head must not be a mostly screen-space overlay that follows a smoothed projected center. It must be attached to an object-local surface state:

- `localPoint`: object-space attachment point.
- `localNormal`: object-space surface normal.
- `localTangent`: stable roll reference.
- `objectPose`: current object-to-camera transform.
- `confidence`: readiness for rendering and voice.

At 90-degree turns, the correct behavior is not to keep forcing a face to stay visible. If the attachment surface becomes back-facing, self-occluded, or poorly constrained, the head should hide or fade until the object-local transform is trustworthy again.

## Research Conclusions

### Keep In The Mobile Frame Loop

- Cheap detector at cadence.
- Tap-time object segmentation.
- LK optical flow for short-term motion.
- Mask-warp ownership checks.
- Lightweight geometric pose and parametric surface fits.
- Low-cadence relocalization and correction in workers.

### Evaluate As Near-Term Replacements Or Additions

- YOLO segmentation ONNX for known selectable classes. This can improve tap masks for bottles, cups, books, phones, people, and other COCO-covered objects.
- XFeat ONNX for degraded/lost relocalization. It is designed for lightweight image matching and should be tested only on recovery cadence first, not every frame.
- A free-tap segmentation path. If no detection box is selected, run tap segmentation and derive the object box from the mask.
- LightGlue-style learned matching only belongs in the same low-cadence recovery bucket unless an in-browser benchmark proves it fits the mobile budget.

### Use As Benchmarks, Teachers, Or Offline References

- TAPIR, TAPNext, CoTracker, and LocoTrack-style point trackers: use as tracking-quality references and dataset/evaluation guides, not as default mobile-browser frame-loop dependencies.
- SAM 2, Cutie, XMem, and AOT-style video object segmentation: excellent references for object memory and reappearance, but too heavy and complex for the default iPhone browser frame loop.
- VGGT, DUSt3R/MASt3R, and BundleSDF: important 3D references, but not immediate in-browser dependencies. Use them offline to score captured clips or generate pseudo-ground-truth.

### Current Attachment Gate

The face overlay is intentionally more conservative than tracking. `reconstructionReady` means the map has enough evidence to estimate pose; it does not by itself mean the head can be rendered. Runtime readiness now separates:

- `poseReady`: there is a usable current pose source.
- `poseQualityReady`: pose inliers, confidence, and residual are good enough for rendering.
- `surfaceReady`: the selected reconstruction or planar pose can describe the attachment surface.
- `attachmentSourceReady`: the current attachment position comes from the same object-local source, not a screen-space tracker fallback.
- `attachmentReady`: all of the above pass, so the face may render.

Tracking and rendering now have deliberately different contracts. A weak planar homography can keep an object tracked, but the face waits for stronger planar inlier support. A reconstruction pose can keep the map alive, but the face waits for a tighter render residual. A recent mature reconstruction source can also suppress a one-frame planar normal takeover so source churn does not produce a visible head snap.

### Current Feedback Loop

`npm run vision:quality` now emits compact failure buckets in addition to per-scenario records:

- `failedByMode`
- `failedByScenario`
- `trackingSources`
- `headPoseSources`
- `trackingTransitions`
- `headPoseTransitions`
- `topFailingScenarios`
- `topTrackingSources`
- `topHeadPoseSources`
- `topTrackingTransitions`
- `topHeadPoseTransitions`

This makes each pass measurable without manual camera testing. The current tracked baseline after the planar-ownership, face-readiness, sparse 3D-anchor, curved-dropout recovery, sparse-only centroid fallback, rigid-planar motion cap, book-specific planar cap, planar pose-filter, planar mirror-rejection, and low-lag tracker passes is:

- 54 scenario/mode combinations.
- 30 pass, 24 fail.
- Failed stages: tracking 21, reconstruction 6.
- No strict head-attachment failures remain in the replay matrix.
- No remaining head-pose source transition exceeds the strict world-error or rotation-error transition limits.
- Rigid planar selected-reconstruction normals are no longer trusted as external normal corrections, so book/card targets do not let a face-on reconstruction collapse a real planar turn.
- High-confidence, low-residual reference-similarity tracker positions can bypass smoothing lag outside sparse reconstruction, while weak tracker and sparse-recovery paths still stay smoothed and step-limited.

Measured deltas from the prior tracked baseline:

- Aggregate: 13 pass / 41 fail -> 30 pass / 24 fail.
- Head attachment failures: 19 -> 0.
- Tracking failures: 34 -> 21.
- Reconstruction failures: 6 -> 6.
- Worst sparse-reconstruction head rotation source bucket: 2.28rad -> 0.64rad.
- Worst planar-homography world-position source bucket: 0.40 -> 0.12 after low-inlier planar render gating.
- Worst planar-homography anchor source bucket: 51.89px -> 22.95px after low-support planar homographies stopped owning the tapped attachment and planar pose updates became less laggy.
- Worst reference-similarity anchor source bucket: 49.23px -> 36.13px after centroid dropout was limited to sparse reconstruction.

Interpretation: overlay gating now avoids visibly bad face renders in the strict replay matrix. Book targets no longer let the one-euro position filter introduce vertical lag after occlusion; they use raw object-local candidates with the tighter book step cap. High-quality tracker measurements also avoid unnecessary lag before reconstruction takes over, but sparse reconstruction keeps smoothing during dropout-heavy recovery because that path is more vulnerable to reference-transform overshoot. The remaining product gap is tracking/relocalization: many high-error frames still report success through `reference_similarity_transform` after curved objects rotate or recover from occlusion, the high-support `curved-centroid-position` recovery bucket still has large anchor error on hard rotations, and several reconstruction failures are consensus dropouts rather than missing keypoints. The most useful next algorithmic target is low-cadence recovery that re-establishes object-owned correspondences before falling back to 2D reference similarity.

## Stage Scoring

### 1. Object Detection And Segmentation

Primary score:

- Tap success rate: a tap on the intended object creates a candidate object.
- Detection recall by class on the app object set.
- Mask IoU where annotation exists.
- Tap component correctness: selected connected component contains the tap and mostly covers the object.
- Runtime: raw inference time and amortized time.

Immediate failures to expose:

- No detection for phone, wine glass, laptop/tablet/screen, poster/sign, can-like object, mug, and box.
- Detection box exists but tap mask is empty or dominated by background.
- Segmentation succeeds but the mask does not contain the tap component.

Target next state:

- Broaden the detector target set to all relevant COCO classes.
- Add free-tap segmentation when no detection is found.
- Add YOLO-seg as an alternate detector profile and compare against MediaPipe Interactive Segmenter.
- Report mask coverage, mask confidence, mask source, and class recall in the HUD/debug report.

### 2. Object Tracking

Primary score:

- TAP-style point tracking accuracy on object-owned points.
- Object mask agreement over time.
- Anchor drift in pixels.
- Anchor jump by position-source transition.
- Frame-to-frame head-root jump after readiness.
- Lost/recovered count and relocalization latency.
- Background landmark rejection rate.

Immediate failures to expose:

- Landmarks with high stability that live outside the object mask.
- Bootstrap points promoted to pose inliers before surviving enough frames.
- Background texture replacing object texture during refresh.
- Recovery that snaps to the wrong repeated texture.

Target next state:

- Keep LK as fast path.
- Add a correction path that periodically refreshes object ownership with segmentation or detector masks.
- Add XFeat ONNX as a worker-backed recovery experiment.
- Promote landmarks through states: bootstrap, candidate, object-owned, pose-eligible, mature.
- Store descriptor/keyframe memory only for object-owned landmarks.

### 3. Object 3D Reconstruction

Primary score:

- Pose residual and inlier ratio.
- Normal angular error in synthetic and annotated fixtures.
- Scale/depth consistency.
- View coverage and baseline.
- Map confidence calibration.
- For real 3D data: object pose error and Chamfer/point-cloud consistency where available.

Immediate failures to expose:

- Reconstruction marked ready with little view baseline.
- Curved object treated as planar under a 90-degree turn.
- Planar object allowed to hallucinate depth and rotate the head incorrectly.
- Sparse map grows with background points.

Target next state:

- Separate "pose ready", "surface ready", and "attachment ready".
- Require view-coverage evidence before enabling non-planar attachment.
- Use class/mask shape to select plane, cylinder, tapered cylinder, box, ellipsoid, or unknown.
- Use offline VGGT/DUSt3R/MASt3R/CO3D-style validation to benchmark captured clips, not as the runtime default.

### 4. Head Merge

Primary score:

- Object-local attachment drift.
- Projected head-root error.
- Normal angular error.
- Scale jitter.
- Rotation jitter.
- Head jump and rotation error by pose-source transition.
- Bounded jump after occlusion/reappearance.
- Correct hide/fade when the surface is back-facing or not reconstructed.

Immediate failures to expose:

- Head follows a 2D anchor while the object rotates in depth.
- Head remains visible after object identity is lost.
- Head jumps when pose source changes from tracker to reconstruction.
- Head uses detector box scale instead of object-local scale.

Target next state:

- Add `HeadAttachmentState` as a first-class model.
- Derive head transform from `objectToCamera * objectLocalAttachment`.
- Keep the existing overlay gate, but make the readiness reason stage-specific.
- Hide the head in candidate/mapping and on back-facing or low-confidence surfaces.

## Implementation Order

### Stage 0: Make Quality Measurable

Add a `vision:quality` report that emits one JSON record per replay and one aggregate score per stage:

- detection: class recall, tap success, mask health.
- tracking: anchor drift, point survival, relocalization, background rejection.
- reconstruction: pose residual, normal error, map confidence, view coverage.
- head: local drift, projected error, jitter, visibility correctness.

This should run against synthetic fixtures first and real cached datasets when available. It should fail on current loose thresholds so improvements have direction.

### Stage 1: Fix Selection Recall

Broaden `TARGET_CLASS_IDS` and add per-class detection tests for the intended selectable object list. Then add a free-tap segmentation path for objects not detected by YOLO.

Do this before adding heavier tracking models. If the wrong object is selected or no object can be selected, tracking quality cannot recover the UX.

### Stage 2: Strengthen Object Ownership

Introduce explicit landmark states and promotion rules:

- `bootstrap`: seeded by grid or weak keypoint extraction.
- `candidate`: tracked in one or more frames but not pose-eligible.
- `object-owned`: repeatedly inside object mask and geometrically coherent.
- `pose-eligible`: object-owned with enough age, low residual, and descriptor agreement.
- `mature`: stable through motion/occlusion and eligible for reconstruction.

Refresh should add only object-owned candidates, and background points should never replace mature object points.

### Stage 3: Add Low-Cadence Relocalization

Evaluate XFeat ONNX in a worker as a degraded/lost recovery path. Keep current patch relocalization as the baseline until the score report proves XFeat improves occlusion, 90-degree turns, blur, or repeated texture cases within budget.

### Stage 4: Rebuild Readiness Around Attachment

Split readiness into:

- `selectionReady`: object candidate exists.
- `trackingReady`: object identity is stable.
- `poseReady`: pose is usable.
- `surfaceReady`: object-local surface is usable.
- `attachmentReady`: head local point and normal are stable.

The head renders only when `attachmentReady` is true or when a strong planar pose provides an equivalent local surface.

### Stage 5: Real Data And Offline Teachers

Use fetch/cache scripts, not vendored blobs, for:

- DAVIS and YouTube-VOS: segmentation and occlusion quality.
- TAP-Vid and TAPVid-3D: point tracking and 3D trajectory quality.
- CO3D: object-centric multi-view reconstruction checks.
- App-captured clips: exact target UX with phones, cups, cans, books, posters, bottles, and faces.

Real fixture manifests are now schema-validated before fetch or replay validation. A fixture may declare `tasks` such as `segmentation`, `pointTracking`, `pose3d`, `reconstruction`, or `detection`, plus annotation files such as masks, tracks, cameras, or pose metadata. The local validator rejects unsafe paths, unknown task labels, missing source URLs during fetch, and missing annotation files in the cache.

Use SAM 2, Cutie, VGGT, DUSt3R/MASt3R, and BundleSDF as references to score what "good" looks like on clips, then copy the smallest viable runtime idea into the mobile architecture.

## Acceptance Gates

The next implementation milestone should not be considered good until:

- Tapping any supported object enters candidate/mapping immediately.
- Detector recall covers the intended class list or free-tap segmentation takes over.
- Candidate progress visibly increases when new object-owned landmarks are found.
- Weak candidate/mapping never renders the head.
- Ready head attachment has bounded local drift and bounded projected jitter.
- A 90-degree left/right/up/down object turn hides or rotates correctly instead of sliding the head.
- Reappearance after occlusion restores the same object-local attachment, not just any similar texture.
- The quality report identifies the failing stage when live testing looks bad.
- The quality report identifies the failing source transition when the head jumps or rotates during a source handoff.
- Real-data cache validation confirms dataset/task/annotation coverage before any real replay score is trusted.

## Sources

- MediaPipe Interactive Segmenter: https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter
- MediaPipe Interactive Segmenter Web JS: https://ai.google.dev/edge/mediapipe/solutions/vision/interactive_segmenter/web_js
- Ultralytics instance segmentation and ONNX export: https://docs.ultralytics.com/tasks/segment
- XFeat paper: https://arxiv.org/abs/2404.19174
- XFeat repository: https://github.com/verlab/accelerated_features
- XFeat ONNX repository: https://github.com/DavideCatto/XFeat-ONNX
- TAP-Vid benchmark: https://tapvid.github.io/
- TAPVid-3D benchmark: https://tapvid3d.github.io/
- BOP benchmark tasks and pose metrics: https://bop.felk.cvut.cz/tasks/
- SAM 2: https://ai.meta.com/research/sam2/
- SAM 2 repository: https://github.com/facebookresearch/sam2
- Cutie repository: https://github.com/hkchengrex/Cutie
- VGGT repository: https://github.com/facebookresearch/vggt
- BundleSDF: https://bundlesdf.github.io/
- DAVIS benchmark: https://davischallenge.org/
- YouTube-VOS benchmark: https://youtube-vos.org/
- CO3D dataset: https://ai.meta.com/datasets/co3d-dataset/
