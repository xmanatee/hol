# Vision benchmark workflow

Use the smallest matrix that reproduces the issue:

```bash
npm run vision:feedback:quick
npm run vision:feedback:hard
npm run vision:feedback
npm run vision:feedback:full
```

Quick checks production cadence; hard adds compound capture degradation, complete disappearance, a distractor, and distant re-entry. The default representative and full matrices broaden coverage. Results are JSON and HTML under `artifacts/vision-benchmarks/`; `--out-dir` and `--label` select a destination and run name.

Read coverage before scores: filters and motion/occlusion balance determine what was exercised. Separate strict product targets from regression floors; a passing regression contract does not mean the app is reliable on arbitrary objects.

| Evidence                                                 | Likely owner                                       |
| -------------------------------------------------------- | -------------------------------------------------- |
| Anchor drift, false locks, slow re-entry                 | Landmark ownership, masks, tracking/relocalization |
| Tracking stable but map readiness or normal quality poor | Reconstruction/depth                               |
| Jumps when pose source changes                           | Pose arbitration and reference ownership           |
| Geometry accepted but face misplaced or wrongly visible  | Attachment projection and render readiness         |

For each change, reproduce one failure, fix its owning layer, then expand validation. Retain it only if the target improves without moving failures into another query, object family, or mode. Tracking/recovery changes need hard and annotated replay as well as the curated quality matrix.

For timing, separate active-update latency, display-amortized cost, queue/delivery age, and rare spikes. Rank exclusive stage cost; adding parent envelopes to child timings double-counts work. Missing samples are not zero-cost samples. Desktop replay can reject a change but cannot certify mobile latency, memory, or thermals.

See [experiment protocols](vision-experimentation.md), [open work](../TODO.md), and [release verification](../README.md#verification). Raw measurements belong in artifacts; this document is not a run log.
