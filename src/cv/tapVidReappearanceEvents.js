export const findTapVidEligibleReappearances = (track, trackIndex = 0) => {
  const events = [];
  let undetectableFrames = 0;
  let longestPreviousUndetectability = 0;

  for (let frameIndex = track.queryFrame + 1; frameIndex < track.groundTruthOccluded.length; frameIndex++) {
    if (track.groundTruthOccluded[frameIndex]) {
      undetectableFrames++;
      continue;
    }
    if (undetectableFrames > longestPreviousUndetectability) {
      events.push({ track, trackIndex, frameIndex, undetectableFrames });
      longestPreviousUndetectability = undetectableFrames;
    }
    undetectableFrames = 0;
  }

  return events;
};
