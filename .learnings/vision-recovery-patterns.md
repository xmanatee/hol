# Vision recovery patterns

## Geometry must own recovery scope

- A trusted tap-time landmark set is strong enough for an immediate descriptor keyframe only when the recovery transform matches the target geometry. In HOL that means rigid planar targets and an affine ORB fit.
- Curved and non-convex targets need mature observations and a broad query because one local affine view cannot represent their viewpoint change.
- A local descriptor ROI is appropriate for geometry degradation while tracking still provides a bounded object location. Complete tracking loss must retain a full-frame recovery path.
- ROI keypoints must be translated to full-frame coordinates before fitting geometry, and the ROI `cv.Mat` header must be deleted after descriptor extraction.

## Region state must not become its own measurement

- Reusing an already padded tracking region as the next refresh input causes monotonic search-area growth.
- Rebuild bounded 2D tracking regions from the current support mask plus the immutable tap template.
- Sparse and depth map builders may require accumulated broad support; do not generalize a 2D optimization across reconstruction models without per-mode evidence.

## Benchmark both quality and cost

- Report recovery cost per call, amortized cost per frame, call coverage, and worst quality together.
- A faster ROI is invalid if it reduces spatial consensus or increases drift in an existing failure bucket.
- Mask-only temporal probation does not prove object ownership during occlusion: an occluder can remain inside the same support mask across frames.

## Growth and recovery need different candidate policies

- The current OpenCV.js `goodFeaturesToTrack` result provides corner coordinates but no per-corner quality output, so HOL's extracted real corners all carry the same response. Response sorting alone cannot improve their spatial distribution.
- Deliberate map growth should fill under-covered object-mask cells, but recovery and occlusion-support refreshes must preserve correspondence-oriented ordering. Applying one policy to both can improve coverage while regressing pose quality.
- Real detected corners must remain ahead of synthetic bootstrap points. Bootstrap points restore minimum support; they are not equivalent measurement evidence.
- Selection and diagnostics must share one mask-aligned coverage grid. A second coverage definition makes benchmark gains impossible to interpret.

## Coherent sparse support still needs an independent reference

- A surviving LK subset can have low residual while tracking the wrong rigid-planar reference. Internal agreement is not independent evidence after a large support drop.
- Trigger descriptor validation from both map maturity and active support. In the measured HOL envelope, at least 70 stored landmarks and fewer than 18 active landmarks isolates the useful state; lowering maturity to 48 regressed the broader replay.
- Preserve measurement filtering unless independent candidates agree. Directly bypassing planar smoothing improved lag on individual frames but amplified glare and partial-support outliers, reducing the laminated-card pass count from 11 to 7.
- Compare recovery policies on pass count, risk, recovery windows, call coverage, and amortized cost. A lower mean time per call can still cost more overall if it increases call frequency.

## A recovery prior must not become the output owner

- Preserve confidence, residual, and inlier evidence through position filtering. A position without its source quality cannot safely seed temporal recovery.
- A trustworthy planar/object trajectory may define the coordinate frame for recovering established curved-map landmarks during a short dropout. It must not directly hold or replace the displayed pose; that changed recovery cadence and worsened reacquisition in HOL.
- Scope bootstrap and reversal thresholds to the behavioral owner proven by replay. Broad curved-mode ownership improved one mug case but regressed a depth-fusion can; the accepted policy changes only parametric handled mugs.
- Run the complete matrix after a focused replay passes. The 84-report matrix exposed the sibling regression that the three-report target slice could not.

## Learned matching requires a complete deployment chain

- A permissive model license and desktop CPU benchmark are necessary but not sufficient for a browser recovery provider.
- Require an upstream or independently reproducible export graph, exact weight revision, operator support in WebKit, worker-safe memory behavior, and target-device timing before adding an adapter.
- Do not retain speculative model providers or converted weights after a bake-off fails the deployment contract. Keeping dormant integration code creates a second recovery architecture without evidence.

## Segmentation inference and mask acceptance are different decisions

- Record why a refresh was requested separately from whether the prompted model returned a mask.
- A usable model result can still fail spatial continuity, and a rejected model mask can still lead to an accepted tap-local fallback. Preserve both facts instead of collapsing them into one success flag.
- The tracking service's last applied-mask reason is historical state; the manager's current request outcome is request lifecycle state. Keep both fields rather than overwriting one with the other.
- Invalidate asynchronous refresh requests when the anchor session ends. Clearing visible state alone does not prevent a late result from mutating the underlying service.

## Camera lifecycle must own coordinate-space validity

- Viewport orientation and camera-source orientation are different signals. Layout follows viewport/observer changes; vision calibration follows the video element's intrinsic `resize` event and its new `videoWidth`/`videoHeight`.
- A media track `mute` is a reversible interruption. Keep the stream and calibrated runtime available for `unmute`; an unexpected `ended` is terminal and must replace the entire session so no worker, model, listener, or audio state leaks into restart.
- Invalidating an async worker requires both runtime reset and a generation check before initialization starts and after every awaited boundary. Reset alone is insufficient when the stale task has not entered the worker yet.
- Worker reset and disposal are different ownership operations: reset terminates coordinate-dependent work but preserves listeners and the chosen tracking mode; disposal additionally drops all ownership and subscribers.
- Calling `MediaStreamTrack.stop()` does not produce an `ended` event. Lifecycle tests must dispatch or receive `ended` independently rather than assuming stop exercises interruption recovery.

## Capture artifacts belong between rendering and CV

- Object albedo, lighting, frame cadence, and sensor artifacts are independent axes. A dark texture does not provide shot/read-noise evidence, and wider pose spacing does not provide exposure-blur evidence.
- Apply capture degradation after rendering in one adapter rather than adding variants to every object generator. This keeps scene geometry reusable and makes the capture condition explicit in reports.
- A geometric sensor warp must transform all coordinate evidence with the image: masks, corners, bounds, tap position, probes, and anchor truth. Warping only pixels creates artificial tracker error; warping only annotations makes the fixture easier than the camera.
- Deterministic noise and fixed exposure/readout profiles are necessary for regression gates. Randomized augmentation is useful for training or broad sweeps, but it cannot own a strict reproducible threshold.
- Sensor-inspired synthesis is not device calibration. Record the model and bounds honestly, then require physical-iPhone fixtures before drawing hardware-specific conclusions.
- Measure one shared threshold envelope across every reconstruction mode. Per-mode limits would hide exactly the cross-engine weakness the capture axis is intended to expose.

## Derived raster work needs semantic caching and bounded sampling

- A getter that derives a full-frame mask is a computation boundary, not a field accessor. Repeated calls in one frame must reuse the result only when the source mask and every transform input are identical.
- Preserve inverse nearest-neighbor sampling when optimizing binary-mask projection. Forward mapping can create holes during scale-up, and approximate contour projection can alter ownership decisions at the boundary.
- Transform the source pixel-edge bounding box to obtain a conservative destination ROI, then retain the original inverse lookup inside that ROI. Byte-parity tests should include rotation, scaling, and clipping at every frame edge.
- When a producer already owns a fresh destination buffer, assemble metadata directly from the write pass. Copying the buffer and rescanning the full frame for bounds and pixel count defeats the ROI optimization.
- Report the isolated operation, its amortized owning stage, overall frame processing, and exact quality parity together. Node timings can accept an optimization but cannot establish the iPhone budget.

## Hidden intermittent work needs named ownership

- A top-level stage average is not actionable when it contains periodic full-frame feature extraction. Time the owning operation on every invocation and the expensive sub-operation only when it runs.
- Keep early exits in the owner timing. Otherwise an optimization can appear faster merely by making rejected attempts invisible.
- A faster crop is not automatically an equivalent extractor input. Cropping changes the ORB pyramid, border support, keypoint selection, and descriptors; raw-operation timing is invalid unless replay quality remains stable.
- Landmark translation residual is not sufficient keyframe novelty evidence. A translated view can still contribute useful descriptors near image borders and after local appearance changes, even when its shared points fit a coherent 2D translation.
- Evaluate aggregate quality first, then isolate every strict failure near its threshold. A broad pass/fail summary can hide a scenario-level regression.
- Node replay can locate a bottleneck, but physical iPhone Safari and Chromium measurements still own the mobile frame-budget claim.

## Optimize descriptor bookkeeping without changing descriptor evidence

- A storage feature cap changes which ORB responses survive global ranking; a lower cap is not a quality-neutral performance knob even when the final keyframe stores only dozens of landmarks.
- `Feature2D.compute` at supplied LK coordinates avoids detection work, but LK points do not carry ORB orientation or pyramid octave. In the measured 90-degree rotation case this reduced reciprocal matches from 84 to 6, so direct descriptors cannot replace detector-owned keypoints without rebuilding equivalent evidence.
- An OpenCV feature mask can reduce the returned feature count while still making extraction slower because mask processing participates in the image pyramid. Measure the complete detector call, not only output cardinality.
- Once the detector output is fixed, spatial indexing is safe only if it preserves exhaustive-search ordering. Equal-distance ties and one-to-one feature ownership are observable matching semantics.
- Delay typed descriptor views until association has selected an index. Materializing descriptor objects for every detector candidate creates allocation work without adding evidence.
- When the optimized slice is smaller than upstream WASM timing variance, use same-input microbenchmarks to establish the local saving and full replay to establish quality parity. Do not turn a noisy aggregate run into a speedup claim.

## Materialize native feature evidence at its surviving boundary

- Keep a native descriptor matrix alive only through its synchronous consumer. Match and associate through a zero-copy view, then release the native owner before returning or storing state.
- Copy the complete descriptor matrix only when every row must cross the boundary, such as an exact same-frame reusable snapshot. A keyframe that retains selected matches should copy only those rows.
- Store selected rows in one compact backing buffer while preserving detector order, fixed row width, byte offsets, and typed word views. Per-entry views may share that compact buffer; they must not keep the full detector output alive.
- Test both ownership outcomes: retained keyframes must have an exact `entryCount * descriptorSize` backing buffer, while any full reusable snapshot must remain valid after native handles are released.
- Measure retained bytes and the complete owner stage separately. Native/WASM timing variance can obscure a small copy saving in total-frame measurements.
- Reusing detector or output handles adds lifecycle complexity and is justified only by a repeatable end-to-end gain. Exact output parity alone is insufficient.

## Reuse feature evidence only under exact input identity

- A detector result can serve two same-frame consumers only when image extent, pixels, detector parameters, feature budget, mask, coordinate space, and output ordering are identical.
- Full-frame ORB relocalization and full-frame keyframe storage satisfy that contract when their feature budgets match. An ROI query does not: translating coordinates after cropped detection cannot restore the full-image pyramid or border evidence.
- Detector evidence remains valid when a downstream matcher or geometric-consensus stage rejects it. Reuse ownership follows detector input identity, not the success status of a later consumer.
- Carry only a plain point/response and descriptor snapshot across updater or state boundaries. Native `cv.Mat` and `KeyPointVector` ownership may span a synchronous consumer, but must end before that consumer returns.
- Keep the snapshot scoped to the current update and out of diagnostic state. Cross-frame caching adds invalidation and memory ownership that are unnecessary for eliminating a same-frame duplicate.
- Count detector calls as well as stage timings. A telemetry reduction is not proof if work merely moved into a different named stage.

## Prove expensive evidence feasibility from cardinality

- When downstream association is one-to-one, its output cardinality cannot exceed the upstream candidate count. Reject a candidate set below the required output quorum before constructing the expensive detector.
- Derive pre-extraction, post-association, and evidence-reuse eligibility from one quorum. Separate limits for the same stored artifact invite wasted work and semantic drift.
- Do not equate "feature extraction happened" with "the storage attempt consumed cadence." A feasibility rejection can complete the storage decision without running the expensive operation.
- Compare attempt count, insertion count, recovery count, and output quality as well as detector calls. The first HOL candidate saved extraction but accidentally retried earlier; the resulting cadence shift was caught and removed before acceptance.
- Count structurally eliminated calls against the paired active-operation mean. Treat adjacent end-to-end timing only as supporting evidence when WASM or device scheduling is noisy.

## Bounded history must not redefine reference geometry

- Evicting old observations controls memory and optimization cost; it does not rebase map coordinates. A moving `frames[0]` is not a valid reference frame unless every map point, anchor, and accumulated transform is explicitly rebased with it.
- Cache reference-derived normalization by the semantics that can invalidate it. In HOL that is reset or a surface-model change, not the identity of the oldest retained observation or a same-model tracking-region resize.
- Cache the completed evaluation, including an unavailable fit, so paired scale and rotation reads cannot repeat the same robust estimation.
- Test both sides of the ownership boundary: history eviction and same-model refresh must preserve the fit, while a real estimator-model change must invalidate it exactly once.
- Profile candidate frequency before adding hot-path identity checks. Exact local/wide planar correspondence identity occurred only twice in 2,099 attempts, so that proposed optimization was rejected without production code.

## Reuse robust consensus only at an exact evidence boundary

- Mapping and pose may consume the same camera measurement under different semantic roles. Reuse is valid only when the ordered observation identities and every estimator option match; equal coordinates alone do not prove equal ownership or preprocessing.
- Snapshot the fields that determine robust estimation: model, residual threshold, minimum inliers, minimum inlier ratio, sample bound, and sampling policy. A change to any field must create a new evaluation.
- Cache the completed decision, including failure. Repeating a deterministic failed consensus on identical evidence adds cost but no information.
- Accept a new array containing the same ordered observation objects, because filters commonly allocate a view without changing evidence. Reject reordered or cloned objects so another preprocessing pass cannot masquerade as the same measurement.
- Measure real reuse coverage before retaining the abstraction. HOL reused 764 of 1,112 ready-pose evaluations; this high hit rate justified the identity checks, unlike the rejected local/wide planar candidate that matched only twice in 2,099 attempts.

## Factor one design matrix across all right-hand sides

- When several least-squares outputs share the same observations and basis rows, accumulate every right-hand side beside one normal matrix and eliminate that matrix once. Rebuilding and refactoring it per output is duplicate work, not independent evidence.
- Preserve the previous normal-equation accumulation order, regularization, pivot rule, singularity threshold, and per-RHS arithmetic order. Sharing a factorization need not change a single output bit.
- Pin representative full-precision outputs in RED tests and compare a broader deterministic result corpus byte-for-byte. End-to-end quality equality alone can miss small numerical drift that later moves a robust inlier boundary.
- Replace every production pair and remove the old single-RHS wrapper. Keeping both APIs after migration invites the duplicate hot path to return.
- Treat isolated solver timings as the primary mechanism evidence and adjacent full-pipeline timings as supporting evidence. Device measurements still own mobile budget claims.

## Retain only evidence that can survive a robust hypothesis

- A RANSAC scoring pass needs the inlier count, accepted residual sum, and ordered inlier references. Projected-point objects, rejected residual records, and full residual arrays cannot survive the hypothesis and should not be materialized.
- Traverse observations once and append only accepted evidence. Preserve projection arithmetic, threshold comparison, observation order, and residual addition order so allocation removal remains bit-exact.
- Hoist model constants such as a similarity hypothesis's sine and cosine outside the observation loop. Recomputing them cannot add evidence because the hypothesis is immutable during scoring.
- Pin full-precision fitted transforms, ordered inliers, residuals, and confidence, then compare broad deterministic artifacts byte-for-byte. Pass/fail parity alone is too weak near robust-estimator tie boundaries.
- Attribute end-to-end gains only to the stage that owns the change. Unrelated OpenCV stages can move the total frame mean by more than a small JS saving between adjacent runs.
- When a native robust estimator returns an ownership mask, use that mask before projecting or materializing downstream residuals. Rejected correspondences cannot contribute to an inlier-only summary.
- Check the inlier quorum before derived geometry, then accumulate ordered references, sum, and extrema in one mask-ordered pass. Preserve projection and addition order so the optimization stays bit-exact.
- A detector/extractor split is not equivalent merely because one image returns identical selected rows. Pyramid construction and keypoint processing must survive the full recovery matrix before changing the evidence boundary.
- For short fixed-width binary descriptors, branch and bound maintenance can cost more than unconditional arithmetic. Benchmark the complete matcher rather than inferring a gain from fewer theoretical popcounts.

## Let a linear solver consume its private workspace

- If a caller creates a normal matrix solely for the following solve, copying it before destructive elimination protects no live evidence. Make that single ownership explicit and consume the matrix in place.
- Specialize the private API to the production contract. HOL always solves a paired X/Y system, so generic arrays of value sets and callback-built augmented rows added allocations without adding capability.
- Encode mutability in the function name and keep the consuming solver private. Callers that need reusable matrices require a different ownership contract, not an ambiguous flag.
- Preserve row accumulation, regularization, pivot selection, elimination, and result order exactly. Characterize rank-deficient and wider camera systems as well as the common affine case, then compare a broad deterministic corpus byte-for-byte.
- Benchmark the small dense sizes the application actually uses. At three and four columns, container allocation and copying can dominate the arithmetic even though asymptotic solver complexity is unchanged.
- Attribute pipeline gains only to modes that exercise the solver materially. Adjacent movements in unrelated depth, planar, or total-frame measurements remain noise until repeated target-device evidence says otherwise.

## Bound robust search before replacing its consensus model

- A newer robust-estimation backend is not a drop-in performance optimization. Different samplers, scoring functions, local optimization, and termination rules change the inlier mask, which changes downstream pose ownership even when average consensus improves.
- Profile robust-estimator options on captured correspondence sets, then validate the entire application replay. Raw solver success count and residuals cannot reveal head-attachment or recovery regressions.
- When an existing seeded estimator is stable, its documented maximum-iteration budget is the lowest-risk performance lever. Keep method, reprojection threshold, confidence, and RNG seed fixed, and make the bound an explicit real-runtime contract.
- Select a bound that preserves categorical quality, worst risk, strict replay, and isolated release cases with observed headroom. In HOL, the broad matrix accepted 500 iterations but a narrower repeated-occlusion replay rejected every tested bound through 1,050; 1,250 retains 150 iterations above the first passing boundary. This is evidence for the deterministic replay envelope, not a universal RANSAC constant or a mobile claim.
- Remove rejected backend experiments completely. A runtime switch between consensus models would turn a benchmark question into a permanent second geometry path.

## Preserve baseline strata when adding harder benchmark cases

- Select stress cases from ground-truth or annotation-only difficulty signals before observing model output. Motion, visibility ratio, occlusion duration, and visibility transitions are legitimate selection axes; choosing by the model's worst score turns the benchmark into a post-hoc sample.
- Do not append hard cases to an established aggregate and then lower its floor. Keep the original stratum and thresholds unchanged, add a disjoint named stress stratum, and enforce aggregate plus per-query floors on each stratum independently.
- A combined score is useful for orientation but cannot own acceptance. A strong baseline average can otherwise hide a failed hard case, while an intentionally difficult group can obscure regression in the stable baseline.
- Reject duplicate query ownership across strata. Replaying one favorable query twice silently weights it twice and makes the aggregate look stronger without adding evidence.
- A minimum quality floor of zero is not a regression contract. Fail manifest validation before replay when a minimum floor cannot reject any result.
- Reuse one verified asset decode across disjoint query sets, then replay each query with fresh tracker state. Statistical separation does not require duplicate fixture bytes, dependencies, or production code.

## Validation report: disjoint annotated benchmark strata

**Date**: 2026-08-05
**Scope**: TAP-Vid query selection, manifest ownership, release-gating floors

- [x] Six real 250-frame replays run through the production-cadence tracker
- [x] The original three-query metrics and floors remain numerically unchanged
- [x] Three annotation-ranked occlusion-stress queries own independent aggregate and per-query floors
- [x] Schema tests reject version 1, flat query fields, duplicate ownership, and zero minimum floors
- [x] Full release, vision, Chromium, and WebKit gates pass
- [x] No asset, dependency, model, fallback, migration, or compatibility path was added

## Validation report: geometry-scoped recovery

**Date**: 2026-07-30
**Scope**: rigid-planar ORB keyframes, ROI extraction, tracking-region refresh

### Checks

- [x] Unit and real-OpenCV examples run
- [x] Geometry gates match repository conventions
- [x] OpenCV references remain valid
- [x] No duplicate recovery pipeline or compatibility path remains

### Findings

- Tap-time planar keyframes and geometry-scoped ROI recovery improve both repeated-occlusion drift and amortized latency.
- Applying either optimization to curved or non-convex targets regresses existing replays.

### Actions

- Keep tap-time keyframes and ROI queries behind the rigid-planar gate.
- Profile recovery spikes on the primary iPhone target before claiming the mobile budget is met.

## Validation report: segmentation-refresh outcomes

**Date**: 2026-07-30
**Scope**: refresh triggers, inference outcomes, mask acceptance, tap-local fallback, request invalidation

### Checks

- [x] Empty and unavailable segmenter results remain distinct
- [x] Accepted, fallback, rejected, and downstream service-rejection paths are unit-tested
- [x] Clearing an anchor invalidates an in-flight result
- [x] UI diagnostics consume the manager-owned decision record

### Findings

- The prior boolean acceptance boundary hid whether segmentation failed, geometry rejected the mask, or the tracking service declined the update.
- A request generation is necessary because a worker result may arrive after the user clears an anchor.

### Actions

- Keep segmentation outcomes discriminated and stable for field diagnostics.
- Preserve the rejected model-mask reason when tap-local growth is applied.

## Validation report: coverage-balanced map growth

**Date**: 2026-07-31
**Scope**: map-growth candidate ordering, mask-cell coverage, replay diagnostics

### Checks

- [x] Candidate ordering and tracker integration are unit-tested
- [x] Coverage measurement and selection share one implementation
- [x] All 72 strict replay reports pass
- [x] The 20-run laminated-card benchmark retains its pass and risk-band counts
- [x] No steady-state CV stage, asset, model, or compatibility path was added

### Findings

- Restricting spatial balancing to deliberate map growth increases final coverage without changing refresh volume.
- Applying the same ordering to occlusion-support refreshes caused two strict quality failures despite a larger aggregate coverage gain.
- Per-refresh cell deltas are more actionable than aggregate surface coverage alone because they attribute growth to the exact refresh operation.
- A 300-candidate/96-landmark Node microbenchmark averages 0.335 ms per ordering call; target-device timing still owns the mobile performance claim.

### Actions

- Keep mask-coverage ordering scoped to `mapping-growth` and `map-growth`.
- Preserve response-ranked recovery and occlusion-support refreshes.
- Use replay `landmarkRefreshCoverageGain` and `landmarkRefreshNewOccupiedCells` when evaluating future growth policies.

## Validation report: camera coordinate-space lifecycle

**Date**: 2026-07-31
**Scope**: intrinsic video dimensions, track interruptions, worker reset, session replacement, mobile rotation

### Checks

- [x] Intrinsic dimension, mute/unmute, and unexpected-ended paths are unit-tested
- [x] Worker reset rejects stale work while preserving subscribers and tracking mode
- [x] Async initialization uses generation ownership across awaited boundaries
- [x] Active rotation and ended-to-restart behavior run in the mobile Chromium release profile
- [x] WebKit retains shell-orientation, service-worker, and runtime-error coverage

### Findings

- A mounted canvas is not proof of an active camera because the canvas exists during the requesting state. Browser tests must also assert interactive canvas semantics and a bound media stream.
- Source dimensions can change independently of CSS viewport dimensions, so the rendering observer cannot own worker calibration.
- Reversible and terminal track events require different cleanup scopes; collapsing them would either leak stale state or force needless session loss.

### Actions

- Keep camera lifecycle work event-driven and outside the per-frame budget.
- Use a non-terminal anchor reset only for intrinsic-dimension changes.
- Replace the complete session after unexpected track termination and require a fresh user gesture.

## Validation report: capture-degradation evidence

**Date**: 2026-07-31
**Scope**: low-light sensor noise, linear motion blur, rolling-shutter scanline warp, strict quality grouping

### Checks

- [x] Noise, blur, and scanline primitives are deterministic and unit-tested
- [x] Degradation leaves source fixtures immutable
- [x] Rolling-shutter pixels and geometric annotations share one mapping
- [x] All reconstruction modes use one capture-condition threshold envelope
- [x] All 84 strict reports pass with capture-condition diagnostics
- [x] No production runtime, asset, worker protocol, or model changed

### Findings

- The former `dark-book` and `fast` axes did not model camera noise or exposure integration.
- A signed integer leak in the first deterministic noise hash produced invalid Gaussian samples; the RED flat-patch variance test exposed it before replay calibration.
- The existing tracker remains within the tighter capture envelope, so runtime compensation would add complexity without measured benefit.
- Condition-level aggregation makes future failures actionable without weakening the overall strict gate.

### Actions

- Keep capture physics in the synthetic adapter and scene geometry in object fixtures.
- Retain the fixed profile parameters until a broader full-matrix experiment justifies changing them.
- Add physical iPhone low-light and fast-pan recordings before claiming device calibration.

## Validation report: mature-map descriptor validation

**Date**: 2026-07-31
**Scope**: rigid-planar sparse-support trigger, learned-matcher feasibility, recovery cost

### Checks

- [x] RED unit case distinguishes mature sparse support from an immature map
- [x] Real OpenCV replay requires local ORB consensus and the strict 8 px mean bound
- [x] All 84 fixed strict reports pass
- [x] The 300-run representative matrix completes without a new affected object path
- [x] Rejected smoothing and early-trigger experiments were removed

### Findings

- Residual-only geometry gating missed a coherent but incomplete rigid-planar LK subset.
- Mature-map validation converts one laminated-card report to pass while adding 0.114 ms amortized ORB work in that benchmark.
- A 48-landmark trigger and direct homography steps both regressed quality; the narrower 70-landmark gate is evidence-backed rather than a general recovery heuristic.
- At this checkpoint, the original XFeat repository did not yet provide a pinned browser graph and LightGlue had the same deployment gap. A later validation found and audited the official Kornia ONNX revision; see the ORB-first XFeat report below.

### Actions

- Keep LK as the steady-state path and ORB validation scoped to mature rigid-planar support collapse.
- Require physical iPhone Safari and Chromium timing before claiming the rare recovery spike meets the device budget.
- Revisit learned matching only with a reproducible, permissively licensed browser graph and the same replay matrix.

## Validation report: bounded object-support projection

**Date**: 2026-07-31
**Scope**: mask construction, current-transform projection, same-frame reuse, tracking hot-path timing

### Checks

- [x] RED service test proves identical frame transforms reuse one projected mask
- [x] Bounded inverse mapping is byte-identical to the full-frame reference across translation, rotation, scale, and clipping
- [x] Object-mask and anchor-service unit suites pass
- [x] Quick benchmark quality and risk objects are exactly equal before and after
- [x] All 84 fixed strict reports pass
- [x] No new asset, dependency, threshold, recovery branch, or OpenCV object lifecycle was added

### Findings

- The nominally small landmark-metrics stage was dominated by repeated full-frame mask projection, metadata rescans, and buffer copies.
- Bounding the exact inverse mapper and caching the same semantic transform reduces the stage from 4.743 ms to 0.106 ms amortized in the 84-report Node quick matrix.
- The isolated 640×480 projection falls from 2.301 ms to 0.673 ms, while the full profiled frame falls from 41.50 ms to 34.82 ms.
- Every quality aggregate, failed stage, risk band, and mean risk value is unchanged.

### Actions

- Keep the cache key explicit: source mask identity, frame index, position, scale, and rotation.
- Preserve byte-parity coverage when changing mask representation or projection math.
- Measure the same stage on the primary iPhone before converting the Node reduction into a device-budget claim.

## Validation report: full-path ORB keyframe storage telemetry

**Date**: 2026-07-31
**Scope**: ORB storage ownership, extractor timing, rejected optimization audit

### Checks

- [x] RED service coverage attributes both storage wall time and feature extraction
- [x] Relocalization and image-anchor service suites pass
- [x] The 84-report quick matrix is exactly unchanged in quality and risk
- [x] All 84 fixed strict reports pass
- [x] Rejected ROI and translation-admission paths and their API surfaces were removed
- [x] No asset, dependency, model, compatibility branch, or duplicate storage path was added

### Findings

- Periodic full-frame ORB storage was hidden inside `keypointUpdateMs` or `templateUpdateMs`; explicit store and extraction timings make the intermittent cost attributable.
- Storage costs 5.130 ms amortized and reaches 24.732 ms; extraction alone costs 5.051 ms amortized across 26.0% of frames and reaches 24.412 ms.
- Broad quality remains exactly 45/39 with 24.58884 mean risk and the same failing scenarios, failed stages, risk bands, and maximum risk.
- Cropped ORB extraction was much faster in isolation but introduced two strict failures by changing extractor geometry. It was removed rather than retained as an alternate path.
- Translation-residual admission regressed isolated sparse-cylinder mean error from 5.76 px to 8.15 px despite stable broad aggregates. It was also removed.
- Adjacent-run aggregate mean processing changes from 32.735 ms to 32.727 ms, which is not evidence of a speedup.

### Actions

- Preserve the existing evidence-backed storage decisions until a candidate passes both broad and isolated strict replays.
- Use `keyframeStoreMs` and `keyframeFeatureExtractionMs` to evaluate future storage changes.
- Measure storage spikes on the primary iPhone before claiming the mobile frame budget is met.

## Validation report: indexed ORB landmark association

**Date**: 2026-07-31
**Scope**: post-extraction feature indexing, one-to-one landmark association, descriptor materialization

### Checks

- [x] RED randomized contract is bit-exact with ordered exhaustive search, including duplicate-coordinate ties
- [x] Low-contrast 90-degree rotation and partial-occlusion recovery passes with real OpenCV
- [x] Relocalization and image-anchor service suites pass 172/172
- [x] Quick quality, failed-scenario, risk-band, mean-risk, and maximum-risk outputs are exactly unchanged
- [x] All 84 fixed strict reports pass
- [x] Rejected feature-cap, provided-keypoint, and feature-mask paths were removed

### Findings

- A cell index reduces fixed 1,000-feature/96-landmark association from 0.789 ms to 0.127 ms in the same-input Node microbenchmark.
- Lazy descriptor views remove another 0.049 ms, for 0.711 ms isolated JS savings per storage call.
- The full 84-report replay is dominated by variable ORB/WASM extraction and did not show an aggregate speedup in the adjacent run; no aggregate or mobile timing claim is made.
- Lowering storage to 500 features saved 8.3% extractor time but introduced two additional quick failures. Provided LK points lost rotation/scale evidence, while masked detection was 5.9–7.8% slower across six fixtures.

### Actions

- Keep full detector-owned ORB evidence and the bit-exact indexed post-processing.
- Use `keyframeStoreMs` to validate the saving on the primary iPhone rather than extrapolating from Node.
- Revisit extraction only when a candidate preserves broad and isolated quality, orientation, scale, and full-image border behavior.

## Validation report: bounded deterministic homography consensus

**Date**: 2026-07-31
**Scope**: planar homography consensus, RANSAC iteration budget, backend bake-off, end-to-end pose timing

### Checks

- [x] RED real-OpenCV contract fixes RANSAC method, 2.5 px threshold, 1,250 iterations, and 0.99 confidence
- [x] Homography and image-anchor service suites pass 167/167
- [x] The 84-report quick matrix preserves its complete quality aggregate exactly
- [x] All 84 fixed strict quality reports pass
- [x] Under-budget candidates through 1,050 iterations were removed after a narrower real-OpenCV release replay regressed
- [x] Rejected USAC backend code and contracts were removed
- [x] No feature flag, fallback, dependency, model, asset, migration, or compatibility path was added

### Findings

- The original 2,000-iteration bound made seeded classic RANSAC dominate planar pose even though its full replay consensus was stable at a lower cap.
- The accepted 1,250-iteration bound preserves the complete quick quality aggregate exactly. Planar pose falls from 4.496 ms to 4.274 ms active and from 4.442 ms to 4.222 ms amortized.
- Mean profiled frame processing falls 4.92%, and maximum p95 falls 10.93% in the identical Node replay. Single maximum samples were noisier and worse, so no maximum-spike improvement is claimed.
- Bounds of 500, 1,000, and 1,050 looked safe in the broad matrix but regressed the narrower repeated-occlusion rigid-planar replay to 16.59–31.01 px maximum anchor error. The first passing boundary was 1,100; the accepted contract adds 150 iterations of observed headroom.
- USAC default improved pass count and raw latency but increased severe reports from one to three. USAC accurate left two severe reports, while MAGSAC raised head-attachment failures from four to eleven and worsened mean and maximum risk. Backend novelty did not outweigh the downstream consensus regressions.

### Actions

- Keep the single seeded classic-RANSAC implementation and its explicit 1,250-iteration contract.
- Re-run the full quality matrix before changing method, threshold, confidence, seed, correspondence ordering, or iteration budget.
- Measure planar-pose and frame spikes on the primary iPhone Safari and Chromium targets before treating the Node budget crossing as device evidence.

## Validation report: same-frame ORB extraction reuse

**Date**: 2026-07-31
**Scope**: full-frame relocalization queries, refreshed keyframe storage, OpenCV object ownership

### Checks

- [x] RED real-OpenCV contract counts detector calls across query and storage
- [x] Reuse requires a full-frame query, enough features for storage, and equal query/storage feature budgets
- [x] Matching, geometric-consensus, and LK-restoration failures preserve valid detector evidence
- [x] ROI and mismatched-budget paths remain ineligible
- [x] Relocalization and image-anchor suites pass 173/173
- [x] Low-light/capture-degradation, repeated planar occlusion, and mature-map validation cases pass
- [x] Quick quality and risk aggregates are exactly unchanged
- [x] All 84 fixed strict reports pass
- [x] No OpenCV handle or reusable snapshot remains in relocalizer state

### Findings

- The 84-report quick matrix performs 185 descriptor relocalizations, including 183 full-frame queries. Detector evidence from both accepted and rejected matches can serve 44 subsequent storage evaluations without another detector call.
- Storage extraction falls from 719 to 675 calls with zero remaining exact same-frame duplicates, while update-profiled extraction falls from 707 to 663 calls. Recovery query count remains 185, proving the saving does not come from reduced recovery cadence.
- At the baseline 21.386 ms active extraction mean, 44 removed calls equal 0.346 ms amortized per frame. Adjacent total storage timing improves further, but OpenCV/WASM variance is too large to attribute the entire change to reuse.
- Query keypoints, responses, descriptor bytes, order, and downstream association are the exact detector output already used by relocalization. No descriptor evidence or acceptance decision changes.

### Actions

- Keep same-frame reuse restricted to exact full-image detector identity.
- Route the snapshot through every same-update storage owner, including ordinary refresh after failed geometry validation.
- Preserve detector-call instrumentation in the real-OpenCV regression.
- Re-run broad and isolated recovery gates before expanding reuse to another coordinate space or detector configuration.
- Measure the structural saving on the primary iPhone before converting the Node estimate into a mobile claim.

## Validation report: feasibility-first keyframe admission

**Date**: 2026-07-31
**Scope**: keyframe storage quorum, extraction ownership, storage cadence

### Checks

- [x] RED real-OpenCV contract instruments detector construction below the entry quorum
- [x] Pre-extraction, post-association, and reusable-evidence checks share one derived quorum
- [x] A completed feasibility rejection consumes storage cadence without claiming feature extraction
- [x] The superseded `featuresEvaluated` result field has no runtime compatibility alias
- [x] Relocalization and image-anchor suites pass 173/173
- [x] Low-light/capture-degradation, repeated planar occlusion, and mature-map validation cases pass
- [x] Quick quality and risk aggregates are byte-for-byte unchanged
- [x] All 84 fixed strict reports and all 573 release tests pass
- [x] Storage attempts and successful insertions are exactly unchanged

### Findings

- The quick matrix previously sent 46 sets of five to seven eligible landmarks into ORB even though the accepted keyframe required eight one-to-one entries. Every call extracted features and then failed storage.
- Early feasibility admission reduces standalone storage extraction from 675 to 629 calls and update-profiled extraction from 663 to 617 calls. Attempts remain 918, successful insertions remain 664, and relocalization remains 185 calls.
- At the paired 19.927 ms active extraction mean, the removed calls represent 0.338 ms of structural work per benchmark frame. This is a Node replay estimate, not an iPhone timing claim.
- The first implementation coupled cadence to extraction and changed later insertion timing. Naming the real contract `storageEvaluated` restored exact cadence while keeping the extraction saving.

### Actions

- Keep the storage quorum centralized and preserve one-to-one association ownership.
- Require attempt, insertion, recovery, and detector-call parity for future admission optimizations.
- Re-run broad and isolated recovery gates before moving any other descriptor work ahead of extraction.
- Measure the saving on the primary iPhone Safari and Chromium targets before applying it to the mobile frame budget.

## Validation report: stable reconstruction reference fit

**Date**: 2026-07-31
**Scope**: direct-photometric and parametric-surface reference ownership

### Checks

- [x] RED contracts cover bounded-history eviction and same-model reference-region updates
- [x] Surface-model changes invalidate the retained fit exactly once
- [x] Direct, parametric, and reconstruction-mode suites pass 28/28
- [x] Five real-OpenCV engine, occlusion, drift, and rejection replays pass
- [x] Quick status, failure-stage, maximum-risk, and risk-band aggregates are unchanged
- [x] All 84 fixed strict reports pass
- [x] Full release verification passes 577/577 tests, production build, bundle budgets, flow audit, SBOM, license audit, and vulnerability audit
- [x] Mobile Chromium/WebKit browser matrix passes 7 tests with 3 browser-specific skips
- [x] No second reference path, rebase branch, feature flag, or compatibility field remains

### Findings

- Direct-photometric removed 162 robust fit calls across 658 processed reconstruction frames; parametric-surface removed 175 across 669 frames.
- Isolated reference-fit ownership improves by 0.818 ms/direct frame and 0.918 ms/parametric frame. The full quick replay's reconstruction stage improves by 0.582 ms amortized across all four modes despite the unaffected sparse and depth modes.
- Mean quick risk improves by 0.01755 with categorical parity. Stable normalization changes a small number of direct/parametric attachment values after their bounded windows fill; this is the intended removal of implicit rebasing rather than bit-exact output preservation.
- A separate exact-input optimization for local/wide planar pose was rejected: only two of 2,099 paired attempts shared identical ordered estimator inputs.

### Actions

- Keep session reference geometry independent from bounded observation retention.
- Invalidate reference fits only when reset or estimator-model semantics change.
- Require long replay windows that exceed `maxFrames` for future reference-state changes.
- Measure the isolated fit saving on iPhone Safari and Chromium before applying it to the mobile budget.

## Validation report: exact same-frame reconstruction consensus

**Date**: 2026-07-31
**Scope**: direct-photometric and parametric mapping-to-pose robust consensus

### Checks

- [x] RED integration contracts cover both reconstruction engines
- [x] Exact-order reuse, reorder, clone, option invalidation, and failed-evaluation reuse are unit-tested
- [x] Direct, parametric, shared-cache, and reconstruction-mode suites pass 30/30
- [x] Five real-OpenCV engine, occlusion, drift, and rejection replays pass
- [x] Quick quality and risk aggregates are numerically identical
- [x] All 84 fixed strict reports pass
- [x] Full release verification passes 577/577 tests, production build, bundle budgets, flow audit, SBOM, license audit, and vulnerability audit
- [x] Mobile Chromium/WebKit browser matrix passes 7 tests with 3 browser-specific skips
- [x] No second estimator, threshold profile, feature flag, compatibility field, or alternate path remains

### Findings

- Direct-photometric reuses 280 of 550 ready-pose evaluations; parametric-surface reuses 484 of 562.
- Direct reconstruction improves by 1.683 ms per direct frame, parametric by 2.705 ms per parametric frame, and the four-mode aggregate by 0.923 ms per frame in the adjacent Node quick replay.
- Reuse changes no inlier set or pose result because both consumers receive the same completed result object. Calls whose eligibility filter or estimator contract differs are recomputed.

### Actions

- Keep the cache scoped to one plain-JS frame evaluation and clear it on reset or surface-model change.
- Require exact ordered evidence identity and complete estimator-option equality for future consumers.
- Measure the saving on iPhone Safari and Chromium before applying it to the mobile budget.

## Validation report: shared affine multi-RHS factorization

**Date**: 2026-07-31
**Scope**: robust 2D affine consensus, affine camera pose, sparse reconstruction completion

### Checks

- [x] RED contracts pin well-conditioned and regularized rank-deficient outputs exactly
- [x] All 80 deterministic robust-affine result records are byte-identical to the independent-solver baseline
- [x] Targeted reconstruction suites pass 35/35
- [x] Five real-OpenCV engine, occlusion, drift, and rejection replays pass
- [x] Quick quality and risk aggregates are numerically identical
- [x] All 84 fixed strict reports pass
- [x] Full release verification passes 579/579 tests, production build, bundle budgets, flow audit, SBOM, license audit, and vulnerability audit
- [x] Mobile Chromium/WebKit browser matrix passes 7 tests with 3 browser-specific skips
- [x] No single-RHS production wrapper, alternate solver, fallback, threshold change, dependency, compatibility branch, or migration path remains

### Findings

- A fixed 35-observation robust-affine fit improves from a five-run median of 6.040 ms to 5.387 ms, or 10.8%, while the 80-case result artifact retains the same SHA-256.
- The adjacent 84-report Node replay reduces amortized `reconstructionUpdateMs` from 7.337 ms to 6.172 ms, or 15.9%. Every reconstruction mode improves, from 9.4% for depth fusion to 19.2% for sparse reconstruction.
- One elimination now owns both image axes in robust consensus, affine camera pose, and sparse completion. No estimator evidence, inlier decision, pose result, or quality score changes.

### Actions

- Keep paired outputs on one factorization whenever they share the exact design matrix and regularization contract.
- Require bit-exact corpus comparison before accepting future solver-internal optimizations.
- Measure this saving on iPhone Safari and Chromium before applying it to the mobile frame budget.

## Validation report: allocation-free robust consensus scoring

**Date**: 2026-07-31
**Scope**: affine and similarity hypothesis scoring

### Checks

- [x] Full-precision contracts pin transforms, ordered inliers, residuals, ratios, and confidence
- [x] All 80 affine and 80 similarity deterministic result records are byte-identical to their materialized-scoring baselines
- [x] Targeted reconstruction suites pass 35/35
- [x] Five real-OpenCV engine, occlusion, drift, and rejection replays pass
- [x] Quick quality and risk structures are exactly identical
- [x] All 84 fixed strict reports pass
- [x] Full release verification passes 579/579 tests, production build, bundle budgets, flow audit, SBOM, license audit, and vulnerability audit
- [x] Mobile Chromium/WebKit browser matrix passes 7 tests with 3 browser-specific skips
- [x] No materialized-residual path, unused scorer export, alternate estimator, fallback, feature flag, compatibility branch, or migration path remains

### Findings

- The 35-observation affine microbenchmark improves from a five-run median of 5.345 ms to 5.088 ms, or 4.8%; similarity improves from 0.696 ms to 0.474 ms, or 31.9%.
- The adjacent 84-report Node replay reduces amortized `reconstructionUpdateMs` from 6.172 ms to 5.978 ms, or 3.1%, with improvements in every mode.
- The full-frame mean is 0.3% slower because the unrelated planar stage is 1.6% slower in the adjacent run. This is measurement noise, not evidence for or against the isolated scorer change.

### Actions

- Keep robust hypothesis loops allocation-free except for evidence owned by the current best candidate.
- Require byte-identical deterministic corpora for future scorer-internal optimizations.
- Measure scorer and GC behavior on iPhone Safari and Chromium before applying the Node saving to the mobile budget.

## Validation report: consuming paired least-squares workspace

**Date**: 2026-07-31
**Scope**: shared affine, camera, and sparse-completion least-squares internals

### Checks

- [x] Exact contracts pin well-conditioned and regularized rank-deficient three-column outputs plus a four-column camera fit
- [x] All 240 deterministic paired-solver result records are byte-identical to the copying-solver baseline
- [x] The existing 80-case robust-affine artifact retains its exact SHA-256
- [x] Targeted reconstruction suites pass 36/36
- [x] Five real-OpenCV engine, occlusion, drift, and rejection replays pass
- [x] Quick quality, risk, and benchmark result structures are exactly identical
- [x] All 84 fixed strict reports pass
- [x] Full release verification passes 580/580 tests, production build, bundle budgets, flow audit, SBOM, license audit, and vulnerability audit
- [x] Mobile Chromium/WebKit browser matrix passes 7 tests with 3 browser-specific skips
- [x] No generic value-set wrapper, copied augmented-matrix path, alternate solver, fallback, feature flag, compatibility branch, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Five-run solver medians improve by 38.1% for three-row affine hypotheses, 54.4% for 31-row affine refinements, and 51.4% for 32-row four-column camera fits.
- The fixed 35-observation robust-affine fit improves from 5.088 ms to 4.467 ms, or 12.2%, while retaining the exact 80-case result artifact.
- The adjacent 84-report Node replay reduces amortized `reconstructionUpdateMs` from 5.978 ms to 5.446 ms, or 8.9%. Sparse, direct, and parametric modes improve by 12.1%, 8.0%, and 10.2%.
- Depth fusion, total-frame, and planar timings move by +2.7%, +0.2%, and +1.0% in the adjacent run. Those stages do not provide mechanism evidence for this change, so no improvement is claimed for them.

### Actions

- Keep destructive solve ownership private and explicit; copy only if a future caller demonstrates that it must retain the source matrix.
- Require exact solver and end-to-end result artifacts for future least-squares internal changes.
- Measure solver and GC behavior on iPhone Safari and Chromium before applying the Node saving to the mobile frame budget.

## Validation report: compact ORB descriptor ownership

**Date**: 2026-07-31
**Scope**: native OpenCV descriptor lifetime, keyframe retention, same-frame reusable evidence

### Checks

- [x] RED real-OpenCV assertions require exact `descriptorCount * 32` retained buffers for fresh extraction and same-frame reuse
- [x] Stored descriptor row order, byte width, typed-word layout, association decisions, and insertion results are unchanged
- [x] Full reusable snapshots remain plain JavaScript data after native handles are released
- [x] Relocalization and image-anchor suites pass 173/173
- [x] Eight focused real-OpenCV planar, occlusion, recovery, and continuity cases pass
- [x] Quick quality, risk, benchmark result structures, and 617 profiled extractions are exactly unchanged
- [x] All 84 fixed strict reports pass
- [x] Full release verification passes 580/580 tests, production build, 24 asset checks, eight bundle budgets, flow audit, SBOM, 205-component license audit, and vulnerability audit
- [x] Mobile Chromium/WebKit browser matrix passes seven tests with three browser-specific skips
- [x] No detector cache, alternate descriptor representation, cadence change, feature flag, compatibility branch, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- The former selected descriptor views retained the complete detector buffer. Representative RED fixtures retained 13,440 bytes for 96 entries; the compact result retains the exact required 3,072 bytes.
- With 1,000 detected features and a typical 22 selected entries, retained descriptor payload falls from 32,000 to 704 bytes, or 97.8%. At the 96-entry maximum it falls by 90.4%; six full keyframes retain about 18 KB instead of 192 KB, excluding object overhead.
- The fixed isolated copy benchmark improves from a seven-run median of 1.359 to 0.845 microseconds, or 37.8%. Adjacent amortized `keyframeStoreMs` improves from 4.561 to 4.437 ms, or 2.7%.
- Reusing the ORB detector and output workspace produced bit-identical keypoints and descriptors but no repeatable latency gain. Global and rigid-planar cadence reductions saved extraction calls but failed repeated-texture, repeated-occlusion, or mature-map recovery thresholds. All rejected production changes were removed.

### Actions

- Keep native descriptor ownership synchronous and explicit; persist only the evidence the next owner consumes.
- Preserve exact retained-buffer assertions alongside semantic matching and replay gates.
- Treat keyframe cadence as recovery-quality policy, not a performance-only knob.
- Measure descriptor retention, garbage collection, and storage latency on primary iPhone Safari and Chromium before applying the Node figures to the mobile budget.

## Validation report: inlier-only homography post-processing

**Date**: 2026-07-31
**Scope**: OpenCV homography mask ownership, reprojection residuals, ORB optimization audit

### Checks

- [x] A 60-case real-OpenCV corpus preserves matrices, ordered inliers, ratios, condition metrics, and residual summaries byte-for-byte
- [x] Corpus SHA-256 remains `180febaa2c94a7f5a5fbbf4f42c276eeb07d009da6097737f50c0493d34dc2a0`
- [x] Persistent unit coverage independently recomputes average and maximum residual from returned ordered inliers
- [x] Homography and relocalization focused tests pass 16/16
- [x] Quick quality, benchmark, and coverage structures are exactly unchanged
- [x] All 84 fixed strict reports pass
- [x] Full release verification passes 581/581 tests, production build, 24 asset checks, eight bundle budgets, flow audit, SBOM, 205-component license audit, and vulnerability audit
- [x] Mobile Chromium/WebKit browser matrix passes seven tests with three browser-specific skips
- [x] No alternate matcher, split extractor, lookup table, fallback, flag, compatibility branch, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Inlier-only post-processing removes rejected-point projection plus the full residual-record, filtered-residual, and Boolean-mask arrays. It retains one ordered inlier array because planar PnP consumes it.
- The fixed 96-correspondence/85-inlier post-processing median improves from 2.949 to 1.672 microseconds, or 43.3%, while the exact complete-estimator result corpus remains unchanged.
- Complete-estimator reruns ranged from roughly 0.27 to 0.52 ms because native RANSAC variance dominates the isolated JS saving. The adjacent quick run was also slower in planar pose, reconstruction, ORB storage, and total frame time together, so no complete-estimator or pipeline improvement is claimed.
- Exact bounded Hamming early exit slowed the 96×1,000 JS matcher by 39.2%; typed nearest tables slowed it by 5.1%; native reciprocal `BFMatcher` was 3.8 times slower despite exact results in 30 cases. A 16-bit popcount table provided only a marginal raw-loop gain while adding a 64 KB module table. None was retained.
- Full-image ORB detection followed by selected-keypoint descriptor computation improved a single 640×480 fixture by 11.4% and matched its selected rows, but the quick matrix changed stage failures from 30/8/4 to 29/10/4 and increased storage extractions from 617 to 623. The entire split path and its structural test were removed.
- The unreferenced `transformTemplateCenter` method allocated two OpenCV matrices around a native one-point transform. Production already uses the retained homography matrix directly, so the dead path was deleted.

### Actions

- Treat a native robust-estimator mask as the ownership boundary for all downstream summaries.
- Require exact result corpora and full replay parity for future post-estimator optimizations.
- Keep the current unrolled JS Hamming matcher until a complete production-shaped benchmark demonstrates a faster exact implementation.
- Keep combined ORB `detectAndCompute`; do not split detector and descriptor evidence based on isolated-image parity.
- Measure post-processing and garbage-collection behavior on primary iPhone Safari and Chromium before applying the Node saving to the mobile budget.

## Validation report: session-owned planar PnP camera inputs

**Date**: 2026-07-31
**Scope**: immutable OpenCV input ownership, worker-session lifecycle, per-pose native allocation

### Checks

- [x] RED coverage fails while the estimator has no owned native camera inputs
- [x] Real-OpenCV coverage verifies exact matrix values and handle identity across consecutive solves
- [x] Reinitialization deletes both old handles before replacing the calibrated inputs
- [x] Disposal deletes both current handles and clears tracking continuity
- [x] A 60-case exact result corpus remains byte-identical with SHA-256 `c5b8b120b567862314fb49fe7afff0817b222a5ceee5d9311229e102f76f2561`
- [x] Quick quality remains 45/84 passes, 39 diagnostic failures, and 24.571289 mean risk
- [x] All 84 fixed strict reports pass
- [x] Full release verification passes 581/581 tests, production build, asset and bundle gates, flow audit, SBOM, license audit, and vulnerability audit
- [x] Mobile Chromium/WebKit browser matrix passes seven tests with three browser-specific skips
- [x] No per-size cache, pool, alternate solver, compatibility branch, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- OpenCV marks `cameraMatrix` and `distCoeffs` as inputs to `solvePnP`; their reuse is aligned with the calibrated worker-session lifetime, while `rvec` and `tvec` remain solve-owned outputs.
- Rebuilding and deleting the 3x3 camera matrix and four-value zero-distortion matrix costs a nine-run Node median of 1.841 microseconds per pose call.
- An alternating 11-pair complete-PnP benchmark improves from 97.432 to 95.126 microseconds per call, or 2.4%. The saving is deliberately not generalized to the whole frame or to iPhone hardware.
- Exact pose output, temporal branch selection, residual scoring, and quality reports are unchanged; the optimization changes ownership only.

### Actions

- Align immutable OpenCV input handles with the narrowest stable owner lifecycle instead of recreating them inside hot calls.
- Require explicit replacement and disposal assertions whenever native state moves from call ownership to session ownership.
- Profile this native-allocation saving on primary iPhone Safari and Chromium before applying it to the mobile frame budget.

## Validation report: session-owned planar PnP solve workspace

**Date**: 2026-07-31
**Scope**: reusable OpenCV output workspace, variable correspondence shapes, temporary point ownership

### Checks

- [x] RED coverage fails while no session workspace exists
- [x] Real-OpenCV coverage verifies the same five handles across 35, 20, and 35 correspondence shapes
- [x] Fresh and forced temporal candidates share rotation, translation, and Rodrigues output handles
- [x] Recalibration and disposal delete every workspace handle
- [x] A normal fresh solve creates zero Mat handles instead of five
- [x] The 60-case exact corpus retains SHA-256 `c5b8b120b567862314fb49fe7afff0817b222a5ceee5d9311229e102f76f2561`
- [x] Quick quality, benchmark, and coverage structures are byte-identical to the preceding baseline
- [x] All 84 fixed strict reports pass
- [x] Release verification passes 582/582 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] No pool, fixed-capacity assumption, compatibility branch, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- OpenCV `Mat.create` is the correct variable-shape primitive because matching shapes reuse storage and changed shapes remain owned by one stable Mat handle.
- `solvePnP` output arrays and Rodrigues output are safe sequential workspace members because every candidate result is copied to JavaScript values before a later candidate overwrites them.
- Direct native point filling removes the two point-array copies; residual computation must continue from original correspondences to preserve the previous double-precision scoring arithmetic.
- The controlled alternating workspace benchmark improves from 96.106 to 91.416 microseconds, or 4.9%. The preceding production-shaped baseline and candidate measure 97.034 and 91.357 microseconds, or 5.9%.
- Adjacent quick timings moved against the isolated mechanism while multiple unrelated stages slowed together, so they do not support a complete-pipeline speed claim.

### Actions

- Reuse output matrices only when calls are sequential and copy every retained result before the next native write.
- Pair variable-shape `Mat.create` reuse with lifecycle and changing-shape tests; do not infer buffer reuse from stable JavaScript handle identity alone.
- Preserve original numerical inputs for quality scoring when native solver inputs intentionally use lower precision.
- Measure native allocation and garbage-collection behavior on primary iPhone Safari and Chromium before applying Node measurements to the mobile budget.

## Validation report: allocation-stable Lucas-Kanade tracking

**Date**: 2026-07-31
**Scope**: per-frame OpenCV ownership, bounded tracker histories, disabled diagnostics, outlier residual containers

### Checks

- [x] RED coverage fails while Lucas-Kanade matrices and bounded histories remain call-owned
- [x] Real OpenCV verifies accurate translated flow through the retained workspace
- [x] The same four handles support 80- and 32-point shapes
- [x] Reinitialization and disposal delete every workspace handle
- [x] Initial five-frame motion-consensus behavior remains covered
- [x] Quick coverage, quality, and benchmark projections are byte-identical to the preceding baseline
- [x] All 84 fixed strict reports pass
- [x] Release verification passes 585/585 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] No native pool, maximum-point assumption, compatibility branch, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- A tracker session is the narrow stable owner for LK input and output matrices; `Mat.create` preserves handle identity while allowing the active landmark count to change.
- Candidate objects are evidence during initial motion-consensus but are redundant after that window. Reading native result views directly preserves status, threshold, coordinate, and update order.
- Bounded histories should evict in place. Replacing a ten-entry array for every tracked landmark on every frame creates avoidable young-generation garbage and breaks storage identity.
- Disabled diagnostics must guard payload construction at the call site when the logger API receives eager arguments; rate limiting inside the logger cannot recover already-created objects and strings.
- Single-pass quality averaging preserves filtered reduction order without materializing the filtered values. Numeric residual arrays preserve outlier order without record wrappers or a temporary reference-ID set.
- The isolated 80-point Node medians improve from 3.294 to 0.858 microseconds for four native matrices, 1.857 to 0.586 for bounded histories, 1.447 to 0.827 for quality scanning, 0.501 to 0.117 for steady-state flow metadata, and 5.321 to 3.604 for outlier residual ownership.
- The adjacent quick mean `keypointTrackMs` improves from 1.839 to 1.785 ms, while its maximum sample worsens from 12.331 to 13.626 ms. Treat the mean as supporting evidence only; do not claim a spike or mobile-budget improvement.

### Actions

- Align OpenCV workspaces with sequential service lifetimes and prove replacement plus disposal explicitly.
- Keep startup-only geometric evidence separate from steady-state metadata so correctness work does not impose permanent allocations.
- Guard eager debug payloads before construction in frame loops.
- Profile allocation and garbage-collection behavior on iPhone Safari and Chromium before applying Node measurements to the mobile budget.

## Validation report: session-owned homography consensus workspaces

**Date**: 2026-07-31
**Scope**: seeded homography input/output ownership, typed-view access, independent planar evidence

### Checks

- [x] RED tests fail while both homography owners keep call-owned inputs and masks
- [x] Real OpenCV verifies retained handles across 35→20→35 and 24→12→24 correspondence shapes
- [x] Estimator reinitialization and both owner disposals delete every retained handle
- [x] Quick coverage, quality, and benchmark projections remain byte-identical
- [x] All 84 fixed strict reports pass
- [x] Release verification passes 586/586 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] No duplicate path, native pool, compatibility branch, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Cache an Embind typed view once before a fill loop. Re-reading `mat.data32F` for every scalar made the first workspace candidate 39% slower even though its ownership model was sound.
- One variable-shape workspace improves the alternating 14/27-point workload from 102.869 to 100.352 microseconds. Two size-stable workspaces reach 100.167 microseconds but do not justify twice the native state.
- Fixed-size microbenchmarks can overstate reuse because production alternates local and wide correspondence counts. Always reproduce the actual shape sequence before selecting a workspace topology.
- Planar local and wide correspondence sets are nested but not equivalent: 677 observed pairs had a 100% prefix relationship and zero exact matches, with mean sizes 13.7 and 27.2. Evidence deduplication is invalid even though memory ownership can be shared sequentially.
- Shared workspace helpers should own only shape and lifecycle. Callers retain their explicit point schemas, thresholds, seeds, and mask interpretation, preventing a generic helper from becoming an alternate estimator.
- Adjacent replay timings moved together across unrelated native stages and are not attributed to the workspace. Exact quality parity plus controlled ownership timings are the valid evidence.

### Actions

- Benchmark reusable native buffers with production-shaped size alternation, not only a steady maximum size.
- Treat nested robust-estimator inputs as distinct evidence unless ordered identity and every estimator option are equal.
- Cache native typed views outside scalar loops and cover variable shapes plus disposal with the real backend.
- Measure native allocation and garbage-collection behavior on primary iPhone Safari and Chromium before applying the Node result to the mobile budget.

## Validation report: consumer-audited tracker similarity fitting

**Date**: 2026-07-31
**Scope**: production consumer graph, dead per-frame diagnostics, robust similarity allocation behavior

### Checks

- [x] Repository-wide references prove tracking stability history and its accessor have no production consumer
- [x] RED coverage fails while steady-state LK still evaluates the unused anchor position
- [x] Full-precision characterization preserves transform, consensus, residual, and confidence output
- [x] A deterministic 100-case corpus retains SHA-256 `a69ce6a666a528a74cbd403912631e35f01fde9a21fd2e6f7f27a2bc8b4065af`
- [x] Four reconstruction modes produce the same profiled call reduction on a fixed 23-frame replay
- [x] Quick coverage, quality, and benchmark projections remain byte-identical
- [x] All 84 fixed strict reports pass
- [x] Release verification passes 586/586 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] No diagnostic history, compatibility API, cache, alternate estimator, flag, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Trace the consumer graph before optimizing diagnostic work. The original candidate was to cache repeated attachment fits, but one of the three per-frame evaluations existed only to feed an unread history and could be deleted without an invalidation contract.
- Profile nested primitives by call count as well as wall time. The fixed replay exposed 69 anchor evaluations, 70 local fits, 163 robust reference fits, and 326 similarity fits per mode; deleting one anchor evaluation per frame reduced those counts to 46, 47, 117, and 234.
- Preserve reduction order when removing allocation. Scalar centroid accumulators, numeric residual storage, ordered inlier pushes, and a direct refined-residual sum reproduce the prior JSON result exactly while avoiding per-point wrapper objects and intermediate filter/map arrays.
- Pair old and new implementations in the same warmed process. Separate-process medians were noisy enough to suggest the wrong direction; an alternating 15-batch comparison measured 4.579 versus 2.604 microseconds, a 43.1% improvement, with exact result parity.
- Deterministic output hashes and broad replay quality are stronger acceptance evidence than adjacent whole-pipeline timings. The latter include unrelated OpenCV/WASM and host-load variance and should not be attributed to a micro-optimization.

### Actions

- Audit production readers before preserving, caching, or pooling diagnostic data structures.
- Require explicit invalidation ownership before adding a per-frame result cache; delete unconsumed computations first.
- Benchmark old and candidate primitives alternately in one process and keep a deterministic result corpus alongside timing evidence.
- Preserve arithmetic and iteration order when replacing allocation-heavy functional chains with scalar hot-loop traversal.

## Validation report: update-scoped attachment evidence

**Date**: 2026-07-31
**Scope**: same-update evidence reuse, explicit mutation boundary, attachment-fit call volume

### Checks

- [x] Full quick-matrix profiling covers all 2,683 preliminary/final evaluation pairs
- [x] Every one of the 88 changed evidence pairs follows successful descriptor restoration
- [x] Zero evidence pairs change without descriptor restoration
- [x] RED coverage proves preliminary and final resolution share one immutable evaluation
- [x] RED coverage proves descriptor restoration invalidates the preliminary evaluation
- [x] Quick coverage, quality, and benchmark projections remain byte-identical
- [x] All 84 fixed strict reports pass
- [x] Release verification passes 588/588 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] No cross-frame cache, fingerprint, compatibility branch, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Profile evidence identity across the complete control-flow matrix before introducing reuse. In 2,595 of 2,683 pairs the point snapshot was identical; the other 88 all crossed the same explicit descriptor-restore mutation.
- Store reusable evidence in the update scope that owns its lifetime. A local evaluation makes preliminary policy and final OpenCV arbitration share work without creating session state, a generation counter, or a structural fingerprint.
- Invalidate at the proven mutator, not at downstream symptoms. Successful descriptor restoration replaces landmark coordinates and reference geometry, so it clears the evaluation immediately; failed relocalization leaves the immutable evidence valid.
- Preserve the final estimator set. Similarity candidates are reused, while homography still runs once when OpenCV becomes available. The optimization removes duplicate computation rather than dropping geometric evidence.
- On the fixed 23-frame replay, similarity fits fall from 234 to 142, reference-transform evaluations from 117 to 71, and local fits from 47 to 24. The paired 35-point benchmark improves from 14.974 to 7.620 microseconds, with exact result parity.
- A hidden tracker cache would require mutation versioning across refresh, relocalization, support rejection, and disposal. The explicit evaluation avoids that state-space and makes invalidation reviewable at the service call site.

### Actions

- Prefer request/update-owned evidence snapshots when two sequential consumers use one immutable observation set.
- Prove the complete mutation boundary from production-shaped traces and lock every observed invalidator with a contract test.
- Keep expensive late-stage evidence lazy when preliminary policy does not need it; here homography remains final-resolution-only.
- Validate call-volume reductions separately from whole-pipeline timings, and measure on primary iPhone Safari/Chromium before claiming frame-budget improvement.

## Validation report: allocation-stable robust affine hypotheses

**Date**: 2026-07-31
**Scope**: bounded affine RANSAC arithmetic, hypothesis allocation ownership, reconstruction stage performance

### Checks

- [x] Existing exact affine examples compile and pass
- [x] A deterministic 100-case quality/spatial corpus preserves every projected result byte
- [x] All affine consumers pass focused reconstruction and relocalization tests
- [x] Quick coverage, quality, and benchmark projections remain byte-identical
- [x] All 84 fixed strict reports pass
- [x] Release verification passes 589/589 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] The focused numeric helper does not duplicate or conflict with the general refined least-squares solver
- [x] No session cache, shared mutable workspace, compatibility branch, or migration path remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Profile the complete estimator before optimizing its native subroutine. Parametric PnP consumed 0.627 ms amortized, but its first isolated workspace result improved only the light solve by 13%, so it was deferred until after the higher-leverage affine hypothesis loop. A later complete lifecycle audit found 704 native create/delete pairs across 88 solves and justified the engine-owned workspace once explicit disposal and bundle-budget contracts were included.
- In bounded exhaustive robust fitting, per-hypothesis allocation can dominate arithmetic. Reusing one invocation-local augmented matrix and scoring into numeric slots improves the representative fit from 5.001 to 2.365 ms without reducing the hypothesis set.
- Preserve search and refinement as separate ownership phases. Hypothesis search needs only count and residual sum; ordered inlier objects are materialized once for the winning transform, then passed to the unchanged general least-squares refinement.
- Keep numeric workspaces invocation-local unless reentrancy and lifecycle ownership have been proved. This fit is synchronous and its buffers never escape, avoiding session invalidation, disposal, or cross-frame evidence concerns.
- A similarity-only mode is a useful performance control. Depth fusion changed by 4.5%, while the three affine-heavy modes improved by 27–33%, supporting attribution to the affine solver rather than general host-load variance.
- Exact corpus hashes and full replay structure are the correctness gates. Timing improvements alone cannot detect a changed tie-break, pivot choice, inlier order, or near-threshold consensus.

### Actions

- For bounded exhaustive estimators, measure allocation per hypothesis as well as hypothesis count and arithmetic cost.
- Accumulate the minimum sufficient hypothesis score, materializing rich evidence only for the selected candidate.
- Preserve operation order, regularization, pivoting, and tie-break semantics when replacing generic containers with fixed-shape numeric workspaces.
- Use an unaffected algorithmic mode as a timing control and require primary-device profiling before claiming mobile frame-budget compliance.

## Validation report: columnar ORB keyframe association

**Date**: 2026-07-31
**Scope**: native ORB feature materialization, landmark association ordering, keyframe storage performance

### Checks

- [x] A deterministic 1,002-feature/97-landmark contract matches ordered exhaustive association exactly
- [x] Equal-distance ties and one-to-one feature ownership retain their prior semantics
- [x] Fresh detector output and exact same-frame reusable evidence use one association implementation
- [x] A production-shaped 1,000-feature/96-landmark benchmark shows an isolated 58.3% bookkeeping improvement
- [x] Quick pass/fail counts, mean risk, and maximum risk remain exact
- [x] All 84 fixed strict reports pass
- [x] Release verification passes 589/589 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] Cropped, masked, string-indexed, and exhaustive-column experiments leave no production path
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Preserve detector evidence before optimizing its consumers. Cropping reduced invoked ORB extraction by roughly 70% but changed its pyramid and caused seven focused replay failures. A full-frame feature mask still changed ranking and retained four of those failures. Both candidates were removed.
- Fewer allocations do not prove faster execution. The first columnar exhaustive association was bit-exact but measured 56% slower than the existing spatial lookup, so it was rejected before acceptance.
- Numeric structure-of-arrays storage and a nested numeric spatial index remove nested point objects, string cell keys, and `Set` membership without expanding the search. Sorting each local candidate list back into detector order preserves distance ties and output identity.
- On the same warmed production-shaped input, the retained bookkeeping path improves from 0.145 to 0.060 ms. In the adjacent full matrix, invoked keyframe feature extraction improves from 20.184 to 19.040 ms and amortized keyframe storage from 4.668 to 4.385 ms, with exact quality parity.
- Reused relocalization evidence needs the same columnar boundary as fresh extraction. Keeping a separate object-based association path would preserve duplicate semantics and leave the optimization incomplete.

### Actions

- Keep full-frame ORB detection and descriptor evidence unchanged until a replacement passes the entire focused recovery suite, not only aggregate quality.
- Benchmark allocation changes together with their replacement lookup algorithm; reject lower-allocation candidates that increase complete slice time.
- Preserve detector order explicitly whenever a spatial index narrows candidate traversal.
- Measure the accepted path on primary iPhone Safari and Chromium before treating Node/OpenCV-WASM results as a mobile budget claim.

## Validation report: axis-bounded robust residual scoring

**Date**: 2026-07-31
**Scope**: affine and similarity consensus scoring, exact geometric bounds, reconstruction-stage performance

### Checks

- [x] RED coverage proves coordinate-rejected observations skip Euclidean norm evaluation
- [x] Surviving observations retain the exact `Math.hypot` circular residual test
- [x] The deterministic 100-case affine corpus retains its established SHA-256
- [x] All affected reconstruction and relocalization tests pass 63/63
- [x] Quick coverage, quality, and compact benchmark projections remain byte-identical
- [x] All 84 fixed strict reports and all 90 strict vision tests pass
- [x] Release verification passes 590/590 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] The rejected frame-consensus fit reuse leaves no alternate path or compatibility code
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Use a mathematically necessary cheap bound before an expensive exact metric. A point inside a radius-`t` circle must lie inside `[-t, t]` on both axes, so either coordinate exceeding `t` proves rejection without evaluating a square root.
- Keep the exact expensive predicate for every survivor. The axis check narrows candidates but does not replace `Math.hypot`, preserving circular boundary behavior, residual sums, hypothesis tie-breaks, and output bytes.
- Optimize the hypothesis population, not only the winning model. A rejected 36-point hypothesis improves from 0.567 to 0.090 microseconds because most observations fail an axis bound; the complete affine fit improves from 2.228 to 2.016 ms without reducing search coverage.
- Quick `reconstructionUpdateMs` improves from 4.024 to 3.664 ms, while unrelated OpenCV/WASM stages move upward. Attribute only the isolated mechanism and affected-stage reduction, not total frame timing.
- Apparent duplicate estimators require empirical equivalence proof. Reusing the first consensus fit changed affine transforms in up to 19 of 96 cases and similarity transforms in eight, so the second refinement owns real evidence and must remain.
- A failed optimization investigation is useful evidence when its experiment is removed completely and the rejection boundary is recorded.

### Actions

- Look for necessary scalar bounds before transcendental work in exhaustive CV loops, then retain the original exact predicate for survivors.
- Lock residual ordering and full result hashes whenever a scoring shortcut can affect robust-estimator tie-breaks.
- Characterize sequential estimator outputs across structured and adversarial corpora before treating one as redundant.
- Separate affected-stage evidence from host-level timing noise and require primary iPhone measurements for mobile budget claims.

## Validation report: allocation-stable robust similarity hypotheses

**Date**: 2026-07-31
**Scope**: bounded similarity RANSAC allocation ownership, paired V8 benchmarking, reconstruction-stage performance

### Checks

- [x] RED coverage defines the numeric hypothesis workspace and minimum sufficient search score
- [x] A deterministic 120-case corpus preserves every complete result byte
- [x] Focused similarity, reconstruction, depth, surface, and relocalization tests pass 73/73
- [x] Quick coverage, quality, and compact benchmark projections remain byte-identical
- [x] All 84 fixed strict reports and all 90 strict vision tests pass
- [x] Release verification passes 592/592 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] The old per-hypothesis rich object path is removed completely
- [x] No session cache, shared workspace, alternate estimator, compatibility branch, or migration remains
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Rich evidence belongs to the selected model, not every candidate. Pair search needs four transform scalars, inlier count, and accepted residual sum; ordered observation objects are materialized only for the winning transform before refinement.
- Preserve phase boundaries when removing allocation. Hypothesis generation and scoring use an invocation-local numeric workspace, while the established rich scorer remains the single owner of winning inliers and the existing least-squares refinement.
- Benchmark small JavaScript changes by alternating old and new implementations in one warmed process. Separate runs measured only a 0.5% difference; 21 alternating pairs resolved a stable 5.38% improvement from 0.344779 to 0.326233 ms.
- A broad affected-stage profile is necessary even after an isolated win. Quick reconstruction improves in all four consumers, from 6.3% in direct photometric to 14.6% in depth fusion, while quality and risk structures remain exact.
- Do not credit correlated host-load movement. Total frame and relocalization timings improved too, but include native ORB/OpenCV work that the similarity workspace cannot own.
- Session-lifetime pooling is unnecessary when one synchronous invocation can own all mutable scratch space. Invocation ownership preserves reentrancy without invalidation or disposal state.

### Actions

- Keep candidate search results numeric until a winner requires object identity and ordered evidence.
- Use same-process alternating benchmarks for sub-millisecond V8 changes and retain all paired samples, not only one mean.
- Require a full deterministic output corpus whenever allocation removal changes representation inside a robust-estimator tie-break loop.
- Attribute performance only to isolated mechanisms and directly affected stages; require primary iPhone profiling for mobile budget claims.

## Validation report: single planar pose solver

**Date**: 2026-07-31
**Scope**: planar pose ownership, fallback reachability, unused homography diagnostics

### Checks

- [x] Repository-wide tracing finds one production homography `estimatePose` consumer with an explicit anchor reference
- [x] An instrumented 84-report quick matrix records zero approximate decomposition-fallback calls across 2,683 tracked updates
- [x] RED coverage requires the duplicate decomposition solver, stability API, history state, and pseudo-condition metric to be absent
- [x] Homography matrix, ordered inlier identity, ratios, residual summaries, and planar PnP behavior remain covered
- [x] Quick coverage, quality, and compact benchmark projections remain byte-identical at their established SHA-256 values
- [x] All 84 curated strict reports and all 90 strict vision tests pass
- [x] Release verification passes 592/592 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] The rejected columnar hypothesis experiment leaves no production module, test, API, or alternate path
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Consumer reachability is stronger deletion evidence than naming a branch a fallback. The only production caller always supplied planar PnP's anchor reference, and a complete instrumented matrix observed zero executions of the alternative decomposition.
- A diagnostic is not free merely because nobody reads it. Every successful homography retained another bounded matrix reference and computed a nine-element diagonal-dominance ratio, while its history and stability method had no consumer.
- Keep the solver that owns calibrated geometry. The retained path uses the session camera matrix, zero distortion input, object points relative to the tapped anchor, ordered RANSAC inliers, and temporal branch continuity. The removed approximation duplicated part of that responsibility without sharing its contract.
- Lower object-property reads do not imply lower wall time. Packing affine/similarity coordinates into typed columns passed exactness coverage, but complete warmed benchmarks stayed flat and spatial sampling moved slightly slower, so the experiment was removed.
- Deleting a dead recovery branch is safe only after broad dynamic evidence. Exact quick hashes, strict replays, release tests, and mobile browser lifecycle tests guard against a repository search missing indirect runtime behavior.

### Actions

- Require both static consumer tracing and production-shaped call counting before removing an algorithmic fallback.
- Make required geometric inputs explicit at the sole call boundary; do not retain optional containers for nonexistent consumers.
- Remove dead diagnostics with their state and result fields instead of leaving compatibility aliases or empty lifecycle hooks.
- Reject representation-only optimization when a complete warmed benchmark does not improve, even if allocation or property-access counts look better.
- Preserve target-device validation as a separate gate; desktop parity can approve deletion semantics but not mobile latency.

## Validation report: direct affine hypothesis assembly

**Date**: 2026-07-31
**Scope**: three-point affine normal-equation construction, planar-solver candidate research, reconstruction-stage performance

### Checks

- [x] RED coverage restricts the hypothesis workspace to elimination, current result, winning result, and score storage
- [x] The deterministic 100-case affine corpus retains SHA-256 `db6c2d4b01610427b010a26a3b3ad204ddd207c26d7a6b404b606effcd40a878`
- [x] A 21-pair alternating same-process benchmark preserves the exact winning score and improves complete search wall time
- [x] Focused affected tests pass 67/67
- [x] Quick coverage, quality, and compact benchmark projections remain byte-identical at their established SHA-256 values
- [x] All 84 curated strict reports and all 90 strict vision tests pass
- [x] Release verification passes 593/593 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] Rejected IPPE, SQPnP, and SQPnP-plus-LM experiments leave no production branch, test, fallback, or compatibility code
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- Fixed-size algebraic staging can be removed without changing arithmetic ownership. Reading the three matches into scalars and writing the `3 x 5` augmented system directly preserves coefficient accumulation, regularization, pivoting, elimination, and solution layout while removing five scratch containers.
- Measure the complete hot search, not only coefficient construction. The paired production-shaped median improves from 1.723008 to 1.519494 ms, or 11.8%, with the exact same winning score.
- A deterministic result corpus must cover both quality and spatial sampling because hypothesis ordering participates in tie-break behavior. All 100 full results remain byte-identical after the representation change.
- Synthetic microbenchmarks cannot approve an estimator switch. SQPnP looked faster and accurate in the isolated synthetic sweep, but the strict low-light planar-book replay exposed a `0.116` head-world error that the iterative solver did not produce.
- Refinement can erase an apparent algorithmic win. `solvePnPRefineLM` restored SQPnP residual quality but made its median isolated solve about 17% slower than iterative PnP, so the whole experiment was removed.
- The affected quick stage improves 5.2% without changing coverage, quality, compact benchmark, or risk structures. Aggregate frame timing is supporting host evidence only because native OpenCV/WASM stages share it.

### Actions

- Specialize tiny fixed-shape linear systems only when exact corpus hashes prove arithmetic and tie-break parity.
- Benchmark the complete estimator in alternating warmed pairs; subroutine timing alone is insufficient for approval.
- Require strict capture-degradation replay before replacing a calibrated geometry solver, even when official algorithm guarantees and synthetic accuracy look stronger.
- Delete rejected solver experiments completely and retain their rejection evidence in the validation record instead of shipping dormant fallbacks.
- Keep primary iPhone profiling as the separate authority for the mobile frame budget.

## Validation report: conservative squared affine residual rejection

**Date**: 2026-07-31
**Scope**: affine hypothesis scoring, exact circular residual ownership, mode-specific performance attribution

### Checks

- [x] RED coverage distinguishes axis rejection, diagonal circular rejection, and an accepted exact boundary
- [x] The original `Math.hypot` comparison remains the acceptance authority for every surviving observation
- [x] The deterministic 100-case affine corpus retains SHA-256 `db6c2d4b01610427b010a26a3b3ad204ddd207c26d7a6b404b606effcd40a878`
- [x] Four alternating same-process populations retain exactly equal accumulated scores
- [x] Focused affine consumers pass 34/34
- [x] Quick coverage, quality, and compact benchmark projections remain byte-identical at their established SHA-256 values
- [x] All 84 curated strict reports and all 90 strict vision tests pass
- [x] Release verification passes 593/593 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] Similarity and indexed-loop experiments leave no production branch, abstraction, test path, or compatibility code
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly

### Findings

- A cheap proof predicate can precede an expensive exact predicate without replacing it. Axis bounds constrain residual magnitude, the conservative squared check rejects points clearly outside the circle, and `Math.hypot` still decides every survivor and supplies the unchanged accumulated residual.
- Numerical proof checks need an outward rounding margin when exact boundary behavior matters. Eight machine epsilons around the squared threshold keep the `3-4-5` boundary on the original path while remaining negligible for clear rejections.
- Cache fixed model coefficients, not observation geometry. Six affine coefficients are constant across an entire hypothesis score; reading them once helps without the copy cost that caused the earlier columnar-observation experiment to fail.
- Report the full benchmark range. Four populations improve by 0.3–3.3%; the weak light-outlier result prevents presenting the heavy-outlier maximum as typical.
- Mode controls strengthen attribution. The three affine-heavy modes improve by 2.2–3.3%, while similarity-only depth fusion is effectively flat at −0.07% and unrelated ORB timings do not move with the scorer.
- A mathematically reusable idea is not automatically a performance abstraction. Similarity scoring became slightly slower, from 0.179893 to 0.180600 ms, so only the measured affine owner retains the change.

### Actions

- Keep exact metric evaluation after conservative scalar proof gates whenever residual values participate in tie-breaks.
- Add explicit boundary cases before using squared comparisons around floating-point thresholds.
- Cache per-hypothesis constants only after measuring the complete observation population in a warmed process.
- Preserve mode-specific controls and exact result hashes when a host-level improvement is small.
- Reject universal helpers when consumers have different JIT and workload behavior; shared mathematics alone is insufficient.

## Validation report: session-owned ORB extraction workspace

**Date**: 2026-07-31
**Scope**: ORB native resource ownership, keyframe storage/recovery extraction, robust-estimator replacement research

### Checks

- [x] RED coverage requires sequential real ORB extractions to share one detector while executing both calls
- [x] Workspace lifecycle coverage proves detector, mask, keypoint vector, and descriptor matrix are released
- [x] Successful and failed recovery preserve exact same-frame feature reuse
- [x] Nine focused recovery, dropout, rigid-planar, and occlusion scenarios pass 9/9
- [x] Quick coverage, quality, and compact benchmark projections remain byte-identical at their established SHA-256 values
- [x] All 84 curated strict reports and all 90 strict vision tests pass
- [x] Release verification passes 593/593 tests plus build, asset, budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly
- [x] Rejected USAC, RHO, landmark-mask, and attempt-pruning experiments leave no production branch, flag, compatibility path, or legacy helper

### Findings

- Pool native resources only at the lifecycle that already owns sequential execution. One relocalizer session can reuse its detector, empty mask, keypoint vector, and descriptor matrix without exposing shared mutable state outside synchronous extraction.
- Preserve feature evidence before optimizing the search domain. Both landmark masks changed which pyramid features survived ORB ranking and caused strict recovery regressions even though all requested landmarks remained inside the mask.
- Faster consensus is not equivalent consensus. USAC produced more inliers and a strict residual mask at roughly one thirteenth of classic RANSAC's isolated cost, but its different inlier population changed downstream PnP continuity and failed seven strict scenarios.
- Allocation stability can be accepted without pretending it is a latency win. The alternating benchmark measured only about 0.25% median improvement and the quick extraction stage was flat; the objective result is four fewer native allocation/deletion cycles after the first extraction.
- Exact output structure is the appropriate guard for a resource-only change. Fixed extraction counts and the established coverage, quality, and compact benchmark hashes prove that the workspace does not alter event frequency or pipeline decisions.
- Reject low-yield exact pruning too. The local/wide pose score bound could prove only 19 of 677 skips in the better order, which was insufficient to justify changing evaluation order.

### Actions

- Keep full-frame ORB evidence until a replacement passes all recovery-specific strict tests, not just aggregate risk.
- Require explicit disposal tests for every session-owned OpenCV.js workspace.
- Separate allocation-count claims from latency claims, and require primary iPhone measurements before asserting frame-budget impact.
- Treat robust estimator masks as downstream model inputs; validate PnP continuity and dropout semantics before switching methods.
- Remove rejected experiments completely and retain only their measured rejection boundary in the validation record.

## Validation report: ORB-first XFeat keyframe recovery

**Date**: 2026-07-31
**Scope**: learned planar relocalization, nested-worker ownership, model provenance, async CV lifetime, classical recovery isolation

### Checks

- [x] A 545-pair bake-off compares ORB-only, XFeat-only, and ORB-first fallback on identical non-occluded frames
- [x] A real pinned ONNX contract proves ORB failure and XFeat recovery with 15 inliers at 7.26 px anchor error
- [x] Preprocess, 5x5 NMS, reliability ranking, bicubic descriptor sampling, mutual-nearest matching, robust geometry, lifecycle, and worker ownership are unit-tested
- [x] XFeat runtime failure preserves the original ORB result and reports learned-path diagnostics
- [x] A query-frame ownership test proves nested-worker transfer cannot detach depth-fusion RGB
- [x] Generic learned eligibility cannot reclassify tracker geometry; curved tap-time ORB admission remains geometry-scoped
- [x] Quick coverage, quality, and compact benchmark structures remain byte-identical at their established SHA-256 values
- [x] All 90 strict vision tests pass
- [x] Release verification passes 605/605 tests, 29 asset checks, eight bundle budgets, a clean 90-file flow audit, SBOM, license audit, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes seven tests with three browser-specific skips
- [x] Rejected XFeat-only, LightGlue/SuperPoint, static anchor-worker import, and raised-budget paths leave no production branch, flag, shim, or migration code
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly
- [ ] Physical iPhone Safari/Chromium recovery latency and peak-memory profiling remain required for a target-device budget claim

### Findings

- Complementary recovery beat replacement. ORB recovered 454/545 pairs with 14.51 px p95 error, XFeat alone recovered 424/545 with 34.56 px p95 error, and ORB-first fallback recovered 484/545 without replacing an accepted ORB result.
- Capability eligibility and geometry classification are different contracts. Reusing the learned gate as a planar pose hint regressed broad replay even though focused matcher tests passed.
- Tap-time and mature-map ORB admission are also different contracts. Giving curved targets a trusted-tap affine keyframe broke three strict scenarios; restoring geometry-scoped tap-time admission recovered all three while preserving later mature-map ORB recovery.
- Async recovery extends native-resource lifetime. The frame `Mat` must survive until the learned promise settles; deleting it at the old synchronous boundary produced a deterministic deleted-handle failure.
- Transfer ownership must follow downstream consumers. The nested XFeat worker can own a copied recovery query, but depth fusion must retain the original RGB frame alongside its depth map. Omitting it failed all 21 depth-fusion quick reports.
- Code splitting is part of the performance contract. Static model runtime import pushed the anchor worker beyond its 320 KB budget; a dedicated nested worker keeps it at 314.01 KB and isolates the 98.61 KB XFeat worker without raising the limit.
- The official XFeat graph and data have a short permissive provenance chain. LightGlue added a second learned stage and a less suitable SuperPoint weight-provenance chain for this project, so its complexity was not retained.
- Node timing selected 256×192 but cannot establish mobile performance. The observed 9.44 ms median is host WASM evidence only; primary iPhone measurement remains separate.

### Actions

- Keep LK steady-state, ORB first, and XFeat recovery-only for conservatively eligible planar selections.
- Keep learned eligibility, pose geometry, and classical keyframe admission as separate policy owners with regression coverage.
- Preserve the query-copy boundary until every same-frame RGB consumer has completed; do not transfer the live depth-fusion buffer.
- Keep the learned runtime in its dedicated worker and enforce the existing anchor-worker budget.
- Require the real-model verifier, strict 90-case vision gate, quick structure hashes, and complete release gate for future matcher changes.
- Collect physical iPhone Safari and Chromium cold/warm latency, memory, orientation, and WebGL-coexistence evidence before making a mobile recovery-budget claim.

## Validation report: production-browser XFeat recovery contract

**Date**: 2026-08-01
**Scope**: production XFeat assets, nested-worker execution, transformed recovery, browser release freshness

### Checks

- [x] Browser verification creates a fresh production build before starting Playwright
- [x] The test discovers and executes the single content-hashed production XFeat worker rather than importing source code
- [x] Mobile Chromium and WebKit load the real ONNX Runtime WASM, graph, and external-data asset inside a nested worker
- [x] Both engines store the reference, recover the independently transformed laminated-card fixture, and remain within 5 px at 256×192
- [x] Both engines clear the worker reference and reject the next query with `No XFeat reference available`
- [x] The complete browser matrix passes 9 tests with 3 intentional Chromium-only camera skips on WebKit
- [x] Lint and the focused fresh-build browser contract pass
- [ ] Physical iPhone Safari/Chromium latency, peak memory, orientation, thermal, and WebGL-coexistence evidence remains required

### Findings

- Source-level and Node ONNX tests did not prove the emitted chunk could resolve every model/runtime asset in a browser worker. Executing the hashed production worker closes that packaging and runtime gap without creating a test-only worker build.
- A same-frame identity check was insufficient for relocalization. The accepted fixture uses the established laminated-card transformation and asserts geometric anchor accuracy, so descriptor inference, mutual matching, and robust consensus all participate.
- Repeating procedural texture produced mutual matches but no valid geometric consensus. That rejection was correct; the surrogate was removed instead of weakening production geometry thresholds.
- Blob workers have a blob URL base. The harness resolves the emitted worker URL against the page origin before crossing that boundary; production workers already originate from HTTP and required no compatibility branch.
- Freshness belongs to the public browser command. Building before Playwright prevents a green local run from accidentally exercising a stale `dist` directory.

### Actions

- Keep the test on the emitted production worker and real model assets; do not replace it with mocked inference or a source import.
- Preserve a transformed recovery assertion plus the clear-state lifecycle assertion in both browser engines.
- Keep target-device profiling separate: desktop browser execution proves compatibility and packaging, not iPhone latency or memory compliance.

## Validation report: production-browser depth runtime contract

**Date**: 2026-08-01
**Scope**: emitted depth service, worker protocol, ONNX Runtime assets, inference ownership, failure lifecycle

### Checks

- [x] The browser contract dynamically imports the single content-hashed production depth service rather than source code
- [x] Mobile Chromium and WebKit request the emitted module worker, 27.4 MB Q4 model, JSEP loader, and JSEP WASM
- [x] Both engines run the real model at a bounded 56×56 diagnostic input and return a finite normalized 64×48 depth frame
- [x] The service reports its actual provider, owns the transferred input buffer, publishes the latest frame, and clears it on disposal
- [x] A RED unit test proves `messageerror` previously left depth work unresolved; both worker failure channels now share one terminal owner
- [x] Unconsumed input/output-name fields were removed from the worker initialization message and every fake protocol fixture
- [x] Focused depth service coverage passes 8/8; the full browser matrix passes 11 tests with 3 intentional Chromium-only camera skips on WebKit
- [ ] Physical iPhone production-size WebGPU/WASM latency, peak memory, orientation, thermal, and WebGL-coexistence evidence remains required

### Findings

- Node inference did not prove that Vite's emitted service could resolve the emitted worker and all four remote runtime/model requests. Importing the production service is stronger than calling source or constructing the worker directly because it also exercises the generated worker URL and public lifecycle.
- Successful inference is the model I/O contract at the browser boundary. The service intentionally does not expose tensor names, and adding unused status fields merely to satisfy a test would expand the API without a consumer; the Node verifier remains the tensor-name authority.
- Worker runtime errors and worker message-deserialization errors are equally terminal for an in-flight depth request. Handling only `error` could leave the cadence latched and the promise unresolved after structured-clone failure.
- The accepted browser test checks the reduced dynamic graph shape to keep CI bounded. It proves packaging, operator compatibility, transfer, post-processing, and lifecycle, but it is not a production-size performance or quality benchmark.
- Current headless Chromium/WebKit do not expose WebGPU, so this gate proves the documented WASM fallback. WebGPU execution still requires a supported physical target and cannot be inferred from the imported WebGPU bundle.

### Actions

- Keep browser inference on the emitted service and real capability assets; do not replace it with a worker stub or source import.
- Keep tensor-name validation in the Node model verifier and service behavior validation at the browser boundary.
- Route both worker failure channels through the same terminal cleanup and pending-request rejection path.
- Preserve physical-device profiling as the authority for production-size provider selection, latency, memory, and thermal claims.

## Validation report: production-browser tap segmentation contract

**Date**: 2026-08-01
**Scope**: MagicTouch output semantics, emitted MediaPipe runtime, transferable ownership, worker failure lifecycle

### Checks

- [x] A production-browser RED contract executes the single content-hashed interactive-segmenter worker instead of importing source or substituting inference
- [x] Mobile Chromium and WebKit request the real 18.0 MB MagicTouch model, MediaPipe loader, and 11.2 MB WASM
- [x] Both engines transfer the source RGBA buffer and return a non-empty bounded foreground mask that contains the prompt point
- [x] The regression contract rejects the former full-frame background result by bounding positive area and both mask dimensions
- [x] RED unit contracts prove message deserialization and reported inference failures immediately terminate the failed worker, reject pending work, and retry through a fresh runtime
- [x] Focused interactive-segmenter service coverage passes 7/7
- [x] Release verification passes 608/608 tests, 29 asset checks, eight bundle budgets, a clean 90-file flow audit, 205 dependency licenses, and zero vulnerabilities
- [x] The complete browser matrix passes 13 tests with 3 intentional Chromium-only camera skips on WebKit
- [ ] External captured-device fixtures were unavailable at `/Users/xmanatee/.cache/hol-real-vision/manifest.json`; the gate skipped cleanly
- [ ] Physical iPhone cold/warm latency, peak memory, orientation, thermal, and WebGL-coexistence evidence remains required

### Findings

- Packaging validation exposed a semantic defect that source-level mask tests could not see. The pinned MagicTouch model card defines background at channel 0 and foreground at channel 1; reading the first confidence mask produced a plausible high-confidence mask of the wrong side of the object.
- Prompt ownership is a strong invariant. Requiring the output mask to contain the tapped point and remain smaller than the deliberately isolated synthetic object scene distinguished foreground from a structurally valid but semantically inverted background mask in both engines.
- A model or worker error is terminal for that worker instance. Retaining a worker after initialization or inference failure risks reusing poisoned runtime state; one cleanup owner gives every pending request an immediate, deterministic result and makes retry semantics explicit.
- The emitted worker grew only to 146.30 KB and remains under its 170 KB raw budget. The fix adds no asset, model, dependency, adapter, feature flag, compatibility branch, migration, or legacy path.
- The official web guide recommends a worker because segmentation is synchronous. Real desktop Chromium/WebKit execution proves that boundary and asset resolution, but it cannot establish the primary iPhone latency, memory, thermal, orientation, or WebGL coexistence budget.

### Actions

- Keep channel selection tied to the pinned model's declared foreground output; do not infer polarity from frame area or confidence at runtime.
- Keep the browser contract on the emitted worker and real capability assets, with prompt containment and bounded-area assertions.
- Route worker runtime, message-deserialization, and reported inference failures through the same terminal cleanup and fresh-retry owner.
- Measure cold and warm tap selection on physical iPhones before tightening the declared selection budgets or changing delegate policy.

## Validation report: production ES-module CV worker graph

**Date**: 2026-08-01
**Scope**: emitted anchor factory, nested MediaPipe/XFeat workers, OpenCV LK, tap-selection diagnostics

### Checks

- [x] The browser contract imports the emitted anchor factory and exercises its emitted implementation worker rather than source code
- [x] Mobile Chromium and WebKit request the real OpenCV runtime, nested segmenter worker, MagicTouch model, MediaPipe loader, and WASM
- [x] Both engines create an Interactive Segmenter-owned anchor and track an independently translated frame through LK and planar homography
- [x] A separate module-worker calibration requires at least 23/24 accurate translated observations from the emitted OpenCV asset
- [x] Existing direct MediaPipe and nested XFeat production contracts pass with the ES-module chunk graph
- [x] Tap creation reports accepted, rejected, empty, and unavailable segmentation outcomes explicitly
- [x] The complete browser matrix passes 17 tests with 3 intentional WebKit skips for Chromium-only camera behavior
- [x] Release verification passes 609/609 tests, 32 asset checks, 8 budgets, a clean 90-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [ ] Physical iPhone latency, memory, orientation, thermal, and WebGL-coexistence evidence remains required

### Findings

- Directly launching the segmenter implementation as a module proved the model but did not prove production nesting. Vite's default IIFE worker factory launched the same emitted code as classic inside the anchor worker, where the MediaPipe loader failed on `import.meta` before requesting model or WASM.
- The owner-layer fix is Vite's documented `worker.format: 'es'`. Generated factories now launch module workers consistently; there is no alternate loader, classic-worker retry, compatibility branch, or second segmentation path.
- The production fallback previously made the runtime defect look like a valid low-confidence selection. A discriminated `objectSupportSelection` record made the exact browser error observable while retaining intentional tap-local availability.
- ES output introduces small factory and implementation files with the same worker stem. Production-asset tests must select by both content-hashed name and expected size class so they execute the implementation they claim to cover.
- A pixel-translation invariant belongs next to synthetic browser motion fixtures. It caught a mismatched `{x, y}` versus `{offsetX, offsetY}` test input before a fixture bug could be mistaken for an LK regression.
- The emitted OpenCV calibration tolerates the backend's one high-residual observation and validates the 23 accurate flows. Requiring all status bits to imply accurate motion would conflate LK's raw status with the application's existing error threshold.

### Actions

- Keep all Vite-generated CV workers on the single ES-module output policy.
- Keep the integrated contract on the complete production tap-to-LK graph in both browser engines; direct component tests are complementary, not substitutes.
- Preserve structured tap-selection and retained-LK-quorum diagnostics at their existing owners.
- Keep physical-device profiling as the authority for mobile performance and coexistence claims.

## Validation report: generation-bound worker startup

**Date**: 2026-08-01
**Scope**: lazy anchor-worker construction, concurrent initialization, camera reset, failed-runtime retry, nested-worker disposal

### Checks

- [x] RED contracts reproduce duplicate workers and requests from concurrent initialization
- [x] A reset during lazy worker-module loading rejects the stale initialization while the latest camera calibration starts exactly one worker
- [x] Initialization errors terminate the invalid runtime and retry through a fresh worker
- [x] Late response, runtime-error, and deserialization-error callbacks from a terminated generation cannot publish state or reset its successor
- [x] The worker exposes its manager only after OpenCV and anchor initialization succeed
- [x] Anchor-manager disposal releases both the image-anchor runtime and its owned interactive-segmenter runtime
- [x] Focused lifecycle coverage passes 31/31
- [x] Release verification passes 613/613 tests, 32 asset checks, 8 budgets, a clean 90-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [x] The complete mobile Chromium/WebKit matrix passes 17 tests with 3 intentional WebKit skips
- [ ] Physical iPhone rotation timing, peak memory, thermal behavior, and WebGL coexistence remain target-device measurements

### Findings

- Terminating an existing worker is not sufficient cancellation when a stale async task is still awaiting the worker module and has not constructed anything yet. The generation must be captured before lazy creation and checked again after the awaited boundary and before request publication.
- Worker creation and initialization are one lifecycle transaction. Sharing only the initialization request still permits duplicate workers if concurrent callers both pass the pre-import `worker === null` check.
- Termination and pending-request rejection do not prove that a callback already queued on the owner event loop cannot run. Every worker callback must validate both the captured generation and exact worker identity before touching current state.
- An initialization error leaves runtime internals in an unknown partial state. Retry must replace that worker rather than send a second initialize command into it.
- Resource ownership stays compositional when every manager disposes every runtime it constructs. Outer-worker termination remains immediate platform cleanup; explicit manager disposal still owns protocol-driven and direct-manager lifecycles.
- Startup and reset work remain outside the frame path; steady-state response delivery adds only a constant-time worker-identity and generation check, with no CV pass or allocation. The fix adds no dependency, asset, model, threshold, feature flag, compatibility branch, migration, or legacy API.

### Actions

- Preserve one service-owned promise for both worker construction and initialization, plus a generation check after each awaited construction boundary.
- Bind response and failure callbacks to the worker instance and generation that registered them.
- Treat initialization failure as terminal for that worker instance and make retry allocate a fresh runtime.
- Keep camera-coordinate reset non-terminal: preserve listeners and tracking mode while invalidating every pending request and lazy startup from the old generation.
- Require composite runtime owners to dispose nested workers explicitly, even when an outer worker normally provides a second cleanup boundary.

## Validation report: terminal anchor-manager lifecycle

**Date**: 2026-08-01
**Scope**: manager initialization, tap selection, image-anchor publication, tracking, disposal

### Checks

- [x] Concurrent manager initialization shares one child initialization and one promise
- [x] Disposal during initialization prevents listener registration and initialized-state publication
- [x] Disposal during tap segmentation prevents image-anchor creation from starting
- [x] Disposal during image-anchor creation or tracking rejects the late result and re-disposes the child runtime
- [x] Late child initialization failure retains its cause while normalizing the owner-level disposal result
- [x] Disposal is terminal and idempotent, clears listener, camera, mode, active-anchor, and refresh state, and ignores queued child callbacks
- [x] Focused lifecycle coverage passes 38/38
- [x] Release verification passes 620/620 tests, 32 asset checks, 8 budgets, a clean 90-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [x] The complete mobile Chromium/WebKit matrix passes 17 tests with 3 intentional WebKit skips
- [ ] Physical iPhone rotation timing, peak memory, thermal behavior, and WebGL coexistence remain target-device measurements

### Findings

- Worker-generation invalidation protects the outer transport but does not replace lifecycle ownership inside the worker. Direct manager users and already-running child promises still need a terminal owner state.
- Cancellation must be checked at every publication boundary. Checking only at method entry allows a segmenter, anchor creator, or tracker result to resurrect state after disposal.
- Child listeners are also publication boundaries: clearing the manager's outward listeners does not prevent an already-queued inward callback from mutating manager state.
- A late child success may have allocated internal CV state before the owner observes disposal. Re-disposing the child at that boundary makes the terminal state authoritative without a legacy reset path.
- Normalizing a late rejection at the manager boundary keeps disposal deterministic while retaining the original error as `cause` for diagnostics.
- The added checks sit on initialization, tap, and existing async update boundaries. They add no CV pass, model, dependency, asset, feature flag, migration, compatibility branch, or steady-state allocation.

### Actions

- Keep manager instances single-use after disposal; construct a new manager for a new worker lifetime.
- Preserve one manager-owned initialization promise and clear it only if it is still the active transaction.
- Treat post-await state publication as a lifecycle boundary and reject results once the owner is disposed.
- Re-dispose child runtimes when late work may have recreated internal state.

## Validation report: generation-bound depth worker lifecycle

**Date**: 2026-08-01
**Scope**: depth initialization, inference transfer, mode disposal, fatal worker failure, runtime restart

### Checks

- [x] RED contracts reproduce stale initialization, depth-result, runtime-error, and deserialization-error callbacks crossing a runtime restart
- [x] Every worker callback validates both the exact worker instance and its captured generation
- [x] Initialization and inference requests enter the pending map only after `postMessage` succeeds
- [x] A failed inference transfer consumes neither the in-flight gate nor cadence timestamp
- [x] Idle and fatal-error snapshots clear provider, processing time, frame timestamp, and retained depth data
- [x] Focused depth lifecycle coverage passes 12/12; adjacent hook and service coverage passes 14/14
- [x] Release verification passes 624/624 tests, 32 asset checks, 8 budgets, a clean 90-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [x] The production mobile Chromium/WebKit matrix passes 17 tests with 3 intentional WebKit skips
- [x] Examples run, repository conventions remain satisfied, platform references are current, and the guidance does not conflict with the terminal anchor-manager lifecycle
- [ ] Physical iPhone depth latency, peak memory, thermal behavior, mode-switch timing, and WebGL coexistence remain target-device measurements

### Findings

- Worker termination controls the worker execution agent; lifecycle ownership at the page boundary still requires callbacks to prove they belong to the current worker before publishing state.
- A constant request key such as `initialize` makes stale callbacks especially dangerous: an old worker can otherwise resolve or reject the new worker's transaction even when request IDs for frame inference are monotonic.
- Adding a pending request before `postMessage` creates a leak when structured cloning or transfer throws synchronously. Publishing pending ownership after the call succeeds uses the platform's asynchronous message delivery guarantee and needs no cleanup branch for an unpublished request.
- Cadence begins when inference is successfully posted, not when preparation starts. A rejected transfer must remain immediately retryable.
- An unavailable depth runtime must expose one canonical snapshot. Retaining the previous provider, timing, or depth map makes diagnostics ambiguous and risks downstream use of stale evidence.
- Callback identity checks run only when messages or failures arrive. The change adds no model, asset, dependency, CV operation, frame allocation, feature flag, migration, compatibility branch, or legacy API.

### Actions

- Capture worker identity and generation in every callback closure for reusable worker-backed services.
- Invalidate the owner before terminating or replacing its worker.
- Publish pending requests and cadence ownership only after `postMessage` succeeds.
- Clear inference evidence whenever its producing runtime becomes unavailable.

## Validation report: generation-bound interactive-segmenter requests

**Date**: 2026-08-01
**Scope**: lazy segmenter construction, transferable request publication, timeout ownership, worker failure, retry

### Checks

- [x] RED contracts reproduce a retired worker terminating its successor through queued runtime and deserialization errors
- [x] Every worker callback validates the exact worker instance and captured generation before reaching service state
- [x] A rejected worker constructor clears the cached single-flight promise and permits fresh construction
- [x] A synchronous `postMessage` failure rejects immediately, retires the failed runtime, and clears pending requests and timers
- [x] A retry after construction, publication, reported inference, runtime, deserialization, or timeout failure creates one fresh worker
- [x] Focused interactive-segmenter coverage passes 10/10; adjacent manager and segmenter coverage passes 35/35
- [x] Release verification passes 627/627 tests, 32 asset checks, 8 budgets, a clean 90-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [x] The production Chromium/WebKit matrix passes 17 tests with 3 intentional WebKit skips, including real nested MediaPipe model inference and tap-to-LK tracking
- [ ] Physical iPhone cold/warm segmentation latency, memory, orientation, thermal behavior, and WebGL coexistence remain target-device measurements

### Findings

- Generation invalidation around lazy construction does not protect callbacks already attached to a previously active worker. Callback closures must also retain and validate exact worker identity.
- A throw inside a promise fulfillment callback does not reject the outer manually constructed request promise. The posting transaction needs an explicit rejection consumer that settles the service-owned request immediately.
- Failed lazy construction must clear only the promise for that exact transaction. Otherwise every future selection reuses one permanently rejected promise and no worker can recover.
- Timeout ownership remains service-wide because a stalled model runtime may strand all requests. Once the owner is retired, clearing every timer prevents an old timeout from invalidating the replacement.
- The hardening adds only constant-time identity checks at worker event boundaries. It adds no model, asset, dependency, segmentation pass, threshold, feature flag, migration, compatibility branch, or legacy API.

### Actions

- Treat worker construction, request publication, and response/failure callbacks as one owner transaction.
- Cache lazy construction single-flight, but clear rejected promises by exact promise identity.
- Consume posting failures explicitly whenever an outer promise owns request settlement.
- Keep terminal worker cleanup centralized so runtime, deserialization, reported inference, timeout, and posting failures share one retry policy.

## Validation report: generation-bound lazy depth runtime

**Date**: 2026-08-01
**Scope**: page-level depth chunk loading, mode release, service publication, worker allocation

### Checks

- [x] A production-browser RED contract delays the emitted depth service chunk and reproduces two workers after Depth → Auto → Depth
- [x] Mode release and camera-session teardown invalidate the pending import generation before service construction
- [x] Only the exact current import may publish a service or clear the current single-flight promise
- [x] The fixed production sequence constructs one worker, retains no superseded listener/runtime, and terminates that worker on Auto
- [x] Real emitted depth service, worker, ONNX model, JSEP runtime, transferable input, inference output, and disposal pass in mobile Chromium and WebKit
- [x] Release verification passes 627/627 tests, 32 asset checks, 8 budgets, a clean 90-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [x] The complete mobile Chromium/WebKit matrix passes 18 tests with 4 intentional WebKit skips
- [ ] Physical iPhone rapid mode-switch memory, thermal behavior, orientation changes, and WebGL coexistence remain target-device measurements

### Findings

- Clearing a cached import promise does not cancel its continuation. Every continuation that can construct an expensive runtime must validate owner generation and exact promise identity after the await boundary.
- Session identity alone is insufficient when a capability can be released and selected again inside the same camera session.
- A stale rejection must not clear a successor's single-flight promise or surface a failure for a mode that no longer owns the request.
- The production browser boundary is materially stronger here than a mocked service test: it proved the emitted dynamic chunk, React mode controls, worker factory, and termination path together.
- The fix adds constant-time checks only at capability activation and teardown. It adds no steady-state frame cost, dependency, model, asset, flag, migration, compatibility branch, or legacy API.

### Actions

- Bind lazy capability construction to both a monotonic generation and exact promise identity.
- Invalidate the generation before releasing the published runtime.
- Keep the heavyweight runtime absent unless the currently selected mode still owns the resolved import.

## Validation report: terminal speech runtime ownership

**Date**: 2026-08-01
**Scope**: lazy TTS loading, queued synthesis, AudioContext readiness, provider transport, decoding, disposal

### Checks

- [x] RED contracts reproduce synthesis continuing through a loaded lazy client after session disposal
- [x] Disposal during a suspended `AudioContext.resume()` prevents fetch, decode, playback, and context recreation
- [x] Direct synthesis after real-client disposal constructs no AudioContext and issues no request
- [x] A stale non-abort provider failure cannot clear or report over the newer synthesis owner
- [x] Current-owner AudioContext resume and provider failures remain explicit
- [x] A transient rejected speech chunk clears its exact single-flight promise and succeeds on the next request
- [x] Focused speech coverage passes 15/15; adjacent audio and camera-session coverage passes 44/44
- [x] Release verification passes 633/633 tests, 32 asset checks, 8 budgets, a clean 90-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [x] The complete mobile Chromium/WebKit matrix passes 18 tests with 4 intentional WebKit skips
- [ ] Physical iPhone interruption/resume behavior and the configured local speech backend still require target-device integration measurement

### Findings

- Lazy module generation alone is insufficient: awaiting an already-resolved client still yields, allowing disposal to run before the forwarding continuation.
- Aborting fetch does not prove cancellation because a provider or test transport may ignore the signal and reject later with a different error. Exact request ownership must guard every result and failure.
- `AudioContext.resume()` is an ownership boundary. Closing a context while resume is pending may reject that promise; the rejection is cancellation only after the runtime generation has retired.
- Terminal disposal must be marked before stopping playback or awaiting `AudioContext.close()`, otherwise another continuation can recreate the resource during teardown.
- A rejected lazy promise should be evicted by exact identity. Evicting whatever promise is current lets an old failure destroy a healthy successor.
- The change adds only constant-time checks at existing asynchronous boundaries. It adds no dependency, alternate speech provider, retry loop, asset, migration, compatibility branch, legacy API, or frame cost.

### Actions

- Capture runtime generation before every lazy or audio readiness await.
- Validate generation plus exact request identity before parsing, decoding, playback, error publication, or forwarding to a real client.
- Make disposal terminal before releasing owned browser resources.
- Keep transient module recovery caller-driven by evicting only the rejected single-flight promise.

## Validation report: terminal personality request ownership

**Date**: 2026-08-01
**Scope**: image cropping, vision identification, persona generation, supersession, camera-session disposal

### Checks

- [x] RED contracts reproduce missing cancellation at every LocalAI wrapper and a retired request publishing after a newer request
- [x] The exact `AbortSignal` reaches the LocalAI transport through both the vision and persona clients
- [x] Disposal during canvas cropping prevents all later network work
- [x] Disposal during vision transport aborts that request and prevents persona generation
- [x] Out-of-order persona completions publish only the newest request; the older request resolves `null`
- [x] Current-owner provider failures remain explicit and observable
- [x] Disposal is terminal: later generation attempts return `null` without cropping or network work
- [x] Focused personality and API coverage passes 9/9; adjacent service coverage passes 27/27
- [x] Release verification passes 638/638 tests, 32 asset checks, 8 budgets, a clean 90-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [x] The complete mobile Chromium/WebKit matrix passes 18 tests with 4 intentional WebKit skips
- [ ] Physical iPhone backend latency, cancellation timing, interruption behavior, and memory still require target-device integration measurement

### Findings

- Clearing listeners does not cancel continuations already awaiting cropping or provider work. The owning request needs a terminal state independent of event subscriptions.
- Canvas `toBlob()` has no abort contract. Revalidating ownership immediately after that await prevents a retired crop from reaching the network.
- Cancellation must cross every wrapper. Creating an `AbortController` only at the service boundary has no effect unless the same signal reaches the final `fetch`.
- Abort is an optimization, not the correctness boundary: a transport may ignore the signal and settle later. Exact request identity and generation must still guard every result, error, metric, and event.
- An older request's `finally` block cannot clear `isProcessing` while its successor is active. Processing state is released only by the exact active request.
- The change adds constant-time ownership checks only at existing asynchronous boundaries. It adds no dependency, provider, retry loop, asset, migration, compatibility branch, legacy API, or animation-frame cost.

### Actions

- Propagate one request-owned signal through every asynchronous transport wrapper.
- Validate terminal service state, generation, and exact request identity after each await and before every publication.
- Treat non-abortable preprocessing as an ownership boundary before starting expensive or external work.
- Make session disposal terminal before aborting transport and clearing observers.

## Validation report: gesture-owned tap frame capture

**Date**: 2026-08-01
**Scope**: presented camera frame, pointer coordinates, canvas readback, tap selection scheduling

### Checks

- [x] A production-browser RED contract observes two unsolicited full-canvas readbacks while waiting 750 ms without a gesture
- [x] Selection mode now performs zero `getImageData()` calls before the user taps
- [x] The first `pointerup` performs exactly one readback with the current non-empty canvas dimensions
- [x] Tap coordinates and RGBA pixels are derived synchronously from the same presented canvas
- [x] A camera restart resets presented-frame ownership, so an immediate tap cannot reuse pixels from the previous session
- [x] The obsolete cached-frame refs, 500 ms scheduler, and exported interval constant were deleted
- [x] Focused production Chromium coverage passes 1/1 and the unit suite passes 638/638
- [x] Release verification passes 638/638 tests, 32 asset checks, 8 budgets, a clean 90-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [x] The complete mobile Chromium/WebKit matrix passes 19 tests with 5 intentional WebKit skips
- [ ] Physical iPhone tap latency, main-thread readback cost, moving-object accuracy, memory, and thermal behavior remain target-device measurements

### Findings

- A tap coordinate belongs to the pixels visible during that gesture, not to the most recently cached processing frame. A 500 ms cache can be roughly 15 camera frames stale at 30 FPS.
- Periodic full-canvas readback violated the declared one-shot selection budget even when the user never selected anything. At 960×540 it copied about 2 MiB of RGBA data every interval on the main thread.
- Canvas drawing and pointer handling run as separate event-loop tasks. Reading synchronously inside the pointer handler preserves one coherent presented-frame boundary without keeping a second frame buffer alive.
- Camera state can become active before its first presented frame callback. Explicit per-session frame ownership prevents a fast tap from reading an empty canvas or the previous session's final frame.
- The change removes work and state from the steady path. It adds no worker, dependency, asset, threshold, timer, flag, migration, compatibility branch, or legacy API.

### Actions

- Acquire selection pixels only at the gesture boundary that supplies their coordinates.
- Keep tap capture one-shot and transfer ownership immediately to the worker graph.
- Reset presented-frame ownership whenever the camera leaves the active state.
- Preserve production-browser instrumentation that proves the absence of idle canvas readbacks.

## Validation report: exclusive tap-selection ownership

**Date**: 2026-08-01
**Scope**: repeated pointer gestures, canvas capture, lazy vision initialization, camera-session replacement

### Checks

- [x] A production-browser RED contract reproduces two immediate full-canvas readbacks from two rapid taps
- [x] Ten rapid `pointerup` events now invoke exactly one admitted capture
- [x] A competing request returns an explicit busy result without invoking its capture callback
- [x] Rejection releases the transaction for a user-driven retry
- [x] Camera reset admits a new transaction immediately, while the retired request cannot release the new owner
- [x] Focused camera/manager/worker/gate coverage passes 43/43
- [x] Release verification passes 641/641 tests, 32 asset checks, 8 budgets, a clean 91-file flow audit, 205 dependency licenses, and 0 vulnerabilities
- [x] The complete mobile Chromium/WebKit matrix passes 20 tests with 6 intentional WebKit skips
- [ ] Physical iPhone multi-touch timing, first-tap latency, memory pressure, and interruption behavior remain target-device measurements

### Findings

- Checking the published anchor mode cannot prevent double submission because lazy initialization and segmentation yield before the worker publishes its first state transition.
- The ownership boundary must run before `getImageData()`. A worker-only gate would prevent concurrent CV mutation but would still waste one full-frame readback per repeated gesture.
- Coalescing different taps onto the first promise is incorrect: each caller would associate its own coordinates and voice frame with another gesture's result. Competing taps therefore receive an explicit non-success result and are not queued.
- Reset is an identity boundary rather than a boolean clear. An older transaction's `finally` may run after a replacement starts and must not unlock the replacement.
- The change adds constant-time checks only to the one-shot gesture path. It adds no dependency, worker, asset, timer, retry loop, frame task, migration, compatibility branch, or legacy API.

### Actions

- Acquire transaction ownership before capturing tap pixels or starting lazy vision initialization.
- Keep exactly one owner across capture, initialization, segmentation, and anchor creation.
- Release ownership only when the exact admitted transaction settles.
- Reset ownership when camera coordinates or the complete camera session are replaced.

## Validation report: independent position and normal dropout ownership

**Date**: 2026-08-03
**Scope**: sparse handled-mug normal innovation, pose arbitration, segmentation-recovery policy

### Checks

- [x] RED coverage separates reconstruction, planar, object, and tracker position owners from normal ownership
- [x] Marginal high-residual normals are rejected only when mature-map support collapses and both temporal and tracker priors conflict
- [x] A quarantined normal cannot trigger spatial support recovery in the same frame
- [x] One-frame position and rejection diagnostics are cleared before the next update
- [x] The target replay preserves every baseline position metric while max head world error improves from 0.1169 to 0.0476 and rotation error from 0.9246 to 0.1698
- [x] The 84-report matrix reduces max risk from 54.01 to 47.37 and head-attachment failures from 4 to 3 without changing the other 83 reports
- [x] Release verification passes 689/689 tests, 32 asset checks, 8 budgets, a clean 97-file flow audit, 248 dependency licenses, 0 vulnerabilities, and 22 browser tests with 6 intentional WebKit skips

### Findings

- `poseSource` owns orientation evidence; it cannot by itself prove that 2D attachment position was lost. Position recovery must inspect the independently selected `posePositionRole`.
- Rejecting a bad normal is an intentional safety decision, not new evidence that object support is stale. Triggering support refresh from that quarantine changed later reconstruction cadence and regressed position accuracy.
- A same-frame quarantine exception is safe only when it is keyed to the exact rejection reason and current tracking mode, then cleared at the next frame boundary.
- The accepted gate adds constant-time scalar checks on a rare sparse-mug path. It adds no model, dependency, asset, compatibility branch, legacy path, migration, or steady-state CV work for other modes.

### Actions

- Keep normal and position ownership explicit from pose arbitration through recovery policy.
- Centralize production and synthetic pose-dropout decisions in one policy implementation.
- Treat normal quarantine as a one-frame recovery deferral, while preserving normal periodic support refresh on the following frame.

## Validation report: coherent direct-photometric motion release

**Date**: 2026-08-03
**Scope**: curved-object position filtering, direct-photometric bootstrap, mature recovery step bounds

### Checks

- [x] A frame-by-frame replay traces the worst quick-matrix cluster to pre-occlusion filter lag rather than recovery or segmentation
- [x] A raw-versus-filtered survey covers 978 reference-transform observations across all 84 quick-matrix reports
- [x] A curved-target survey rejects broad pre-ready prediction: it would regress 139 of 163 observations
- [x] RED coverage admits only a fresh, fast, directionally coherent, densely supported direct-photometric measurement and keeps divergent or stale measurements smoothed
- [x] Parametric recovery retains its expanded catch-up step while mature direct-photometric recovery stays at the standard reconstruction bound
- [x] The target direct-photometric replay improves risk 47.37 to 45.20, mean error 16.80px to 16.02px, max error 26.50px to 25.80px, p95 error 23.25px to 22.85px, and pose-ready ratio 13.0% to 21.7%
- [x] The 84-report matrix reduces mean risk 24.098 to 24.065 and max risk 47.37 to 47.00 without adding failures or changing risk bands
- [x] The recovery-step bound changes three reports and lowers risk in all three; the coherent-motion gate changes only its proven target report
- [x] Release verification passes 691/691 tests, 32 asset checks, 8 budgets, a clean 97-file flow audit, 248 dependency licenses, and 0 vulnerabilities
- [x] Extended vision coverage passes 91/91 and the mobile Chromium/WebKit matrix passes 22 tests with 6 intentional WebKit skips
- [ ] Physical iPhone camera jitter, motion-to-photon latency, thermal behavior, and 30/60 FPS cadence remain target-device measurements

### Findings

- The 1€ principle is necessary but insufficient when measurement quality varies: release filter lag only when a recent trusted velocity sample and the new measurement agree spatially and directionally.
- A confidence/residual threshold alone is unsafe. Corpus evidence showed that a broad prediction release would regress most curved-target observations even before reconstruction was ready.
- Limit the coherence sample to one fresh camera interval. Reusing an older velocity estimate turns a low-lag release into unbounded extrapolation after a dropout.
- Step budgets belong to pose algorithms, not only target geometry. Parametric surface recovery benefits from a wider catch-up step, while the direct-photometric pose was more accurate and stable at the normal reconstruction bound.
- Evaluate the downstream map, normal, support, and attachment state after any early-frame position change. A locally better anchor observation can still change reconstruction branching and worsen the full replay.
- The accepted gates add constant-time scalar math to the existing position-filter path. They add no dependency, model, asset, worker, retry loop, migration, compatibility branch, legacy path, or steady-state task.

### Actions

- Gate low-lag motion by freshness, velocity magnitude, directional alignment, prediction distance, tracker support, and the owning reconstruction mode.
- Preserve the ordinary 1€ output for stale, weak, sparse, or geometrically divergent measurements.
- Keep recovery step ratios explicit and mode-owned; do not generalize a catch-up budget across reconstruction algorithms without corpus evidence.
- Compare full replay reports, not just the causal frame, before accepting filter or prediction changes.

## Validation report: motion-aware mug relocalization

**Date**: 2026-08-03
**Scope**: direct-photometric handled-mug recovery after early occlusion on busy backgrounds

### Checks

- [x] Frame-level diagnostics trace the failure to a high-residual direct pose overwriting coherent pre-occlusion velocity, followed by an internally valid but attachment-biased full-frame ORB recovery
- [x] RED coverage rejects high-residual direct motion samples and bounds a collapsed-reference relocalization rebase to 18px
- [x] The target replay removes all 19 held-degraded-object-pose frames and cuts recovery from 13 frames to 2
- [x] Target mean error improves 24.29px to 11.77px, max error 41.93px to 18.15px, p95 error 41.36px to 17.80px, and risk 46.39 to 33.67
- [x] The direct-photometric sibling matrix keeps 13/21 passes and 8 failures while mean risk improves 23.44 to 22.84 and high-risk reports fall from 3 to 2
- [x] The 84-report matrix keeps 45 passes and all failure-stage counts while mean risk improves 24.065 to 23.914 and high-risk reports fall from 12 to 11
- [x] Release verification passes 694/694 unit tests, 92/92 vision tests, 32 asset checks, 8 budgets, a clean 97-file flow audit, 248 dependency licenses, 0 vulnerabilities, and 22 browser tests with 6 intentional WebKit skips
- [ ] Physical iPhone camera blur, background parallax, memory pressure, and thermal cadence remain target-device measurements

### Findings

- Descriptor consensus can validate an affine transform while still assigning the attachment anchor to the wrong motion layer on a busy background. Recovery must validate attachment motion separately from descriptor geometry.
- Do not let a high-residual selected pose overwrite the last trusted velocity sample. A corrupted sample removes the only bounded temporal evidence available at reacquisition.
- Localize descriptor search only after the tracker reference has proven collapse, and latch that choice for the anchor session. Restricting every frame or every curved target regressed cups, cans, sparse tracking, and depth fusion.
- Apply the temporal prior once at the descriptor ownership boundary, cap the correction by the existing dropout step budget, and preserve the matched landmark geometry. Repeated extrapolation regressed direction reversals.
- Lowering the Lucas-Kanade landmark quorum appeared to solve the local deadlock but introduced sibling regressions. Keep the strict quorum until a separate corpus proves a general low-cardinality estimator.
- The accepted path adds bounded scalar math and a smaller ORB search region only during proven direct-mug reference collapse. It adds no dependency, asset, model, migration, compatibility branch, legacy path, or steady-state task.

### Actions

- Treat descriptor geometry, attachment position, and motion continuity as independent evidence during relocalization.
- Preserve the last quality-gated bootstrap motion sample across weak direct measurements.
- Scope recovery policies by demonstrated mode and target geometry, then run sibling and full matrices before generalizing them.

## Validation report: established parametric can map recovery

**Date**: 2026-08-03
**Scope**: glossy-can parametric-surface landmark recovery after repeated occlusion

### Checks

- [x] Frame-level diagnostics trace the late failure to a support-refresh miss resetting a ready 14-frame reconstruction map with 19 mature landmarks
- [x] RED coverage keeps an 11-frame can map ineligible and admits the same evidence after 12 mapped frames
- [x] Recovery-prior refresh reactivates at least 12 established landmark identities and cannot create unverified landmarks
- [x] The target replay removes the late reinitialization and degraded-pose tail while preserving the quality and risk metrics of both non-target glossy-can reports exactly
- [x] Target mean error improves 15.80px to 11.37px, max error 40.40px to 32.93px, p95 error 37.49px to 20.67px, and risk 43.96 to 33.65
- [x] Reconstruction-ready ratio improves from 37.2% to 79.1% and reconstruction-pose-ready ratio from 27.9% to 48.8%
- [x] The 84-report matrix keeps 45 passes and all failure-stage counts while mean risk improves 23.914 to 23.791 and high-risk reports fall from 11 to 10
- [x] Release verification passes 696/696 unit tests, 93/93 vision tests, 32 asset checks, 8 budgets, a clean 97-file flow audit, 248 dependency licenses, 0 vulnerabilities, and 22 browser tests with 6 intentional WebKit skips
- [ ] Physical iPhone camera blur, background parallax, memory pressure, and thermal cadence remain target-device measurements

### Findings

- Tracker reference validity and reconstruction-map identity are separate concerns. Failed Lucas-Kanade support is not evidence that an established multi-view map should be discarded.
- Recovery must reactivate only existing descriptor-matched landmark IDs. It may use a bounded attachment transform to search, but it cannot manufacture new map evidence.
- Map age is required in addition to readiness, confidence, and mature-landmark count for symmetric targets. Enabling can recovery on the earlier six-frame map changed estimator cadence and regressed the replay; admitting only maps with at least 12 mapped frames preserved that boundary.
- Broad depth-fusion position ownership, resetting or synchronizing position filters after confident bypasses, and unrestricted parametric-can recovery each regressed sibling or target replays. Those experiments were removed completely.
- The accepted gate adds constant-time scalar checks only during support recovery. It adds no dependency, asset, model, worker, compatibility branch, migration, legacy path, or steady-state CV task.

### Actions

- Attempt relocalization against an established reconstruction map before replacing its landmark identity.
- Gate recovery by target geometry and accumulated multi-view evidence, then validate the entire sibling slice and full matrix.
- Treat map reset as an evidence-backed lifecycle decision, not the automatic consequence of one failed local tracker refresh.

## Validation report: deformation-gated object-wide mug attachment

**Date**: 2026-08-03
**Scope**: depth-fusion handled-mug attachment after tap-local reference deformation

### Checks

- [x] Frame diagnostics separate depth-map readiness, depth-pose availability, tracker success, tap-local residual, object-wide inliers, and selected reference scope
- [x] RED unit coverage proves object-wide consensus requires explicit owner preference, sparse support, a local residual of at least 24 px, and at least seven broad inliers
- [x] RED replay coverage requires at least four gated object-wide frames and bounds target mean/max/p95 error at 11.5/17/16 px
- [x] The repeated-occlusion target improves mean/max/p95 error from 16.27/26.17/22.46 px to 11.08/16.04/15.58 px and risk from 47.00 to 40.67
- [x] The busy early-occlusion sibling improves mean error from 13.18 to 11.28 px, 8 px accuracy from 9.3% to 37.2%, recovery from 0% to 100%, and risk from 44.39 to 38.51
- [x] The clean sibling is numerically unchanged; the three-report slice reduces mean risk from 38.80 to 34.73
- [x] The 84-report matrix keeps 45 passes and all failure-stage/risk-band counts while mean risk improves from 23.7913 to 23.6459 and max risk from 47.00 to 45.20
- [x] Release verification passes 698/698 unit tests, 94/94 vision tests, 32 asset checks, eight budgets, a clean 97-file flow audit, five capability packs, 13 source assets, 248 dependency licenses, zero vulnerabilities, and 22 browser tests with six intentional skips
- [ ] Physical iPhone camera motion, latency, thermal, memory, orientation, and WebGL coexistence remain target-device measurements

### Findings

- A high LK success rate does not prove that a tap-local reference patch still represents rigid object motion. Under partial occlusion, local residual and whole-object consensus must remain separately observable.
- Global consensus is not universally superior to a local attachment frame. Always-global similarity improved one target but regressed early motion; healthy local support must remain the default owner.
- Reuse existing current-frame candidates before adding another estimator or CV pass. The accepted policy changes only arbitration and therefore adds no new steady-state vision work.
- Scope evidence-based recovery by both mode and geometry. Object-centroid recovery, broad depth-pose position ownership, filter resets, and unrestricted global similarity regressed target or sibling replays and were removed completely.
- Strict quality status must remain independent from relative improvement. The target is materially better but still fails the 8 px mean/recovery contract, so the benchmark remains red and the residual gap stays visible.
- The accepted path adds no dependency, model, asset, worker, fit, feature flag, compatibility branch, migration, legacy path, or alternate output estimator.

### Actions

- Keep tap-local similarity as the normal attachment owner and expose both local deformation and selected reference scope in per-frame diagnostics.
- Permit object-wide consensus only after explicit mode/geometry ownership and measured local deformation, with a minimum inlier quorum.
- Validate the causal target, clean and stressed siblings, then the complete matrix before accepting any reference-frame arbitration change.
- Preserve failed experiments in learning evidence, not in production branches.

## Validation report: early dense-mug deformation recovery

**Date**: 2026-08-03
**Scope**: direct-photometric handled-mug object-wide consensus and descriptor relocalization under repeated occlusion

### Checks

- [x] Frame diagnostics trace the first error growth to a deformed tap-local reference and the second growth to a 21-landmark reference that remained above the generic relocalization quorum
- [x] RED unit coverage pins the direct-mug boundary at a ready reconstruction, at most 24 active landmarks, and at least 24 px residual
- [x] RED ownership coverage admits object-wide similarity only for ready depth-fusion or direct-photometric mugs, excluding cups, parametric mode, and immature maps
- [x] RED replay coverage requires three object-wide recovery frames, successful descriptor relocalization at frame 12, and mean/max/p95 bounds of 13/21/20 px
- [x] The target improves mean/max/p95 error from 16.02/25.80/22.85 px to 12.64/20.00/19.03 px and risk from 45.20 to 42.06
- [x] The clean and early-occlusion direct siblings are numerically unchanged
- [x] The 84-report matrix keeps 45 passes and every failure/risk-band count while mean risk improves from 23.6459 to 23.6084 and maximum risk from 45.20 to 43.52
- [x] Release verification passes 701/701 unit tests, 95/95 vision tests, 32 asset checks, eight budgets, a clean 97-file flow audit, five capability packs, 13 source assets, 248 dependency licenses, zero vulnerabilities, and 22 browser tests with six intentional skips
- [ ] Physical iPhone camera blur, one-shot recovery latency, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- A generic collapse quorum can be too late for a mature curved target. Reference residual identifies geometric deformation before the number of active LK tracks reaches ordinary tracking failure.
- Use broad consensus to bridge the deformed window, then feature relocalization to replace the bad reference. Either mechanism alone improved part of the sequence but left a larger maximum error or delayed the second recovery.
- Reuse evidence already computed in the current frame. Object-wide selection changes arbitration only; early recovery schedules two additional one-shot ORB calls across 2,716 matrix frames and adds no steady-state fit.
- Localizing every ORB query to object support regressed the target. Discarding the relocalized reference, forcing planar ownership, rejecting direct poses by residual alone, and releasing the full raw coherent-motion measurement each caused target or sibling regressions. None remains in production.
- The threshold is a mode-and-geometry policy, not a global LK relaxation. A ready dense mug has independent object-wide and descriptor evidence that sparse, parametric, cup, or immature-map states do not.
- Relative improvement does not satisfy the strict contract automatically. The target remains failed at the 8 px threshold, so its remaining weakness stays visible for the next iteration.
- The accepted path adds no dependency, model, asset, worker, fit, compatibility branch, migration, legacy path, alternate estimator, or steady-state CV task.

### Actions

- Trigger curved-target relocalization from reference deformation plus a bounded active-support envelope, not only from final LK collapse.
- Keep tap-local attachment as the default; admit whole-object consensus only through explicit reconstruction-mode and target-geometry ownership.
- Validate combined recovery sequencing on causal frames, siblings, and the complete matrix; a locally useful recovery mechanism may still change later estimator cadence.
- Preserve rejected variants in this learning report and remove them entirely from production code.

## Validation report: pose-contradiction sparse-mug relocalization

**Date**: 2026-08-03
**Scope**: mature sparse handled-mug attachment recovery before generic LK collapse

### Checks

- [x] Frame diagnostics separate active support, map maturity, reconstruction-pose inliers, tracker-reference residual, support correction, and descriptor recovery timing
- [x] RED unit coverage requires a ready sparse mug, at least eight retained pose inliers, at most 32 active landmarks, and at least 40 px reference residual
- [x] RED replay coverage advances the first successful full-frame ORB recovery from frame 11 to frame 6 and bounds mean/max/p95 error at 13/35/26 px
- [x] The target improves mean/max/p95 error from 26.23/36.69/35.42 px to 12.93/34.10/25.92 px, 8 px accuracy from 9.3% to 30.2%, and post-occlusion recovery from zero to one window
- [x] The exact 25-report full sparse-mug slice keeps 3 passes and 22 failures while mean risk improves from 36.3400 to 36.3174
- [x] Descriptor relocalization rises from 89 to 93 of 807 slice frames; there is no new steady-state task
- [x] The exhaustive 1,500-report exploration and exact sparse-mug A/B reject broader threshold, local-ROI, and support-anchor-rebase candidates
- [x] Final verification passes 96/96 vision tests, 703/703 release unit tests, production build and asset budgets, clean anchor-flow and license audits, zero vulnerabilities, and 22 browser tests with six intentional platform-policy skips
- [ ] Physical iPhone one-shot ORB latency, blur, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- A bad 2D reference and a lost object are different states. Early descriptor recovery is justified when a still-supported 3D pose contradicts catastrophic 2D reference residual, not when either signal is weak by itself.
- A locally successful benchmark seed is insufficient evidence for a recovery threshold. The 24 px sparse gate improved the original quick target but increased full-slice mean risk from 36.34 to 37.75 and added a strict failure.
- Search-region policy is extractor evidence policy. Restricting sparse recovery to the current support mask changed the ORB pyramid/ranking context and regressed the busy-background sibling from 15.07 to 24.92 px mean error, so full-frame evidence remains canonical.
- A segmentation anchor expressed as static mask-relative UV is not automatically a valid correction for a descriptor reference after perspective and silhouette change. Rebasing the restored anchor propagated a horizontally biased support estimate and improved mean error by only 0.26 px without changing max, p95, recovery, or risk.
- The retained gate reuses existing tracker, reconstruction, and keyframe evidence. It adds no dependency, model, asset, worker, fit, compatibility path, migration, legacy path, alternate owner, or steady-state CV task.

### Actions

- Trigger early sparse-mug relocalization only from explicit cross-model contradiction: supported 3D pose plus catastrophic 2D reference deformation.
- Preserve full-frame ORB query geometry unless an ROI policy passes the complete background corpus.
- Validate thresholds on the full affected slice and failure count, not only the motivating seed or aggregate position mean.
- Record rejected recovery hypotheses here and remove their production code and tests completely.

## Validation report: canonical nested benchmark fixtures

**Date**: 2026-08-04
**Scope**: quick/full benchmark reproducibility and recovery-test ownership

### Checks

- [x] An axis audit finds all 10 quick/full overlaps and proves the former implementation assigned a different background seed to every one
- [x] RED unit coverage requires equal seeds for every overlap and byte-identical metadata, ground truth, and RGBA frames for a representative replay
- [x] A real filtered quick/full sparse handled-mug run produces identical quality and benchmark SHA-256 `cf28057450a94ef7d337b2485a3ba96e10b191387df930b1b9b6f7ec810402c8`
- [x] Seventeen recovery branch tests own explicit fixture parameters and keep their existing behavior thresholds independent from benchmark sampling
- [x] The canonical 84-report quick baseline records 36 passes, 48 failures, 25.368526 mean risk, 54.006789 maximum risk, and 73/84 recovered occlusion windows
- [x] Strict vision passes 98/98; release verification passes 703/703 unit tests, production build, 32 asset checks, eight budgets, a clean 97-file flow audit, 248 dependency licenses, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical iPhone camera cadence, blur, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- Scenario identity must derive from semantic axes, not filtered-loop position. Local object and condition indexes made a quick report and its same-named full report different experiments.
- Nested suites are useful only when the smaller suite is a reproducible subset. Matching labels without matching generated bytes can invalidate historical A/B conclusions and hide difficult seeds.
- Behavioral branch tests and evaluation sampling have different owners. Recovery contracts need explicit, pinned fixtures; changing quick coverage must not silently rewrite an estimator's expected event sequence.
- A corrected corpus can report worse aggregate quality without a runtime regression. The quick baseline moved from 45/39 at 23.6084 risk to 36/48 at 25.3685 because ten shared scenarios now use their canonical full-matrix pixels; production tracking code did not change.
- Disabling mug support correction worsened mean risk from 35.004 to 35.537 and the worst report from 43.522 to 47.88. Disabling sparse motion prediction had no effect.
- Admitting a seven-inlier sparse mug pose improved the 25-report mean from 36.317 to 36.165 but worsened maximum risk from 56.56 to 57.91 and a shelf/slow/early sibling mean from 15.77 to 18.35. A 28-frame counterexample corpus contained 12 beneficial and 16 harmful seven-point fits, so the candidate was removed completely.
- The accepted change adds no runtime work, dependency, model, asset, worker, compatibility branch, migration, legacy seed mode, or feature flag.

### Actions

- Derive procedural fixture seeds only from canonical semantic axes and test nested-suite byte identity directly.
- Keep branch behavior fixtures explicit and stable; let the benchmark matrix own only coverage and sampling.
- Treat the canonical 36/48 quick result as the new triage baseline, never as an algorithmic before/after comparison with the former non-overlapping corpus.
- Require sibling slices and counterexample corpora before relaxing sparse pose quorums, even when one aggregate mean improves.

## Validation report: weak-geometry direct mug motion bridge

**Date**: 2026-08-04
**Scope**: direct-photometric handled-mug position ownership during early occlusion

### Checks

- [x] RED service coverage requires a fresh coherent motion sample, direct mug ownership, ready reconstruction, at least 18 mature landmarks, weak tracker geometry, weak selected position geometry, and a direction reversal before prediction can own position
- [x] Negative controls prove strong tracker geometry, parametric mode, and a 16-landmark immature direct map keep their existing position owner
- [x] A pinned canonical causal replay activates the bridge on three frames, lowers mean/max/p95 error from 18.44/42.18/35.02 px to 11.86/25.57/25.36 px, and changes the 8 px post-occlusion window from unrecovered to recovered
- [x] Clean and repeated direct handled-mug siblings never activate the bridge; the pinned immature-map sibling preserves its existing frame-eight ORB adjustment
- [x] The canonical 84-report quick matrix remains 36/48 with unchanged failure buckets and risk bands; mean risk falls from 25.368526 to 25.248809 and recovered occlusion windows rise from 73/84 to 74/84
- [x] Strict vision passes 99/99; release verification passes 705/705 unit tests, production build, 32 asset contracts, eight budgets, a clean 97-file flow audit, 248 dependency licenses, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical iPhone camera cadence, blur, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- Fresh motion is not sufficient evidence by itself. The useful signal is cross-model contradiction: coherent recent velocity, a selected position reversing that velocity, and both tracker and selected geometry independently weak.
- Temporal recovery policy is mode-specific. Extending the same correction to parametric reconstruction improved position error but introduced a head-attachment failure and 1.091 rad maximum rotation error, so that version was removed completely.
- Map maturity defines recovery-policy ownership. Without an 18-landmark boundary, a 16-landmark sibling lost its useful ORB correction and maximum anchor error regressed from 18.15 px to 28.43 px despite a lower mean; the immature-map negative control prevents that overgeneralization.
- A prediction must be a finite bridge, not recursive evidence. Frames produced by `weak-mug-motion-bridge` are excluded from motion-sample recording, so an occlusion cannot self-extend stale velocity.
- Aggregate improvement does not erase the remaining contract failure. The causal report still misses strict 6/8 px tracking thresholds, its pose-ready coverage falls from 6.98% to 2.33%, and the unchanged sparse-mug report remains the global worst case.
- The accepted change reuses current scalar diagnostics and bounded prediction. It adds no CV pass, model, asset, dependency, worker, feature flag, compatibility path, migration, legacy path, or alternate owner.

### Actions

- Admit temporal position ownership only from explicit, independently weak geometry plus a fresh contradicted motion prior.
- Calibrate recovery gates against map maturity and preserve counterexample fixtures at both sides of the boundary.
- Reject cross-mode generalization unless attachment rotation, visibility policy, failure buckets, and sibling cadence improve together with position error.
- Keep the remaining sparse-mug worst case and physical-device measurements visible rather than weakening the strict contract.

## Validation report: transactional reconstruction-map admission

**Date**: 2026-08-04
**Scope**: ready-map lifecycle during recovery-landmark ownership probation

### Checks

- [x] RED coverage proves a ready map is not mutated by a partial recovery-probation observation set
- [x] Pose estimation continues with the confirmed subset while mapping is held
- [x] The same contract proves an unfinished map continues its canonical mapping path
- [x] The hold state is explicit in per-frame diagnostics and clears when the map is not ready
- [x] Canonical quick coverage, quality, and benchmark projections remain byte-identical
- [x] The exact 25-report sparse-mug slice remains 3/22 pass/fail at 36.317428 mean risk
- [x] The rejected early-keyframe experiment leaves no metadata, cadence change, test, or runtime path
- [x] Focused owner-layer suite passes 232/232 tests and the full vision suite passes 99/99
- [x] Release verification passes 705/705 unit and replay tests, production build budgets, SBOM, open-source license verification, and a zero-vulnerability audit
- [x] Mobile Playwright verification passes 22 tests across Chromium and WebKit with 6 intentional platform skips
- [ ] Physical iPhone recovery-probation cadence and reconstruction cost remain target-device measurements

### Findings

- Tracking eligibility, object ownership, landmark identity, and map mutation are separate evidence boundaries. A point may remain useful for 2D tracking before it is safe to change an established 3D map.
- Filtering probationary points is insufficient if the smaller remainder is still submitted as a mapping frame. The map owner can interpret temporary absence as lifecycle evidence and rebuild a previously ready map.
- Preserve the ready map transactionally and continue pose estimation from confirmed points. Bootstrap has different ownership: an unfinished map must keep accumulating confirmed evidence or probation can deadlock initialization.
- The ORB-SLAM tracking/local-mapping split and restrictive recent-map-point retention support this separation, but HOL implements only the local invariant required by its synchronous worker pipeline.
- A clean frame-four ORB keyframe cut the motivating mug's risk from 54.01 to 27.49 when paired with temporary 3D probation. The full sparse-mug slice still added tracking, reconstruction, and head failures because four mask/LK confirmations proved object membership, not correct non-planar landmark identity. The entire keyframe candidate was removed.
- The retained guard adds no CV pass, model, asset, dependency, worker, flag, compatibility branch, migration, legacy path, or steady-state task.

### Actions

- Never let a partial probation set mutate an already-ready reconstruction map.
- Continue pose estimation from confirmed evidence and let unfinished maps continue canonical mapping.
- Treat non-planar descriptor identity as a separate unresolved problem; do not approximate it with elapsed frames or mask membership.
- Require sibling failure buckets, not aggregate risk alone, before admitting earlier recovery evidence.

## Validation report: geometry-owned ORB keyframe redundancy

**Date**: 2026-08-04
**Scope**: pre-extraction keyframe admission for rigid-planar recovery

### Checks

- [x] RED coverage proves common translation is redundant only for an explicitly rigid-planar view
- [x] A 20-degree rotation remains non-redundant and reaches the existing ORB storage path
- [x] The general geometry path retains the previous absolute-displacement calculation verbatim
- [x] Service ownership maps `rigidPlanarRecoveryEligible` to translation-invariant admission and leaves curved selections unchanged
- [x] Canonical quick coverage, quality, benchmark, and recovery projections remain byte-identical
- [x] Five paired planar slices keep identical quality while reducing ORB extraction cadence from 100 to 84 calls
- [x] The 100-report full planar slice keeps 77/23 pass/fail and 96/100 recovered windows while removing 114 of 853 extraction calls
- [x] The rejected all-geometry implementation leaves no global policy, test assumption, flag, compatibility branch, migration, or legacy path
- [x] Strict vision passes 99/99
- [x] Release verification passes 706/706 unit and replay tests, production bundle budgets, SBOM, open-source license verification, and a zero-vulnerability audit
- [x] Mobile Playwright verification passes 22 tests across Chromium and WebKit with 6 intentional platform skips
- [ ] Physical iPhone ORB latency, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- Keyframe motion must be measured in the geometry owner's coordinate model. Absolute screen displacement is visual change for a general surface, but a nuisance transform for a proven rigid plane.
- A median common translation is the smallest robust invariant needed here. It preserves rotation, scale, perspective, deformation, and new-landmark evidence without adding another fit or CV pass.
- Broad aggregate improvement can hide a geometry violation. The all-geometry candidate reduced quick extraction from 615 to 499 calls and improved two reports, but handled-mug direct and parametric recovery both fell from 1 to 0 while risk rose by 7.20 and 4.63.
- The accepted rigid-planar scope reduces the five-run median amortized extraction from 5.096 to 4.228 ms and median frame processing from 17.950 to 16.825 ms. The full planar slice reduces extraction from 853 to 739 calls and amortized extraction from 5.053 to 4.320 ms without a failure or recovery regression.
- ORB-SLAM's reference-tracking ratio and redundant-keyframe culling reinforce the same abstraction: admit useful visual evidence, not motion in an arbitrary image origin. HOL keeps its simpler object-local owner and does not adopt a SLAM map thread or graph.
- The accepted change adds no model, asset, dependency, worker, alternate matcher, CV pass, feature flag, compatibility path, migration, or legacy behavior.

### Actions

- Normalize nuisance motion only after the geometry owner proves the corresponding invariant.
- Preserve the prior general path exactly when an invariant is unsafe for curved, multi-plane, or non-convex targets.
- Measure extraction cadence deterministically and use repeated medians for noisy wall-clock claims.
- Reject an optimization when any sibling recovery window regresses, even if aggregate failures and mean risk improve.

## Benchmark the presentation timeline and name timing ownership

- A replay that invokes an update on every synthetic source frame measures an algorithm loop, not necessarily the shipped scheduler. Production-facing evaluation must admit work through the runtime interval and still score every source frame while the last result is held.
- Keep algorithm-regression and scheduling protocols separate and explicit. Reusing cadence in focused branch tests can rewrite recovery event order; omitting cadence from production benchmarks hides pose age and backpressure.
- Floating-point timestamps need a narrow boundary tolerance. Exact 30 Hz timestamps compared against a 15 Hz interval otherwise drift across the equality boundary and can silently under-admit work.
- Report active latency, presentation-amortized cost, and held-result age independently. An infrequent 12 ms task is 12 ms of response latency even when its 60 Hz display contribution is only 3 ms.
- A stage timer is either an envelope or an owner. For nested owners, subtract child totals before budget attribution; adding inclusive parents and children double-counts the same interval and can rank the wrong optimization.
- Treat desktop/WASM replay as bottleneck-location evidence. Physical-iPhone Safari and Chromium still own motion-to-photon, thermal, memory, and device frame-budget claims.

## Materialize reconstruction statistics once per accepted state

- Statistics and preview geometry derived from the same accepted map must consume one statistics snapshot. Recomputing the scan for each consumer adds work and allows the returned state to describe different observations if either boundary later becomes stateful.
- Pass the completed snapshot into state and preview constructors rather than retaining both a convenience getter and an internal rescanning path.
- Instrument the real statistics traversal in tests and assert both one traversal and snapshot identity; result mocks cannot prove that duplicate production work was removed.

## Validation report: production-cadence replay and exclusive timing

**Date**: 2026-08-04
**Scope**: shared CV scheduler, replay admission, held-pose scoring, performance schema, stage-timing ownership, reconstruction statistics snapshots

### Checks

- [x] RED scheduler coverage fails at 11 rather than 15 admitted updates on an exact 30 Hz timeline before the floating-point boundary fix
- [x] RED real-OpenCV replay coverage requires 30 scored source frames, 15 admitted updates, 15 held poses, and observable 33.33 ms pose age
- [x] RED performance coverage separates 12 ms active latency from 3 ms/display-frame cost and subtracts a 54 ms child from its 60 ms parent
- [x] Direct-photometric, parametric-surface, and depth-fusion tests prove one real statistics traversal and one shared snapshot per accepted update/pose
- [x] The deterministic algorithm gate remains per-update and passes all 84 reports
- [x] The complete vision suite passes 102/102 tests
- [x] Release verification passes 707/707 unit/replay tests, five capability packs, 13 source assets, real depth/XFeat/head contracts, 32 production asset checks, eight bundle budgets, a clean 97-file flow audit, 248 dependency licenses, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone motion-to-photon latency, camera cadence, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- The former quick benchmark processed all 2,716 source frames as updates even though production schedules tracking at 15 Hz. That made a roughly 29.13 ms active-update mean look like steady presentation cost and could not expose held-pose quality or cadence debt.
- Production cadence measures 2,716 source frames, 1,400 admitted updates, 1,316 held frames, and 5,432 equivalent 60 Hz display frames. Mean active update latency is 27.226 ms, display-amortized update cost is 7.017 ms, maximum held-pose age is 33.33 ms, and 36 report groups exceed their update interval at p95.
- Inclusive stage totals previously made parent and child work appear independently actionable. Exclusive ownership attributes 3.516 ms/display frame across measured stages; the leading owners are planar pose at 1.098 ms, keyframe extraction at 0.960 ms, reconstruction at 0.657 ms, and keypoint tracking at 0.464 ms.
- The production-cadence quality view records 18 passes and 66 failures, versus the canonical per-update quick baseline of 36/48. This is a newly measured scheduling failure surface, not an algorithmic before/after regression; thresholds and production cadence were not changed to make it green.
- A statistics-snapshot cleanup removes redundant accepted-map traversals but measured only about 0.01 ms/source frame in the desktop replay. It is retained as a correctness/ownership improvement, not presented as the primary performance result.
- Focused replay remains every-update by default; only production-facing benchmark/report/debug commands opt into shared cadence. No legacy runtime schema, compatibility alias, feature flag, migration, alternate replay path, dependency, model, or asset was added.

### Actions

- Use production-cadence results to prioritize pose-age and p95 cadence failures; use per-update quality to localize estimator regressions.
- Rank optimization work by display-amortized exclusive ownership, then verify active latency so intermittent one-shot work cannot hide behind a low average.
- Capture the same counters and presentation timestamps on physical iPhone Safari and Chromium before claiming the 4 ms mobile budget.
- Keep stage-parent relationships explicit whenever new nested timers are added, and add a subtraction contract with the timer.

## Complete timing ownership before optimizing the apparent leader

- An exclusive timer can still produce a misleading ranking when large intervals have no owner. Always report `owned / active` coverage and the absolute unattributed remainder beside stage rankings.
- Partition the real update control flow into non-overlapping phase envelopes first, then subtract named child work. For HOL those phases are tracking validation, pose estimation, pose selection, keypoint-map refresh, keyframe storage, and relocalization.
- Instrument every early return at the phase boundary. A success-only timer systematically hides failure-path cost precisely where recovery and degraded tracking are most expensive.
- Keep intermittent maintenance separate from steady-state tracking. Its display-amortized cost determines throughput impact, while per-call mean and maximum expose responsiveness and cadence debt.
- Do not optimize a quality-sensitive solver merely because it leads a partial profile. In the first production-cadence report, only about 50.1% of update time had an owner; after 99.10% ownership, keypoint-map refresh—not planar pose—is the largest exclusive display cost.
- Treat adjacent desktop wall-clock runs as noisy location evidence. Instrumentation-only changes prove quality invariance through deterministic result structure; they do not claim a speedup from different observed wall times.

## Validation report: complete keypoint-update timing ownership

**Date**: 2026-08-04
**Scope**: production keypoint update, hierarchical timing aggregation, benchmark CLI/HTML reporting, coverage contracts

### Checks

- [x] RED real-OpenCV replay coverage requires the new tracking-validation, pose-estimation, pose-selection, attachment-evidence, and attachment-resolution phases
- [x] Nested timing contract partitions a 12 ms update to exactly 100% ownership without double-counting
- [x] Unprofiled timing contract retains all 180 ms as unattributed and 3 ms/display frame instead of treating missing ownership as zero cost
- [x] Focused real-OpenCV and performance tests pass 13/13
- [x] Scoped lint and whitespace validation pass
- [x] The 84-report production-cadence quick matrix remains at 18/66 pass/fail and 39.08382993013283 mean risk
- [x] The deterministic algorithm gate passes 84/84 and the complete vision suite passes 103/103
- [x] Release verification passes 707/707 unit/replay tests, five capability packs, 13 source assets, real depth/XFeat/head contracts, 32 production asset checks, eight bundle budgets, a clean 97-file flow audit, 248 dependency licenses, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone phase timing, motion-to-photon latency, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- The earlier ownership report named 3.516 of 7.017 ms/display frame, only about 50.1%. Its planar-pose-first ranking was incomplete and is superseded.
- The complete run measures 2,716 source frames, 1,400 admitted updates, 1,316 held frames, and 5,432 display frames. It attributes 6.365 of 6.423 ms/display frame, leaves 0.058 ms unattributed, and reaches 99.10% timing coverage.
- Keypoint-map refresh is the largest exclusive owner at 2.143 ms/display frame. It runs on 188/1,400 admitted updates, averages 61.91 ms per call, and reaches 92.82 ms. Planar pose follows at 1.012 ms/display frame, keyframe extraction at 0.899 ms, attachment resolution at 0.741 ms, reconstruction at 0.581 ms, and keypoint tracking at 0.426 ms.
- The instrumentation changes no runtime decision, solver, threshold, schedule, quality schema, model, asset, dependency, worker, feature flag, compatibility path, or migration.

### Actions

- Use 95% timing ownership as the minimum evidence threshold for a bottleneck ranking; keep unattributed time visible even above that threshold.
- The next bounded candidate is a reference-feasibility gate before GFTT only when failed support refresh cannot use the existing reinitialization path. A read-only real-OpenCV observation pass found 188 refresh detections: 77 successes, 111 discarded no-reference results, and 22 later reinitializations. The conservative remaining 89 calls account for about 1.08–1.10 ms/display frame.
- RED coverage must pin failure-reason precedence as well as all successful refreshes, reinitializations, recovery windows, pose/result hashes, and ORB cadence. An unconditional move of the current no-reference check is unsafe because `insufficient-candidates` versus `no-reference-transform` controls downstream recovery.
- Confirm the accepted candidate's phase latency and spikes on primary iPhone Safari and Chromium before claiming the 4 ms mobile budget.

## Gate expensive evidence with a consumer-owned feasibility plan

- Before moving an expensive extraction earlier or later, identify every downstream consumer of its failure precedence. Here, `insufficient-candidates` permits a different recovery decision than `no-reference-transform`; skipping GFTT everywhere would therefore change behavior even when its points could not update the landmark map.
- Keep feasibility and policy in different layers. The tracker owns reference geometry and returns a frame-local `reference` or `no-reference` plan. The service owns whether a no-reference frame still needs candidate evidence for support reinitialization. A required policy flag on the tracker makes omission visible but still leaks the consumer into the producer.
- Make plans single-use and frame-owned. A plan is bound to the tracker frame that produced it and cannot be consumed twice or after `previousGray` changes. This prevents stale homography evidence or an overwritten native workspace from becoming an implicit cache.
- Return outcomes directly from the mutating operation. Mutable `last*Stats` side channels make it possible to pair a boolean from one call with diagnostics from another. The refresh outcome now carries success, reason, candidate count, GFTT calls, reference source, map changes, and coverage as one value.
- Count actual work, not a boolean approximation. Adaptive GFTT can execute one to three detector passes. `candidateCount: null` plus `gfttCallCount: 0` means work was skipped; integer candidate counts, including zero, mean extraction ran.
- Eligibility is not success. Reinitialization returns `reinitialized`, `insufficient-candidates`, or `missing-anchor-position`; cadence and reconstruction reset only for the successful result.
- Aggregate production telemetry from admitted updates, not held display frames, and identify an attempt by its outcome rather than an optional business label. Four legitimate refresh calls had no `landmarkRefreshReason`; label-based aggregation undercounted 184 instead of 188.

## Validation report: reference-feasibility gated keypoint refresh

**Date**: 2026-08-04
**Scope**: GFTT refresh planning, service recovery ownership, reinitialization outcomes, deterministic production-cadence contracts

### Checks

- [x] Real adaptive OpenCV extraction preserves candidate-failure precedence in the sole reinitialization consumer
- [x] Real OpenCV service coverage proves zero tracker-detector calls and no tracker mutation on a no-reference refresh plan
- [x] Frame-local plans reject cross-frame reuse and double consumption
- [x] Failed reinitialization returns its actual outcome and cannot reset reconstruction; successful reinitialization resets it exactly once
- [x] The canonical benchmark enforces 188 attempts, 77 refreshes, 111 no-reference failures, 99 evaluated stages, 89 skipped stages, 77 refresh GFTT calls, 22 reinitialization GFTT calls, 22 actual reinitializations, zero reinitialization failures, 253 ORB extraction frames, and 26 learned-relocalization extraction frames
- [x] Coverage, quality, benchmark, and recovery projection remains byte-identical at SHA-256 `94d44c76c2967ec11c933d1c19d0558bf49e888701382c17d6a595ee4624886e`
- [x] Five sequential production-cadence runs measure median refresh cost at 0.423 ms/display frame and median total update cost at 5.311 ms/display frame
- [ ] Physical-iPhone active latency, refresh spikes, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- The feasibility plan skips 89 of 188 candidate stages. Another 22 no-reference frames delegate their only extraction to reinitialization, leaving 77 refresh calls and 22 reinitialization calls without changing any successful mutation.
- Median refresh cost is 0.423 ms/display frame, median maximum refresh latency is 54.45 ms, and cadence-overage groups have a median of five. Desktop timing remains bottleneck evidence, not a mobile-budget claim.
- The implementation contains one plan/outcome API and one service-owned decision, with no mutable stats side channel or alternate behavior path.

### Actions

- Gate expensive evidence before extraction only when downstream feasibility and failure precedence are both explicit.
- Put recovery policy at the layer that owns recovery, while keeping geometric planning at the estimator layer.
- Pin cadence and deterministic output in the benchmark that exercises the real scheduler; keep targeted unit tests for boundary semantics.

## Bound masked operators by their dependency halo, not only their output mask

- A library mask can restrict accepted outputs without restricting upstream computation. OpenCV GFTT computes the corner-response image for the complete supplied ROI before mask-aware maximum selection, so a sparse mask alone does not bound response cost.
- Crop the supplied ROI to the nonzero support only after deriving the full operator halo. For block-size three GFTT, the gradient, block aggregation, and 3x3 non-maximum suppression require three pixels of context around the support bounds.
- Prove semantic equivalence with the real library call. Compare the complete ordered corner list from full-region masked GFTT against the bounded call; mocks cannot expose border-response or tie-order differences.
- Count both calls and pixels. Calls identify repeated passes, while pixels expose oversized domains that a one-call metric would hide.
- Find every evidence consumer before moving extraction. If refresh and reinitialization both search the same frame but only reinitialization can mutate state, make reinitialization the sole owner and propagate its actual outcome instead of preserving duplicate work for failure precedence.
- Record nested recovery stages in the timing hierarchy. Template recovery may call refresh or reinitialization; treating all three as independent owned stages can exceed 100% attribution and corrupt bottleneck ranking.

## Validation report: mask-bounded GFTT and sole-consumer recovery

**Date**: 2026-08-04
**Scope**: GFTT response domain, refresh/reinitialization ownership, exact work telemetry, timing hierarchy

### Checks

- [x] Official OpenCV implementation confirms response computation precedes mask-aware candidate filtering
- [x] Real-OpenCV equivalence preserves the exact ordered corner list for irregular support while bounding response pixels
- [x] Adaptive extraction sums every strict/adaptive GFTT call and processed pixel
- [x] Service coverage proves no-reference refresh delegates candidate evidence exclusively to eligible reinitialization
- [x] Timing coverage subtracts refresh and reinitialization nested inside template recovery
- [x] Five sequential 84-report production-cadence runs pass the exact cadence and quality contracts
- [x] Complete vision verification passes 107/107 and the strict quality matrix passes 84/84
- [x] Release verification passes 715/715 unit/replay tests, production asset and bundle audits, 248 dependency licenses, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone refresh latency, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- Production-shaped profiling found that the padded nonzero mask domain covered only 28.4% of requested refresh ROI pixels, identifying full-ROI corner response as the spike source.
- The exact canonical contract records 77 refresh calls over 4,336,852 pixels and 22 reinitialization calls over 1,019,755 pixels. The previous duplicate consumer added 22 refresh calls and 1,105,187 refresh pixels without changing any successful map mutation.
- Against the immediately preceding accepted baseline, five-run median refresh display cost improves 62.7%, median maximum refresh latency improves 43.5%, total display cost improves 9.9%, and cadence-overage groups fall from 13 to 5 with an identical deterministic quality hash.
- Timing ownership is 98.86%; the remaining unattributed fraction stays visible rather than being clamped or assigned speculatively.

### Actions

- Inspect source-level mask semantics before assuming an API mask bounds compute.
- Derive crop padding from the full operator dependency chain and lock equivalence with real-library tests.
- Keep one extraction owner per state mutation and expose exact work at every consumer boundary.

## Separate algorithm passes from native preparation ownership

- An adaptive operator can require several algorithm invocations while sharing one immutable input domain. Count invocations, processed pixels, and native preparation separately; reducing preparation must not pretend the detector itself ran fewer times.
- Keep frame-aliasing native state in a synchronous callback scope. ROI headers share parent image storage and must not survive the call, cross an `await`, or become a service-lifetime cache. A callback scope also prevents a disposed session from becoming an alternate API.
- Start cleanup ownership before the first dependent allocation. Nested `try/finally` scopes release the ROI if mask creation fails, release ROI and mask if output allocation fails, and release all owned Mats when the operator throws. The parent image remains borrowed.
- Put output-domain filtering in the detector pass before adaptive early-stop and winner selection. Filtering only the final winner lets rejected raw outputs influence control flow and creates different semantics for real and replacement backends.
- Derive the response-domain halo from the largest block profile in the complete policy, not a convenient default. The active profiles happen to share one block size, but the session contract remains valid if they diverge.
- Copy every output immediately after its native call and reacquire the Mat view on the next pass. Reusing an OpenCV output handle does not promise that its backing buffer survives a zero-size or resized result.
- When profiling a detector, compare detector outputs separately from downstream bootstrap points. A deliberately unreachable minimum can activate synthetic grid bootstrap; including that suffix in an OpenCV parity assertion diagnoses policy, not native reuse.

## Validation report: scoped GFTT preparation reuse

**Date**: 2026-08-04
**Scope**: strict/adaptive GFTT policy, native Mat lifetime, object-support filtering, refresh/reinitialization work telemetry

### Checks

- [x] Real OpenCV strict-plus-adaptive coverage preserves the exact ordered winner while all four passes share one ROI, mask, and output Mat
- [x] A pass-local filtering contract proves rejected raw points cannot short-circuit fallback or win adaptive selection
- [x] Partial preparation releases its owned ROI exactly once and propagates the allocation failure
- [x] The canonical benchmark retains 188 attempts, 77 refresh calls over 4,336,852 pixels in 77 preparations, and 22 reinitialization calls over 1,019,755 pixels in 22 preparations
- [x] Canonical coverage, quality, benchmark, and recovery projection remains exact at SHA-256 `94d44c76c2967ec11c933d1c19d0558bf49e888701382c17d6a595ee4624886e`
- [x] Complete vision verification passes 107/107 and strict quality passes 84/84
- [x] Release verification passes 718/718 tests, five capability packs, 13 source assets, real depth/XFeat/head contracts, 32 production assets, eight bundle budgets, a clean 99-file flow audit, 248 dependency licenses, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone latency, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- A nine-sample forced-three-pass real-OpenCV comparison on the same 276×226 bounded ROI preserves all 360 ordered corners and reduces median extraction from 47.34 ms with repeated ROI/mask/output preparation to 17.93 ms with one scoped preparation, a 62.1% reduction.
- Five production-cadence runs measure median refresh cost at 0.410 ms/display frame, median maximum refresh latency at 39.77 ms, median active-update latency at 18.597 ms, total update cost at 4.793 ms/display frame, two cadence-overage groups, and 98.80% timing ownership. Whole-replay timings remain environment-sensitive; the isolated paired profile owns the causal claim.
- The production API has one detector with primary, adaptive, and primary-then-adaptive policies. The service no longer owns a second object-support filtering path, and the native extraction session cannot escape its synchronous callback.

### Actions

- Reuse preparation only across invocations that share the exact frame, ROI, mask, and dependency halo; distinct template, tracking, refresh, and reinitialization calls retain distinct scopes.
- Preserve exact pass/pixel/preparation telemetry and deterministic output together. Any one metric alone can hide a regression in another dimension.
- Require target-device evidence before translating the desktop/WASM reduction into an iPhone frame-budget claim.

## Share immutable frame evidence without sharing estimator decisions

- Separate observation ownership from solver ownership. Mapping coherence, pose coherence, and attachment fitting may consume the same ordered point snapshot while retaining different models, thresholds, sample caps, and inlier requirements.
- Cache only copied scalar evidence at a same-frame boundary. Tracker point objects are mutable session state; retaining them would turn array identity into stale geometry. A prepared sequence of copied `reference`, `current`, and quality values is immutable for its consumer window.
- Bind reuse to the exact tracked-point array and release that borrowed identity on every pose path. A different array prepares fresh evidence, reset and reference-space changes clear it, and ready pose consumes the same-frame snapshot while a no-map pose discards it.
- Do not infer that numerically similar robust fits are interchangeable. Re-running a robust estimator on its accepted inliers can change refinement, confidence, cadence, and downstream arbitration even when the initial consensus looked stable. Canonical output hashes are the acceptance boundary.
- Benchmark the owned preparation separately from the complete CV stage. Short-lived object materialization can show a deterministic allocation reduction while native RANSAC and OpenCV variance dominate adjacent end-to-end timings.

## Validation report: sparse same-frame observation reuse

**Date**: 2026-08-04
**Scope**: sparse mapping/pose observation materialization, estimator independence, deterministic production cadence

### Checks

- [x] RED coverage requires one preparation across a real curved-map mapping and pose sequence
- [x] Sparse, reconstruction-mode, and deterministic robust-fit coverage passes 36/36
- [x] Canonical quality and cadence remain exact at SHA-256 `94d44c76c2967ec11c933d1c19d0558bf49e888701382c17d6a595ee4624886e`
- [x] Release verification passes 720/720 tests, all asset and bundle contracts, 248 dependency licenses, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone allocation pressure, active latency, thermals, orientation, and WebGL coexistence remain target-device measurements

### Findings

- The previous ready sparse update materialized equivalent reference observations three times: once for mapping and twice for pose. The accepted path prepares one copied sequence while keeping every robust fit independent.
- The isolated 72-point benchmark improves 3.02× for the preparation owner with an identical checksum. The final canonical run improves sparse reconstruction by 5.2% per active reconstruction frame and aggregate reconstruction by 3.0%.
- A rejected shortcut that shared an accepted affine fit instead of only its observations preserved cadence in one variant but changed the deterministic quality projection. It was removed completely, including its helper, tests, and compatibility surface.

### Actions

- Reuse raw immutable evidence only when producer identity and ordered contents belong to the same frame.
- Keep solver results independent unless every estimator option and the precise refinement contract are identical.
- Require both a focused structural counter and the complete deterministic replay before accepting allocation-oriented hot-path changes.

## Share completed raw model evidence, not downstream policy

- When two consumers use the same ordered points, frame, estimator inputs, and estimator options, share the completed raw candidate evidence. Keep each consumer's scoring, ordering, acceptance thresholds, and fallback logic independent.
- Represent completion separately from value. A robust fit can legitimately finish with `null`; without an explicit `evaluated` sentinel, a failed fit is recomputed and the most expensive failure path remains duplicated.
- Bind the evidence lifetime to the update-local owner. A relocalization that replaces active points invalidates the evidence; failed relocalization can retain it because the ordered snapshot remains unchanged. Do not turn this into a cross-frame cache.
- Test a deliberate policy disagreement. If attachment selects similarity while refresh selects homography from the same candidates, shared evidence has not accidentally collapsed distinct decisions into one owner.
- Benchmark the actual dominant substage before widening an optimization. Computing descriptors only for associated ORB keypoints preserved output but improved the canonical ORB stage by just 0.02% because pyramid detection dominated. That experiment was removed completely.

## Validation report: same-frame attachment evidence reuse

**Date**: 2026-08-04
**Scope**: attachment/refresh transformation evidence, failed-fit completion, relocalization invalidation, deterministic production cadence

### Checks

- [x] Real OpenCV valid and degenerate geometry each perform one homography fit across attachment and refresh consumers
- [x] Local similarity, object-wide similarity, and failed homography are each evaluated once for an identical active-point snapshot
- [x] Attachment and refresh retain independent candidate scoring and can select different winners
- [x] Periodic and recovery refresh receive current evidence; successful descriptor relocalization regenerates it from the replacement points
- [x] Canonical quality and cadence remain exact at SHA-256 `94d44c76c2967ec11c933d1c19d0558bf49e888701382c17d6a595ee4624886e`
- [x] Release verification passes 723/723 tests, all asset, model, bundle, flow, license, and vulnerability contracts
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone latency, thermal behavior, memory pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- Mean active refresh cost falls from 10.7452 to 7.0375 ms, a 3.7077 ms or 34.5% reduction. Refresh display cost falls from 0.3719 to 0.2436 ms/frame.
- Mean active-update time falls by 0.7822 ms and total display update cost falls by 0.2016 ms/frame in the paired canonical runs. These aggregate figures are environment-sensitive supporting evidence.
- Exact pass/fail, risk, refresh/reinitialization, ORB, and learned-relocalization contracts are unchanged. The accepted optimization changes evidence ownership only.

### Actions

- Reuse completed candidates only under exact frame, ordered-point, estimator, and option identity.
- Preserve completed failures with an explicit sentinel and invalidate evidence whenever the point owner changes.
- Require independent-consumer tests, exact replay hashes, and stage-level timing before accepting shared-evidence optimizations.

## Treat immediate producer-consumer evidence as a transaction

- If a producer and its immediate consumer run the same estimator over the exact same mutable-array snapshot and options, let the producer lend the completed raw result once. Keep readiness, scoring, fallback, and output policy with their existing owners.
- Clear the prior loan at producer entry, before every possible early return can expose stale evidence. Borrow only under exact array identity, consume before downstream branching, and invalidate on reset or reference-space change.
- Represent completion independently from value. Failed robust fits are legitimate completed work and often the most expensive path; a truthiness cache silently recomputes them.
- Measure how often the proposed identity exists before designing an abstraction. Exact local/wide planar correspondence reuse appeared in only 6 of 1,111 pose attempts, and a strict score upper bound could skip just 7 of 258 local fits. Both opportunities were too rare and were removed without production changes.
- Preserve source-operator semantics in image-pyramid optimizations. A padded landmark-bounded ORB crop cut isolated extraction time by 42.5%, but moving the pyramid origin changed scale sampling and global feature ranking: the canonical replay gained one strict failure, three tracking failures, one reconstruction failure, and changed relocalization cadence. The experiment, helpers, tests, and alternate path were removed completely.

## Validation report: exact same-update depth pose evidence

**Date**: 2026-08-04
**Scope**: depth-fusion mapping/pose fit ownership, failure completion, lifecycle invalidation, deterministic production cadence

### Checks

- [x] RED coverage requires one observation preparation and one robust fit across a valid same-snapshot mapping and pose sequence
- [x] A completed failed fit is reused once, while a different array recomputes
- [x] Duplicate depth and reference replacement invalidate pending evidence before pose
- [x] Canonical quality, failure structure, and work cadence remain exact at SHA-256 `94d44c76c2967ec11c933d1c19d0558bf49e888701382c17d6a595ee4624886e`
- [x] Complete vision verification passes 107/107
- [x] Release verification passes 726/726 tests, all asset and bundle contracts, 248 dependency licenses, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone latency, thermals, allocation pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- The isolated 72-point owner benchmark cuts duplicate work by 50.1% with an exact result checksum.
- Canonical depth-fusion reconstruction falls from 1.4818 to 1.2260 ms per active reconstruction frame, a 17.3% reduction, while quality and cadence remain byte-identical.
- The accepted implementation is a single-use evidence loan, not a cross-frame cache or a shared policy decision.

### Actions

- Search for identical estimator ownership at synchronous transaction boundaries before changing models or thresholds.
- Require success, completed failure, second-consumption, wrong-identity, skipped-producer, and lifecycle-reset tests for every one-shot evidence loan.
- Use isolated owner timings for causality, canonical stage timings for production relevance, and target-device measurements for mobile budget claims.

## Measure domain geometry before rendering projection

- A projection API is not a neutral data accessor. Ranking, truncation, stable IDs, color conversion, reliability scoring, and rich object construction belong to display ownership and should not be paid by a scalar geometry consumer.
- Prove set membership before bypassing rank. In depth fusion, every fusion prunes to `maxSurfels` and pose requested that same limit, so sorting could only reorder the complete set. Median-based normal and extent-based quality are order-independent.
- Put raw measurement in the mutable collection owner and return only copied value objects and scalars. Do not expose collection entries, arrays, or iterators and do not introduce a cache when the entries mutate in place.
- Preserve the projection path for consumers that need projection semantics. RED should require zero projection calls for the scalar hot path and the unchanged call count and output fields for preview consumers.
- Pair exact saturated-set equality with an alternating owner benchmark. A microbenchmark proves causality; the canonical reconstruction stage establishes production relevance; full-frame totals remain environment-sensitive context.

## Validation report: projection-free depth geometry

**Date**: 2026-08-04
**Scope**: surfel geometry ownership, preview separation, exact saturated-map parity, deterministic production cadence

### Checks

- [x] RED saturates a real fused map and requires exact normal and quality equality with its complete ranked projection
- [x] Production hot pose performs zero preview-point projections while preview-enabled pose retains one
- [x] The map returns only fresh geometry values and retains no raw iterator, surfel reference, or cache
- [x] Canonical quality, benchmark projection, and cadence remain byte-identical at SHA-256 `94d44c76c2967ec11c933d1c19d0558bf49e888701382c17d6a595ee4624886e`
- [x] Focused depth/service verification passes 202/202 and complete vision verification passes 107/107
- [x] Release verification passes 727/727 tests, all asset and bundle contracts, 248 dependency licenses, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone latency, thermals, allocation pressure, orientation, and WebGL coexistence remain target-device measurements

### Findings

- The nine-sample 1,400-surfel owner benchmark reduces median measurement cost by 62.3%, saving 0.2707 ms per pose with an exact checksum.
- Canonical depth-fusion reconstruction falls from 1.2260 to 1.0790 ms per active reconstruction frame, a 12.0% reduction, while quality and work cadence remain exact.
- The independent code audit confirmed that raw-reference exposure or caching would create lifetime risk; the accepted API returns semantic values only.

### Actions

- Audit measurement consumers for accidental use of rendering, serialization, diagnostic, or transport projections.
- Require a proof that ranking or truncation cannot change membership before selecting raw collection values.
- Keep target-device evidence as the boundary for mobile frame-budget claims.

## Prefer lifetime ownership over copies when history depth is fixed

- Profile copy sites by semantic owner before introducing a cache. The grayscale audit separated 1,494 clones into tracking, initialization, merge, and restoration and showed that every copy served the same one-frame history contract.
- If an algorithm needs exactly previous and current images, two owner-held output slots are the complete state model. Write the producer directly into the inactive slot and swap identity only after the consumer accepts the frame.
- Bind transactions to logical generations when a native handle can be committed more than once. Pointer identity alone cannot distinguish a same-frame refresh commit from a later camera frame after storage reuse.
- Keep native lifetime with one component. The service borrows a writable slot, the tracker retains it, and tracker teardown deletes both slots; mixed per-call and retained-frame deletion creates use-after-free and double-delete risk.
- Test failure and async boundaries, not only the happy path. A failed update must leave the prior frame intact, an awaited recovery must keep the borrowed current slot alive, and teardown must release both slots exactly once.
- Treat memory-traffic removal honestly. The paired 640×480 owner benchmark improved 3.87%, while whole-matrix timings were dominated by host-wide variation. Exact clone counts and paired microbenchmarks establish causality; physical-device profiling determines user-visible value.

## Validation report: tracker grayscale ping-pong workspace

**Date**: 2026-08-04
**Scope**: grayscale frame ownership, refresh-plan generations, native lifecycle, deterministic production cadence

### Checks

- [x] Two tracker-owned native frames alternate without retained-frame cloning
- [x] Repeated same-frame retention advances logical generation and invalidates stale plans
- [x] Async degraded recovery retains its frame until completion
- [x] Service teardown releases both slots while per-call cleanup releases only the RGBA source
- [x] Canonical quality, work cadence, and failure structure remain exact at SHA-256 `94d44c76c2967ec11c933d1c19d0558bf49e888701382c17d6a595ee4624886e`
- [x] Focused verification passes 233/233 and complete vision verification passes 107/107
- [x] Release verification passes 729/729 tests, all production contracts, 248 open-source dependency components, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone active latency, memory pressure, thermals, orientation, and WebGL coexistence remain target-device measurements

### Findings

- The canonical baseline copied about 437.7 MiB of grayscale history through 1,494 clones even though only one previous frame was ever consumed.
- Direct output into two reusable slots removes the duplicate buffers and their create/delete lifecycle while preserving exact image bytes and every quality decision.
- The paired real-OpenCV lifecycle benchmark saves 0.00913 ms/frame at 640×480, or 3.87% of frame conversion plus history retention. This is a deterministic efficiency improvement, not evidence of a material whole-app frame-rate change.
- A foreground-masked ORB retry, homography skip gates, and smaller same-frame sharing opportunities were rejected or removed after target-bucket quality or measured upper-bound checks failed.

### Actions

- Audit native image pipelines for fixed-depth history expressed as clone/delete churn.
- Use producer-owned reusable outputs only when consumer lifetime and concurrency are explicit.
- Require exact output hashes, lifecycle counters, paired owner benchmarks, and target-device validation before generalizing the pattern.

## Treat reusable native workspaces as lifecycle contracts

- A hot native solver should not own allocation. Put immutable inputs, reusable variable-sized inputs, and output handles in the configured session owner; resize variable inputs with the native library's reuse primitive and fill their typed views directly.
- Reuse is safe only when the owner has a complete destruction boundary. Require the interface contract at the factory, dispose before every owner replacement, and test teardown by counting exact native-handle deletion rather than observing JavaScript garbage collection.
- A lazy implementation needs a terminal owner state. If loading completes after disposal, destroy the new implementation before publishing it and resolve the readiness transaction without resurrecting state.
- Copy solver outputs that must survive the next call. In parametric PnP, the current pose arrays are copied before the same workspace is reused for the reference solve; retaining `data64F` views would silently alias the next result.
- Fixed internal workspace schemas can use a positional tuple when bundle budgets are strict, provided creation and immediate named destructuring are colocated and lifecycle tests enumerate every handle. Public APIs should retain semantic fields.
- Do not raise a production budget to accommodate an optimization. The initial lifecycle implementation exceeded the anchor-worker budget by 946 bytes; compact ownership brought the final worker to 319,991 of 320,000 bytes while retaining the full contract.

## Validation report: parametric PnP native workspace

**Date**: 2026-08-04
**Scope**: PnP native allocation, engine replacement ownership, lazy resolution, deterministic production cadence

### Checks

- [x] One eight-handle PnP workspace survives repeated solves and observation-size changes
- [x] Teardown releases every native handle exactly once
- [x] Mode replacement, anchor replacement, and service disposal release the previous engine
- [x] A late lazy depth-fusion implementation is disposed before publication
- [x] Canonical quality and cadence remain exact at SHA-256 `94d44c76c2967ec11c933d1c19d0558bf49e888701382c17d6a595ee4624886e`
- [x] Focused verification passes 208/208 and complete vision verification passes 107/107
- [x] All eight production bundle budgets pass without changing the 320,000-byte anchor-worker limit
- [x] Release verification passes 731/731 tests, the complete asset/flow/license audits, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone latency, native memory pressure, thermals, orientation, and WebGL coexistence remain target-device measurements

### Findings

- The 21-report parametric slice reduces PnP-specific native lifecycles from 704 to 168 while preserving its exact quality projection.
- Mean active reconstruction cost falls 2.22% in the paired slice; this is a modest stage improvement backed by a deterministic 76.1% lifecycle reduction.
- Exact factory/service/lazy ownership was necessary: a workspace-only patch would have converted transient allocations into leaked session resources.

### Actions

- Audit repeated OpenCV solvers for per-call camera matrices, distortion vectors, point Mats, and output Mats.
- Couple every accepted workspace to factory, replacement, asynchronous-resolution, and teardown tests.
- Keep desktop timing claims subordinate to exact lifecycle counts and target-device evidence.

## Treat target absence as a distinct evaluation phase

- Partial occlusion with surviving corners is not a target-loss benchmark. If a harness refreshes a ground-truth support mask or supplies synthetic depth during absence, it measures how well the tracker follows an annotation oracle rather than whether it detects loss.
- Render an explicit lifecycle: visible target, complete disappearance, distractor-only gap, and transformed re-entry. During the gap, publish zero target support and suppress every derived modality. Put the re-entry outside the local motion basin so success requires real relocalization.
- Keep ordinary accuracy phase-aware. Absent frames have no meaningful target coordinate and must not inflate anchor-error percentiles; count predicted visibility as false tracking instead. At re-entry, measure first recovery under a fixed error radius and do not score the legitimate displacement across the gap as jitter.
- Make the failing baseline directional. A zero recovery rate is still useful when false-lock count and recovery latency are pinned: any reduction passes, while regression cannot be hidden by an exact snapshot that rejects improvements.
- Prefer generated exact ground truth until an external-video path actually decodes media, adapts coordinates, executes the evaluator, pins checksums, and carries dataset plus source-video attribution. File existence and annotation presence are provenance checks, not algorithm evidence.

## Validation report: phase-aware hard benchmark

**Date**: 2026-08-04
**Scope**: compound capture, full target loss, distractor false locks, transformed re-entry, benchmark reporting

### Checks

- [x] Six degraded rendered scenes compose deterministic low light, blur, and rolling shutter with transformed annotations
- [x] Full-loss frames contain zero target support, no corners, no refreshed support mask, and no synthetic depth
- [x] A deterministic distractor occupies the absent phase and the target returns more than 100 pixels away
- [x] Ordinary tracking metrics exclude absent frames and cross-gap jumps; false-lock and re-entry metrics retain them
- [x] Capture and event axes propagate through coverage, filtering, JSON analysis, HTML reporting, and quality summaries
- [x] The 28-replay hard baseline passes its directional regression contract
- [x] Complete vision verification passes 118/118; release verification passes 735/735 plus all production contracts
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone sensor noise, exposure blur, rolling-shutter geometry, recovery latency, and thermals remain target-device measurements

### Findings

- The hard run records 26 strict failures, mean risk `46.69451430432069`, and 23/40 partial-occlusion recoveries within eight frames.
- All four modes false-lock on all 48 absent replay frames and recover 0/4 full-loss windows within eight frames. The benchmark turns that behavior into the next explicit algorithm target instead of weakening the contract.
- The external-fixture audit found dataset candidates but no executable video evaluator. Generated scenes therefore own current quality evidence; annotated videos remain a separately scoped integration task.

### Actions

- Implement explicit target-loss confidence and global re-entry relocalization against this pinned failure slice.
- Add licensed TAP-Vid or DAVIS fixtures only with decoding, coordinate adaptation, checksum pinning, attribution, and the same phase-aware metrics.
- Require compound camera effects and absence-phase evidence for future recovery claims; a single degradation or surviving ground-truth support is insufficient.

## Separate target observability from pose continuity

- A finite pose is presentation state, not proof that the selected target is present. Publish target observability explicitly and let overlay readiness consume it before any pose-model-specific gate.
- A short held pose may preserve filter and map continuity, but it must not render or contribute to visible-frame accuracy while target presence is unproven.
- Tracking and re-identification need different evidence thresholds. Local ORB continuity can use a small verified set; learned or image-wide recovery must require a stronger inlier and restored-landmark quorum before mutating tracker state.
- `degraded` must be a bounded transition, not a parallel recovery architecture. Give it one local evidence attempt; on failure enter `lost`. Only global descriptors may recover `lost`, and an absolute recovery must atomically reseed position, scale, and rotation filters.
- Local template correlation cannot own identity. In the measured full-loss fixture it failed to help the partially occluded bottle and introduced a false lock on the target-like distractor. Remove the branch rather than retaining it as a fallback.
- Do not lower an LK quorum merely because a similarity model can be fitted with fewer points. Seven-point flow fixed one partial-occlusion frame but admitted four false locks during full disappearance and delayed re-entry; the independent descriptor contract is more important than uninterrupted display.
- Split false-lock measurement by scheduler ownership: admitted CV updates measure algorithmic false presence, while source/display frames measure cadence latency. Combining them makes a held display sample look like a confirmed tracker decision.
- A pixel-identical duplicate is not an identity-recovery test without scene context or another identity modality. Use a distinct but similarly feature-rich printed distractor when the system under test has only image appearance and geometry.

## Validation report: target observability and identity-safe re-entry

**Date**: 2026-08-04
**Scope**: presence contract, degraded/lost transitions, ORB/XFeat thresholds, overlay gating, full-loss benchmark

### Checks

- [x] Every successful tracking/bootstrap/relocalization result publishes `targetPresent: true`; holds, failures, clear, and lost search publish `false`
- [x] All four reconstruction modes share the same presence and global-recovery path
- [x] Runtime overlay gating hides every pose model immediately when presence is false
- [x] XFeat accepts the exact eight-inlier boundary and rejects a six-inlier target-like distractor before tracker mutation
- [x] No degraded template recovery, full-frame template search, legacy false-lock field, or compatibility branch remains
- [x] Canonical quick contract passes 84 replays at SHA-256 `686a9f9a6a67e13fd48db9e730631579e28618df8f80391f49ef80a0c957ce37`
- [x] Canonical hard contract passes 28 replays: 26 strict failures, mean risk `43.990973897142716`, 2 severe cases, and 27/40 post-occlusion recoveries
- [x] Full-loss slice records zero false admitted locks, four display-latency frames, 4/4 recoveries, and at most two source frames to recover within 8px
- [x] Release verification passes 739/739 tests, 32 production assets, eight bundle budgets, 248 open-source components, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 22 tests with six intentional platform-policy skips
- [ ] Physical-iPhone camera loss/re-entry latency, memory pressure, thermals, orientation changes, and WebGL coexistence remain target-device measurements

### Findings

- The old implementation reported presence on all 48 absent hard-replay frames and recovered 0/4 re-entry windows. Explicit observability plus global absolute re-entry removes confirmed false locks and recovers every mode.
- The last generalized defect lived in `degraded`: it bypassed the loss state machine and could hold local templates indefinitely. A single bounded local attempt preserves normal cadence while eliminating that second recovery architecture.
- Raising learned recovery from five to eight required inliers rejects the measured six-inlier distractor without changing deterministic refresh/reinitialization operation counts.
- Removing the dead degraded template path reduced the production anchor worker to 317.81 kB while retaining the existing 320 kB budget.

### Actions

- Keep admitted false-locks, display presence latency, and re-entry accuracy as separate hard gates.
- Require a target-like distractor and distant transformed re-entry whenever recovery thresholds or learned descriptors change.
- Add licensed annotated-video evaluation only with executable decoding, target-presence labels, coordinate adaptation, checksums, and attribution.
- Treat desktop/browser measurements as regression evidence; require physical-iPhone profiling before claiming the 4 ms tracking budget under sustained camera use.

## Treat a missing worker reply as a terminal owner failure

- `error` and `messageerror` cover reported failures, not a worker that remains alive without replying. Every request/response worker boundary needs a finite owner deadline.
- Start the deadline before lazy worker construction so a stalled dynamic import, constructor, model load, publication, or inference all have one bounded outcome.
- Remove and reject the expired request before invoking terminal cleanup. The cleanup owner then cancels sibling deadlines, rejects sibling RPCs, invalidates the generation, and terminates the worker exactly once.
- Do not reuse a timed-out runtime. Its internal mutation may have completed without a reply, and transferred buffers already belong to that worker; retry must construct a clean runtime with newly owned input.
- Keep cold-start and steady-operation deadlines separate. Large model initialization and per-frame inference have materially different latency envelopes.
- Validate deadlines at each public service boundary before importing a runtime, copying a frame, or transferring a buffer. The shared registry can then trust its internal callers.
- Preserve the production size contract while adding lifecycle infrastructure. Compact tuple-owned pending records kept the anchor worker under its existing 320,000-byte raw limit without a new dependency or compatibility path.

## Validation report: bounded worker request ownership

**Date**: 2026-08-04
**Scope**: anchor, depth, XFeat, and interactive-segmentation request lifecycles

### Checks

- [x] Shared request registry owns deadline cancellation, settlement, terminal rejection, and synchronous publication failure
- [x] Anchor frame timeout releases `frameInFlight`, resets runtime state, and terminates the stalled worker
- [x] Depth and XFeat timeouts reject stalled initialization and retry through fresh workers
- [x] Segmenter retains its fresh-worker timeout semantics through the shared registry
- [x] Invalid deadlines fail before worker construction or frame copying
- [x] Focused worker lifecycle verification passes 52/52 tests
- [x] All eight production bundle budgets pass; the anchor worker is 319,883 of 320,000 bytes without changing the limit
- [x] Release verification passes 842/842 tests, all asset/flow/license audits, and zero vulnerabilities
- [x] Mobile Chromium/WebKit passes 30 tests with 10 intentional platform-policy skips

## Relax one bootstrap dimension at a time

- A mathematically minimal frame count is not a sufficient initialization contract. When temporal redundancy is reduced, retain the established spatial-landmark floor and add a spectral separation check for the rank the model requires.
- An observation-ratio setting can be accidentally disabled by a larger absolute `minFrames` floor. Audit the effective threshold at the first eligible build, not only after history has accumulated.
- Missing measurements may be completed from a robust reference transform when a trusted surface prior supplies landmark geometry, but that relaxation should exist only at the minimal bootstrap. Restore the established per-landmark observation floor as soon as the next view arrives.
- Use the third-to-fourth eigenvalue gap to distinguish rank-3 structure from noise/non-rigid residual dimensions. A non-zero third eigenvalue alone accepts unstable factorizations.
- Treat a minimal-view path as an exception for interrupted evidence, not a general latency shortcut. If the established spatial floor is already fully observed in every minimal view, collect the next view instead of spending reduced temporal redundancy without need.
- Validate the policy on the target failure, a harder matrix, and the complete source replay corpus. HOL's first broad three-view candidate regressed hard risk; the first rank-gated candidate then exposed two narrow mug regressions only in the full suite. Combining the eigengap, base spatial floor, partial-support necessity, and post-bootstrap support restoration retained the target gain while making non-qualifying hard cases numerically identical to baseline.

<!-- Evolution: 2026-08-05 | source: implementation-review | skill: self-improving-agent -->

## Require independent cue agreement before an absolute state reset

- A bounded presentation or tracking filter can become the source of map bias when recovery rebuilds landmarks around its stale output. Diagnose current-frame raw tracker evidence, independent support evidence, filtered state, and truth separately before tuning the filter.
- An absolute reset is justified only when independent cues agree, the correction exceeds ordinary update capacity by a meaningful margin, and the semantic scope explains why the normal owner is unavailable. For HOL, the useful boundary was a trusted object-wide mask plus an eight-inlier similarity transform, agreement within a scale-aware 6–14 px gate, more than two normal update envelopes of accumulated lag, and a generic free-tap target.
- Do not generalize a motion prior by object shape alone. A stale constant-velocity sample can look coherent immediately before a trajectory reversal and worsen both mean and tail error. Freshness, direction, and semantics are different evidence dimensions.
- Aggregate improvement is insufficient for recovery changes. Diff every report, failure stage, and operation-cadence counter. The first broad cross-cue gate improved aggregate risk but introduced a 33.17 px jump on a known label bottle; the exact report diff exposed it and a semantic gate removed it.
- Separate a one-shot map-coordinate correction from steady-state motion smoothing. The reset should have one owner and one evidence contract; normal bounded updates resume immediately afterward.

## Validation report: generic cross-cue recovery

**Date**: 2026-08-05
**Scope**: support recovery, similarity tracking, absolute keypoint-map reinitialization

- [x] Generic acceptance and insufficient-lag, disagreement, weak-mask, and known-class rejection are unit tested
- [x] Target production-cadence replay improves mean/max/8 px accuracy and retains one-frame recovery
- [x] Exact 84-report A/B changes only the target replay; cadence and failure-stage counts are unchanged
- [x] Representative per-update quality passes 84/84; hard directional contract is unchanged
- [x] Vision suite passes 385/385 real and synthetic OpenCV tests
- [x] Anchor worker passes the unchanged 320,000-byte limit at 319,899 bytes
- [ ] External annotated-video fixtures and physical-iPhone camera/thermal/orientation measurements remain external evidence requirements

<!-- Evolution: 2026-08-05 | source: benchmark-driven-recovery | skill: self-improving-agent -->

## Normalize object motion before paying for keyframe appearance evidence

- Keyframe novelty can use object-local coordinates only when target geometry justifies that invariance. A common screen translation does not add affine recovery evidence for a rigid plane, but curved and deformable targets may expose useful appearance or border evidence under the same motion.
- Absolute screen displacement and translation-normalized residual deformation are different quantities and require independent algorithm owners. Absolute-motion tolerance also depends on support: 13 shared landmarks survived a 5 px boundary, while two mug fixtures with 10–12 shared landmarks required the strict 4 px boundary.
- Tune pre-extraction rejection against every regression protocol. The 84-report per-update gate accepted 7 px, while the complete source suite exposed a mature planar mean-error regression, a 49.80 px early-occlusion mug error, and a lost motion-bridge invariant in a sibling mug trajectory. A support-aware 4/5 px absolute boundary plus a separate 4 px planar residual is the widest combination that retains those boundaries and removes three of 257 canonical quick ORB storage extractions.
- Preserve extractor evidence when cadence is the owner. Cropping changed pyramid coordinates, masking changed global feature ranking, direct `Feature2D.compute` at LK points changed detector-owned scale/orientation evidence, and lowering the storage feature cap changed the surviving response set. Each looked attractive in isolation and each introduced a strict matrix regression.
- Attribute only deterministic work removal to the algorithm. Node/WASM timings locate the stage, while physical iPhone Safari and Chromium own mobile latency, thermals, memory pressure, and WebGL coexistence claims.
- Final evidence is 84/84 per-update reports, the exact hard contract, 908/908 source tests, a 319,871-byte production worker under the unchanged budget, and 32 passing mobile-browser tests. The unavailable external-video manifest remains an explicit evidence gap.

<!-- Evolution: 2026-08-05 | source: object-local-keyframe-audit | skill: self-improving-agent -->

## A fixture is evidence only after executable coordinate adaptation and scoring

- File existence, arbitrary annotation names, and minimum byte sizes are supply checks, not benchmark execution. A fixture gate must decode the declared frame format, adapt the annotation coordinate system, invoke the production algorithm, and score predictions before it may pass.
- Use one versioned fixture owner. Exact byte length plus SHA-256 prevents truncation and substitution; a declared decompression ceiling prevents a small compressed asset from becoming an unbounded allocation; strict known fields prevent misspelled metadata from being silently ignored.
- Point-query independence is part of benchmark validity. Start a fresh tracker for every selected query and never use sibling tracks to infer support, motion, object membership, or visibility.
- Match the reference metric at its sharp boundaries. TAP-Vid excludes the query frame, evaluates at a 256 px raster, uses strict less-than thresholds at 1/2/4/8/16 px, measures coordinate accuracy independently of predicted visibility, and adds false-visible or too-distant predictions to Jaccard's denominator.
- Do not constrain occluded annotations as though they are visible pixels. Official trajectories remain finite while occluded coordinates may leave normalized raster bounds; only visible samples must lie inside `[0,1]`.
- Preserve production cadence in the system benchmark even when the academic protocol scores every source frame. Held presentation estimates remain predictions and visibility decisions; admitted-update counts must be reported beside quality.
- External benchmark licensing needs a machine-readable boundary. Requiring CC-BY-4.0, attribution, and source URL made the smaller 187 MB RGB-Stacking archive objectively preferable to the 1.67 GB DAVIS archive for a first reproducible rendered-scene pack.
- Sandboxed native runtimes must not acquire process-global failure ownership. Snapshot error listeners around Emscripten initialization and remove only newly registered handlers so a later assertion remains concise and belongs to the test runner.

## Validation report: executable TAP-Vid-style fixtures

**Date**: 2026-08-05
**Scope**: fixture integrity, RGB decoding, causal replay, official point metrics, OpenCV Node lifecycle

- [x] Strict manifest and annotation RED contracts cover versions, fields, paths, hashes, sizes, URLs, licenses, track identity, first-visible queries, visible raster bounds, and occluded out-of-raster coordinates
- [x] Official metric characterization covers threshold boundaries, 256 px scaling, occlusion accuracy, Jaccard, cross-query aggregation, incomplete predictions, and regression floors
- [x] Official CC-BY TAP-Vid RGB-Stacking sample 34 executes 3 independent queries over 747 evaluation frames at production cadence
- [x] Baseline reports AJ `0.22874138101326952`, average threshold accuracy `0.3011647254575707`, and occlusion accuracy `0.5957161981258366`
- [x] Node OpenCV initialization retains the caller's exact process error-listener ownership
- [x] Focused contracts pass 16/16; strict vision passes 397/397; representative quality passes 84/84; the hard regression contract passes exactly
- [x] Release verification passes 920/920 source tests plus production build, asset, bundle-budget, flow, SBOM, license, and vulnerability gates
- [x] Mobile Chromium/WebKit passes 32 tests with 10 intentional platform-policy skips
- [ ] Physical-iPhone camera latency, sustained thermals, memory pressure, orientation, WebGL coexistence, and captured-device fixture diversity remain separate evidence requirements

<!-- Evolution: 2026-08-05 | source: annotated-video-benchmark-execution | skill: self-improving-agent -->

## Separate evidence quorums by the claim they certify

- A pose quorum and a temporal-continuity quorum are different contracts. Reusing the stricter pose threshold can freeze a provisional track even when enough landmarks remain to update local motion; lowering the shared threshold falsely promotes weak evidence into pose ownership.
- Keep one numerical implementation behind two semantically named operations. The provisional operation may advance temporal state and attachment position, while full tracking retains its established geometry, visibility, and reconstruction gates.
- Sweep the quorum against aggregate quality, the weakest independent query, and an error tail. A mathematically minimal fit can maximize tight-threshold hits while creating catastrophic coherent drift that only p95 reveals.
- Annotation-conditioned diagnostics belong in the evaluator, never the algorithm. Split visible and occluded phases for tracking rate, landmark count, state, method, readiness, and runtime so opposite failure modes cannot cancel in one mean.
- Aggregate benchmark floors are insufficient when independent queries exercise different owners. Apply minimum Jaccard and occlusion accuracy and maximum error-tail limits to every query, and include the query identity in the first failure.
- Reject attractive semantic shortcuts when the benchmark disproves their ownership. In this session, forced reinitialization, weak-texture promotion, forward-backward LK, generic keyframes, and a simplistic presence rule all improved a local signal or one error bucket while worsening end-to-end tracking.

## Validation report: candidate continuity and per-query floors

**Date**: 2026-08-05
**Scope**: provisional LK ownership, annotated point tracking, visibility/localization diagnostics

- [x] Six-landmark candidate flow is unit tested at its exact boundary; seven landmarks still fail the unchanged eight-landmark full pose operation
- [x] Service candidate bootstrap uses the provisional operation without changing pose, reconstruction, or overlay readiness admission
- [x] Official TAP-Vid metrics expose visibility confusion and visible-point mean/p50/p95 without using annotations in production decisions
- [x] Fixture manifests require strict aggregate and per-query quality contracts
- [x] Official RGB-Stacking AJ is `0.2600768464726836`, average threshold accuracy is `0.3853577371048253`, and occlusion accuracy is `0.6398929049531459`
- [x] Every selected query passes AJ, occlusion, and p95 gates; the weakest query remains explicit
- [x] Candidate-heavy bootstrap p95 remains below `3.1` ms in Node; the rare transition spike remains reported separately
- [x] Source verification passes 921/921 and the 28-replay hard directional contract remains exact
- [ ] Physical-iPhone sustained camera latency, thermals, memory pressure, orientation, and WebGL coexistence remain device-owned measurements

<!-- Evolution: 2026-08-05 | source: per-query-candidate-continuity | skill: self-improving-agent -->

## Arm expensive appearance memory from cheap mature geometry

- A long-occlusion failure with only two to four reciprocal local-descriptor matches is missing identity evidence, not a weak version of an accepted geometric match. Do not lower the global inlier floor to compensate.
- Separate reference eligibility from recovery eligibility. An unknown/generic tap may be unsafe as learned identity evidence at selection time but become safe after the classical tracker accepts a mature object-owned keyframe. Do not extend that late gate to semantic targets whose recovery models already encode shape-specific ownership.
- Keep the cascade ordered: cheap local tracking in steady state, classical global descriptors on every recovery admission, learned appearance only after classical failure, and the same strict geometric/restoration gate after either descriptor source.
- Bound the expensive fallback by cadence and sweep that cadence against the weakest independent query. Every third recovery attempt saved work but missed the only useful re-entry phase; every second attempt retained the floor, while every-frame inference was both slower and slightly worse on aggregate quality.
- Measure attempted and accepted learned recoveries separately in visible and occluded phases. A quality gain is credible only when long-term recovery increases without accepting the absent interval.
- Optional worker failure must settle to an explicit failed result so background warm-up cannot create an unhandled rejection. Clearing the tracked object must reset both the reference promise and the cadence clock.
- Avoid mutations in default parameter expressions for generation or ownership state. Defaults are evaluated before the function body, so a coalesced early return can still advance the generation unexpectedly.

## Validation report: mature appearance memory

**Date**: 2026-08-05
**Scope**: mature ORB keyframes, XFeat reference lifecycle, recovery cadence, annotated long occlusion

- [x] Accepted and rejected keyframe reference ownership is unit tested
- [x] ORB remains per-admission while learned recovery is cadence-bounded
- [x] Official annotated aggregate and weakest-query floors improve with zero false occlusion recovery
- [x] The installed aggregate and per-query floors were raised so the previous implementation cannot pass
- [x] The 28-replay hard feedback contract remains green and numerically identical to baseline
- [x] The complete source corpus rejects broad semantic arming and retains the unknown/generic scope
- [x] The unchanged 320,000-byte production worker budget passes at 319,737 bytes
- [ ] Physical-iPhone recovery spikes, thermals, memory pressure, orientation, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-05 | source: mature-appearance-memory | skill: self-improving-agent -->

## Preserve complementary long-term views instead of refreshing identity in place

- A newer reference is not automatically a better long-term identity reference. Replacing HOL's initial XFeat view with a later mature view regressed annotated aggregate AJ from `0.2888167288808251` to `0.26099599152258335`; retaining both raised it to `0.29189255696038807`.
- Bound appearance memory explicitly. Two views capture initial and mature appearance without turning recovery into unbounded matching work, memory growth, or an implicit online-training system.
- Extract query features once, but fit each reference geometry independently. Pooling correspondences from different camera/object poses would mix coordinate systems before geometric validation; choose among completed fits by inlier count, inlier ratio, and residual instead.
- Treat extension failure as a local rejection, not loss of the published memory. Core storage, worker-client readiness, and service recovery must all continue to expose the first valid view after a second view is undersupported.
- Sweep admission timing against aggregate AJ, the weakest independent query, visibility confusion, and p95 error. The second ORB keyframe nearly eliminated visibility misses but fell below the aggregate AJ floor; the third was the best balanced boundary; the fourth and fifth progressively reduced AJ.
- Keep event telemetry transient and bank telemetry cumulative. A stored-keyframe result/reason must reset on the next frame, while keyframe and descriptor counts remain available; otherwise evaluators duplicate one storage event across held frames and invalidate cadence conclusions.

## Validation report: bounded dual-view appearance memory

**Date**: 2026-08-05
**Scope**: XFeat reference bank, extension lifecycle, annotated long-occlusion recovery, keyframe-event diagnostics

- [x] Initial-view, mature-view selection, full-bank rejection, undersupported extension, client readiness, service fallback, clear, and runtime-failure boundaries are unit tested
- [x] Official RGB-Stacking aggregate reaches AJ `0.29189255696038807`, threshold accuracy `0.46322795341098166`, and occlusion accuracy `0.785809906291834`
- [x] The limiting query reaches AJ `0.2545695990968245`, p95 `45.91011311264051` px, 143 TP, 46 TN, zero FP, and 60 FN
- [x] No keyframe is admitted and no recovery is accepted during the 46-frame occlusion
- [x] The 84-report quality matrix passes, and the 28-replay hard contract remains exact at mean risk `42.8498883005434`
- [x] Release verification passes 929/929 source tests, eight bundle budgets, license/SBOM/vulnerability gates, and 32 production browser tests
- [ ] Physical-iPhone recovery latency, sustained thermals, memory pressure, orientation stability, and WebGL coexistence remain device-owned measurements

<!-- Evolution: 2026-08-05 | source: bounded-dual-view-memory | skill: self-improving-agent -->

## Keep dynamic registries out of runtime leaves

- A generic registry lookup can retain every registry member even when a runtime needs one constant. Production source-map attribution exposed `7855` bytes of capability metadata in HOL's anchor worker solely to resolve the OpenCV URL.
- Preserve one ownership source while exposing a narrower static boundary. Each direct runtime URL must be the exact URL stored in the immutable manifest record; generic lookup remains for dynamic cache/release consumers, not for statically known worker leaves.
- Mark both leaf records and aggregate composition as pure when they are immutable data construction. Marking only the asset records saved about 502 bytes because top-level pack construction still looked observable; marking the pack assembly allowed the unused graph to disappear.
- Prefer tree-shaking before adding a dynamic import or another worker chunk. A new split adds fetch, evaluation, cache, and failure transitions; removing irrelevant static metadata changes none of those runtime contracts.
- Use source-map generated-byte attribution to prove the owner before editing. Raw source length would have blamed the 131 KB service, while the actionable independent branch was the 7.9 KB manifest contribution.
- Do not tighten a budget to the exact measured output. HOL's transient 313,000-byte candidate left only 45 bytes; the final 315,000-byte contract is still 5 KB stricter than before while retaining 2,045 bytes for controlled evolution.
- Every emitted implementation needs its own budget. Adding a 24,000-byte XFeat-worker limit closed a previously unbounded worker class instead of letting savings elsewhere hide future learned-runtime growth.

## Validation report: static capability leaves

**Date**: 2026-08-05
**Scope**: capability manifest ownership, Vite ES-worker tree-shaking, production bundle budgets

- [x] Direct URL exports and generic lookup return the same frozen records without a duplicate registry
- [x] Anchor manifest attribution falls from `7855` to `1025` generated bytes
- [x] Anchor worker falls from `319841` to `312955` bytes and passes the new `315000`-byte budget
- [x] XFeat worker falls from `28142` to `21138` bytes and passes its new `24000`-byte budget
- [x] Depth and Interactive Segmenter workers remain fully emitted and execute through production browser tests
- [x] Quality passes 84/84, hard risk remains exactly `42.8498883005434`, and annotated aggregate/per-query floors pass
- [x] Release verification passes 930/930 tests, nine bundle budgets, SBOM/license/vulnerability gates, and 32 production browser tests
- [ ] Physical-iPhone download, parse, startup, memory, thermal, orientation, and WebGL-coexistence measurements remain device-owned

<!-- Evolution: 2026-08-05 | source: worker-manifest-tree-shaking | skill: self-improving-agent -->

## Defer optional implementations at their service ownership boundary

- A constructor that performs no network or model work can still make its complete static dependency graph part of startup. Source-map attribution, not runtime intuition, must decide whether a supposedly lazy feature is actually absent from the initial shell.
- Put the dynamic import behind the stable service interface rather than scattering it across UI callers. Listener registration, idle metrics, reset, disposal, and configuration validation remain available synchronously while one real implementation continues to own business behavior.
- Treat an unfinished import as lifecycle work. Runtime generation must make disposal terminal; subject generation must let a clear/reset retire queued work without permanently disposing the camera session; rejected imports must release only the single-flight promise so a later request can retry.
- Preserve fail-early platform validation outside the deferred implementation. Moving code out of startup must not defer malformed injected collaborators until after expensive capture or network work.
- Guard both sides of the split. The initial shell and deferred implementation each need independent raw-byte budgets, and the generated HTML must be checked so a future preload cannot silently reverse the intended network boundary.
- Report total-code tradeoffs explicitly. HOL removed 16,137 raw bytes from startup but added 2,462 raw bytes across the complete shell-plus-personality graph because lifecycle coordination is real code; this is justified deferral, not total-size reduction.

## Validation report: lazy personality ownership

**Date**: 2026-08-05
**Scope**: optional personality code splitting, listener ownership, reset/dispose races, release startup graph

- [x] The old 139,871-byte app shell fails the tightened startup budget
- [x] The new app shell is 123,734 bytes and the deferred personality implementation is 18,599 bytes
- [x] Idle registration, single loading, listener removal, loaded reset, reset/dispose during loading, malformed exports, retry, strict config, metrics, and terminal disposal are unit tested
- [x] Release verification passes 942/942 tests, ten bundle budgets, twelve deferred-asset preload exclusions, license/SBOM/vulnerability gates, and the 112-file architecture audit
- [x] Quality passes 84/84, hard risk remains exactly `42.8498883005434`, annotated floors pass, and the production browser suite passes 32 tests
- [ ] Physical-iPhone startup download, parse, compile, INP, memory, and thermal effects remain device-owned measurements

<!-- Evolution: 2026-08-05 | source: lazy-personality-ownership | skill: self-improving-agent -->

## Budget the complete startup graph and split conditional UI at its persistent shell

- Source-map attribution should distinguish always-visible interaction from code reachable only after explicit disclosure. For HOL, the HUD belongs in the shell; the diagnostic drawer, preview, and advanced tabs belong behind the open-state boundary.
- Keep state that must survive close/reopen in the persistent shell, not in the lazy implementation. The shell also owns focus return, while both the loading state and resolved drawer own valid initial focus and an immediate close action.
- A budget on the entry filename is incomplete because a bundler may extract statically required shared modules into `modulepreload` chunks. Parse the generated index and sum the entry plus every startup preload as a separate aggregate contract.
- Guard the deferred side independently: require the emitted chunk, bound its raw size, reject HTML preload, and verify actual production-network timing before and after the user action. Static source inspection alone does not prove a request boundary.
- Do not generalize strict asset cardinality blindly. Ordinary chunk owners require exactly one emitted asset, while an intentional ES-worker bootstrap/implementation pair requires exactly two. Encode that architecture explicitly so missing and duplicate files both fail.
- Report the complete-code tradeoff. HOL removed 26,558 raw bytes from startup but added 2,021 raw JavaScript bytes across startup plus the drawer; the result is justified interaction-gated deferral, not total-size reduction.

## Validation report: lazy field-control ownership

**Date**: 2026-08-05
**Scope**: React lazy drawer, focus/state ownership, production request timing, complete startup graph

- [x] The old static drawer fails both the required-chunk gate and production request-timing test
- [x] Main shell falls from 123,734 to 97,091 raw bytes; complete startup JavaScript falls from 325,676 to 299,118 bytes
- [x] The 28,579-byte drawer has an independent 32,000-byte budget and is excluded from startup preload
- [x] Cold/warm focus, close, Escape, tab persistence, controlled values, and WCAG A/AA checks pass
- [x] Release verification passes 942/942 tests, 11 owner budgets, aggregate startup accounting, 13 deferred assets, license/SBOM/vulnerability gates, and the 112-file architecture audit
- [x] Quality passes 84/84, hard risk remains exactly `42.8498883005434`, annotated floors pass, and production browsers pass 33 tests
- [ ] Physical-iPhone startup and first-open download, parse, INP, memory, and thermal effects remain device-owned measurements

<!-- Evolution: 2026-08-05 | source: lazy-field-controls-ownership | skill: self-improving-agent -->

## Derive optional diagnostics at the narrowest mounted consumer

- A lazy UI boundary is incomplete when its parent still constructs the child's rich view model. Keep the always-visible status projection small, pass validated source state across the boundary, and derive the detailed record only inside the mounted diagnostic consumer.
- Split the decision record from the detail projection without duplicating decisions. HOL's compact status module owns every user-facing state/message branch; the Anchor tab adds details to that exact record instead of retaining a second combined descriptor.
- Trace transitive imports, not just the obvious source file. A platform-readiness module retained the HTTP client, response parsers, and deadline machinery solely because the environment reader lived in the transport module. Moving the finite environment registry to its own strict leaf removed the complete transport graph from startup.
- `useMemo` is neither a loading boundary nor an appropriate owner for external-resource probes. Conditional mounting controls whether code and work exist; a post-commit effect owns capability probing, and a ref makes the one-shot lifecycle explicit under React's development effect replay.
- A capability probe must release what it allocates. For WebGL, request `WEBGL_lose_context` and call `loseContext()` on the detached test context; production-browser instrumentation should prove both zero early allocations and one create/release pair at the owning interaction.
- Evaluate cumulative user paths as well as individual chunks. A larger optional drawer is acceptable only when startup plus first-open bytes still fall; separately guard newly emitted shared leaves so extraction cannot turn into unbounded fragmentation.
- Be precise about microbenchmarks. A 6.37× reduction in a sub-microsecond desktop selector proves removed allocation work, not a meaningful mobile frame-time win; source-map and network evidence carry the stronger claim here.

## Validation report: consumer-owned diagnostics

**Date**: 2026-08-05
**Scope**: compact anchor status, rich diagnostic derivation, runtime readiness, environment ownership, production bundle graph

- [x] Compact status exhaustively covers camera, initialization, selection, stable, candidate, mapping, tracking, degraded, lost, pose-recovery, and unknown branches
- [x] Rich anchor details remain complete and are built only by the mounted Anchor tab
- [x] Runtime readiness is collected only by the mounted System tab, with an explicit loading state
- [x] WebGL2, WebGL1 fallback, unavailable support, production creation timing, and explicit context release are tested
- [x] Unknown Vite environment keys fail immediately, while readiness no longer imports or requests the local-AI transport
- [x] App shell falls from `97091` to `80776` bytes and aggregate startup JavaScript falls from `299118` to `282803` bytes
- [x] Startup plus first drawer open falls from `327697` to `320853` bytes despite the drawer assuming its real diagnostic ownership
- [x] The closed desktop selector falls from `0.105743` to `0.016590` microseconds median; open rich derivation remains `0.106113` microseconds
- [x] Final verification passes 948 source tests, 38 production assets, 13 bundle budgets, 113 audited flow files, 253 open-source dependency components, zero vulnerabilities, 84/84 quality reports, the exact hard baseline, the installed annotated-video floors, and 34 production-browser tests
- [ ] Physical-iPhone startup, first-open responsiveness, WebGL context pressure, orientation, memory, thermal, and sustained-camera behavior remain device-owned evidence

<!-- Evolution: 2026-08-05 | source: consumer-owned-diagnostics | skill: self-improving-agent -->

## Require orthogonal gates before accepting a vision algorithm

**Confidence**: 0.96
**Category**: algorithm evaluation

- An improvement in one aggregate is not sufficient evidence for a stateful vision change. Evaluate at least per-update correctness, full-sequence workload/cadence, and explicit target-loss safety as independent contracts.
- Pin workload ownership as well as output quality. Refresh, reinitialization, feature-extraction, and learned-recovery counts can reveal a hidden policy change even when average risk improves.
- Treat false locks and post-loss recovery as hard constraints, not terms that a better mean score may offset. A local consistency signal can still preserve a coherent distractor.
- Run the narrow experiment first, then every orthogonal gate before retaining production code. If a candidate fails, remove its buffers, telemetry, API, tests, and flags rather than leaving a dormant alternate path.
- Put deterministic, hermetic protocols in the release-owned script. Keep externally provisioned datasets separate until CI installs and verifies them; a successful missing-fixture skip is not quality evidence.

## Validation report: cross-protocol release ownership

**Date**: 2026-08-05
**Scope**: forward-backward LK experiments, synthetic release gates, annotated-fixture ownership

- [x] Focused and complete examples run: 949/949 source tests and 34 production-browser tests pass
- [x] The checklist matches HOL's fail-fast npm and single release-job conventions
- [x] Primary OpenCV, forward-backward error, npm, and GitHub status-check references remain valid
- [x] No duplicate or conflicting vision gate, tracker branch, buffer, metric, feature flag, or compatibility path remains
- [x] Quality is 84/84; exact quick cadence/hash and the hard loss/re-entry contract pass
- [x] The installed 250-frame annotated fixture passes independently and is not counted when absent
- [ ] Physical-iPhone latency, thermals, memory pressure, orientation, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-05 | source: cross-protocol-release-ownership | skill: self-improving-agent -->

## Make external benchmark evidence hermetic before making it required

**Confidence**: 0.98
**Category**: benchmark infrastructure and provenance

- A strict evaluator is not a release gate when missing data exits successfully or provisioning depends on a developer-owned environment variable. Required evidence needs one deterministic location and must fail on deletion, corruption, provenance drift, quality regression, or license rejection.
- Compare the cost of the published source with the smallest faithful derived fixture. A checked-in 4.5 MB pack can be more reliable and cheaper than downloading and parsing a 187 MB archive in every job; Git LFS or a cache is counterproductive when the compact file is comfortably below repository limits.
- Pin two distinct chains: upstream provenance (HTTPS source, exact archive bytes, SHA-256, sample identity, attribution, license) and executable evidence (format, dimensions, cadence, hashes, lengths, query identities, and floors). Neither substitutes for the other.
- Treat fixture manifests as allocation inputs. Bound fixture count, query count, compressed files, annotations, and decoded payload before reading or decompressing; then verify exact lengths and hashes again at the asset boundary.
- Keep research assets outside every production input root and reject their emitted names in build validation. Include their licenses in the release license gate even when they are test-only and absent from the dependency SBOM.
- Use one console/artifact ownership rule across synthetic and annotated protocols: project decision metrics before serialization, prove discarded evidence is not observed, and serialize complete replay evidence only for an explicit output path.
- Bound hardware-like browser resources in local and CI runs alike. Unrestricted parallel fake-camera sessions can create permission timeouts that disappear at the CI worker limit; encode the shared resource limit in configuration and pin it with a source contract.

## Validation report: hermetic annotated release evidence

**Date**: 2026-08-05
**Scope**: TAP-Vid fixture provenance, manifest hardening, release ownership, output reporting, browser concurrency

- [x] Examples run through the mandatory 250-frame, three-query TAP-Vid replay and explicit full-artifact path
- [x] The checklist matches the repository's single `verify:vision` and `verify:release` ownership model
- [x] Official TAP-Vid format/license, live upstream archive SHA-256, and GitHub file-limit references are valid
- [x] No cache path, downloader, environment override, missing-data skip, asset URL, migration, or compatibility route remains
- [x] Release verification passes 960 source tests plus every production asset/budget, architecture, SBOM/license, and vulnerability gate; the final corpus passes 961 after adding the browser-worker ownership contract
- [x] Quality remains 84/84; quick cadence/hash and hard loss safety remain exact; annotated AJ/occlusion remain `0.29189255696038807`/`0.785809906291834`
- [x] Complete production browser validation passes 34 tests with 12 intentional platform-policy skips at the shared two-worker resource bound
- [ ] Physical-iPhone latency, thermals, memory pressure, orientation, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-05 | source: hermetic-annotated-release-evidence | skill: self-improving-agent -->

## Gate post-reappearance quality independently of whole-track averages

**Confidence**: 0.98
**Category**: long-term tracking evaluation

- Whole-track AJ and occlusion accuracy can retain enough headroom to accept a stateful tracker that collapses after a long occlusion. A release gate needs an independently thresholded post-reappearance metric, not only additional diagnostics.
- Follow the TAPNext++ Re-Detection Average Jaccard event definition: admit a reappearance only when its preceding invisible run is longer than every earlier run for that track, then evaluate the segment from reappearance through the end. This prevents repeated short flickers from dominating long-term recovery evidence.
- Report every configured minimum-undetectable duration and keep thresholds without an eligible event explicit. Average only defined duration scores; never coerce absent evidence to zero or silently dilute it into a whole-track mean.
- Require a finite aggregate floor and a finite per-query floor. The aggregate protects the recovery bucket, while the per-query contract prevents a strong reappearing trajectory from hiding one complete recovery collapse.
- Calibrate floors from the accepted deterministic baseline with deliberate headroom, then replay a known rejected candidate through the new gate. A metric that cannot reject the failure that motivated it is descriptive telemetry, not regression protection.
- Preserve standard TAP-Vid AJ, threshold accuracy, and occlusion accuracy as separate contracts. Re-detection AJ narrows the evaluation domain; it does not replace false-visible penalties during the preceding occlusion or ordinary visible tracking quality.

## Validation report: reappearance-specific release evidence

**Date**: 2026-08-05
**Scope**: TAPNext++ AJ_RD definition, TAP-Vid metric integration, annotated fixture schema, release floors

### Checks

- [x] Examples compile or run
- [x] Checklists match current repo conventions
- [x] External references still valid
- [x] No duplicated or conflicting guidance

### Findings

- [x] The accepted six-query baseline retains whole-track AJ `0.23480652929273851` and re-detection AJ `0.08815318481845025`
- [x] Primary and occlusion-stress sets own independent aggregate and per-query re-detection floors with approximately 5–6% deterministic headroom
- [x] A rejected three-view memory still passed the former AJ/OA floors but produced re-detection AJ `0` on track `18`; the re-detection contract rejects it
- [x] Equal-length repeated occlusions are excluded, record-length events and unavailable duration thresholds are unit tested, and incomplete metrics fail early

### Actions

- [x] Replaced the fixture schema with one strict shape; no compatibility parser, migration, alternate metric, model, asset, or production path remains
- [x] Added re-detection AJ to full artifacts, compact decision output, top-level summaries, and current benchmark documentation
- [ ] Physical-iPhone recovery latency, memory pressure, thermals, orientation stability, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-05 | source: reappearance-specific-release-evidence | skill: self-improving-agent -->

## Gate temporal error concentration, not only error volume

**Confidence**: 0.98
**Category**: long-term tracking evaluation

- Sequence averages do not constrain when errors occur. The same false-positive count is materially worse when it forms one uninterrupted hallucination during an occlusion, and a whole-tail re-detection average can be repaired by a later visibility episode after the immediate return was completely missed.
- Add orthogonal temporal contracts only when an adversarial trace proves the existing metrics accept the motivating failure. Keep the established metrics; a temporal concentration metric supplements rather than redefines their semantics.
- Measure disappearance errors as the longest consecutive false-visible duration. Normalize the gate to time using the fixture's pinned cadence so videos at 15, 30, and 60 FPS remain comparable; keep frame indices and counts as diagnostics.
- Measure stable recovery inside the first visible run following an eligible reappearance. Require a short consecutive correctness window so one chance frame cannot count as re-detection, and stop before the next occlusion so later episodes cannot repair the event.
- Use the coarsest established localization threshold for identity/reacquisition and retain the complete multiscale metric for precision. In TAP-Vid coordinates, a strict sub-16-pixel boundary owns recovery while 1/2/4/8/16-pixel AJ continues to own localization quality.
- Report eligible and recovered counts, recall, latency, and explicit unrecovered events together. Latency among only recovered events is unsafe without the recall floor because deleting difficult recoveries can otherwise improve the apparent maximum.

## Validation report: temporal concentration gates

**Date**: 2026-08-06
**Scope**: false-visible persistence, stable re-detection, cadence normalization, annotated release floors

### Checks

- [x] Examples compile or run
- [x] Checklists match current repo conventions
- [x] External references still valid
- [x] No duplicated or conflicting guidance

### Findings

- [x] An adversarial trace keeps AJ and AJ_RD above `0.75` and OA above `0.8` while producing a ten-frame false-visible run and missing the complete first reappearance episode
- [x] The real six-query baseline contains eight eligible stable events, recovers four, reaches `466.6666666666667` ms worst latency, and contains a `1000` ms false-visible run
- [x] Stable evidence is 100 ms at the pinned source cadence; recovery uses strict sub-16-pixel error on the standard 256-pixel raster
- [x] Full artifacts retain event-level frames and durations while compact output retains only decision metrics

### Actions

- [x] Replaced the annotated fixture schema with the sole version-4 temporal contract; no version-3 parser, migration, compatibility branch, model, asset, dependency, or production path remains
- [x] Added independent aggregate stable-recall/latency floors and per-query false-visible-duration ceilings to both primary and occlusion-stress gates
- [ ] Physical-iPhone recovery latency, memory pressure, thermals, orientation stability, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-06 | source: temporal-concentration-release-gates | skill: self-improving-agent -->

## Gate visible-track continuity symmetrically

**Confidence**: 0.98
**Category**: long-term tracking evaluation

- Visibility averages are symmetric in total error but not in user impact. A long false-visible interval leaves an attachment on an absent target; a long missed-visible interval removes it from a present target. Gate both longest streaks in time, not only their contribution to aggregate occlusion accuracy.
- Longest outage and fragmentation count are independent. One bounds a concentrated loss; the other bounds repeated flicker even when every loss lasts only one frame. Require an adversarial trace for each before adding either to the release contract.
- Count a fragmentation only after the target has been acquired during the current uninterrupted ground-truth-visible run. Reset acquisition on true occlusion. Preserve an initially missed run as an outage diagnostic without misclassifying re-detection latency as track fragmentation.
- Treat the visible query as initialization, not as an evaluated prediction. Reject an occluded query and ignore the query-frame prediction when classifying the first evaluation-frame outage; otherwise an excluded input can silently change fragmentation ownership.
- Normalize duration ceilings from the pinned source cadence and retain integer frame bounds in artifacts. For deterministic footage, set the ceiling below one additional source frame so the contract is strict without comparing floating-point durations for exact equality.
- Keep per-track event diagnostics alongside aggregate counts. A total fragmentation count describes corpus burden; track index, start/end frames, duration, and acquisition state make the regression actionable.

## Validation report: visible continuity gates

**Date**: 2026-08-06
**Scope**: missed-visible persistence, track fragmentation, annotated schema version 5

### Checks

- [x] Examples compile or run
- [x] Checklists match current repo conventions
- [x] External references still valid
- [x] No duplicated or conflicting guidance

### Findings

- [x] A 500 ms visible-target outage retains AJ, OA, and AJ_RD above `0.8`, perfect immediate stable re-detection, and zero false visibility
- [x] Five isolated one-frame interruptions retain AJ and OA above `0.9`, proving longest outage alone does not constrain flicker
- [x] The pinned six-query replay has a 55-frame (`1833.3333333333333` ms) worst visible outage and ten total acquired-track fragmentations, with at most three on one query
- [x] Occluded queries fail early, and query-frame prediction state cannot alter post-query continuity
- [x] The new ceilings reject one additional worst-case frame or one additional per-query fragmentation

### Actions

- [x] Replaced the annotated fixture schema with sole version 5; no version-4 parser, migration, compatibility branch, dependency, asset, or production path remains
- [x] Added scalar decisions to compact output and full missed-streak diagnostics only to explicit artifacts
- [ ] Physical-iPhone overlay continuity, thermals, memory pressure, orientation stability, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-06 | source: symmetric-visible-continuity-gates | skill: self-improving-agent -->

## Make the reporting unit own its regression contract

**Confidence**: 0.99
**Category**: benchmark design

- A threshold applied separately to every item is not item-specific when every item receives the same weakest-case value. It only enforces the worst member's envelope repeatedly and lets stronger members regress inside that borrowed headroom.
- Keep aggregate contracts for corpus-level orientation, but make each independently replayed query, sequence, scene, device, or subgroup own its complete expected metric surface. Do not derive all item ceilings from the corpus maximum or all item floors from the corpus minimum.
- Prove the masking failure before changing the schema: regress a strong item by one discrete event while keeping it inside a weak sibling's shared threshold. The old design must pass and the item-owned contract must fail with the item's identity in the error.
- Calibrate continuous metrics with explicit deterministic headroom and discrete event limits below one additional event or source frame. An unrecovered hard case may honestly own zero recall; spatial quality minima must still reject a result with no quality.
- Validate ownership structurally. The query identifier and its floor belong in one object, identifiers are unique within and across sets, and evaluation consumes contracts in the validated selection order. Do not retain a parallel list plus an index-addressed floor table.
- Replace the old schema and assertion API outright. A compatibility parser would preserve the ambiguous ownership model and make it possible for future fixtures to reintroduce the same masking defect.

## Validation report: query-owned annotated contracts

**Date**: 2026-08-06
**Scope**: annotated manifest v6, aggregate/query assertions, six real-video replays

### Checks

- [x] Examples compile or run
- [x] Checklists match current repo conventions
- [x] External references still valid
- [x] No duplicated or conflicting guidance

### Findings

- [x] A strong query with one new missed-visible frame and one fragmentation still passes the former weak sibling ceilings of 1834 ms and three events
- [x] The same regression fails immediately under the strong query's zero-duration and zero-fragmentation contract
- [x] WILDS worst-subpopulation reporting and VOT per-sequence aggregation independently support retaining both aggregate orientation and failure-unit isolation
- [x] The pinned 250-frame replay preserves all six query metrics while enforcing distinct spatial, recovery, p95, false-visible, missed-visible, and fragmentation limits

### Actions

- [x] Replaced manifest version 5 with sole version 6; no v5 parser, migration, compatibility assertion, shared query floor, model, dependency, or production path remains
- [x] Added strict manifest ownership tests, adversarial masking tests, and full real-fixture execution to the verification path
- [x] Final verification passes 977/977 source tests, all 84 strict quality reports, deterministic quick/hard contracts, six query-owned annotated replays, 38 production asset hashes, 13 bundle budgets, the 120-file architecture audit, 253 open-source dependency licenses, and zero vulnerabilities
- [ ] Add a separately licensed and pinned real-world video domain before making cross-domain generalization claims
- [ ] Physical-iPhone overlay continuity, latency, thermals, memory pressure, orientation stability, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-06 | source: query-owned-benchmark-contracts | skill: self-improving-agent -->

## Make metric applicability an explicit evidence contract

**Confidence**: 0.99
**Category**: external benchmark design

- A null recovery metric is not automatically a failure. It can mean no post-query reappearance exists, a reappearance exists but its visible run is shorter than the stable window, or an eligible recovery was attempted but not achieved. Encode those states as exact discriminated variants instead of coercing null to zero or excluding valid tracks.
- Require each variant to prove its annotation preconditions. `not-applicable` owns zero events and null metrics; `segment-only` owns positive segment AJ and zero stable-eligible events; `eligible` owns positive events, consistent eligible/recovered counts, recall, and latency only when recovery occurs.
- Apply applicability at every reporting owner. A query-level variant with an unconditional aggregate recovery floor merely moves the same dataset bias upward.
- Reject zero spatial and recovery floors even for deliberately hard samples. A result with no measurable quality cannot protect a regression; keep it in research evidence or improve the algorithm until a positive executable surface exists.
- Register selection from annotations before tracker replay, then separate difficulty selection from executable-floor feasibility. Record rejected zero-signal candidates rather than quietly replacing them or admitting a vacuous threshold.
- Treat video and annotation licenses as separate provenance components. Derived benchmark samples often combine creator-owned footage with independently licensed labels; one fixture-wide license silently misstates at least one component.
- Add a genuinely different domain before claiming generalization. Rendered-object volume improves coverage but does not substitute for live-action lighting, motion blur, non-rigid motion, camera motion, and creator-specific footage provenance.
- When a new domain exposes a state-machine failure, preserve truth at the transition. Recovery may move the runtime back to provisional evidence collection, but the failed frame must remain not visible and established successful paths must retain their exact baselines.

## Validation report: real-world applicability-owned benchmark

**Date**: 2026-08-06
**Scope**: TAP-Vid-DAVIS `shooting`, component provenance, query/aggregate recovery contracts, weak-anchor first-update recovery

### Checks

- [x] Examples compile or run
- [x] Checklists match current repo conventions
- [x] External references still valid
- [x] No duplicated or conflicting guidance

### Findings

- [x] The pinned source archive is exactly 1,668,710,491 bytes with SHA-256 `60eb6239c57a9877900c269d14637c2b6eece8fa280f59e4592324c6392031b6`
- [x] The derived real-world pack retains 40 frames, 25 complete tracks, deterministic RGB/annotation hashes, and independent CC-BY-3.0 video plus CC-BY-4.0 annotation provenance
- [x] Pre-registered track `7` initially produced zero AJ; first-update progressive recovery raised it to a positive `0.0027397260273972603` without changing the established RGB-Stacking baseline
- [x] Repeated/long-occlusion candidates `3`, `5`, and `17` could not own positive re-detection floors and were rejected instead of receiving zero thresholds
- [x] The final 290-frame, 12-query replay reaches AJ `0.13806473021972454`, occlusion accuracy `0.7173823499124704`, re-detection AJ `0.08265562406523544`, and stable recall `0.6`
- [x] Focused manifest, applicability, ownership, and state-transition tests pass

### Actions

- [x] Replaced flat fixture provenance with exact video and annotation components; no fixture-wide license field or compatibility parser remains
- [x] Replaced unconditional recovery floors with exact `not-applicable`, `segment-only`, and `eligible` contracts at query and aggregate scope
- [x] Added the licensed DAVIS fixture and strict positive query-owned floors without a downloader, cache, skip, codec, runtime dependency, or production asset path
- [x] Limited progressive recovery to the first failed update of a weak anchor with existing bounded support; the failure frame remains not visible
- [x] Complete repository, release-vision, asset, license, build, formatting, SBOM, dependency-audit, and mobile-browser verification
- [ ] Physical-iPhone latency, thermals, orientation, memory pressure, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-06 | source: real-world-applicability-contracts | skill: self-improving-agent -->

## Keep benchmark coordinate derivation in the executable contract

**Confidence**: 0.99
**Category**: benchmark reproducibility

- A derived video hash proves byte identity, not coordinate provenance. Record the source raster, evaluation raster, resize/identity decision, exact resampler, cadence, and annotation coordinate space in machine-validated data rather than relying on prose.
- Make derivation discriminated and non-ambiguous. Identity must preserve both axes; resize must actually change the raster and accept only a pinned implementation path. Reject unknown fields and old schema versions rather than inferring intent.
- Carry the validated transform into compact and full benchmark reports. Analysis scripts should never need to remember that an upstream 1152×480 video was already serialized as 256×256 RGB.
- A research-inspired signal is not a production improvement until the complete independent corpus moves safely. Velocity-seeded LK with identical metrics adds complexity without value; weak ORB memory and background affine motion both looked locally plausible but regressed sibling queries.
- Background coherence cannot own object translation. Even when an affine fit has broad support and low residual, foreground motion, parallax, and occlusion can make moving the object search center worse. Learned or descriptor memory needs identity evidence, not merely a stronger motion model.
- Remove rejected experiments completely, including tests, telemetry, flags, temporary floor bypasses, and lifecycle code. Preserve only the measured result and generalized lesson.

## Validation report: source-raster-owned annotated evidence

**Date**: 2026-08-06
**Scope**: manifest v8, RGB-Stacking identity derivation, DAVIS Lanczos derivation, 12 independent queries

### Checks

- [x] Examples compile or run
- [x] Checklists match current repo conventions
- [x] External references still valid
- [x] No duplicated or conflicting guidance

### Findings

- [x] The derived DAVIS payload is 256×256 even though its upstream raster is 1152×480; treating the bytes as source-resolution produced invalid motion analysis
- [x] Manifest validation rejects missing/unknown derivation fields, v7, mismatched identity rasters, no-op resize, unknown resamplers, and source dimensions above 16,384
- [x] Compact and full reports expose source derivation plus evaluation dimensions and cadence
- [x] Annotated aggregate metrics are byte-identical before and after the schema replacement
- [x] Initial-flow, weak-keyframe, and camera-motion experiments left no production code or alternate policy

### Actions

- [x] Replaced manifest v7 with sole v8 and added an exact frame-derivation owner
- [x] Made report artifacts self-describing for downstream analysis
- [x] Retained the current classical tracker after three complete negative experiments instead of shipping an unproven fallback
- [ ] A learned long-term tracker still requires a permissive deployable model, reproducible export, worker-safe browser runtime, and physical-iPhone timing before adoption

<!-- Evolution: 2026-08-06 | source: source-raster-owned-annotated-evidence | skill: self-improving-agent -->

## Put model-specific quality loss at the model verification boundary

**Confidence**: 0.99
**Category**: learned recovery verification

- Successful inference is not a quality contract. A pinned model check must own feature coverage, geometric support, and final task error independently; otherwise a matcher or postprocessor regression is discovered only by a much more expensive end-to-end replay.
- Do not substitute lower residual for correspondence support. Pruning XFeat from 15 to seven inliers improved isolated anchor error from 7.26 px to 4.60 px while destroying a temporal track's AJ.
- Calibrate descriptor ambiguity with the complete temporal owner. Conventional nearest-neighbour ratio tests are useful research priors, but even a 0.99 gate removed a correspondence needed by real recovery while leaving synthetic hard quality unchanged.
- Remove an unproven matcher branch completely. Preserve the negative thresholds and outcomes as research evidence, then strengthen the boundary that failed to catch them.

## Validation report: XFeat recovery quality ownership

**Date**: 2026-08-06
**Scope**: XFeat transformed fixture, symmetric ambiguity filtering, annotated temporal recovery

### Checks

- [x] Examples compile or run
- [x] Checklists match current repo conventions
- [x] External references still valid
- [x] No duplicated or conflicting guidance

### Findings

- [x] The previous verifier accepted seven inliers because it checked only recovery success and a loose 12 px error ceiling
- [x] Ratio gates at 0.8, 0.95, and 0.99 failed either the model-owned fixture or RGB-Stacking track `1`
- [x] Restoring mutual-nearest matching restores 15 inliers, 7.26 px isolated error, and track `1` AJ `0.2545695990968245`
- [x] The complete annotated aggregate returns exactly to AJ `0.13806473021972454`

### Actions

- [x] Added one exact XFeat verification evidence shape with 500-feature, 15-inlier, and 7.5 px gates
- [x] Added focused rejection tests for every numeric and structural boundary
- [x] Removed every experimental ratio threshold, second-neighbour accumulator, and adversarial matcher test
- [ ] Physical-iPhone cold/warm latency, memory, thermals, orientation stability, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-06 | source: xfeat-recovery-quality-ownership | skill: self-improving-agent -->

## Add domains by failure structure, then compress evidence without weakening it

**Confidence**: 0.99
**Category**: benchmark generalization and fixture infrastructure

- A new benchmark domain must contribute a missing failure structure, not only more frames. Fixed-camera tabletop manipulation adds hands, tiny accessories, record-length disappearances, and foreground/background ambiguity that rendered blocks and cinematic footage do not own.
- Select queries from annotations before replay, then require a positive executable surface. Preserve the ordered rejection trail for high-ranked zero-signal tracks; never turn a zero re-detection result into an accepted zero floor.
- Pin video and annotation archives independently even when current datasets store both in one archive. One uniform component-owned source shape removes inference and naturally supports split datasets.
- Repository cost is a benchmark constraint, but shortening the hard sequence is not the first remedy. Lossless temporal deltas preserve every frame and metric while exploiting the redundancy that independent raw-frame gzip cannot see.
- Make the compact representation the only executable representation. A second raw decoder, compatibility branch, or fallback path doubles corruption and drift surfaces.
- Prove a storage optimization at three boundaries: exact codec unit vectors, exact derived asset hashes and lengths, and unchanged end-to-end quality metrics.

## Validation report: third-domain evidence and temporal delta storage

**Date**: 2026-08-06
**Scope**: Perception Test `video_5032`, manifest v9 source ownership, all annotated frame payloads

### Checks

- [x] Examples compile or run
- [x] Checklists match current repo conventions
- [x] External references still valid
- [x] No duplicated or conflicting guidance

### Findings

- [x] The selected 333-frame real manipulation sample adds 45 tracks and six annotation-first executable queries with disappearances up to 207 frames
- [x] Tracks `41`, `40`, `28`, and `29` produced zero re-detection AJ and were rejected; retained tracks all own positive floors
- [x] The Perception Test video and annotation archives are independently pinned by exact URL, bytes, and SHA-256 under CC-BY-4.0 provenance
- [x] The three-domain replay executes 623 frames and 18 queries at AJ `0.17682167909600022`, occlusion accuracy `0.6807798867906737`, and re-detection AJ `0.0811919143614828`
- [x] Lossless XOR temporal deltas reduce derived assets from 66,912,658 to 42,665,119 bytes while preserving the complete replay exactly

### Actions

- [x] Replaced manifest v8 and the singular archive pin with sole v9 and independent video/annotation source records
- [x] Added the complete Perception Test scene, all annotations, strict derivation, query-owned floors, notices, and release-gate integration
- [x] Replaced raw RGB gzip with one tested in-place temporal-delta decoder across every fixture; no old encoding or fallback remains
- [x] Recorded the zero-signal candidates and the newly exposed false-visible, missed-visible, and latency owners as algorithm targets
- [ ] Physical-iPhone replay latency, memory pressure, thermals, orientation, and WebGL coexistence remain device-owned evidence

<!-- Evolution: 2026-08-06 | source: third-domain-temporal-delta-evidence | skill: self-improving-agent -->
