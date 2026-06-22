import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraService } from './CameraService.js';

const installGlobal = (name, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  };
};

const createFakeVideo = () => {
  const listeners = new Map();
  const video = {
    readyState: 0,
    videoWidth: 640,
    videoHeight: 360,
    playCalled: false,
    attributes: {},
    srcObject: null,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(name, callback) {
      if (!listeners.has(name)) {
        listeners.set(name, new Set());
      }
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      listeners.get(name)?.delete(callback);
    },
    emit(name) {
      this.readyState = 2;
      listeners.get(name)?.forEach(callback => callback());
    },
    play() {
      this.playCalled = true;
      return Promise.resolve();
    },
  };
  return video;
};

test('camera startup reports insecure origins before requesting media', () => {
  const service = new CameraService();
  const blocker = service._getStartBlocker({
    protocol: 'http:',
    hostname: 'example.com',
    isSecureContext: false,
    mediaDevices: { getUserMedia: () => {} }
  });

  assert.equal(blocker, 'Camera access requires HTTPS or localhost.');
});

test('camera startup allows localhost even when isSecureContext is false', () => {
  const service = new CameraService();
  const blocker = service._getStartBlocker({
    protocol: 'http:',
    hostname: '127.0.0.1',
    isSecureContext: false,
    mediaDevices: { getUserMedia: () => {} }
  });

  assert.equal(blocker, null);
});

test('camera startup reports missing getUserMedia support', () => {
  const service = new CameraService();
  const blocker = service._getStartBlocker({
    protocol: 'https:',
    hostname: 'example.com',
    isSecureContext: true,
    mediaDevices: {}
  });

  assert.equal(blocker, 'Camera capture is not supported by this browser.');
});

test('camera service prepares iOS-safe video playback attributes', () => {
  const service = new CameraService();
  const attributes = {};
  const videoElement = {
    setAttribute: (name, value) => {
      attributes[name] = value;
    }
  };

  service._prepareVideoElement(videoElement);

  assert.equal(videoElement.muted, true);
  assert.equal(videoElement.defaultMuted, true);
  assert.equal(videoElement.playsInline, true);
  assert.equal(videoElement.autoplay, true);
  assert.equal(attributes.playsinline, '');
  assert.equal(attributes['webkit-playsinline'], '');
});

test('camera start accepts canplay readiness when loadedmetadata is not emitted', async () => {
  const stream = { getTracks: () => [] };
  const restoreWindow = installGlobal('window', {
    location: { protocol: 'https:', hostname: 'example.com' },
    isSecureContext: true,
  });
  const restoreNavigator = installGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () => Promise.resolve(stream),
    },
  });
  const service = new CameraService();
  service.timeoutMs = 100;
  const video = createFakeVideo();

  try {
    const startPromise = service.start(video);
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));

    assert.equal(service.getState(), 'requesting');
    assert.equal(video.srcObject, stream);
    assert.equal(video.playCalled, true);

    video.emit('canplay');

    assert.equal(await startPromise, true);
    assert.equal(service.getState(), 'active');
  } finally {
    restoreNavigator();
    restoreWindow();
  }
});
