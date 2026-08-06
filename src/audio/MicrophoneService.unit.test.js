import test from 'node:test';
import assert from 'node:assert/strict';
import { MicrophoneService } from './MicrophoneService.js';

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

const createAudioContext = () => ({
  state: 'running',
  sampleRate: 44100,
  addEventListener() {},
  removeEventListener() {},
  resume: async () => {},
  close() {
    this.state = 'closed';
    return Promise.resolve();
  },
  createMediaStreamSource() {
    return {
      connect() {},
      disconnect() {},
    };
  },
  createAnalyser() {
    return {
      fftSize: 256,
      frequencyBinCount: 128,
      smoothingTimeConstant: 0,
      minDecibels: -90,
      maxDecibels: -10,
      getByteFrequencyData() {},
      getByteTimeDomainData() {},
    };
  },
});

const createStream = () => {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  return {
    track,
    stream: { getTracks: () => [track] },
  };
};

test('microphone frame reads each analyser domain exactly once', () => {
  const service = new MicrophoneService();
  let frequencyReads = 0;
  let timeReads = 0;
  service.isInitialized = true;
  service.isActive = true;
  service.inputGain = 1;
  service.voiceActivityThreshold = 0.01;
  service.frequencyData = new Uint8Array(4);
  service.timeData = new Uint8Array(4);
  service.analyserNode = {
    getByteFrequencyData(data) {
      frequencyReads++;
      data.set([0, 64, 128, 255]);
    },
    getByteTimeDomainData(data) {
      timeReads++;
      data.set([128, 160, 96, 128]);
    },
  };

  const frame = service.readFrame();

  assert.equal(frequencyReads, 1);
  assert.equal(timeReads, 1);
  assert.equal(frame.voiceActive, frame.energy > service.voiceActivityThreshold);
});

test('microphone initialization coalesces concurrent permission requests', async () => {
  let resolvePermission;
  let permissionRequests = 0;
  const { stream } = createStream();
  const restoreWindow = installGlobal('window', {
    AudioContext: class {
      constructor() {
        Object.assign(this, createAudioContext());
      }
    },
  });
  const restoreNavigator = installGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () => {
        permissionRequests++;
        return new Promise((resolve) => {
          resolvePermission = resolve;
        });
      },
    },
  });
  const service = new MicrophoneService();

  try {
    const firstInitialization = service.initialize();
    const secondInitialization = service.initialize();
    await Promise.resolve();

    assert.equal(permissionRequests, 1);
    resolvePermission(stream);
    assert.equal(await firstInitialization, true);
    assert.equal(await secondInitialization, true);
  } finally {
    await service.dispose();
    restoreNavigator();
    restoreWindow();
  }
});

test('microphone disposal invalidates initialization and releases a late stream', async () => {
  let resolvePermission;
  const { stream, track } = createStream();
  const restoreWindow = installGlobal('window', {
    AudioContext: class {
      constructor() {
        Object.assign(this, createAudioContext());
      }
    },
  });
  const restoreNavigator = installGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
    },
  });
  const service = new MicrophoneService();

  try {
    const initialization = service.initialize();
    await Promise.resolve();
    await service.dispose();
    resolvePermission(stream);

    assert.equal(await initialization, false);
    assert.equal(track.stopped, true);
    assert.equal(service.isInitialized, false);
    assert.equal(service.isActive, false);
    assert.equal(service.microphoneStream, null);
    assert.equal(service.audioContext, null);
  } finally {
    await service.dispose();
    restoreNavigator();
    restoreWindow();
  }
});
