import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraService } from './CameraService.js';

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
