import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createControlPanelContext,
  createDefaultExpandedSections,
  expandSectionsForWorkflow,
} from './controlPanelState.js';

test('control panel defaults prioritize status controls diagnostics and pre-anchor configuration', () => {
  const sections = createDefaultExpandedSections({
    anchorStatus: 'ready',
    runtimeStatus: 'ready',
  });

  assert.equal(sections.status, true);
  assert.equal(sections.controls, true);
  assert.equal(sections.diagnostics, true);
  assert.equal(sections.config, true);
  assert.equal(sections.reconstruction, false);
  assert.equal(sections.runtime, false);
  assert.equal(sections.logs, false);
});

test('control panel opens reconstruction for active object-building workflows', () => {
  for (const anchorStatus of ['candidate', 'mapping', 'tracking', 'stable', 'weak', 'recovering']) {
    const sections = createDefaultExpandedSections({ anchorStatus });

    assert.equal(sections.reconstruction, true, anchorStatus);
    assert.equal(sections.config, false, anchorStatus);
  }
});

test('control panel opens runtime and microphone sections only when they need attention', () => {
  const sections = createDefaultExpandedSections({
    runtimeStatus: 'service-setup',
    microphoneMode: true,
  });

  assert.equal(sections.runtime, true);
  assert.equal(sections.microphone, true);
});

test('control panel workflow expansion opens attention sections without closing user-opened sections', () => {
  const current = {
    status: true,
    reconstruction: false,
    diagnostics: false,
    runtime: false,
    controls: true,
    microphone: false,
    personality: true,
    meshControls: false,
    metrics: false,
    logs: true,
    config: true,
  };

  const sections = expandSectionsForWorkflow(current, {
    anchorStatus: 'candidate',
    runtimeStatus: 'blocked',
  });

  assert.equal(sections.reconstruction, true);
  assert.equal(sections.diagnostics, true);
  assert.equal(sections.runtime, true);
  assert.equal(sections.personality, true);
  assert.equal(sections.logs, true);
  assert.equal(sections.config, true);
});

test('control panel workflow expansion does not reopen sections after the user closes them inside the same workflow', () => {
  const current = {
    status: true,
    reconstruction: false,
    diagnostics: false,
    runtime: false,
    controls: true,
    microphone: false,
    personality: false,
    meshControls: false,
    metrics: false,
    logs: false,
    config: false,
  };

  const sections = expandSectionsForWorkflow(
    current,
    createControlPanelContext({ anchorStatus: 'mapping' }),
    createControlPanelContext({ anchorStatus: 'candidate' })
  );

  assert.equal(sections.reconstruction, false);
  assert.equal(sections.diagnostics, false);
});

test('control panel workflow expansion opens sections again when a new object workflow starts', () => {
  const current = {
    status: true,
    reconstruction: false,
    diagnostics: false,
    runtime: false,
    controls: true,
    microphone: false,
    personality: false,
    meshControls: false,
    metrics: false,
    logs: false,
    config: true,
  };

  const sections = expandSectionsForWorkflow(
    current,
    createControlPanelContext({ anchorStatus: 'candidate' }),
    createControlPanelContext({ anchorStatus: 'ready' })
  );

  assert.equal(sections.reconstruction, true);
  assert.equal(sections.diagnostics, true);
});
