# Open work

## Camera-to-face reliability

- Add independently labelled negative/objectness videos. A confident point mask can still select background; large-mask rejection alone is not a solution.
- Improve glossy-can landmark ownership under moving reflections, and test blank laptop lids separately from textured planes. Choose one laptop surface, not the whole open device.
- Decouple segmentation latency from tracking and selection only with immutable source-frame/reference ownership, mask reprojection, and stale-result rejection. Removing the segmentation `await` alone introduces races.
- Correct refreshed-mask coordinate bases jointly with the estimator/reference model; isolated scale/rotation rebasing regressed tracking.
- Improve curved-surface attachment and hand occlusion. Approximate cylinder/normal presentation is not material-point 6DoF.
- Improve Perception Test `video_5032` tracks `35` (false visibility), `3` (visible-target outage), and `0` (slow re-entry), preserving every query's existing floors. Fixture provenance and reproduction live in [the annotated benchmark](tests/fixtures/annotated-vision/README.md).

## Physical-device acceptance

Target devices: iPad Pro M4 and Xiaomi; retain iPhone Safari compatibility.

- Measure camera-to-ready latency, capture-to-response age, selection queue time, and UI frame p95 with the face rendering concurrently.
- Measure OpenCV, segmentation, XFeat recovery, and optional depth cold/warm latency, memory growth, and sustained thermal behavior. Do not infer phone budgets from desktop averages.
- Exercise portrait/landscape source-raster changes, autoplay, background/sleep/resume, camera interruption, WebGL stability, and recovery without identity switches.
- Validate production-size depth on each supported execution plan before considering it a default.

## Candidate approaches

- Evaluate temporal-memory segmentation only after export parity, bounded temporal state, independent mask-video labels, and target-device timing. See [the experiment protocol](docs/vision-experimentation.md).
- Test synchronized camera/IMU recordings before using gyro rotation as a motion prior; it cannot establish object motion or renew visual evidence.
- Compare photometric preprocessing on low light and glare without trading fewer losses for false locks or excessive preprocessing cost.
- Keep optional local persona/TTS model profiles reproducible and separate from the visual demo.

Verification commands and release gates are maintained in [README.md](README.md#verification); executable thresholds belong in tests and manifests, not this backlog.
