import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRuntimeReadiness } from './runtimeReadiness.js';

test('blocks camera readiness on insecure non-local origins', () => {
  const readiness = assessRuntimeReadiness({
    protocol: 'http:',
    hostname: 'example.com',
    isSecureContext: false,
    hasMediaDevices: true,
    hasGetUserMedia: true,
    hasWebGL: true,
    hasAudioContext: true,
    openAIKey: 'present',
    elevenLabsAgentId: 'present'
  });

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.cameraReady, false);
  assert.equal(readiness.checks.find(check => check.id === 'secureContext').ok, false);
});

test('accepts localhost camera development while flagging missing external services', () => {
  const readiness = assessRuntimeReadiness({
    protocol: 'http:',
    hostname: '127.0.0.1',
    isSecureContext: false,
    hasMediaDevices: true,
    hasGetUserMedia: true,
    hasWebGL: true,
    hasAudioContext: true,
    openAIKey: '',
    elevenLabsAgentId: ''
  });

  assert.equal(readiness.status, 'service-setup');
  assert.equal(readiness.cameraReady, true);
  assert.equal(readiness.serviceReady, false);
  assert.deepEqual(
    readiness.checks.filter(check => !check.ok).map(check => check.id),
    ['openAIKey', 'elevenLabsAgentId']
  );
});
