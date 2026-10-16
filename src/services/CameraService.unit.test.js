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
      listeners.get(name)?.forEach((callback) => {
        callback();
      });
    },
    play() {
      this.playCalled = true;
      return Promise.resolve();
    },
    requestVideoFrameCallback() {
      return 1;
    },
    cancelVideoFrameCallback() {},
  };
  return video;
};

const createFakeTrack = (onStop = () => {}) => {
  const track = new EventTarget();
  track.muted = false;
  track.addEventListener('mute', () => {
    track.muted = true;
  });
  track.addEventListener('unmute', () => {
    track.muted = false;
  });
  track.stopCalled = false;
  track.stop = () => {
    track.stopCalled = true;
    onStop();
  };
  return track;
};

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const waitForTask = () =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });

test('camera startup reports insecure origins before requesting media', () => {
  const service = new CameraService();
  const blocker = service._getStartBlocker({
    protocol: 'http:',
    hostname: 'example.com',
    isSecureContext: false,
    mediaDevices: { getUserMedia: () => {} },
  });

  assert.equal(blocker, 'Camera access requires HTTPS or localhost.');
});

test('camera startup allows localhost even when isSecureContext is false', () => {
  const service = new CameraService();
  const blocker = service._getStartBlocker({
    protocol: 'http:',
    hostname: '127.0.0.1',
    isSecureContext: false,
    mediaDevices: { getUserMedia: () => {} },
  });

  assert.equal(blocker, null);
});

test('camera startup reports missing getUserMedia support', () => {
  const service = new CameraService();
  const blocker = service._getStartBlocker({
    protocol: 'https:',
    hostname: 'example.com',
    isSecureContext: true,
    mediaDevices: {},
  });

  assert.equal(blocker, 'Camera capture is not supported by this browser.');
});

test('camera startup requires video-frame callbacks for frame-synchronous processing', () => {
  const service = new CameraService();
  const blocker = service._getStartBlocker({
    protocol: 'https:',
    hostname: 'example.com',
    isSecureContext: true,
    mediaDevices: { getUserMedia: () => {} },
    hasVideoFrameCallbacks: false,
  });

  assert.equal(blocker, 'Frame-synchronous camera processing is not supported by this browser.');
});

test('camera capture caps the requested source cadence at the processing budget', () => {
  const service = new CameraService();

  assert.deepEqual(service.constraints.video.frameRate, { ideal: 30, max: 30 });
});

test('camera service prepares iOS-safe video playback attributes', () => {
  const service = new CameraService();
  const attributes = {};
  const videoElement = {
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
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
    await waitForTask();

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

test('camera stop cancels a pending media request and releases a late stream', async () => {
  let resolveMediaRequest;
  let trackStopped = false;
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          trackStopped = true;
        },
      },
    ],
  };
  const restoreWindow = installGlobal('window', {
    location: { protocol: 'https:', hostname: 'example.com' },
    isSecureContext: true,
  });
  const restoreNavigator = installGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((resolve) => {
          resolveMediaRequest = resolve;
        }),
    },
  });
  const service = new CameraService();
  service.timeoutMs = 100;
  const video = createFakeVideo();

  try {
    const startPromise = service.start(video);
    await waitForTask();

    service.stop();
    assert.equal(await startPromise, false);
    assert.equal(service.getState(), 'idle');
    assert.equal(video.srcObject, null);

    resolveMediaRequest(stream);
    await waitForTask();

    assert.equal(trackStopped, true);
    assert.equal(service.getState(), 'idle');
    assert.equal(video.srcObject, null);
  } finally {
    restoreNavigator();
    restoreWindow();
  }
});

test('camera stop cancels startup while video readiness is pending', async () => {
  let trackStopped = false;
  const track = createFakeTrack(() => {
    trackStopped = true;
  });
  const stream = {
    getTracks: () => [track],
  };
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
    await waitForTask();

    assert.equal(service.getState(), 'requesting');
    assert.equal(video.srcObject, stream);
    service.stop();

    assert.equal(await startPromise, false);
    assert.equal(trackStopped, true);
    assert.equal(service.getState(), 'idle');
    assert.equal(video.srcObject, null);

    video.emit('canplay');
    await waitForTask();
    assert.equal(service.getState(), 'idle');
  } finally {
    restoreNavigator();
    restoreWindow();
  }
});

test('camera publishes intrinsic dimensions once when a video frame precedes resize', async () => {
  const track = createFakeTrack();
  const stream = { getTracks: () => [track] };
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
  const transitions = [];
  service.addListener({
    onStateChange: (newState, oldState, data) => {
      transitions.push({ newState, oldState, data });
    },
  });

  try {
    const startPromise = service.start(video);
    await waitForTask();
    video.emit('canplay');
    assert.equal(await startPromise, true);

    video.videoWidth = 360;
    video.videoHeight = 640;
    assert.equal(service.synchronizeVideoDimensions(), true);

    assert.deepEqual(transitions.at(-1), {
      newState: 'active',
      oldState: 'active',
      data: {
        width: 360,
        height: 640,
        reason: 'dimensions-changed',
      },
    });
    assert.deepEqual(service.getDimensions(), { width: 360, height: 640 });
    const beforeResize = transitions.length;
    video.emit('resize');
    assert.equal(transitions.length, beforeResize);
  } finally {
    service.stop();
    restoreNavigator();
    restoreWindow();
  }
});

test('camera reports temporary track interruption and resumes on unmute', async () => {
  const track = createFakeTrack();
  const stream = { getTracks: () => [track] };
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
  const transitions = [];
  service.addListener({
    onStateChange: (newState, oldState, data) => {
      transitions.push({ newState, oldState, data });
    },
  });

  try {
    const startPromise = service.start(video);
    await waitForTask();
    video.emit('canplay');
    assert.equal(await startPromise, true);

    track.dispatchEvent(new Event('mute'));
    assert.equal(service.getState(), 'interrupted');
    assert.equal(video.srcObject, stream);

    track.dispatchEvent(new Event('unmute'));
    assert.equal(service.getState(), 'active');
    assert.deepEqual(service.getDimensions(), { width: 640, height: 360 });

    track.dispatchEvent(new Event('mute'));
    video.videoWidth = 360;
    video.videoHeight = 640;
    video.emit('resize');
    track.dispatchEvent(new Event('unmute'));

    assert.equal(service.getState(), 'active');
    assert.deepEqual(service.getDimensions(), { width: 360, height: 640 });
    assert.equal(transitions.at(-1).data.reason, 'dimensions-changed');
  } finally {
    service.stop();
    restoreNavigator();
    restoreWindow();
  }
});

test('camera waits for usable video dimensions after unmute and publishes one coherent resume', async () => {
  const restoreWindow = installGlobal('window', {
    location: { protocol: 'https:', hostname: 'example.com' },
    isSecureContext: true,
  });
  let stream;
  const restoreNavigator = installGlobal('navigator', {
    mediaDevices: { getUserMedia: () => Promise.resolve(stream) },
  });
  try {
    for (const [zeroWidth, zeroHeight] of [
      [0, 0],
      [0, 640],
      [360, 0],
    ]) {
      for (const [width, height] of [
        [640, 360],
        [360, 640],
      ]) {
        const track = createFakeTrack();
        stream = { getTracks: () => [track] };
        const video = createFakeVideo();
        const service = new CameraService();
        const transitions = [];
        service.addListener({
          onStateChange: (newState, oldState, data) => transitions.push({ newState, oldState, data }),
        });
        try {
          const start = service.start(video);
          await waitForTask();
          video.emit('canplay');
          assert.equal(await start, true);
          track.dispatchEvent(new Event('mute'));
          video.videoWidth = width;
          video.videoHeight = height;
          video.emit('resize');
          assert.equal(service.getState(), 'interrupted', 'resize must not resume a muted track');
          video.videoWidth = zeroWidth;
          video.videoHeight = zeroHeight;
          track.dispatchEvent(new Event('unmute'));
          assert.equal(service.getState(), 'interrupted', 'unmute does not prove usable video dimensions');
          assert.equal(service.getDimensions(), null);
          const beforeResume = transitions.length;
          video.videoWidth = width;
          video.videoHeight = height;
          video.emit('resize');
          assert.deepEqual(transitions.at(-1), {
            newState: 'active',
            oldState: 'interrupted',
            data: {
              width,
              height,
              reason: width === 640 ? 'track-unmuted' : 'dimensions-changed',
            },
          });
          video.emit('resize');
          track.dispatchEvent(new Event('unmute'));
          assert.equal(transitions.length, beforeResume + 1);
          assert.equal(video.srcObject, stream);
          assert.equal(track.stopCalled, false);
        } finally {
          service.stop();
        }
      }
    }
  } finally {
    restoreNavigator();
    restoreWindow();
  }
});

test('camera startup and playback resume recheck media readiness before reporting success', async () => {
  const restoreWindow = installGlobal('window', {
    location: { protocol: 'https:', hostname: 'example.com' },
    isSecureContext: true,
  });
  let stream;
  const restoreNavigator = installGlobal('navigator', {
    mediaDevices: { getUserMedia: () => Promise.resolve(stream) },
  });
  try {
    for (const blocked of [false, true]) {
      for (const interruption of ['width', 'height', 'mute']) {
        const track = createFakeTrack();
        stream = { getTracks: () => [track] };
        const video = createFakeVideo();
        video.readyState = 2;
        const playback = createDeferred();
        let playCalls = 0;
        video.play = () => {
          if (blocked && playCalls++ === 0) return Promise.reject(new Error('User gesture required'));
          return playback.promise;
        };
        const service = new CameraService();
        try {
          let pending = service.start(video);
          await waitForTask();
          if (blocked) {
            assert.equal(await pending, false);
            assert.equal(service.getState(), 'blocked');
            pending = service.resume();
          }
          if (interruption === 'width') video.videoWidth = 0;
          if (interruption === 'height') video.videoHeight = 0;
          if (interruption === 'mute') track.dispatchEvent(new Event('mute'));
          playback.resolve();
          assert.equal(await pending, false);
          assert.equal(service.getState(), 'interrupted');
          assert.equal(service.getDimensions(), null);
          video.videoWidth = 640;
          video.videoHeight = 360;
          video.emit('resize');
          if (interruption === 'mute') {
            assert.equal(service.getState(), 'interrupted');
            track.dispatchEvent(new Event('unmute'));
          }
          assert.equal(service.getState(), 'active');
          assert.deepEqual(service.getDimensions(), { width: 640, height: 360 });
          assert.equal(track.stopCalled, false);
          assert.equal(video.srcObject, stream);
        } finally {
          service.stop();
        }
      }
    }
  } finally {
    restoreNavigator();
    restoreWindow();
  }
});

test('camera releases an unexpectedly ended track and exposes a restartable state', async () => {
  const track = createFakeTrack();
  const stream = { getTracks: () => [track] };
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
  let interruption = null;
  service.addListener({
    onStateChange: (newState, oldState, data) => {
      if (newState === 'interrupted') {
        interruption = { oldState, data };
      }
    },
  });

  try {
    const startPromise = service.start(video);
    await waitForTask();
    video.emit('canplay');
    assert.equal(await startPromise, true);

    track.dispatchEvent(new Event('ended'));

    assert.equal(service.getState(), 'interrupted');
    assert.equal(video.srcObject, null);
    assert.equal(service.getVideoElement(), null);
    assert.equal(service.getDimensions(), null);
    assert.deepEqual(interruption, {
      oldState: 'active',
      data: {
        error: 'Camera stream ended unexpectedly.',
        reason: 'track-ended',
      },
    });
  } finally {
    service.stop();
    restoreNavigator();
    restoreWindow();
  }
});

test('camera start is a single-flight operation for one pending permission request', async () => {
  const mediaRequest = createDeferred();
  let mediaRequestCount = 0;
  const stream = { getTracks: () => [] };
  const restoreWindow = installGlobal('window', {
    location: { protocol: 'https:', hostname: 'example.com' },
    isSecureContext: true,
  });
  const restoreNavigator = installGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () => {
        mediaRequestCount++;
        return mediaRequest.promise;
      },
    },
  });
  const service = new CameraService();
  const video = createFakeVideo();

  try {
    const first = service.start(video);
    const second = service.start(video);

    assert.equal(first, second);
    assert.equal(mediaRequestCount, 1);

    service.stop();
    mediaRequest.resolve(stream);
    assert.equal(await first, false);
  } finally {
    service.stop();
    mediaRequest.resolve(stream);
    restoreNavigator();
    restoreWindow();
  }
});

test('camera start exposes listener failures on its owned promise without a detached rejection', async () => {
  const service = new CameraService();
  const unhandledRejections = [];
  const recordUnhandledRejection = (error) => {
    unhandledRejections.push(error);
  };
  process.on('unhandledRejection', recordUnhandledRejection);
  service.addListener({
    onStateChange: () => {
      throw new Error('listener failed');
    },
  });

  try {
    await assert.rejects(() => service.start(null), /listener failed/);
    await waitForTask();
    await waitForTask();
    assert.deepEqual(unhandledRejections, []);
    assert.equal(service.startPromise, null);
  } finally {
    process.removeListener('unhandledRejection', recordUnhandledRejection);
  }
});

test('camera resume is single-flight and cannot reactivate a stopped session', async () => {
  const playback = createDeferred();
  const stream = { getTracks: () => [] };
  const video = createFakeVideo();
  let playCount = 0;
  video.srcObject = stream;
  video.play = () => {
    playCount++;
    return playback.promise;
  };
  const service = new CameraService();
  service.state = 'blocked';
  service.stream = stream;
  service.videoElement = video;

  const first = service.resume();
  const second = service.resume();

  assert.equal(first, second);
  assert.equal(playCount, 1);

  service.stop();
  playback.resolve();

  assert.equal(await first, false);
  assert.equal(service.getState(), 'idle');
  assert.equal(service.getVideoElement(), null);
});

test('camera readiness ignores metadata events until intrinsic dimensions are usable', async () => {
  const service = new CameraService();
  service.timeoutMs = 100;
  const video = createFakeVideo();
  const controller = new AbortController();
  video.videoWidth = 0;
  video.videoHeight = 0;
  let settled = false;
  const readiness = service._waitForVideoReady(video, controller.signal).then(() => {
    settled = true;
  });

  video.emit('canplay');
  await Promise.resolve();
  assert.equal(settled, false);

  video.videoWidth = 640;
  video.videoHeight = 360;
  video.emit('resize');
  await readiness;
  assert.equal(settled, true);
});
