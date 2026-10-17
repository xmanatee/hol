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
    <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(0.5rem,env(safe-area-inset-left))] right-[max(0.5rem,env(safe-area-inset-right))] z-40 mx-auto max-h-[calc(100dvh_-_max(1rem,env(safe-area-inset-bottom))_-_max(1rem,env(safe-area-inset-top)))] max-w-[42rem] overflow-y-auto overscroll-contain text-white">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/70 p-2 shadow-2xl backdrop-blur-md">
        <MetricPill label="Anchor" value={anchorLabel} tone={anchorTone} />
        <MetricPill
          label="Voice"
          value={ttsData.isSynthesizing ? 'preparing' : voiceActive ? 'live' : 'idle'}
          tone={ttsData.isSynthesizing ? 'warn' : voiceActive ? 'good' : 'neutral'}
        />
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
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
