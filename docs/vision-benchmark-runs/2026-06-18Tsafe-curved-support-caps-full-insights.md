# Vision Reconstruction Feedback Loop Insights

## Run

- Matrix: full
- Scenarios: 300
- Replays: 1,200
- Strict pass rate: 42.75%
- Strict failures: 687
- Mean risk: 31.36
- High + severe risk: 329
- Severe risk: 10

## Conclusions

- Strongest mode: depth-fusion with 29.43 mean risk, 154 strict failures, and 0 severe cases.
- Weakest mode: sparse-reconstruction with 33.36 mean risk, 174 strict failures, and 5 severe cases.
- Weakest object: handled-mug has 90 strict failures (90%), 5 severe cases, and 41.29 mean risk.
- Weakest motion profile: fast has 316 strict failures (65.83%), 9 severe cases, and 34.57 mean risk.
- Weakest occlusion profile: early has 164 strict failures (68.33%), 6 severe cases, and 35.66 mean risk.
- Weakest background: shelf has 141 strict failures (58.75%), 2 severe cases, and 31.73 mean risk.
- Worst replay: laminated-card / busy / fast / early / sparse-reconstruction; primary weakness is tracking.meanAnchorError.

## Fix Queue

1. Tracking spine: reduce tracking.meanAnchorError in the worst fast-motion and occlusion cases before adding more dense reconstruction complexity.
2. Object ownership: inspect mask refresh, object-owned landmark promotion, and background rejection for handled-mug.
3. Recovery: improve post-occlusion correspondence recovery for early occlusion and fast motion.
4. Reconstruction readiness: rerun targeted checks where reconstruction fails after tracking changes, because map readiness often follows anchor stability.
5. Head attachment: only tune render gates when headAttachment is a top failed stage; current failures are mainly upstream.

## Next Iteration Rule

Run a quick loop after every targeted code change, run the representative loop when quick risk improves without regressions, and run the full loop before declaring the weak point closed.
