export class CameraService {
  constructor() {
    this.stream = null;
    this.videoElement = null;
    this.state = 'idle'; // idle, requesting, active, blocked, error
    this.constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
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
      videoElement.srcObject = this.stream;

      return new Promise((resolve) => {
        const onLoadedMetadata = () => {
          videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
          
          videoElement.play()
            .then(() => {
              this._notifyStateChange('active', {
                width: videoElement.videoWidth,
                height: videoElement.videoHeight
              });
              resolve(true);
            })
            .catch((playError) => {
              this._notifyStateChange('blocked', { error: playError.message });
              resolve(false);
            });
        };

        videoElement.addEventListener('loadedmetadata', onLoadedMetadata);
        
        // Fallback timeout
        setTimeout(() => {
          if (this.state === 'requesting') {
            videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
            this._stopStream();
            videoElement.srcObject = null;
            this._notifyStateChange('error', { error: 'Camera start timeout' });
            resolve(false);
          }
        }, this.timeoutMs);
      });
    } catch (err) {
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
    }, () => {});

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
