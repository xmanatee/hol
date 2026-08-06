const POST_OCCLUSION_ANCHOR_THRESHOLD = 8;

const isOccluded = (frame) => frame.occluded === true || frame.groundTruth?.occluded === true;

const frameIndex = (frame, index) => (Number.isFinite(frame.index) ? frame.index : index);

const isRecoveredFrame = (frame, threshold) =>
  frame.success === true && Number.isFinite(frame.anchorError) && frame.anchorError <= threshold;

const isTargetRecoveredFrame = (frame, threshold) =>
  frame.targetPresent === true && isRecoveredFrame(frame, threshold);

const maxValue = (values) => (values.length ? Math.max(...values) : 0);

const meanValue = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export const postOcclusionRecoveryWindows = (frames, threshold = POST_OCCLUSION_ANCHOR_THRESHOLD) => {
  const windows = [];
  let index = 0;

  while (index < frames.length) {
    if (!isOccluded(frames[index])) {
      index++;
      continue;
    }

    const occlusionStartFrameIndex = frameIndex(frames[index], index);
    while (index < frames.length && isOccluded(frames[index])) {
      index++;
    }
    const occlusionEndFrameIndex = frameIndex(frames[index - 1], index - 1);
    const visibleStart = index;
    const visibleFrames = [];
    let recoveredFrame = null;

    while (index < frames.length && !isOccluded(frames[index])) {
      const frame = frames[index];
      visibleFrames.push(frame);
      if (isRecoveredFrame(frame, threshold)) {
        recoveredFrame = frame;
        index++;
        break;
      }
      index++;
    }

    if (!visibleFrames.length) {
      continue;
    }

    windows.push({
      occlusionStartFrameIndex,
      occlusionEndFrameIndex,
      startFrameIndex: frameIndex(frames[visibleStart], visibleStart),
      recoveredFrameIndex: recoveredFrame ? frameIndex(recoveredFrame, index - 1) : null,
      recoveredAt8: recoveredFrame !== null,
      framesToRecoverAt8: visibleFrames.length,
      maxAnchorError: maxValue(visibleFrames.map((frame) => frame.anchorError).filter(Number.isFinite)),
      meanAnchorError: meanValue(visibleFrames.map((frame) => frame.anchorError).filter(Number.isFinite)),
    });

    while (index < frames.length && !isOccluded(frames[index])) {
      index++;
    }
  }

  return windows;
};

export const postOcclusionRecoveryMetrics = (frames) => {
  const windows = postOcclusionRecoveryWindows(frames);
  const recoveredWindows = windows.filter((window) => window.recoveredAt8);
  const recoveryFrames = windows.map((window) => window.framesToRecoverAt8);

  return {
    postOcclusionWindowCount: windows.length,
    postOcclusionRecoveredAt8: recoveredWindows.length,
    postOcclusionFailedWindowsAt8: windows.length - recoveredWindows.length,
    postOcclusionRecoveryRateAt8: windows.length ? recoveredWindows.length / windows.length : 1,
    maxPostOcclusionRecoveryFramesAt8: maxValue(recoveryFrames),
    meanPostOcclusionRecoveryFramesAt8: meanValue(recoveryFrames),
    worstPostOcclusionWindows: [...windows]
      .sort(
        (left, right) =>
          Number(left.recoveredAt8) - Number(right.recoveredAt8) ||
          right.framesToRecoverAt8 - left.framesToRecoverAt8 ||
          right.maxAnchorError - left.maxAnchorError ||
          left.startFrameIndex - right.startFrameIndex,
      )
      .slice(0, 6),
  };
};

export const targetLossRecoveryMetrics = (frames) => {
  const windows = [];
  let targetAbsentFrameCount = 0;
  let targetPresentAbsentDisplayFrames = 0;
  let falseTrackedAbsentAdmittedFrames = 0;
  let index = 0;

  while (index < frames.length) {
    if (frames[index].targetVisible !== false) {
      index++;
      continue;
    }

    while (index < frames.length && frames[index].targetVisible === false) {
      targetAbsentFrameCount++;
      const processedFrame = frames[index].runtime?.admittedUpdate !== false;
      if (frames[index].targetPresent === true) {
        targetPresentAbsentDisplayFrames++;
        if (processedFrame) falseTrackedAbsentAdmittedFrames++;
      }
      index++;
    }

    let windowRecoveryFrames = 0;
    let recovered = false;
    while (index < frames.length && frames[index].targetVisible !== false) {
      windowRecoveryFrames++;
      if (isTargetRecoveredFrame(frames[index], POST_OCCLUSION_ANCHOR_THRESHOLD)) {
        recovered = true;
        break;
      }
      index++;
    }
    windows.push({ recovered, recoveryFrames: windowRecoveryFrames });

    while (index < frames.length && frames[index].targetVisible !== false) index++;
  }

  const recoveredWindows = windows.filter((window) => window.recovered);
  const recoveryFrames = windows.map((window) => window.recoveryFrames);
  return {
    targetLossWindowCount: windows.length,
    targetAbsentFrameCount,
    targetPresentAbsentDisplayFrames,
    falseTrackedAbsentAdmittedFrames,
    targetLossRecoveredAt8: recoveredWindows.length,
    targetLossFailedWindowsAt8: windows.length - recoveredWindows.length,
    targetLossRecoveryRateAt8: windows.length ? recoveredWindows.length / windows.length : 1,
    maxTargetLossRecoveryFramesAt8: maxValue(recoveryFrames),
    meanTargetLossRecoveryFramesAt8: meanValue(recoveryFrames),
  };
};
