# HOL (High on Life)

HOL is a mobile-first, privacy-preserving camera app. Point at an object, wait for its green highlight, then tap to attach an animated talking face. Discovery and object-owned landmark tracking start before selection; tapping commits the prepared object without rebuilding its map.

The default camera and animation path is fully local. Object-pose tracking is the phone-demo default; reconstruction modes are explicit experiments, not an automatic quality upgrade. Optional object understanding, persona generation, and speech use keyless OpenAI-compatible HTTP contracts pointed at infrastructure you control.

## Runtime architecture

| Capability       | Activation                                                                                                                                                     | Runtime                                                             | Asset                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| Tracking         | Active camera                                                                                                                                                  | ES-module anchor worker, OpenCV 4.9, Shi-Tomasi + LK + ORB recovery | 10.3 MB embedded-WASM runtime      |
| Selection        | Active-camera discovery and bounded refresh                                                                                                                    | Nested ES-module MediaPipe Interactive Segmenter worker             | 18.0 MB MagicTouch model           |
| Learned recovery | Tap-time for proven planes, or a bounded initial/mature memory from an unknown/generic target's first and third accepted ORB keyframes; only after ORB failure | Dedicated XFeat worker + ONNX Runtime Web, single-threaded WASM     | 2.8 MB model + 13.5 MB runtime     |
| Depth            | Depth-fusion mode only                                                                                                                                         | ONNX Runtime Web, declared WebGPU+WASM or WASM execution plan       | 27.4 MB Depth Anything V2 Small Q4 |
| Face             | Stable anchor only                                                                                                                                             | React Three Fiber + Three.js + Meshopt                              | 375 KB GLB, 52 facial targets      |

src/runtime/capabilityPacks.js is the single runtime manifest. It declares activation, performance budget, source, license, revision, byte size, SHA-256, and I/O contract for every first-party binary asset. Each immutable record owns one direct URL export; runtime leaves import only those URLs, while cache and release tooling compose the complete packs from the same records. This lets Vite remove unrelated provenance metadata from worker bundles without duplicating asset declarations. Vite emits content-hashed production URLs, and a serialized 144 MiB/16-entry service-worker cache keeps the corresponding immutable assets; quota or cache-backend failure never replaces a successful network response.

Every request/response CV worker uses one bounded request registry. A missed deadline rejects the exact request, cancels sibling deadlines, retires the worker immediately, and makes the next attempt construct a clean runtime; cold model initialization has a separate budget from steady inference.

A failed discovery dependency is a runtime error, not evidence that no object exists. It stops discovery until an explicit camera restart. Both selection and face visibility require an observation at most 300 ms old; the renderer schedules expiry even when the camera stops delivering frames. Selection names the displayed candidate and is checked again at worker commit, including queue delay; page and worker timestamps are translated using their `performance.timeOrigin`, never compared as unrelated relative clocks. Mask-only refreshes cannot renew tracking continuity, and a changed tracking mode requires fresh preparation evidence without changing the object's identity. Losing visibility hides the face without discarding its identity or remounting its renderer.

The frame path is deliberately classical and cheap:

1. A user gesture starts the rear camera.
2. The browser compositor presents the video directly. `requestVideoFrameCallback` supplies newly presented frames with backpressure, while the transparent 2D canvas contains diagnostics only.
3. One private capture canvas reads pixels only for admitted scheduled CV work (15 Hz maximum, one frame in flight). With no candidate, discovery attempts are spaced by at least 750 ms. CV pixels stay in native sensor coordinates; display mirroring, pointer inversion, and WebGL projection share one explicit transform at their boundaries. A tap sends only selection metadata. Persona generation captures a separate current image only after its service configuration and selected-object ownership are verified.
4. The anchor worker owns full-resolution masks and CV buffers. `ObjectObservationSession` owns the discovered subject, freshness, continuous-observation readiness, focus release, and explicit selection. The manager owns segmentation and tracking, and waits for each RGB frame's requested mask refresh before releasing its transaction. Only interactive object masks can become candidates; tap-local provisional support cannot become green. Selection requires three successful updates spanning at least 180 ms, underlying face readiness, a sample at most 300 ms old, and a tap inside the current object mask. An unselected object leaving the center is released after 700 ms; a selected identity is retained for recovery. Worker initialization is single-flight and generation-bound; every mutation is FIFO. UI messages contain compact snapshots only.
5. LK handles normal motion. Pose availability and target presence are separate contracts: a short pose hold can preserve internal continuity, but it immediately hides the overlay. After the bounded LK failure budget, the target enters `lost`; `degraded` gets one local evidence attempt and enters `lost` immediately if it fails, so local templates cannot create an identity lock or an endless hold loop. Re-entry from `lost` requires image-wide ORB relocalization. XFeat is consulted only after ORB fails: immediately for conservatively proven planes, or after normal tracking has produced accepted mature ORB evidence for an unknown/generic free tap. Those targets retain at most two learned views: the initial accepted keyframe and the third accepted keyframe. One query extraction is matched against each view independently, and the strongest valid geometry wins; a rejected extension cannot discard the initial view. Known curved classes retain their class-specific recovery. ORB runs on every admitted recovery update; XFeat is limited to every second failed-ORB update. Global and learned recovery require at least eight descriptor inliers and eight restored landmarks (local ORB continuity requires five); a verified match atomically reseeds position, scale, and rotation filters in its absolute coordinate frame.
6. The optional depth runtime is generation-bound from lazy page import through result publication. It shares the anchor/XFeat FIFO command handler; transport, deadline, and model errors retire it until explicit reinitialization. Estimates return a newly computed frame or `null`, never a cached map for skipped work. Each request carries its camera capture timestamp. The anchor worker retains one source RGB/mask/pose-fit snapshot while tracking continues; returned depth is fused against that source, never the latest RGB or pose. Reference changes and failures release the snapshot; missing sources and raster mismatches explicitly reject fusion. The latest-value mailbox delivers each inferred frame at most once, and fusion rejects duplicate or older timestamps. Depth buffers transfer directly into the anchor worker; source RGB/mask copies are made only for accepted depth requests, not every tracking update.
7. Sparse, parametric, photometric, or depth-assisted reconstruction produces explicit pose candidates. Mode changes await a real engine within the worker's FIFO transaction; depth code remains lazy-loaded. A failed import retires vision with an explicit restart action, rather than leaving a placeholder engine loading. The image-anchor service owns the current mode; recovery and UI snapshots derive it from that same source.
8. A pure arbiter selects position, attachment transform, and overlay ownership.
9. The lazy Three.js scene mounts only after a prepared object is selected, remains owned across transient pose dropouts, and renders on demand. When both position and orientation belong to an accepted planar PnP pose, the renderer consumes its full rotation/translation and the same camera intrinsics, including cover crop and mirroring. A depth-only local plane clips a bounded emergence animation. This is a reference-pixel local planar attachment with estimated intrinsics, not metric world tracking or whole-object occlusion. Other accepted surface estimates retain screen-position/normal presentation; a cylinder/ellipsoid estimate does not claim a full rigid pose. Continuous frames exist only for bounded presentation motion, emergence, or microphone/TTS animation. The same R3F frame pulls one analyser sample into reusable buffers.
10. The camera shell retains a four-field anchor status; the lazy diagnostic drawer reads richer anchor, depth, and voice state from their existing owners. System displays capture FPS and camera frame cost as one cached snapshot, published at most every 100 ms while subscribed and cleared to unavailable when the camera becomes inactive. Only System collects runtime readiness, releasing its temporary WebGL probe context. Dynamic values share direction-aware, long-token-safe text. One dialog owns focus, close, and Escape across loading, error, and ready states; selected-tab state survives close/reopen, and close returns focus to the HUD trigger. Drawer and 3D failures show their cause without replacing the camera session. Recovery from a failed lazy render requires an explicit app reload.

## Local development

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Camera access on iPhone requires a secure context. Use a trusted local certificate or HTTPS tunnel. To expose Vite to the LAN, pass --host 0.0.0.0 and terminate TLS in front of it.

## Android phone demo

Use current Chrome. Defaults are rear camera, ideal 960×540 at 30 FPS, bounded 15 Hz tracking, object-pose attachment, and rendering capped at 1.5× pixel ratio; depth inference and debug drawing stay off. Start with one well-lit, matte, textured object (for example printed packaging), centered and filling roughly half the view. Wait for green, tap once, and move slowly. Blank/glossy surfaces, rapid turns, occlusion, and large viewpoint changes remain difficult tracking cases.

For a private USB demo without installing a phone certificate:

1. Connect Android to the computer, enable USB debugging, and authorize the computer on the phone.
2. Run `npm run build` and `npm run preview` here.
3. In desktop Chrome, open `chrome://inspect/#devices`, enable USB discovery, and forward device port `4274` to `127.0.0.1:4274` using **Port forwarding**.
4. On the phone, open `http://localhost:4274`, tap Start Camera, and allow rear-camera access. Loopback is a trusted camera origin. For untethered use, serve the production build over trusted HTTPS; a plain HTTP LAN address is not sufficient.

The microphone button requests microphone access separately and animates the face from your voice, entirely locally. It does not transcribe or provide conversational replies. Object-generated greetings require the self-hosted vision/personality and TTS configuration below; without it, the app explicitly shows setup status and does not attempt model requests or capture a persona image. Configuration is not a provider-health check. Device-specific camera/GPU performance still needs physical-phone validation.

## Optional local AI and speech

Copy .env.example to .env.local and point VITE_LOCAL_AI_BASE_URL at an OpenAI-compatible /v1 endpoint. No browser API key or Authorization header is used.

Recommended open-source layouts:

- LocalAI for one endpoint that can serve chat, vision, and POST /audio/speech.
- llama.cpp for chat/persona generation, paired with a speech-compatible service.
- sherpa-onnx or a LocalAI speech backend for local TTS.

Models are not bundled because device memory and hardware vary. Configure an Apache-2.0 or similarly permissive model that your server and hardware support. Use separate VITE_LOCAL_AI_PERSONA_MODEL, VITE_LOCAL_AI_VISION_MODEL, and VITE_LOCAL_AI_TTS_MODEL values when one model cannot cover every capability.

The camera, tracking, reconstruction, face, and microphone lip-sync paths work without optional services.

Discovery currently prepares one object around the camera center, not every visible instance. Segmentation uses bounded point-prompt inference plus geometric mask propagation; it is not a temporal-memory segmentation model. Full planar presentation is restricted to the original uninterrupted tracking reference: support refresh cannot resize the face's reference footprint, and reference reinitialization or relocalization withdraws that capability rather than silently changing its coordinate frame. Remaining surface estimates use approximate presentation. WebGPU remains available through the existing depth backend; neither WebGPU segmentation nor a WebGPU renderer is claimed by this change.

Personality and speech implementations remain lazy until their first generation or synthesis request. Listener registration, camera startup, vision tracking, and idle diagnostics do not load the optional personality crop, schema, vision, or LLM stack. A camera-session generation owns each lazy load, so clearing an object retires queued personality work, disposal wins an unfinished import, and a rejected chunk load clears only its single-flight promise so a later request can retry. Identical speech commands submitted across their cold-load boundary share one operation; different utterances retain newest-wins behavior. Camera-session disposal remains terminal across module loading, `AudioContext` initialization/resume, provider transport, and decoding.

Personality generation is owned by the current camera session, exact request, and active-anchor identity. One `AbortSignal` spans the keyless LocalAI transport, vision identification, and persona generation. Every chat, vision, and speech request also has one configurable 60-second deadline covering both transport and response-body consumption. A newer request, anchor clear, deadline, or session disposal aborts the owned fetch and deterministically settles the caller even if an injected transport ignores its signal; completed requests remove their abort listener and timer. Native stream piping cancels and unlocks retired response bodies, including responses arriving after cancellation. Non-JSON provider errors cancel their unread bodies. Every post-await speech continuation revalidates both request and anchor before publishing feedback.

Object-vision crops use one clipped `ImageBitmap` operation, preserve edge-region aspect ratio, and downsample the long edge to the open-model-friendly 896-pixel input budget before JPEG encoding. The source `ImageData`, crop geometry, media type, and encoded byte size are strict boundaries; cancellation retires bitmap creation or JPEG encoding without leaking native bitmap or canvas storage.

Persona generation and speech share one object-performance contract for voice-style enums, required emotional delivery, Unicode-aware string budgets, exact persona collection sizes, and bounded vision collections. The limits are published to the model schema and prompt, then enforced again before publication; malformed Unicode, oversized model output, and oversized speech input fail before runtime or network work. OCR-derived observation strings remain explicitly marked as untrusted JSON evidence when passed from vision to persona generation. The personality UI uses direction-aware, unbreakable-text-safe rendering, and no speech layer invents a default style or substitutes personality tone for missing delivery direction.

## Verification

```bash
npm test
npm run test:vision
npm run vision:quality
npm run vision:benchmark:quick
npm run vision:benchmark:hard
npm run verify:vision
npm run test:vision:annotated
npm run vision:experiments
npm run vision:probes
npm run validate
npm run verify:release
npx playwright install chromium webkit
npm run test:browser
```

`vision:experiments` compares real CPU/WASM and WebGL point-segmentation delegates on identical hash-pinned probes, with raw latency/quality observations and explicit backend failures. `vision:probes` exports the same RGBA/label bytes for native experiments. Neither command certifies temporal tracking or physical-iPhone performance. See [the experiment protocol, model/license comparison, and open validation gaps](docs/vision-experimentation.md).

`verify:vision` is the cross-protocol release gate: it requires the complete 84-scenario per-update quality matrix, the exact quick cadence contract, the hard full-loss/distractor/re-entry safety contract, and the repository-owned annotated TAP-Vid replay. `verify:release` owns that gate in addition to lint, unit/CV regressions, asset hashes, real ONNX inference, GLB morph targets, production asset integrity, per-owner raw bundle budgets, aggregate startup JavaScript across the entry and every module preload, deferred-asset preload exclusions, anchor-flow architecture, CycloneDX SBOM licenses, and npm high-severity advisories. `test:browser` first creates a fresh production build, then verifies the mobile shell, camera lifecycle, field-control drawer and local-AI transport network deferral, temporary WebGL readiness-context release, service-worker registration, WCAG 2 A/AA and keyboard interaction paths, 320 CSS pixel reflow with 200% text and a long bidirectional runtime token, OpenCV LK calibration, the complete tap-to-segmentation-to-tracking worker graph, transformed XFeat recovery, and real depth inference through the emitted services, workers, runtimes, and model assets in Chromium and WebKit.

The XFeat asset verifier owns recovery quality, not only successful ONNX execution. Its pinned transformed fixture must produce all 500 requested features, at least 15 geometrically consistent recovery inliers, and no more than 7.5 px anchor error. Model, preprocessing, matching, or postprocessing changes therefore fail at the learned-recovery boundary before the more expensive temporal replay has to expose the same loss.

Release vision commands keep stdout bounded to decision-critical aggregates, failing-stage evidence, recovery, cadence, bottlenecks, and contract mismatches. Append `-- --output=/absolute/path/report.json` to `vision:quality`, a synthetic benchmark command, or `test:vision:annotated` when a complete JSON artifact is required; detailed payloads are serialized only for that explicit artifact.

The vision commands deliberately use two protocols. `vision:quality` runs every generated update and owns deterministic algorithm regression thresholds. `vision:benchmark`, `vision:report`, and `vision:debug` reproduce the production 15 Hz tracking admission policy on a 30 Hz source timeline while evaluating the bounded constant-velocity presentation used by the 60 Hz overlay. Presentation motion is derived from consecutive capture timestamps, limited to one tracking interval, and capped by both speed and per-frame displacement; target loss resets it. The hard matrix includes a fully absent target, a feature-rich but independently printed distractor, and a distant blurred re-entry; confirmed false locks are evaluated on admitted CV updates. Performance output separates admitted-update latency, presentation-prediction cost, 60 Hz display-amortized cost, pose age, exclusive stage ownership, timing coverage, and unattributed time; parent envelopes are not added to their children. The canonical quick benchmark also enforces exact refresh and reinitialization GFTT call, processed-pixel, and native-preparation counts, candidate-stage ownership, and ORB and learned-relocalization cadence, so an optimization cannot silently shift recovery work or recreate per-pass buffers. This makes the benchmark representative without silently changing the established per-update regression corpus or presenting a partially attributed profile as a complete bottleneck ranking.

`test:vision:annotated` is a mandatory repository-owned external-evidence protocol. It pins three complementary domains: the 250-frame rendered TAP-Vid RGB-Stacking sample, the 40-frame live-action/CGI TAP-Vid-DAVIS `shooting` scene from _Tears of Steel_, and all 333 frames of Perception Test `video_5032`, a real fixed-camera object-packing scene with hands, small objects, and long disappearances. Complete upstream video and annotation archives and every derived asset own exact SHA-256 and byte-length pins. Provenance is separately machine-validated for video and annotations, so mixed-source licenses cannot be collapsed into an inaccurate fixture-wide declaration. Across six disjoint query sets, 18 independently replayed tracks each own a complete contract; no synthetic fixture, aggregate, or sibling track can lend headroom to a real-world failure.

The runner rejects unknown fields, vacuous spatial floors, invalid temporal bounds, duplicate query ownership, unapproved component licenses, path collisions, and ambiguous frame derivations; caps fixture/query-set/query/file/decompressed sizes before allocation; validates source-to-evaluation raster semantics and visible coordinates; replays every query through the default sparse tracker at the production 15 Hz admission rate; and computes the official 1/2/4/8/16 px threshold, Jaccard, and occlusion metrics on a 256 px evaluation raster. Re-detection contracts are discriminated by evidence: `not-applicable` requires no post-query reappearance, `segment-only` requires a measurable post-reappearance segment but no 100 ms stable window, and `eligible` gates Re-Detection Average Jaccard plus stable recall and latency. Every variant also gates p95 visible error, uninterrupted false visibility, uninterrupted missed visibility, and fragmentation at its actual owner. Durations are normalized from each pinned frame rate. Reports preserve the validated source raster and derivation alongside visibility confusion, stable events, missed-visible streaks, tracker/readiness ownership, recovery attempts, inliers, matches, and keyframe coverage.

The 42,665,119-byte fixture pack lives under `tests/fixtures/annotated-vision`, outside both `src/` and `public/`, and therefore cannot enter the Vite production graph. Manifest v9 has one strict source shape with independent archive pins and one lossless `rgb24-xor-delta-gzip` frame encoding. The first frame is exact RGB24 and later frames are exact XOR deltas against the preceding decoded frame; bounded in-place reconstruction avoids a video decoder and reduces the complete three-domain pack by 24,247,539 bytes versus independently gzipped raw RGB. Its source, transformation, license, and regeneration constraints are documented beside the fixture. There is no downloader, environment override, cache fallback, compatibility parser, old frame decoder, or missing-data skip: deletion, corruption, provenance drift, metric regression, or a non-approved component license fails `verify:vision` and therefore `verify:release` and CI.

```bash
npm run test:vision:annotated
```

Successful stdout is a bounded decision summary. Append `-- --output=/absolute/path/report.json` to persist the complete replay evidence. No Python, video codec, model, network request, or additional npm dependency is used by evaluation.

Low LK retention remains a tracking failure; it is never converted into a higher success percentage. When at least ten accepted, object-owned tracks still form a spatially broad robust similarity consensus, the tracker publishes that evidence separately. Only the selected parametric-surface mode with a previously present, mature curved reconstruction map may admit it for one frame, and the current object mask must still retain at least eight owned landmarks. Every other mode, a prior failure, planar target, lost target, weak map, incoherent flow, excessive residual, scale, or rotation continues through global recovery. Ordinary support correction and keypoint reinitialization share one frame-start displacement envelope, so late recovery work cannot bypass the same-frame motion bound. The sole absolute-reset exception is the independently corroborated generic free-tap recovery described below.

Sparse reconstruction with a non-planar target-surface prior may initialize from three admitted views only when interrupted visibility makes partially observed landmarks necessary to reach the original spatial floor. A fully observed stream waits for a fourth view. The fast path requires at least two observations per landmark, a rank-3 measurement matrix, and a three-to-four eigenvalue gap of at least 4×. Weak, noisy, undersupported, or needlessly early triples remain in mapping; from the fourth view onward the original four-observation support floor applies. Generic reconstruction without a target-surface prior keeps its six-view policy.

When a generic free-tap target loses its local keypoint reference during support recovery, reinitialization may use the current object-wide similarity transform as an absolute anchor only when the fresh interactive mask independently agrees with it. The tracker must retain at least eight inliers, mask and tracker anchors must agree within 6% of object extent (clamped to 6–14 px), and the filtered anchor must be more than two ordinary bounded updates behind. Known cans, bottles, cups, and mugs retain their class-specific bounded recovery; stale motion, a weak or tap-local mask, insufficient lag, or cue disagreement cannot select the absolute path.

Periodic ORB keyframes retain full-frame detector and pyramid evidence. Before invoking ORB, storage compares mature object-owned landmarks with the latest keyframe. Sparse general views use a strict 4 px absolute-motion boundary; views supported by at least 13 shared landmarks may reject motion below 5 px. Proven rigid-planar targets instead subtract median common translation and retain a separate 4 px residual-deformation boundary. Rotation, perspective change, landmark turnover, and the initial keyframes still reach extraction. The branches own independent boundaries so rich-view or planar tuning cannot silently weaken sparse curved recovery evidence.

## Performance policy

The 60 FPS frame budget is 16.67 ms:

- tracking/CV: at most 4 ms amortized;
- OpenCV work: at most 6 ms;
- R3F render plus lip-sync: at most 6 ms;
- safety margin: at least 4 ms.

Discovery segmentation, XFeat warm-up, XFeat recovery, and depth inference are worker-owned tasks outside the steady-state frame path. XFeat runs in a dedicated nested worker, warms immediately only for conservatively proven planes and otherwise builds a bounded initial/mature two-view memory from accepted unknown/generic ORB keyframes; it never replaces a valid ORB recovery. Known curved classes retain their class-specific paths. Learned inference runs on at most every second admitted failed-ORB update. Both reference storage and recovery queries transfer adapter-owned frame copies so tracking, same-frame segmentation and depth fusion retain the live RGB buffer. See docs/vision-quality-roadmap.md.

Synthetic Node timing can identify ownership and reject an over-budget candidate, but only physical-iPhone Safari/Chromium measurements can establish the mobile budget. A 15 Hz update that takes 12 ms has 12 ms active latency but contributes 3 ms per 60 Hz display frame; both values matter, and either can expose a different failure mode.

## Distribution

HOL is licensed under Apache-2.0. Binary asset provenance is documented in THIRD_PARTY_NOTICES.md and machine-verified through the capability manifest. Generated SBOM and browser artifacts are CI outputs rather than committed files.
