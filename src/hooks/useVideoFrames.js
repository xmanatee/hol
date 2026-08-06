import { useEffect, useRef } from 'react';

const assertVideoFrameCallbackSupport = (videoElement) => {
  if (
    typeof videoElement.requestVideoFrameCallback !== 'function' ||
    typeof videoElement.cancelVideoFrameCallback !== 'function'
  ) {
    throw new Error('Video frame callbacks are not supported by this browser');
  }
};

export const subscribeToVideoFrames = ({ videoElement, onFrame }) => {
  assertVideoFrameCallbackSupport(videoElement);

  let active = true;
  let callbackId = null;
  let previousMediaTime = null;

  const handleVideoFrame = (now, metadata) => {
    if (!active) {
      return;
    }

    callbackId = videoElement.requestVideoFrameCallback(handleVideoFrame);
    const mediaDelta = previousMediaTime === null ? null : metadata.mediaTime - previousMediaTime;
    previousMediaTime = metadata.mediaTime;

    onFrame({
      now,
      metadata,
      captureFps: mediaDelta > 0 ? 1 / mediaDelta : null,
    });
  };

  callbackId = videoElement.requestVideoFrameCallback(handleVideoFrame);

  return () => {
    active = false;
    videoElement.cancelVideoFrameCallback(callbackId);
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
