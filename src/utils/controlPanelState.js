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

export const CONTROL_PANEL_MIN_WIDTH = 280;
export const CONTROL_PANEL_MAX_WIDTH = 620;
export const CONTROL_PANEL_MIN_CAMERA_WIDTH = 110;

export const CONTROL_PANEL_TABS = [
  {
    id: 'track',
    label: 'Track',
    sections: ['status', 'controls', 'config', 'diagnostics'],
  },
  {
    id: 'reconstruct',
    label: 'Reconstruct',
    sections: ['reconstruction', 'diagnostics', 'config', 'controls'],
  },
  {
    id: 'head',
    label: 'Head',
    sections: ['personality', 'microphone', 'meshControls', 'controls'],
  },
  {
    id: 'debug',
    label: 'Debug',
    sections: ['diagnostics', 'metrics', 'logs'],
  },
  {
    id: 'system',
    label: 'System',
    sections: ['runtime', 'status', 'config', 'logs'],
  },
];

export const CONTROL_PANEL_TAB_IDS = CONTROL_PANEL_TABS.map(tab => tab.id);

export const clampControlPanelWidth = (width, viewportWidth) => {
  const maxWidth = Math.min(
    CONTROL_PANEL_MAX_WIDTH,
    Math.max(CONTROL_PANEL_MIN_WIDTH, viewportWidth - CONTROL_PANEL_MIN_CAMERA_WIDTH)
  );

  return Math.min(Math.max(width, CONTROL_PANEL_MIN_WIDTH), maxWidth);
};

export const createDefaultControlPanelWidth = (viewportWidth) => {
  return clampControlPanelWidth(Math.round(viewportWidth * 0.34), viewportWidth);
};

export const createDefaultSectionOrders = () => Object.fromEntries(
  CONTROL_PANEL_TABS.map(tab => [tab.id, [...tab.sections]])
);

export const selectControlPanelTabForWorkflow = ({
  anchorStatus = 'pending',
  runtimeStatus = 'unknown',
  microphoneMode = false,
} = {}) => {
  if (RUNTIME_ATTENTION_STATUSES.has(runtimeStatus)) return 'system';
  if (microphoneMode) return 'head';
  if (ANCHOR_WORKFLOW_STATUSES.has(anchorStatus)) return 'reconstruct';
  return 'track';
};

export const moveSectionInTabOrder = (sectionOrders, tabId, sectionId, direction) => {
  const currentOrder = sectionOrders[tabId] || [];
  const currentIndex = currentOrder.indexOf(sectionId);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= currentOrder.length) {
    return sectionOrders;
  }

  const nextOrder = [...currentOrder];
  const moved = nextOrder[currentIndex];
  nextOrder[currentIndex] = nextOrder[nextIndex];
  nextOrder[nextIndex] = moved;

  return {
    ...sectionOrders,
    [tabId]: nextOrder,
  };
};

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
