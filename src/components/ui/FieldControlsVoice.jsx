import { useSyncExternalStore } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { DrawerSection, DynamicText, MetricPill } from './FieldControlPrimitives.jsx';
import { PersonalityPanel } from './PersonalityPanel.jsx';
import { cx } from './uiClassNames.js';

const VoiceTelemetryPills = ({ microphoneActive, microphoneTelemetryStore }) => {
  const telemetry = useSyncExternalStore(
    microphoneTelemetryStore.subscribe,
    microphoneTelemetryStore.getSnapshot,
    microphoneTelemetryStore.getSnapshot,
  );

  return (
    <div className="grid grid-cols-2 gap-2">
      <MetricPill
        label="Mic"
        value={microphoneActive ? 'active' : 'idle'}
        tone={microphoneActive ? 'good' : 'neutral'}
      />
      <MetricPill
        label="Voice"
        value={telemetry.voiceActive ? 'active' : 'silent'}
        tone={telemetry.voiceActive ? 'good' : 'neutral'}
      />
      <MetricPill label="Energy" value={`${Math.round(telemetry.audioEnergy * 100)}%`} />
      <MetricPill label="Viseme" value={telemetry.currentViseme} />
    </div>
  );
};

const VoiceControls = ({
  microphoneMode,
  onMicrophoneModeChange,
  voiceActivityThreshold,
  onVoiceActivityThresholdChange,
  microphoneActive,
  microphoneError,
  microphoneTelemetryStore,
  onMicrophoneGainChange,
  onMicrophoneDebugModeChange,
  onResetMicrophoneBaseline,
  microphoneGain,
  microphoneDebugMode,
  ttsData,
}) => (
  <div className="space-y-3 text-xs">
    <button
      type="button"
      aria-pressed={microphoneMode}
      onClick={() => onMicrophoneModeChange(!microphoneMode)}
      className={cx(
        'flex min-h-11 w-full items-center justify-center gap-2 rounded-md border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
        microphoneMode
          ? 'border-emerald-500 bg-emerald-950 text-emerald-100'
          : 'border-white/10 bg-white/5 text-gray-200',
      )}
    >
      {microphoneMode ? <Mic size={16} aria-hidden="true" /> : <MicOff size={16} aria-hidden="true" />}
      {microphoneMode ? 'Microphone mode on' : 'Microphone mode off'}
    </button>
    <VoiceTelemetryPills
      microphoneActive={microphoneActive}
      microphoneTelemetryStore={microphoneTelemetryStore}
    />
    <label className="grid gap-1 text-gray-300">
      <span>Voice threshold</span>
      <input
        type="range"
        min="0.005"
        max="0.2"
        step="0.005"
        value={voiceActivityThreshold}
        onChange={(event) => onVoiceActivityThresholdChange(parseFloat(event.target.value))}
      />
    </label>
    <label className="grid gap-1 text-gray-300">
      <span>Mic gain: {microphoneGain.toFixed(1)}x</span>
      <input
        type="range"
        min="0.5"
        max="10"
        step="0.5"
        value={microphoneGain}
        onChange={(event) => onMicrophoneGainChange(parseFloat(event.target.value))}
      />
    </label>
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        aria-pressed={microphoneDebugMode}
        onClick={() => onMicrophoneDebugModeChange(!microphoneDebugMode)}
        className="min-h-10 rounded-md border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        Debug {microphoneDebugMode ? 'on' : 'off'}
      </button>
      <button
        type="button"
        onClick={onResetMicrophoneBaseline}
        className="min-h-10 rounded-md border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        Reset baseline
      </button>
    </div>
    {ttsData.error && (
      <div role="alert" className="min-w-0 rounded-md border border-red-900 bg-red-950/50 p-2 text-red-200">
        <DynamicText className="block">{ttsData.error}</DynamicText>
      </div>
    )}
    {microphoneError && (
      <div role="alert" className="min-w-0 rounded-md border border-red-900 bg-red-950/50 p-2 text-red-200">
        <DynamicText className="block">{microphoneError}</DynamicText>
      </div>
    )}
  </div>
);

export const FieldControlsVoice = ({
  hasActiveAnchor,
  microphoneMode,
  onMicrophoneModeChange,
  voiceActivityThreshold,
  onVoiceActivityThresholdChange,
  microphoneActive,
  microphoneError,
  microphoneTelemetryStore,
  onMicrophoneGainChange,
  onMicrophoneDebugModeChange,
  onResetMicrophoneBaseline,
  microphoneGain,
  microphoneDebugMode,
  personalityData,
  ttsData,
  onGeneratePersonality,
  onSpeakGreeting,
}) => (
  <>
    <DrawerSection title="Voice">
      <VoiceControls
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
        ttsData={ttsData}
      />
    </DrawerSection>
    <DrawerSection title="Personality">
      <PersonalityPanel
        personalityData={personalityData}
        ttsData={ttsData}
        onGeneratePersonality={onGeneratePersonality}
        onSpeakGreeting={onSpeakGreeting}
        hasActiveTrack={hasActiveAnchor}
      />
    </DrawerSection>
  </>
);
