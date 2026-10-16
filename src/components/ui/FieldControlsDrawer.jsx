import { useRef } from 'react';
import { FieldControlsAnchor } from './FieldControlsAnchor.jsx';
import { FieldControlsModel } from './FieldControlsModel.jsx';
import { FieldControlsSystem } from './FieldControlsSystem.jsx';
import { FieldControlsVoice } from './FieldControlsVoice.jsx';
import { cx } from './uiClassNames.js';
import FieldControlsDialog from './FieldControlsDialog.jsx';

const TAB_IDS = ['anchor', 'voice', 'model', 'system'];

const FieldControlsDrawer = ({
  activeTab,
  anchorStatus,
  anchorSystemState,
  anchorTrackingMode,
  depthStateStore,
  discoveredMeshes,
  hasActiveAnchor,
  hiddenMeshes,
  metricStore,
  microphoneActive,
  microphoneDebugMode,
  microphoneError,
  microphoneGain,
  microphoneMode,
  microphoneTelemetryStore,
  onActiveTabChange,
  onAnchorTrackingModeChange,
  onClearAnchor,
  onGeneratePersonality,
  onMeshVisibilityChange,
  onMicrophoneDebugModeChange,
  onMicrophoneGainChange,
  onMicrophoneModeChange,
  onOpenChange,
  onResetMicrophoneBaseline,
  onRotationChange,
  onShowStatsChange,
  onSpeakGreeting,
  onStopCamera,
  onVoiceActivityThresholdChange,
  personalityData,
  rotation,
  showStats,
  ttsData,
  voiceActivityThreshold,
}) => {
  const tabRefs = useRef([]);

  const handleTabKeyDown = (event, currentIndex) => {
    let nextIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % TAB_IDS.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + TAB_IDS.length) % TAB_IDS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = TAB_IDS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    onActiveTabChange(TAB_IDS[nextIndex]);
    tabRefs.current[nextIndex].focus();
  };

  return (
    <FieldControlsDialog onOpenChange={onOpenChange}>
      <div
        role="tablist"
        aria-label="Field control sections"
        className="grid shrink-0 grid-cols-4 border-b border-white/10"
      >
        {TAB_IDS.map((tab, index) => (
          <button
            key={tab}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`field-controls-tab-${tab}`}
            aria-controls="field-controls-panel"
            aria-selected={activeTab === tab}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => onActiveTabChange(tab)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            className={cx(
              'min-h-11 min-w-0 [overflow-wrap:anywhere] border-r border-white/10 text-xs capitalize last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70',
              activeTab === tab ? 'bg-white text-black' : 'bg-transparent text-gray-300 hover:bg-white/10',
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div
        id="field-controls-panel"
        role="tabpanel"
        aria-labelledby={`field-controls-tab-${activeTab}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
      >
        {activeTab === 'anchor' && (
          <FieldControlsAnchor
            anchorStatus={anchorStatus}
            anchorSystemState={anchorSystemState}
            anchorTrackingMode={anchorTrackingMode}
            depthStateStore={depthStateStore}
          />
        )}

        {activeTab === 'voice' && (
          <FieldControlsVoice
            hasActiveAnchor={hasActiveAnchor}
            microphoneMode={microphoneMode}
            onMicrophoneModeChange={onMicrophoneModeChange}
            voiceActivityThreshold={voiceActivityThreshold}
            onVoiceActivityThresholdChange={onVoiceActivityThresholdChange}
            microphoneActive={microphoneActive}
            microphoneError={microphoneError}
            microphoneTelemetryStore={microphoneTelemetryStore}
            onMicrophoneGainChange={onMicrophoneGainChange}
            onMicrophoneDebugModeChange={onMicrophoneDebugModeChange}
            onResetMicrophoneBaseline={onResetMicrophoneBaseline}
            microphoneGain={microphoneGain}
            microphoneDebugMode={microphoneDebugMode}
            personalityData={personalityData}
            ttsData={ttsData}
            onGeneratePersonality={onGeneratePersonality}
            onSpeakGreeting={onSpeakGreeting}
          />
        )}

        {activeTab === 'model' && (
          <FieldControlsModel
            anchorTrackingMode={anchorTrackingMode}
            onAnchorTrackingModeChange={onAnchorTrackingModeChange}
            discoveredMeshes={discoveredMeshes}
            hiddenMeshes={hiddenMeshes}
            rotation={rotation}
            onMeshVisibilityChange={onMeshVisibilityChange}
            onRotationChange={onRotationChange}
          />
        )}

        {activeTab === 'system' && (
          <FieldControlsSystem
            showStats={showStats}
            onShowStatsChange={onShowStatsChange}
            metricStore={metricStore}
          />
        )}
      </div>

      <div
        className={cx(
          'grid shrink-0 gap-2 border-t border-white/10 p-3',
          hasActiveAnchor ? 'grid-cols-2' : 'grid-cols-1',
        )}
      >
        {hasActiveAnchor && (
          <button
            type="button"
            onClick={onClearAnchor}
            className="min-h-11 rounded-md border border-emerald-500/40 bg-emerald-950/50 text-sm text-emerald-100 hover:bg-emerald-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            Clear anchor
          </button>
        )}
        <button
          type="button"
          onClick={onStopCamera}
          className="min-h-11 rounded-md border border-red-500/40 bg-red-950/50 text-sm text-red-100 hover:bg-red-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          Stop camera
        </button>
      </div>
    </FieldControlsDialog>
  );
};

export default FieldControlsDrawer;
