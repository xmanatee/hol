const VIDEO_READY_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'resize'];
const HAVE_METADATA = 1;
const CAMERA_START_CANCELLED = 'Camera start cancelled';

const stopMediaStream = (stream) => {
  stream.getTracks().forEach((track) => {
    track.stop();
  });
};

export class CameraService {
  constructor() {
    this.stream = null;
    this.videoElement = null;
    this.state = 'idle';
    this.constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 960, max: 1280 },
        height: { ideal: 540, max: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    };
    this.listeners = new Set();
    this.timeoutMs = 5000;
    this.startController = null;
    this.startPromise = null;
    this.resumeRequest = null;
    this.resumePromise = null;
    this.lastDimensions = null;
    this.removeStreamListeners = null;
    this.removeVideoResizeListener = null;
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notifyStateChange(newState, data = {}) {
    const oldState = this.state;
    this.state = newState;
    this.listeners.forEach((listener) => {
      if (listener.onStateChange) {
        listener.onStateChange(newState, oldState, data);
      }
    });
  }

  start(videoElement) {
    if (this.state === 'active') {
      return Promise.resolve(true);
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const startPromise = this._start(videoElement).finally(() => {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  async _start(videoElement) {
    this._cancelPendingResume();
    this._cancelPendingStart();
    this._stopStream();
    this._detachVideoElement();

    const startController = new AbortController();
    this.startController = startController;

    try {
      if (!videoElement) {
        this.startController = null;
        this._notifyStateChange('error', { error: 'Camera video element is not ready.' });
        return false;
      }
      const blocker = this._getStartBlocker({
        hasVideoFrameCallbacks:
          typeof videoElement.requestVideoFrameCallback === 'function' &&
          typeof videoElement.cancelVideoFrameCallback === 'function',
      });
      if (blocker) {
        this.startController = null;
        this._notifyStateChange('error', { error: blocker });
        return false;
      }

      this._notifyStateChange('requesting');
      this.videoElement = videoElement;
      this._prepareVideoElement(videoElement);

      const stream = await this._requestCameraStream(startController.signal);
      if (startController.signal.aborted || this.startController !== startController) {
        stopMediaStream(stream);
        return false;
      }
      this.stream = stream;
      this._observeStream(stream);
      this._observeVideoDimensions(videoElement);
      const videoReady = this._waitForVideoReady(videoElement, startController.signal);
      videoElement.srcObject = stream;
      const playback = this._playVideo(videoElement, startController.signal);
      const [, playbackResult] = await Promise.all([videoReady, playback]);
      if (
        startController.signal.aborted ||
        this.startController !== startController ||
        this.stream !== stream
      ) {
        return false;
      }
      this.startController = null;
      if (playbackResult.blocked) {
        this._notifyStateChange('blocked', { error: playbackResult.error });
        return false;
      }
      this._publishActiveDimensions();
      return true;
    } catch (err) {
      if (startController.signal.aborted) {
        return false;
      }
      if (this.startController === startController) {
        this.startController = null;
      }
      this._stopStream();
      this._detachVideoElement();
      this._notifyStateChange('error', { error: err.message });
      return false;
    }
  }

  _requestCameraStream(signal) {
    const streamRequest = navigator.mediaDevices.getUserMedia(this.constraints);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;

      function cleanup() {
        globalThis.clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
      }
      const settle = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback(value);
      };
      function onAbort() {
        settle(reject, new Error(CAMERA_START_CANCELLED));
      }

      streamRequest.then(
        (stream) => {
          if (settled) {
            stopMediaStream(stream);
            return;
          }
          settle(resolve, stream);
        },
        (error) => {
          if (!settled) {
            settle(reject, error);
          }
        },
      );

      timeoutId = globalThis.setTimeout(() => {
        settle(reject, new Error('Camera permission timeout'));
      }, this.timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  _waitForVideoReady(videoElement, signal) {
    if (signal.aborted) {
      return Promise.reject(new Error(CAMERA_START_CANCELLED));
    }
    if (
      videoElement.readyState >= HAVE_METADATA &&
      videoElement.videoWidth > 0 &&
      videoElement.videoHeight > 0
    ) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let timeoutId = null;
      function cleanup() {
        globalThis.clearTimeout(timeoutId);
        VIDEO_READY_EVENTS.forEach((eventName) => {
          videoElement.removeEventListener(eventName, onReady);
        });
        signal.removeEventListener('abort', onAbort);
      }
      function onReady() {
        if (
          videoElement.readyState < HAVE_METADATA ||
          videoElement.videoWidth <= 0 ||
          videoElement.videoHeight <= 0
        ) {
          return;
        }
        cleanup();
        resolve();
      }
      function onAbort() {
        cleanup();
        reject(new Error(CAMERA_START_CANCELLED));
      }
      timeoutId = globalThis.setTimeout(() => {
        cleanup();
        reject(new Error('Camera start timeout'));
      }, this.timeoutMs);

      VIDEO_READY_EVENTS.forEach((eventName) => {
        videoElement.addEventListener(eventName, onReady);
      });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  _playVideo(videoElement, signal) {
    if (signal.aborted) {
      return Promise.reject(new Error(CAMERA_START_CANCELLED));
    }

    const playRequest = videoElement.play();
    return new Promise((resolve, reject) => {
      let settled = false;
      function cleanup() {
        signal.removeEventListener('abort', onAbort);
      }
      const settle = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback(value);
      };
      function onAbort() {
        settle(reject, new Error(CAMERA_START_CANCELLED));
      }

      playRequest.then(
        () => settle(resolve, true),
        (playError) => settle(resolve, { blocked: true, error: playError.message }),
      );
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  _getStartBlocker(env = {}) {
    const locationSource = env.location || (typeof window !== 'undefined' ? window.location : {});
    const protocol = env.protocol ?? locationSource.protocol;
    const hostname = env.hostname ?? locationSource.hostname;
    const isSecureContext = env.isSecureContext ?? (typeof window !== 'undefined' && window.isSecureContext);
    const mediaDevices =
      env.mediaDevices ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

    if (!isSecureContext && protocol !== 'https:' && !isLocalhost) {
      return 'Camera access requires HTTPS or localhost.';
    }

    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      return 'Camera capture is not supported by this browser.';
    }

    if (env.hasVideoFrameCallbacks === false) {
      return 'Frame-synchronous camera processing is not supported by this browser.';
    }

    return null;
  }

  _prepareVideoElement(videoElement) {
    videoElement.muted = true;
    videoElement.defaultMuted = true;
    videoElement.playsInline = true;
    videoElement.autoplay = true;
    videoElement.setAttribute('playsinline', '');
    videoElement.setAttribute('webkit-playsinline', '');
  }

  _observeStream(stream) {
    const removers = stream.getTracks().flatMap((track) => {
      const handleEnded = () => {
        if (this.stream !== stream) {
          return;
        }
        this._cancelPendingStart();
        this._stopStream();
        this._detachVideoElement();
        this._notifyStateChange('interrupted', {
          error: 'Camera stream ended unexpectedly.',
          reason: 'track-ended',
        });
      };
      const handleMute = () => {
        if (this.stream === stream && this.state === 'active') {
          this._notifyStateChange('interrupted', {
            error: 'Camera stream is temporarily unavailable.',
            reason: 'track-muted',
          });
        }
      };
      const handleUnmute = () => {
        if (this.stream === stream && this.state === 'interrupted') {
          const dimensionsChanged =
            this.videoElement.videoWidth !== this.lastDimensions?.width ||
            this.videoElement.videoHeight !== this.lastDimensions?.height;
          this._publishActiveDimensions(dimensionsChanged ? 'dimensions-changed' : 'track-unmuted');
        }
      };
      track.addEventListener('ended', handleEnded);
      track.addEventListener('mute', handleMute);
      track.addEventListener('unmute', handleUnmute);
      return [
        () => track.removeEventListener('ended', handleEnded),
        () => track.removeEventListener('mute', handleMute),
        () => track.removeEventListener('unmute', handleUnmute),
      ];
    });

    this.removeStreamListeners = () => {
      removers.forEach((remove) => {
        remove();
      });
      this.removeStreamListeners = null;
    };
  }

  _observeVideoDimensions(videoElement) {
    const handleResize = () => {
      if (this.videoElement !== videoElement || this.state !== 'active') {
        return;
      }
      const dimensions = {
        width: videoElement.videoWidth,
        height: videoElement.videoHeight,
      };
      if (
        dimensions.width <= 0 ||
        dimensions.height <= 0 ||
        (dimensions.width === this.lastDimensions?.width && dimensions.height === this.lastDimensions?.height)
      ) {
        return;
      }
      this._publishActiveDimensions('dimensions-changed');
    };

    videoElement.addEventListener('resize', handleResize);
    this.removeVideoResizeListener = () => {
      videoElement.removeEventListener('resize', handleResize);
      this.removeVideoResizeListener = null;
    };
  }

  _publishActiveDimensions(reason = null) {
    const dimensions = {
      width: this.videoElement.videoWidth,
      height: this.videoElement.videoHeight,
    };
    this.lastDimensions = dimensions;
    this._notifyStateChange('active', {
      ...dimensions,
      ...(reason ? { reason } : {}),
    });
  }

  resume() {
    if (this.resumePromise) {
      return this.resumePromise;
    }

    if (this.state === 'blocked' && this.videoElement && this.stream) {
      const resumeRequest = {
        videoElement: this.videoElement,
        stream: this.stream,
      };
      const resumePromise = resumeRequest.videoElement
        .play()
        .then(
          () => {
            if (!this._ownsResumeRequest(resumeRequest)) {
              return false;
            }
            this._publishActiveDimensions();
            return true;
          },
          (playError) => {
            if (!this._ownsResumeRequest(resumeRequest)) {
              return false;
            }
            this._notifyStateChange('blocked', { error: playError.message });
            return false;
          },
        )
        .finally(() => {
          if (this.resumePromise === resumePromise) {
            this.resumeRequest = null;
            this.resumePromise = null;
          }
        });
      this.resumeRequest = resumeRequest;
      this.resumePromise = resumePromise;
      return resumePromise;
    }
    return Promise.resolve(false);
  }

  stop() {
    this._cancelPendingResume();
    this._cancelPendingStart();
    this._stopStream();
    this._detachVideoElement();
    this._notifyStateChange('idle');
  }

  _stopStream() {
    this.removeStreamListeners?.();
    if (this.stream) {
      stopMediaStream(this.stream);
      this.stream = null;
    }
  }

  _detachVideoElement() {
    this.removeVideoResizeListener?.();
    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }
    this.lastDimensions = null;
  }

  _cancelPendingStart() {
    this.startController?.abort();
    this.startController = null;
    this.startPromise = null;
  }

  _cancelPendingResume() {
    this.resumeRequest = null;
    this.resumePromise = null;
  }

  _ownsResumeRequest(resumeRequest) {
    return (
      this.resumeRequest === resumeRequest &&
      this.videoElement === resumeRequest.videoElement &&
      this.stream === resumeRequest.stream &&
      this.state === 'blocked'
    );
  }

  getState() {
    return this.state;
  }

  isActive() {
    return this.state === 'active';
  }

  getVideoElement() {
    return this.videoElement;
  }

  getDimensions() {
    if (this.videoElement && this.state === 'active') {
      return {
        width: this.videoElement.videoWidth,
        height: this.videoElement.videoHeight,
      };
    }
    return null;
  }
}
