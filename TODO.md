# Measured improvement backlog

This backlog contains only changes that still have an evidence gap. Production does not carry dormant model adapters, duplicate providers, detector compatibility paths, or migration shims.

## Release gates

Any runtime change must:

- keep npm run validate and npm run test:browser green;
- preserve all capability-asset hashes and declared licenses;
- remain under scripts/verify-build-budget.mjs limits;
- improve the fixed vision quality matrix without creating a new failing scenario;
- keep steady-state tracking at or below 4 ms amortized on the primary iPhone target;
- provide an explicit worker boundary and failure state for heavy CV;
- replace its predecessor completely if adopted.

## P0: expand strict replay coverage

The current annotated gate now owns three independently sourced domains, 623 frames, and 18 first-visible queries. The newly admitted Perception Test scene adds real fixed-camera object manipulation, small rings, hands, a 207-frame disappearance, 900 ms stable recovery latency, 4,467 ms missed visibility, and 5,133 ms false visibility. Combined output is AJ `0.17682167909600022`, occlusion accuracy `0.6807798867906737`, re-detection AJ `0.0811919143614828`, and stable recovery 9/16 eligible events. These values supersede the earlier two-domain counts retained below as historical optimization evidence.

The current classical path passes all 84 strict reports across the fixed planar, curved, occlusion, background, reconstruction-mode, low-light, motion-blur, and rolling-shutter matrix. The repository-owned annotated gate now adds 12 independent first-visible queries across a 250-frame rendered fixture and a 40-frame real-world fixture, split into named primary/motion and occlusion-stress contracts. Each track owns a complete query-specific floor, so a strong trajectory cannot lend spatial or temporal headroom to a weak sibling. The stress set's `0.14335244616777107` average Jaccard and `0.6050870147255689` occlusion accuracy expose the clearest remaining algorithm gap without weakening the primary floors. The same gate now exposes temporal concentration rather than only averages: combined stable re-detection is 6/10 eligible events with `466.6666666666667` ms worst latency, a selected query can remain falsely visible for `1000` ms continuously, the longest visible-target outage is `1833.3333333333333` ms, and the 12 tracks contain 19 acquired-track interruptions (at most three on one query). Those are explicit optimization targets; later correct frames and weak sibling ceilings can no longer hide them. Transactional PnP arbitration, geometry-scoped ORB, and mature-map descriptor validation raise the representative laminated-card benchmark from 7/20 to 12/20 passing reports and cut mean risk from 33.36 to 28.97. The extra mature-map checks raise amortized ORB cost from 0.659 ms to 0.774 ms per frame in that benchmark; LK steady state is unchanged. Bounded and same-transform-cached object-mask projection cuts quick-matrix `landmarkMetricsMs` from 4.743 ms to 0.106 ms without changing any quality report. Full-path storage telemetry attributes 5.130 ms amortized quick-matrix cost to `keyframeStoreMs`, including 5.051 ms of ORB feature extraction across 26.0% of frames; indexed, bit-exact post-processing now cuts the isolated 1,000-feature/96-landmark JS association from 0.789 ms to 0.127 ms and avoids unused descriptor materialization. Same-frame full-image query reuse removes another 44 duplicate storage extractions, equal to 0.346 ms amortized at the measured baseline extraction cost, without changing quality or recovery cadence. Compact native-to-JavaScript ownership now retains only selected 32-byte ORB rows: a typical 22-entry keyframe falls from 32,000 to 704 descriptor bytes and the 96-entry maximum to 3,072 bytes, while adjacent `keyframeStoreMs` falls from 4.561 ms to 4.437 ms with exactly unchanged quick output and extraction count. Exact mapping-to-pose consensus reuse removes 764 of 1,112 duplicate ready-pose evaluations in direct and parametric reconstruction and cuts aggregate `reconstructionUpdateMs` from 8.259 ms to 7.337 ms with numerically identical quick quality. Sharing one regularized affine factorization across the X/Y right-hand sides cuts the same aggregate stage from 7.337 ms to 6.172 ms; allocation-free affine and similarity hypothesis scoring reduces it again to 5.978 ms, and letting the paired solver consume its private normal-matrix workspace reduces it further to 5.446 ms while preserving byte-identical solver and robust-fit corpora plus the complete quick-quality aggregate. Bounding the existing deterministic homography RANSAC at 1,250 iterations preserves the complete quick-quality aggregate while reducing amortized planar pose from 4.442 ms to 4.222 ms and maximum p95 frame processing from 141.052 ms to 125.638 ms in the adjacent Node replay. Inlier-only homography post-processing preserves an exact 60-case result corpus while reducing the fixed 96-correspondence/85-inlier summary from 2.949 to 1.672 microseconds; native and pipeline timing are not claimed. Full ORB extraction remains the dominant storage cost and still requires target-device measurement. Curved and non-convex targets retain their broader recovery model. Mode-scoped handled-mug arbitration now prevents weak, tracker-divergent sparse poses from owning attachment position: on the identical historical 84-report diagnostic quick matrix, mean risk falls from 24.571289 to 24.462903, maximum risk from 60.582978 to 56.911951, and severe cases from one to zero without changing the 45/39 diagnostic split or its failure buckets. Motion-aligned parametric handled-mug recovery then preserves reliable bootstrap position evidence, blocks a marginal just-ready pose from reversing it, and uses its bounded prediction only to recover established landmarks. It changes only that historical mode/object slice: mean matrix risk falls again to 24.230523, maximum risk to 54.006817, and recovered post-occlusion windows rise from 66/84 to 67/84 without changing the diagnostic split, failure buckets, or risk bands. Quick/full overlaps now share canonical axis-derived seeds, so those earlier values remain historical A/B evidence rather than the current quick baseline. The weak-geometry direct mug motion bridge then corrects the canonical worst direct position reversal without adding another CV pass: that intermediate quick triage was 36/84 pass, 48/84 fail, 25.248809 mean risk, and 74/84 recovered occlusion windows. Ready reconstruction maps now reject partial recovery-probation mapping frames while still estimating pose from confirmed points; unfinished maps continue building, and the canonical quick hashes remain exact. Preserve the canonical corpus while extending the evidence surface before adding model weight:

- calibrate thresholds only against the full fixture matrix.
- Improve Perception Test identity loss without relaxing its owners: track `35` remains falsely visible through a 154-frame disappearance, track `3` has a 134-frame visible-target outage, and track `0` needs 27 frames to recover after a 207-frame disappearance. Any change must improve these exact queries while preserving every established synthetic and annotated floor.
- Keep rigid-planar ORB keyframe redundancy translation-invariant: the full planar slice removes 114 of 853 extraction calls with unchanged 77/23 pass/fail and 96/100 recovered windows. Do not extend this invariant to curved or non-convex views; the generalized candidate failed handled-mug recovery.
- Preserve hierarchical phase ownership and at least 95% timing coverage before ranking performance work. The complete production-cadence profile owns 99.10% of update time and identifies intermittent keypoint-map refresh—not the previously apparent planar-pose leader—as the largest display-amortized cost. Physical iPhone evidence remains required before claiming the mobile budget.
- Preserve the accepted prepared, mask-bounded GFTT refresh contract: 188 attempts, 77 successful refreshes, 111 `no-reference-transform` outcomes, 99 evaluated candidate stages, 89 zero-GFTT skips, 77 refresh calls over 4,336,852 pixels in 77 native preparations, 22 reinitialization calls over 1,019,755 pixels in 22 native preparations, 22 actual reinitializations, zero reinitialization failures, 253 ORB keyframe-extraction frames, and deterministic quality SHA-256 `94d44c76c2967ec11c933d1c19d0558bf49e888701382c17d6a595ee4624886e`. Five production-cadence Node runs measure median refresh cost at 0.410 ms/display frame, total update cost at 4.793 ms/display frame, active-update latency at 18.597 ms, median maximum refresh latency at 39.77 ms, two cadence-overage groups, and 98.80% timing ownership. A forced three-pass real-OpenCV profile measures 47.34 ms with repeated setup versus 17.93 ms with one scoped preparation while preserving all 360 ordered corners. Physical-iPhone latency and spikes remain the evidence gap.

## P1: learned recovery device validation

The ORB-first XFeat fallback is shipped from one pinned, permissively licensed model revision. Its real ONNX contract, provenance, hashes, bundle budgets, transformed recovery, failure isolation, and nested-worker execution are release-tested. The model-owned gate requires all 500 requested features, at least 15 recovery inliers, and at most 7.5 px anchor error; a lower isolated error cannot compensate for lost correspondence support. The remaining evidence gap is target hardware, not another desktop matcher bake-off:

- record cold and warm recovery latency in iPhone Safari and Chromium;
- record peak memory and thermal behavior alongside the active WebGL scene;
- repeat recovery before and after portrait/landscape source-dimension changes;
- keep LK steady-state and ORB first unless the same target-device evidence proves a replacement better.
- use the production-cadence benchmark's active latency, display-amortized exclusive cost, and pose-age fields for device comparison; never reconstruct frame cost by adding inclusive parent and child stages.
- record timing coverage and unattributed update time with every device profile; reject bottleneck rankings from materially incomplete ownership.

Do not add another matcher, export path, model adapter, or fallback without beating the fixed recovery corpus and completing those device measurements.

## P1: tap segmentation device validation

The emitted MediaPipe worker, MagicTouch foreground channel, model, loader, WASM, transferable ownership, bounded object mask, and fatal-error retry lifecycle now execute in Chromium and WebKit. The remaining evidence gap is physical target behavior:

- record first-load and warm-selection latency in iPhone Safari and Chromium;
- record peak memory and thermal behavior with OpenCV tracking and the WebGL scene active;
- repeat tap selection and bounded refresh before and after portrait/landscape source-dimension changes;
- keep the 6,000 ms cold-selection and 1,400 ms refresh budgets until target measurements justify stricter limits.

Do not add an inversion heuristic, second segmentation model, model adapter, or main-thread inference path. The pinned model contract has one foreground channel and one worker owner.

## P1: depth provider validation

The shipped Q4 Depth Anything model is 27.4 MB. Its graph contract is tested in Node, while its emitted service, worker, model URL, JSEP runtime, transferable input, normalized output, and WASM fallback execute in the Chromium/WebKit release matrix. Before making depth the default:

- record production-size WebGPU and WASM latency, memory, and thermal behavior on supported iPhones;
- compare depth-fusion accuracy with sparse and parametric reconstruction;
- verify orientation-change stability and WebGPU execution on physical supported devices;
- keep depth optional until it is consistently better within budget.

## P2: local AI profiles

Build published, reproducible server profiles after measuring model quality:

- a small permissive chat/persona model;
- a permissive vision-language model;
- a low-latency local TTS model;
- documented RAM/VRAM, quantization, latency, and model revision.

The browser contract remains keyless and provider-neutral. Model downloads stay outside the web artifact.

## Explicit non-goals

- No class detector in the tap-to-anchor path.
- No browser secrets or proprietary hosted-service SDKs.
- No SAM 2, DUSt3R, VGGT, Gaussian Splatting, or generated 3D model in the live frame loop.
- No silent provider fallback.
- No generated geometry treated as measured pose truth.
- No model adoption based on desktop-only throughput.
