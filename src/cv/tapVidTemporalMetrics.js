import { findTapVidEligibleReappearances } from './tapVidReappearanceEvents.js';

export const TAP_VID_STABLE_REDETECTION_DURATION_MS = 100;
export const TAP_VID_REDETECTION_DISTANCE_THRESHOLD = 16;

const maximumFalseVisibleStreak = (track) => {
  let current = 0;
  let maximum = 0;
  for (let frameIndex = track.queryFrame + 1; frameIndex < track.groundTruthOccluded.length; frameIndex++) {
    if (track.groundTruthOccluded[frameIndex] && !track.predictedOccluded[frameIndex]) {
      current++;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
};

const findMissedVisibleStreaks = ({ track, trackIndex, durationMs }) => {
  const streaks = [];
  let startFrame = null;
  let fragmentsTrack = false;
  let trackedInVisibleRun = !track.groundTruthOccluded[track.queryFrame];

  const completeStreak = (endFrameExclusive) => {
    if (startFrame === null) return;
    const durationFrames = endFrameExclusive - startFrame;
    streaks.push({
      trackIndex,
      startFrame,
      endFrameExclusive,
      durationFrames,
      durationMs: durationMs(durationFrames),
      fragmentsTrack,
    });
    startFrame = null;
  };

  for (let frameIndex = track.queryFrame + 1; frameIndex < track.groundTruthOccluded.length; frameIndex++) {
    if (track.groundTruthOccluded[frameIndex]) {
      completeStreak(frameIndex);
      trackedInVisibleRun = false;
      continue;
    }
    if (track.predictedOccluded[frameIndex]) {
      if (startFrame === null) {
        startFrame = frameIndex;
        fragmentsTrack = trackedInVisibleRun;
      }
      continue;
    }
    completeStreak(frameIndex);
    trackedInVisibleRun = true;
  }
  completeStreak(track.groundTruthOccluded.length);
  return streaks;
};

const visibleRunEnd = (event) => {
  let frameIndex = event.frameIndex;
  while (
    frameIndex < event.track.groundTruthOccluded.length &&
    !event.track.groundTruthOccluded[frameIndex]
  ) {
    frameIndex++;
  }
  return frameIndex;
};

const isCorrectVisiblePrediction = ({ event, frameIndex, scaleX, scaleY }) => {
  if (event.track.predictedOccluded[frameIndex]) return false;
  const deltaX =
    (event.track.predictedPoints[frameIndex][0] - event.track.groundTruthPoints[frameIndex][0]) * scaleX;
  const deltaY =
    (event.track.predictedPoints[frameIndex][1] - event.track.groundTruthPoints[frameIndex][1]) * scaleY;
  return (
    deltaX * deltaX + deltaY * deltaY <
    TAP_VID_REDETECTION_DISTANCE_THRESHOLD * TAP_VID_REDETECTION_DISTANCE_THRESHOLD
  );
};

const findStableRecoveryFrame = ({ event, visibleEnd, requiredFrames, scaleX, scaleY }) => {
  const latestStart = visibleEnd - requiredFrames;
  for (let frameIndex = event.frameIndex; frameIndex <= latestStart; frameIndex++) {
    let stable = true;
    for (let offset = 0; offset < requiredFrames; offset++) {
      if (!isCorrectVisiblePrediction({ event, frameIndex: frameIndex + offset, scaleX, scaleY })) {
        stable = false;
        break;
      }
    }
    if (stable) return frameIndex;
  }
  return null;
};

export const computeTapVidTemporalMetrics = ({ tracks, framesPerSecond, scaleX, scaleY }) => {
  const durationMs = (frames) => (frames * 1000) / framesPerSecond;
  const requiredFrames = Math.max(
    1,
    Math.ceil((TAP_VID_STABLE_REDETECTION_DURATION_MS * framesPerSecond) / 1000),
  );
  const stableReDetectionEvents = tracks
    .flatMap((track, trackIndex) => findTapVidEligibleReappearances(track, trackIndex))
    .map((event) => ({ event, visibleEnd: visibleRunEnd(event) }))
    .filter(({ event, visibleEnd }) => visibleEnd - event.frameIndex >= requiredFrames)
    .map(({ event, visibleEnd }) => {
      const recoveredFrame = findStableRecoveryFrame({
        event,
        visibleEnd,
        requiredFrames,
        scaleX,
        scaleY,
      });
      const latencyFrames = recoveredFrame === null ? null : recoveredFrame - event.frameIndex;
      return {
        trackIndex: event.trackIndex,
        reappearanceFrame: event.frameIndex,
        undetectableFrames: event.undetectableFrames,
        undetectableDurationMs: durationMs(event.undetectableFrames),
        visibleRunFrames: visibleEnd - event.frameIndex,
        visibleRunDurationMs: durationMs(visibleEnd - event.frameIndex),
        recoveredFrame,
        latencyFrames,
        latencyMs: latencyFrames === null ? null : durationMs(latencyFrames),
      };
    });
  const recoveredLatencies = stableReDetectionEvents
    .map((event) => event.latencyFrames)
    .filter(Number.isFinite);

  const missedVisibleStreaks = tracks.flatMap((track, trackIndex) =>
    findMissedVisibleStreaks({ track, trackIndex, durationMs }),
  );
  const maximumMissedVisibleStreakFrames = Math.max(
    0,
    ...missedVisibleStreaks.map((streak) => streak.durationFrames),
  );

  const maximumFalseVisibleStreakFrames = Math.max(...tracks.map(maximumFalseVisibleStreak));
  return {
    stableReDetectionRequiredFrames: requiredFrames,
    maximumFalseVisibleStreakFrames,
    maximumFalseVisibleDurationMs: durationMs(maximumFalseVisibleStreakFrames),
    maximumMissedVisibleStreakFrames,
    maximumMissedVisibleDurationMs: durationMs(maximumMissedVisibleStreakFrames),
    visibleTrackFragmentationCount: missedVisibleStreaks.filter((streak) => streak.fragmentsTrack).length,
    stableReDetectionEligibleCount: stableReDetectionEvents.length,
    stableReDetectionRecoveredCount: recoveredLatencies.length,
    stableReDetectionRecall:
      stableReDetectionEvents.length === 0
        ? null
        : recoveredLatencies.length / stableReDetectionEvents.length,
    meanStableReDetectionLatencyFrames:
      recoveredLatencies.length === 0
        ? null
        : recoveredLatencies.reduce((sum, latency) => sum + latency, 0) / recoveredLatencies.length,
    maximumStableReDetectionLatencyFrames:
      recoveredLatencies.length === 0 ? null : Math.max(...recoveredLatencies),
    meanStableReDetectionLatencyMs:
      recoveredLatencies.length === 0
        ? null
        : durationMs(
            recoveredLatencies.reduce((sum, latency) => sum + latency, 0) / recoveredLatencies.length,
          ),
    maximumStableReDetectionLatencyMs:
      recoveredLatencies.length === 0 ? null : durationMs(Math.max(...recoveredLatencies)),
    stableReDetectionEvents,
    missedVisibleStreaks,
  };
};
