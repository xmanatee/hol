import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRuntimeReadiness, probeWebGLSupport } from './runtimeReadiness.js';

test('WebGL readiness probes release the temporary graphics context', () => {
  const requestedContexts = [];
  const requestedExtensions = [];
  let releaseCount = 0;
  const context = {
    getExtension(name) {
      requestedExtensions.push(name);
      return {
        loseContext() {
          releaseCount += 1;
        },
      };
    },
  };
  const documentObject = {
    createElement(name) {
      assert.equal(name, 'canvas');
      return {
        getContext(type) {
          requestedContexts.push(type);
          return type === 'webgl2' ? context : null;
        },
      };
    },
  };

  assert.equal(probeWebGLSupport(documentObject), true);
  assert.deepEqual(requestedContexts, ['webgl2']);
  assert.deepEqual(requestedExtensions, ['WEBGL_lose_context']);
  assert.equal(releaseCount, 1);
});

test('WebGL readiness probes fall back to WebGL 1 and report unavailable contexts', () => {
  const context = {
    getExtension() {
      return null;
    },
  };
  const fallbackDocument = {
    createElement: () => ({
      getContext: (type) => (type === 'webgl' ? context : null),
    }),
  };
  const unavailableDocument = {
    createElement: () => ({ getContext: () => null }),
  };

  assert.equal(probeWebGLSupport(fallbackDocument), true);
  assert.equal(probeWebGLSupport(unavailableDocument), false);
});

test('blocks camera readiness on insecure non-local origins', () => {
  const readiness = assessRuntimeReadiness({
    protocol: 'http:',
    hostname: 'example.com',
    isSecureContext: false,
    hasMediaDevices: true,
    hasGetUserMedia: true,
    hasVideoFrameCallbacks: true,
    hasWebGL: true,
    hasAudioContext: true,
    localAIBaseUrl: 'https://ai.example.com/v1',
    localAIModel: 'qwen',
    localTTSModel: 'kokoro',
    localTTSVoice: 'af_heart',
  });

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.cameraReady, false);
  assert.equal(readiness.checks.find((check) => check.id === 'secureContext').ok, false);
});

test('accepts localhost camera development while flagging missing optional local services', () => {
  const readiness = assessRuntimeReadiness({
    protocol: 'http:',
    hostname: '127.0.0.1',
    isSecureContext: false,
    hasMediaDevices: true,
    hasGetUserMedia: true,
    hasVideoFrameCallbacks: true,
    hasWebGL: true,
    hasAudioContext: true,
    crossOriginIsolated: true,
    localAIBaseUrl: '',
    localAIModel: '',
    localTTSModel: '',
    localTTSVoice: '',
  });

  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.cameraReady, true);
  assert.equal(readiness.serviceReady, true);
  assert.deepEqual(
    readiness.checks.filter((check) => !check.ok).map((check) => check.id),
    ['localAI', 'localSpeech'],
  );
  assert.deepEqual(
    readiness.checks.filter((check) => !check.ok).map((check) => check.severity),
    ['optional', 'optional'],
  );
});

test('reports ONNX threading readiness from cross-origin isolation', () => {
  const readiness = assessRuntimeReadiness({
    protocol: 'https:',
    hostname: 'example.com',
    isSecureContext: true,
    hasMediaDevices: true,
    hasGetUserMedia: true,
    hasVideoFrameCallbacks: true,
    hasWebGL: true,
    hasAudioContext: true,
    crossOriginIsolated: false,
    localAIBaseUrl: 'https://ai.example.com/v1',
    localAIModel: 'qwen',
    localTTSModel: 'kokoro',
    localTTSVoice: 'af_heart',
  });

  assert.equal(readiness.status, 'performance-limited');
  assert.equal(readiness.performanceReady, false);
  assert.equal(readiness.checks.find((check) => check.id === 'crossOriginIsolated').ok, false);
});

test('blocks camera readiness when video-frame callbacks are unavailable', () => {
  const readiness = assessRuntimeReadiness({
    protocol: 'https:',
    hostname: 'example.com',
    isSecureContext: true,
    hasMediaDevices: true,
    hasGetUserMedia: true,
    hasVideoFrameCallbacks: false,
    hasWebGL: true,
    hasAudioContext: true,
    crossOriginIsolated: true,
    localAIBaseUrl: 'https://ai.example.com/v1',
    localAIModel: 'qwen',
    localTTSModel: 'kokoro',
    localTTSVoice: 'af_heart',
  });

  assert.equal(readiness.cameraReady, false);
  assert.equal(readiness.checks.find((check) => check.id === 'videoFrameCallbacks').ok, false);
});
