# Vision Reconstruction Feedback Loop

This workflow turns reconstruction quality work into a measured loop:

1. Run the benchmark matrix.
2. Generate the HTML report and insights summary.
3. Pick the weakest subsystem from evidence.
4. Make one targeted improvement.
5. Rerun progressively larger benchmarks.
6. Keep the change only when the measured weak point improves without moving failures elsewhere.

The point is not to make one report. The report is the steering signal for the next engineering pass.

## Benchmark Passes

Use the smallest pass that can answer the current question.

- Quick: fast regression signal after a focused code change.
- Representative: broader object, background, motion, and occlusion coverage before trusting the direction.
- Full: final evidence across all current synthetic conditions.

Representative and full matrices keep motion balanced independently from occlusion. A weak-point row for `fast` should now mean fast motion, not "the subset that also happened to have early or repeated occlusion." Quick keeps the known high-signal stress fixtures while adding matching slow and standard cases so its motion counts stay balanced.

The feedback runner produces three artifacts from the same run:

- Raw benchmark JSON.
- HTML report.
- Markdown insights and fix queue.

The default output location is `docs/vision-benchmark-runs/`.
Full runs also refresh `docs/vision-benchmark-full-report.html` for easy review.

## Reading The Report

Read the report in this order:

1. **Strict pass rate**: tells whether the overall pipeline got better or worse.
2. **Risk bands**: high and severe cases matter more than small average movement.
3. **Mode comparison**: shows whether the selected reconstruction approach is helping or hiding a deeper tracker issue.
4. **Object and geometry weak points**: picks the fixtures for targeted debugging.
5. **Condition weak points**: identifies whether motion, occlusion, background, or lighting is the real stressor.
6. **Performance budget**: reads per-frame processing time first; replay wall time is secondary because frame counts vary by condition. In the stage table, use `Amortized` to find sustained frame cost and `Mean When Run`/`Max` to find rare recovery spikes.
7. **Worst individual replays**: start debugging from these, not from average cases.

The most important field is usually `primaryWeakness`. If every group says `tracking.meanAnchorError`, the next fix belongs in tracking or object ownership, not in dense reconstruction.

## Mapping Weak Points To Systems

### Tracking Spine

Signals:

- `tracking.meanAnchorError` dominates.
- `tracking.maxAnchorError` spikes under fast motion.
- Failures concentrate in early or repeated occlusion.
- Worst cases still report successful tracking.

Work on:

- Object-owned landmark promotion and retirement.
- Mask-constrained keypoint refresh.
- Descriptor/keyframe relocalization.
- Post-occlusion recovery.
- Step limits and smoothing only after the measurement source is correct.

### Object Ownership And Segmentation

Signals:

- Failures cluster by background or lighting.
- Background texture replaces object texture after refresh.
- Clean scenes pass but cluttered scenes fail for the same object.
- Object classes with weak masks fail across modes.

Work on:

- Tap component quality.
- Mask refresh cadence.
- Background landmark rejection.
- Connected-component stability.
- Detector/segmenter class coverage.

### Dense Reconstruction And Depth Fusion

Signals:

- Tracking metrics are acceptable, but reconstruction ready ratio is low.
- Normal error dominates risk.
- Map confidence stays low after enough view change.
- Depth-fusion improves tracking-equivalent cases but does not become ready.

Work on:

- Keyframe gating.
- Depth quality thresholds.
- Surfel merge and temporal residuals.
- Surface normal estimation.
- Pose refinement from confident surfel support.

### Pose Arbitration

Signals:

- Mode risk changes sharply while tracking metrics are similar.
- Failures happen on source transitions.
- Reconstruction or planar pose replaces a stronger object-local source.
- A mode has good average risk but severe outliers.

Work on:

- Candidate scoring.
- Rejection reasons.
- Pose-source continuity.
- Residual thresholds.
- Class-specific source ownership.

### Head Attachment

Signals:

- `headAttachment` is a top failed stage.
- World position or rotation errors spike while tracking and reconstruction look acceptable.
- Source transitions correlate with head jumps.
- Attachment remains visible when the surface is not trustworthy.

Work on:

- Render readiness gates.
- Object-local attachment source checks.
- Surface normal and tangent continuity.
- Hide/fade policy for back-facing or unconstrained attachment.

## Iteration Rules

Use one primary hypothesis per pass. Do not change tracking, reconstruction, and head rendering in the same iteration unless the report clearly shows a shared root cause.

For each iteration:

1. Name the weak point from the report.
2. Name the owning subsystem.
3. Pick the smallest fixture group that reproduces it.
4. Add or update a focused test when the behavior is narrow enough.
5. Change the owning layer.
6. Rerun quick feedback.
7. Rerun representative feedback if quick improves.
8. Rerun full feedback before calling the weak point closed.

Keep a change only when:

- The target weak point improves.
- Severe cases do not increase.
- High + severe cases do not move to another mode or object family.
- Existing curated quality stays green.
- Runtime-sensitive work still fits the mobile frame budget.
- Missing runtime samples are reported as invalid instead of being counted as `0ms`.

## Current Baseline Interpretation

The full benchmark from June 17, 2026 showed:

- Depth fusion is the best current advanced mode by mean risk and severe-case avoidance.
- Tracking is the main bottleneck across all modes.
- Fast motion plus early or repeated occlusion is the most damaging condition.
- Handled mugs, laminated cards, label bottles, balls, cups, and rigid boxes are the most useful regression targets.
- Background and lighting differences matter, but less than object geometry and motion.

That means the next improvement pass should start with tracking and object ownership, then rerun the loop before tuning dense fusion internals.
