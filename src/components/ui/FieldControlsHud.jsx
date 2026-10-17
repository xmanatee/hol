import { Mic, MicOff, RotateCcw, SlidersHorizontal, StopCircle } from 'lucide-react';
import { IconButton, MetricPill, SpeechStopButton } from './FieldControlPrimitives.jsx';

const getAnchorTone = (status) => {
  if (status.severity === 'good') return 'good';
  if (status.severity === 'bad') return 'bad';
  if (status.severity === 'warn') return 'warn';
  return 'neutral';
};

export const FieldControlsHud = ({
  anchorStatus,
  hasActiveAnchor,
  microphoneMode,
  microphoneActive,
  ttsData,
  onClearAnchor,
  onStopCamera,
  onStopSpeech,
  onMicrophoneModeChange,
  onOpen,
  triggerRef,
  open,
}) => {
  const anchorTone = getAnchorTone(anchorStatus);
  const anchorLabel = anchorStatus.status;
  const voiceActive = microphoneMode ? microphoneActive : ttsData.isPlaying;

  return (
    <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-40 w-[min(94vw,42rem)] -translate-x-1/2 text-white">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/70 p-2 shadow-2xl backdrop-blur-md">
        <MetricPill label="Anchor" value={anchorLabel} tone={anchorTone} />
        <MetricPill
          label="Voice"
          value={ttsData.isSynthesizing ? 'preparing' : voiceActive ? 'live' : 'idle'}
          tone={ttsData.isSynthesizing ? 'warn' : voiceActive ? 'good' : 'neutral'}
        />
        <div className="ml-auto flex items-center gap-1">
          <SpeechStopButton ttsData={ttsData} onStopSpeech={onStopSpeech} />
          <IconButton
            label={microphoneMode ? 'Disable microphone mode' : 'Enable microphone mode'}
            icon={microphoneMode ? Mic : MicOff}
            active={microphoneMode}
            aria-pressed={microphoneMode}
            onClick={() => onMicrophoneModeChange(!microphoneMode)}
          />
          {hasActiveAnchor && (
            <IconButton label="Clear anchor" icon={RotateCcw} tone="good" onClick={onClearAnchor} />
          )}
          <IconButton
            label="Debug drawer"
            icon={SlidersHorizontal}
            buttonRef={triggerRef}
            aria-controls="field-controls-drawer"
            aria-expanded={open}
            onClick={onOpen}
          />
          <IconButton label="Stop camera" icon={StopCircle} tone="danger" onClick={onStopCamera} />
        </div>
      </div>
    </div>
  );
};
