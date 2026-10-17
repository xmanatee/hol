import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRuntimeCapabilities, probeWebGL2Support } from './runtimeCapabilities.js';

const supportedBrowser = {
  protocol: 'https:',
  hostname: 'example.com',
  isSecureContext: true,
  hasMediaDevices: true,
  hasGetUserMedia: true,
  hasVideoFrameCallbacks: true,
  hasWebGL2: true,
  hasAudioContext: true,
  crossOriginIsolated: true,
  localAIBaseUrl: '',
  localAIModel: '',
  localTTSModel: '',
  localTTSVoice: '',
};

test('WebGL 2 probes release healthy and lost temporary contexts', () => {
  for (const lost of [false, true]) {
    const requestedContexts = [];
    let releases = 0;
    const documentObject = {
      createElement(name) {
        assert.equal(name, 'canvas');
        return {
          getContext(type) {
            requestedContexts.push(type);
            return {
              isContextLost: () => lost,
              getExtension(extension) {
                assert.equal(extension, 'WEBGL_lose_context');
                return { loseContext: () => releases++ };
              },
            };
          },
        };
      },
    };
    assert.equal(probeWebGL2Support(documentObject), !lost);
    assert.deepEqual(requestedContexts, ['webgl2']);
    assert.equal(releases, 1);
  }
});

test('WebGL 1-only and unavailable graphics do not satisfy the renderer requirement', () => {
  for (const webgl1Context of [{}, null]) {
    const documentObject = {
      createElement: () => ({ getContext: (type) => (type === 'webgl' ? webgl1Context : null) }),
    };
    assert.equal(probeWebGL2Support(documentObject), false);
  }
});

test('WebGL 2 does not require the optional context-release extension', () => {
  const documentObject = {
    createElement: () => ({
      getContext: () => ({ isContextLost: () => false, getExtension: () => null }),
    }),
  };
  assert.equal(probeWebGL2Support(documentObject), true);
});

test('reports insecure public origins while accepting loopback camera development', () => {
  for (const [hostname, expected] of [
    ['example.com', false],
    ['127.0.0.1', true],
  ]) {
    const checks = assessRuntimeCapabilities({
      ...supportedBrowser,
      protocol: 'http:',
      hostname,
      isSecureContext: false,
    });
    assert.equal(checks.find((check) => check.id === 'secureContext').ok, expected);
  }
});

test('absent optional AI configuration is not a camera or renderer failure', () => {
  const checks = assessRuntimeCapabilities(supportedBrowser);
  assert.deepEqual(
    checks.filter((check) => !check.ok).map((check) => check.id),
    ['localAI', 'localSpeech'],
  );
  assert.ok(checks.filter((check) => !check.ok).every((check) => check.severity === 'optional'));
});

test('configured optional services report configuration availability', () => {
  const checks = assessRuntimeCapabilities({
    ...supportedBrowser,
    localAIBaseUrl: 'https://ai.example.com/v1',
    localAIModel: 'qwen',
    localTTSModel: 'kokoro',
    localTTSVoice: 'af_heart',
  });
  assert.ok(checks.every((check) => check.ok));
});

test('missing isolation affects threading capability, not camera API support', () => {
  const checks = assessRuntimeCapabilities({ ...supportedBrowser, crossOriginIsolated: false });
  assert.deepEqual(
    checks.find((check) => check.id === 'crossOriginIsolated'),
    {
      id: 'crossOriginIsolated',
      label: 'Cross-origin isolation',
      ok: false,
      severity: 'performance',
      detail: 'ONNX will stay single-threaded without COOP/COEP isolation',
    },
  );
  assert.ok(checks.filter((check) => check.severity === 'blocker').every((check) => check.ok));
});

test('missing required APIs identify their own blocker without claiming session health', () => {
  for (const [capability, id] of [
    ['hasMediaDevices', 'mediaDevices'],
    ['hasGetUserMedia', 'getUserMedia'],
    ['hasVideoFrameCallbacks', 'videoFrameCallbacks'],
    ['hasWebGL2', 'webgl2'],
  ]) {
    const checks = assessRuntimeCapabilities({ ...supportedBrowser, [capability]: false });
    assert.deepEqual(
      checks.filter((check) => check.severity === 'blocker' && !check.ok).map((check) => check.id),
      [id],
    );
  }
});
