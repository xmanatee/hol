import { useEffect, useRef } from 'react';
import { pageVisibility } from '../utils/pageVisibility.js';

const assertVideoFrameCallbackSupport = (videoElement) => {
  if (
    typeof videoElement.requestVideoFrameCallback !== 'function' ||
    typeof videoElement.cancelVideoFrameCallback !== 'function'
  ) {
    throw new Error('Video frame callbacks are not supported by this browser');
  }
};

export const subscribeToVideoFrames = ({ videoElement, onFrame, visibility = pageVisibility }) => {
  assertVideoFrameCallbackSupport(videoElement);

  let active = true;
  let callbackId = null;
  let previousMediaTime = null;
  let generation = 0;

  const handleVideoFrame = (now, metadata, scheduledGeneration) => {
    if (!active || scheduledGeneration !== generation || !visibility.getSnapshot()) {
      return;
    }

    scheduleFrame();
    const mediaDelta = previousMediaTime === null ? null : metadata.mediaTime - previousMediaTime;
    previousMediaTime = metadata.mediaTime;

    onFrame({
      now,
      metadata,
      captureFps: mediaDelta > 0 ? 1 / mediaDelta : null,
    });
  };

  function scheduleFrame() {
    const scheduledGeneration = generation;
    callbackId = videoElement.requestVideoFrameCallback((now, metadata) =>
      handleVideoFrame(now, metadata, scheduledGeneration),
    );
  }

  const updateVisibility = () => {
    generation++;
    if (callbackId !== null) videoElement.cancelVideoFrameCallback(callbackId);
    callbackId = null;
    previousMediaTime = null;
    if (visibility.getSnapshot()) scheduleFrame();
  };
  const unsubscribeVisibility = visibility.subscribe(updateVisibility);
  updateVisibility();

  return () => {
    active = false;
    unsubscribeVisibility();
    if (callbackId !== null) videoElement.cancelVideoFrameCallback(callbackId);
    callbackId = null;
  };
};

export const useVideoFrames = (videoRef, active, onFrame) => {
  const onFrameRef = useRef(onFrame);

  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    return subscribeToVideoFrames({
      videoElement: videoRef.current,
      onFrame: (frame) => onFrameRef.current(frame),
    });
  }, [active, videoRef]);
};
