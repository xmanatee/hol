<!-- Evolution: 2026-08-04 | source: implementation-review | skill: self-improving-agent -->

# Runtime contract patterns

## Cross-layer enums and required fields need one owner

**Confidence**: 0.95
**Category**: boundary validation

- A strict provider schema is not sufficient when downstream hooks and lazy clients reintroduce defaults for the same required fields.
- Publish shared enum values and normalization from one dependency-neutral contract module. API schemas, prompts, lazy loaders, and runtime clients must consume that owner instead of copying lists or inventing fallback values.
- Validate before lazy imports, audio initialization, or network work so malformed commands fail without paying runtime cost.
- Cancellation and disposal outcomes may return an explicit inactive result. A live request with missing or unsupported contract data must throw before work begins.

## Do not shadow browser performance globals

**Confidence**: 0.98
**Category**: JavaScript runtime correctness

- Avoid local identifiers such as `performance`, `window`, `document`, `navigator`, or `location` in browser runtime modules.
- Use domain-qualified names such as `speechPerformance`; otherwise a valid refactor can replace `performance.now()` with a lookup on an unrelated local object.
- Run the focused runtime tests immediately after introducing shared domain objects, before expanding validation to the full suite.

## Validation report

**Date**: 2026-08-04
**Scope**: object-performance schema and speech boundaries

### Checks

- [x] Focused AI, schema, lazy-client, and TTS examples run
- [x] Guidance matches the repository's fail-fast boundary policy
- [x] Canonical enums replace duplicated prompt/schema values
- [x] No fallback delivery profile or compatibility path remains

### Findings

- Focused tests caught browser-global shadowing before build or release validation.
- A normalized speech command now has exactly one supported style and one non-empty delivery direction.

### Actions

- Keep provider schema enums, prompt text, and speech validation sourced from `objectPerformance.js`.
- Reject future defaults added to `synthesizeSpeech` or `buildSpeechInstructions` signatures.

<!-- Evolution: 2026-08-04 | source: implementation-review | skill: self-improving-agent -->

## Keep frame-rate telemetry out of owner React state

**Confidence**: 0.97
**Category**: rendering performance

- Separate lifecycle state from telemetry: transitions such as loading, ready, playing, and error belong in React state; audio spectra, microphone samples, worker timing, and debug metrics do not.
- Let runtime consumers read high-cadence values directly from the owning service inside their frame loop. UI-only telemetry belongs in stable external stores, subscribed only by the smallest mounted leaf with `useSyncExternalStore`.
- Stores should retain the latest value when no consumer is mounted. Scheduled publication must stop when the last UI subscriber leaves, so a closed diagnostics panel has no timer or render cost.
- Reset every store explicitly on stop, error, resource replacement, and disposal. Removing a value from React state must not weaken lifecycle ownership.
- Audit the whole event path whenever one frame-driven setter is found: animation/audio callbacks, video-frame callbacks, worker listeners, and diagnostic polling often repeat the same root-render defect.

### Applied evidence

- HUD metrics publish only while the System panel is mounted.
- Microphone telemetry updates only the Voice telemetry leaf.
- The R3F lip-sync frame reads TTS analyser data directly instead of running a second RAF or updating `CameraView`.
- Depth-worker results update the Anchor diagnostics leaf and remain directly readable by the CV runtime.

### Validation

- [x] Store contracts cover deduplication, subscriber removal, latest-value retention, and reset.
- [x] Static event-source scan leaves no frame-rate telemetry setter in root React state.
- [x] Full release gate passes 831 unit, contract, model, and real OpenCV replay tests.
- [x] Mobile browser matrix passes 30 tests with 10 intentional WebKit fake-camera skips.

<!-- Evolution: 2026-08-04 | source: implementation-review | skill: self-improving-agent -->

## Frame owners should own sampling and reusable scratch state

**Confidence**: 0.96
**Category**: hot-path performance

- If rendering consumes an analyser, sensor, or pose sample once per frame, the render loop should pull that sample. A second RAF creates redundant scheduling, phase drift, intermediate publication, and teardown state.
- Web APIs that write into caller-provided typed arrays should keep those arrays for the resource lifetime. Summaries should be written into stable numeric records instead of copying raw buffers into new arrays.
- Resolve string names, semantic pairs, and rig indices during initialization or rare profile changes. Frame loops should operate on numeric indices only.
- Frame helpers should accept caller-owned output objects when a fresh return value would be immediately copied into another mutable runtime object.
- Preserve behavior with structural tests: stable result identity, no autonomous scheduler, no frame-time name resolution, explicit teardown reset, and exact animation regressions.

### Applied evidence

- TTS analysis is sampled by R3F from a stable `Uint8Array` and stable `{ energy, centroid }` record.
- Viseme smoothing uses a fixed ring buffer without per-frame counting dictionaries.
- Morph animation pre-resolves blink, bilateral, rest, expression, and accent targets.
- Eye-gaze math writes into the existing Three.js Euler instead of returning per-eye objects.
- Local microbenchmarks reduced 100k frequency summaries from 188.8 ms to 13.2 ms and 50k morph frames from 148.8 ms to 9.9 ms on the same runtime.

### Validation

- [x] Focused audio, morph, gaze, camera-lifecycle, and telemetry contracts pass 59 tests.
- [x] Static scans find no legacy audio-analysis store, callback publication, autonomous TTS RAF, or raw-spectrum copy.
- [x] Full release gate passes 831 unit, contract, model, and real OpenCV replay tests with zero dependency vulnerabilities.
- [x] Mobile browser matrix passes 30 tests with 10 intentional WebKit fake-camera skips.

<!-- Evolution: 2026-08-05 | source: bounded-report-ownership | skill: self-improving-agent -->

## Project before serializing diagnostic summaries

**Confidence**: 0.97
**Category**: CI observability and performance

- A `summary` flag must define a smaller data projection, not merely remove one obvious array while retaining nested full reports and grouped diagnostics.
- Build the console projection before `JSON.stringify`. Serializing the full object and discarding the string reduces visible output but keeps the allocation, traversal, and process-I/O preparation cost.
- Console summaries should retain decision evidence: aggregate outcome, failing boundaries, recovery/safety results, workload cadence, top bottlenecks, and exact contract mismatches.
- Complete reports belong behind one explicit artifact path. The artifact contains the full validated object; stdout reports its location and small aggregate so automation and humans have distinct stable owners.
- Test non-observation as well as shape. An enumerable throwing getter in discarded detail proves summary formatting never traverses the full payload.
- Measure bytes and lines on the real canonical run. Fixture-only size assertions prevent accidental inclusion but cannot establish the reduction of production-shaped nested data.

## Validation report: bounded report ownership

**Date**: 2026-08-05
**Scope**: quality and benchmark console projection, explicit JSON artifacts, release logs

- [x] Examples compile and run through 954/954 source tests
- [x] Guidance matches the repository's strict CLI and explicit-artifact conventions
- [x] Primary Node process-I/O, Google Benchmark output, and GitHub artifact references remain valid
- [x] No duplicate reporter, compatibility flag, migration path, or conflicting output owner remains
- [x] Canonical quality, quick hash/cadence, and hard safety contracts remain exact
- [x] Combined release vision JSON falls 99.51% in bytes and 99.38% in lines
- [x] Annotated TAP-Vid and production Chromium/WebKit results remain unchanged

## Treat arbitrary runtime text as a layout and bidi boundary

**Confidence**: 0.97
**Category**: accessible UI contracts

- Provider errors, model output, asset names, logger tags, and diagnostic reasons are untrusted layout inputs even when their semantic schemas are strict. A bounded character count does not prevent an uninterrupted token from expanding min-content width.
- Give inserted text one shared owner: automatic base direction, directional isolation, zero minimum size inside flex/grid, and arbitrary wrapping only when ordinary line-break opportunities are unavailable.
- Use logical alignment for direction-sensitive values. A hard-coded right alignment preserves an English visual convention but is not a bidirectional layout contract.
- Do not truncate diagnostic evidence unless the same surface provides an explicit way to reveal the full value. A vertically scrollable diagnostic drawer should wrap complete values instead.
- Axe and ordinary viewport checks do not prove reflow. Exercise the production DOM at 320 CSS pixels with enlarged text and an uninterrupted RTL-first token; assert computed style and the scroll-width delta of every owning container.
- A test locator must not depend on text that the test intentionally replaces. Resolve the element before mutation or perform the mutation and computed-style read in the same evaluation.

## Validation report: direction-aware diagnostic reflow

**Date**: 2026-08-05
**Scope**: dynamic field-control text, WCAG reflow, bidirectional rendering, production browser layout

### Checks

- [x] Examples compile and run through the complete validation and production-browser suites
- [x] The checklist matches the repository's shared-primitive and fail-fast browser-test conventions
- [x] W3C WCAG reflow/C33, CSSWG `overflow-wrap`, and WHATWG/W3C directionality references remain valid
- [x] No duplicate wrapping primitive, truncation fallback, compatibility path, migration, or test-only production route remains

### Findings

- [x] The original diagnostic value failed the new contract because it inherited LTR and had no long-token wrap opportunity
- [x] The accepted 320 CSS pixel, 200% text stress case has zero document, drawer, and panel horizontal overflow
- [x] Diagnostics use logical end alignment; runtime labels and values compute RTL from an RTL-first token
- [x] Full validation passes, and the production browser matrix executes 35 tests with 13 intentional platform-policy skips

### Actions

- [x] Centralized runtime text in `DynamicText` and removed metric/mesh truncation
- [x] Applied the boundary to diagnostics, readiness, metrics, logs, mesh names, voice errors, and persona output
- [ ] Keep physical iPhone Safari text zoom and Dynamic Type behavior in the target-device acceptance pass

<!-- Evolution: 2026-08-05 | source: direction-aware-diagnostic-reflow | skill: self-improving-agent -->
