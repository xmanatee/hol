import { Mic, MicOff, RotateCcw, SlidersHorizontal, StopCircle } from 'lucide-react';
import { IconButton, MetricPill } from './FieldControlPrimitives.jsx';

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
  onMicrophoneModeChange,
  onOpen,
  triggerRef,
  open,
}) => {
  const anchorTone = getAnchorTone(anchorStatus);
  const anchorLabel = hasActiveAnchor ? anchorStatus.status : 'tap to anchor';
  const voiceActive = microphoneMode ? microphoneActive : ttsData.isPlaying;

  return (
    <div className="fixed bottom-4 left-1/2 z-40 w-[min(94vw,42rem)] -translate-x-1/2 text-white">
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/70 p-2 shadow-2xl backdrop-blur-md">
        <MetricPill label="Anchor" value={anchorLabel} tone={anchorTone} />
        <MetricPill
          label="Voice"
          value={voiceActive ? 'live' : 'idle'}
          tone={voiceActive ? 'good' : 'neutral'}
        />
        <div className="ml-auto flex items-center gap-1">
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
