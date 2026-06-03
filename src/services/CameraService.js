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
      this._notifyStateChange('requesting');
      this.videoElement = videoElement;

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

  async resume() {
    if (this.state === 'blocked' && this.videoElement) {
      try {
        await this.videoElement.play();
        this._notifyStateChange('active', {
          width: this.videoElement.videoWidth,
          height: this.videoElement.videoHeight
        });
        return true;
      } catch {
        return false;
      }
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
