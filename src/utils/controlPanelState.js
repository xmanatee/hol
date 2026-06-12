const ANCHOR_WORKFLOW_STATUSES = new Set([
  'candidate',
  'mapping',
  'tracking',
  'stable',
  'weak',
  'recovering',
]);

const RUNTIME_ATTENTION_STATUSES = new Set([
  'blocked',
  'service-setup',
  'unsupported',
]);

export const createDefaultExpandedSections = ({
  anchorStatus = 'pending',
  runtimeStatus = 'unknown',
  microphoneMode = false,
} = {}) => {
  const hasAnchorWorkflow = ANCHOR_WORKFLOW_STATUSES.has(anchorStatus);

  return {
    status: true,
    reconstruction: hasAnchorWorkflow,
    diagnostics: true,
    runtime: RUNTIME_ATTENTION_STATUSES.has(runtimeStatus),
    controls: true,
    microphone: microphoneMode,
    personality: false,
    meshControls: false,
    metrics: false,
    logs: false,
    config: !hasAnchorWorkflow,
  };
};

export const expandSectionsForWorkflow = (currentSections, {
  anchorStatus = 'pending',
  runtimeStatus = 'unknown',
  microphoneMode = false,
} = {}, previousContext = {}) => {
  const previousAnchorStatus = previousContext.anchorStatus ?? 'pending';
  const previousRuntimeStatus = previousContext.runtimeStatus ?? 'unknown';
  const previousMicrophoneMode = previousContext.microphoneMode ?? false;
  const hasAnchorWorkflow = ANCHOR_WORKFLOW_STATUSES.has(anchorStatus);
  const hadAnchorWorkflow = ANCHOR_WORKFLOW_STATUSES.has(previousAnchorStatus);
  const runtimeNeedsAttention = RUNTIME_ATTENTION_STATUSES.has(runtimeStatus);
  const runtimeNeededAttention = RUNTIME_ATTENTION_STATUSES.has(previousRuntimeStatus);
  const microphoneJustActivated = microphoneMode && !previousMicrophoneMode;

  return {
    ...currentSections,
    reconstruction: currentSections.reconstruction || (hasAnchorWorkflow && !hadAnchorWorkflow),
    diagnostics: currentSections.diagnostics || (hasAnchorWorkflow && !hadAnchorWorkflow),
    runtime: currentSections.runtime || (runtimeNeedsAttention && !runtimeNeededAttention),
    microphone: currentSections.microphone || microphoneJustActivated,
  };
};

export const createControlPanelContext = ({
  anchorStatus = 'pending',
  runtimeStatus = 'unknown',
  microphoneMode = false,
} = {}) => {
  return {
    anchorStatus,
    runtimeStatus,
    microphoneMode,
  };
};
