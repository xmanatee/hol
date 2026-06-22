import { logger } from '../utils/logger.js';

const VIDEO_READY_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay'];
const HAVE_METADATA = 1;

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
        frameRate: { ideal: 30 }
      },
      audio: false
    };
    this.listeners = new Set();
    this.timeoutMs = 5000;
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notifyStateChange(newState, data = {}) {
    const oldState = this.state;
    this.state = newState;
    this.listeners.forEach(listener => {
      if (listener.onStateChange) {
        listener.onStateChange(newState, oldState, data);
      }
    });
  }

  async start(videoElement) {
    if (this.state === 'active') {
      return true;
    }

    try {
      const blocker = this._getStartBlocker();
      if (blocker) {
        this._notifyStateChange('error', { error: blocker });
        return false;
      }
      if (!videoElement) {
        this._notifyStateChange('error', { error: 'Camera video element is not ready.' });
        return false;
      }

      this._notifyStateChange('requesting');
      this.videoElement = videoElement;
      this._prepareVideoElement(videoElement);

      this.stream = await this._requestCameraStream();
      const videoReady = this._waitForVideoReady(videoElement);
      videoElement.srcObject = this.stream;
      const playback = videoElement.play().then(
        () => true,
        playError => ({ blocked: true, error: playError.message })
      );
      const [, playbackResult] = await Promise.all([videoReady, playback]);
      if (playbackResult.blocked) {
        this._notifyStateChange('blocked', { error: playbackResult.error });
        return false;
      }
      this._notifyStateChange('active', {
        width: videoElement.videoWidth,
        height: videoElement.videoHeight
      });
      return true;
    } catch (err) {
      this._stopStream();
      if (this.videoElement) {
        this.videoElement.srcObject = null;
      }
      this._notifyStateChange('error', { error: err.message });
      return false;
    }
  }

  async _requestCameraStream() {
    let timedOut = false;
    const streamRequest = navigator.mediaDevices.getUserMedia(this.constraints);

    streamRequest.then((stream) => {
      if (timedOut) {
        stream.getTracks().forEach(track => track.stop());
      }
    }, (error) => {
      if (timedOut) {
        logger.warn('CameraService', `Camera stream request rejected after timeout: ${error.message}`);
      }
    });

    return await Promise.race([
      streamRequest,
      new Promise((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(new Error('Camera permission timeout'));
        }, this.timeoutMs);
      })
    ]);
  }

  _waitForVideoReady(videoElement) {
    if (videoElement.readyState >= HAVE_METADATA && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        globalThis.clearTimeout(timeoutId);
        VIDEO_READY_EVENTS.forEach(eventName => {
          videoElement.removeEventListener(eventName, onReady);
        });
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const timeoutId = globalThis.setTimeout(() => {
        cleanup();
        reject(new Error('Camera start timeout'));
      }, this.timeoutMs);

      VIDEO_READY_EVENTS.forEach(eventName => {
        videoElement.addEventListener(eventName, onReady);
      });
    });
  }

  _getStartBlocker(env = {}) {
    const locationSource = env.location || (typeof window !== 'undefined' ? window.location : {});
    const protocol = env.protocol ?? locationSource.protocol;
    const hostname = env.hostname ?? locationSource.hostname;
    const isSecureContext = env.isSecureContext ?? (typeof window !== 'undefined' && window.isSecureContext);
    const mediaDevices = env.mediaDevices ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

    if (!isSecureContext && protocol !== 'https:' && !isLocalhost) {
      return 'Camera access requires HTTPS or localhost.';
    }

    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      return 'Camera capture is not supported by this browser.';
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

  async resume() {
    if (this.state === 'blocked' && this.videoElement) {
      return this.videoElement.play().then(
        () => {
          this._notifyStateChange('active', {
            width: this.videoElement.videoWidth,
            height: this.videoElement.videoHeight
          });
          return true;
        },
        (playError) => {
          this._notifyStateChange('blocked', { error: playError.message });
          return false;
        }
      );
    }
    return false;
  }

  stop() {
    this._stopStream();
    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }
    this._notifyStateChange('idle');
  }

  _stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
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
        height: this.videoElement.videoHeight
      };
    }
    return null;
  }
}
