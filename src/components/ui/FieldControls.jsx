import { useEffect, useState } from 'react';
import {
  Gauge,
  Mic,
  MicOff,
  RotateCcw,
  SlidersHorizontal,
  StopCircle,
  X,
} from 'lucide-react';
import { PersonalityPanel } from './PersonalityPanel.jsx';
import { ReconstructionPreviewSection } from './ReconstructionPreviewSection.jsx';
import { DiagnosticRow } from './DiagnosticRow.jsx';
import { formatNumber, formatPercent, formatRegion } from './diagnosticFormat.js';
import { LOG_TAG_PRESETS, logger } from '../../utils/logger.js';
import {
  RECONSTRUCTION_MODES,
  RECONSTRUCTION_POSE_MODEL,
} from '../../cv/anchor.reconstructionModes.js';

const TAB_IDS = ['anchor', 'voice', 'model', 'system'];
const ADVANCED_POSE_OPTIONS = [
  ['auto', 'Auto'],
  ...RECONSTRUCTION_MODES
    .filter(mode => mode.id !== RECONSTRUCTION_POSE_MODEL)
    .map(mode => [mode.id, mode.label]),
  ['object-pose', 'Object pose'],
];

const cx = (...classes) => classes.filter(Boolean).join(' ');

const IconButton = ({ label, icon, active = false, tone = 'neutral', className = '', ...props }) => {
  const IconComponent = icon;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'grid h-11 w-11 place-items-center rounded-md border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
        active ? 'border-white bg-white text-black' : 'border-white/15 bg-black/55 text-white hover:bg-white/10',
        tone === 'danger' && !active ? 'border-red-400/40 text-red-200 hover:bg-red-950/70' : '',
        tone === 'good' && !active ? 'border-emerald-400/40 text-emerald-200 hover:bg-emerald-950/70' : '',
        className
      )}
      {...props}
    >
      <IconComponent size={18} strokeWidth={2} aria-hidden="true" />
    </button>
  );
};

const MetricPill = ({ label, value, tone = 'neutral' }) => (
  <div className={cx(
    'min-w-0 rounded-md border px-2 py-1',
    tone === 'good' ? 'border-emerald-400/30 bg-emerald-950/40 text-emerald-100' :
      tone === 'warn' ? 'border-yellow-400/30 bg-yellow-950/40 text-yellow-100' :
        tone === 'bad' ? 'border-red-400/30 bg-red-950/40 text-red-100' :
          'border-white/10 bg-white/5 text-gray-200'
  )}>
    <div className="text-[10px] uppercase text-gray-400">{label}</div>
    <div className="truncate text-xs font-medium">{value}</div>
  </div>
);

const DrawerSection = ({ title, children, className = '' }) => (
  <section className={cx('border-b border-white/10 px-4 py-3 last:border-b-0', className)}>
    <h3 className="mb-2 text-xs font-semibold uppercase text-gray-400">{title}</h3>
    {children}
  </section>
);

const getAnchorTone = diagnostics => {
  if (!diagnostics) return 'neutral';
  if (diagnostics.severity === 'good') return 'good';
  if (diagnostics.severity === 'bad') return 'bad';
  if (diagnostics.severity === 'warn') return 'warn';
  return 'neutral';
};

const CompactHud = ({
  cameraState,
  anchorDiagnostics,
  activeTrackId,
  microphoneMode,
  microphoneActive,
  ttsData,
  detectionEnabled,
  onUnlock,
  onStop,
  onToggleMicrophoneMode,
  onOpenDebug,
}) => {
  const anchorTone = getAnchorTone(anchorDiagnostics);
  const anchorLabel = activeTrackId
    ? anchorDiagnostics?.status || 'anchored'
    : cameraState === 'active' ? 'tap to anchor' : cameraState;
  const voiceActive = microphoneMode ? microphoneActive : ttsData?.isPlaying;

  return (
    <div className="fixed bottom-4 left-1/2 z-40 w-[min(94vw,42rem)] -translate-x-1/2 text-white">
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/70 p-2 shadow-2xl backdrop-blur-md">
        <MetricPill label="Anchor" value={anchorLabel} tone={anchorTone} />
        <MetricPill label="Voice" value={voiceActive ? 'live' : 'idle'} tone={voiceActive ? 'good' : 'neutral'} />
        <MetricPill label="Detect" value={detectionEnabled ? 'debug' : 'off'} tone={detectionEnabled ? 'warn' : 'neutral'} />
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label={microphoneMode ? 'Disable microphone mode' : 'Enable microphone mode'}
            icon={microphoneMode ? Mic : MicOff}
            active={microphoneMode}
            onClick={() => onToggleMicrophoneMode?.(!microphoneMode)}
          />
          {activeTrackId && (
            <IconButton label="Clear anchor" icon={RotateCcw} tone="good" onClick={onUnlock} />
          )}
          <IconButton label="Debug drawer" icon={SlidersHorizontal} onClick={onOpenDebug} />
          <IconButton label="Stop camera" icon={StopCircle} tone="danger" onClick={onStop} />
        </div>
      </div>
    </div>
  );
};

const AnchorDiagnostics = ({ diagnostics }) => {
  if (!diagnostics) {
    return <div className="text-xs text-gray-400">Anchor diagnostics appear after camera startup.</div>;
  }

  const details = diagnostics.details || {};
  const refreshValue = details.landmarkRefreshReason
    ? `${details.landmarkRefreshReason} +${details.landmarkRefreshAdded ?? 0}/${details.landmarkRefreshTotal ?? 0}`
    : 'idle';
  const supportValue = details.segmentationRefreshReason
    ? `${details.segmentationRefreshReason} @ ${details.segmentationRefreshFrame ?? 'N/A'}`
    : 'idle';
  return (
    <div className="space-y-1 text-xs">
      <div className={cx(
        'mb-2 rounded-md border px-2 py-2',
        diagnostics.severity === 'good' ? 'border-emerald-600 bg-emerald-950/60 text-emerald-100' :
          diagnostics.severity === 'bad' ? 'border-red-600 bg-red-950/60 text-red-100' :
            diagnostics.severity === 'warn' ? 'border-yellow-600 bg-yellow-950/60 text-yellow-100' :
              'border-white/10 bg-white/5 text-gray-200'
      )}>
        <div className="font-medium">{diagnostics.message}</div>
        <div className="mt-1 text-[10px] opacity-75">{diagnostics.recommendation}</div>
      </div>
      <DiagnosticRow label="Status" value={diagnostics.status} tone={diagnostics.severity} />
      <DiagnosticRow label="Keypoints" value={details.keypointCount ?? 0} tone={(details.keypointCount ?? 0) >= 12 ? 'good' : 'warn'} />
      <DiagnosticRow label="Object landmarks" value={details.objectOwnedLandmarks ?? 0} tone={(details.objectOwnedLandmarks ?? 0) >= 8 ? 'good' : 'warn'} />
      <DiagnosticRow label="Mask coverage" value={formatPercent(details.maskCoverage)} tone={(details.maskCoverage ?? 0) > 0.03 ? 'good' : 'warn'} />
      <DiagnosticRow label="Mask source" value={details.currentObjectSupportMaskSource || details.objectSupportMaskSource || 'N/A'} />
      <DiagnosticRow label="Surface" value={details.surfacePrior || details.surfaceModel || 'N/A'} />
      <DiagnosticRow label="Surface coverage" value={formatPercent(details.surfaceCoverage)} tone={(details.surfaceCoverage ?? 0) > 0.45 ? 'good' : 'warn'} />
      <DiagnosticRow label="Silhouette" value={formatPercent(details.silhouetteCoverage)} tone={(details.silhouetteCoverage ?? 0) > 0.35 ? 'good' : 'warn'} />
      <DiagnosticRow label="Contour residual" value={formatNumber(details.contourFitResidual, 1)} tone={(details.contourFitResidual ?? 0) <= 5 ? 'good' : 'warn'} />
      <DiagnosticRow label="Locked landmarks" value={details.surfaceLockedLandmarks ?? 0} tone={(details.surfaceLockedLandmarks ?? 0) >= 12 ? 'good' : 'warn'} />
      <DiagnosticRow label="Occlusion" value={details.occlusionState || 'N/A'} tone={details.occlusionState === 'visible' ? 'good' : 'warn'} />
      <DiagnosticRow label="Support refresh" value={supportValue} tone={details.segmentationRefreshReason ? 'good' : 'neutral'} />
      <DiagnosticRow label="Landmark refresh" value={refreshValue} tone={(details.landmarkRefreshAdded ?? 0) > 0 ? 'good' : 'neutral'} />
      <DiagnosticRow label="Rejected by mask" value={details.landmarkRefreshRejectedByMask ?? 0} />
      <DiagnosticRow label="Tracking success" value={formatPercent(details.trackingSuccessRate)} />
      <DiagnosticRow label="Pose model" value={details.poseModel || 'auto'} />
      <DiagnosticRow label="Pose source" value={details.poseSource || 'N/A'} />
      <DiagnosticRow label="Pose candidate" value={details.poseCandidateSource || 'N/A'} />
      <DiagnosticRow label="Pose rejection" value={details.poseRejectedReason || details.poseSourceHoldReason || 'N/A'} />
      <DiagnosticRow label="3D map" value={details.reconstructionState || 'inactive'} tone={details.reconstructionReady ? 'good' : 'warn'} />
      <DiagnosticRow label="3D landmarks" value={details.reconstructionLandmarks ?? 0} />
      <DiagnosticRow label="3D rejection" value={details.reconstructionPoseRejectedReason || details.reconstructionFailureReason || 'N/A'} />
      <DiagnosticRow label="Processing" value={`${formatNumber(details.processingTime, 1)} ms`} />
      <DiagnosticRow label="Template region" value={formatRegion(details.templateRegion)} />
      <DiagnosticRow label="Tracking region" value={formatRegion(details.trackingRegion)} />
      <DiagnosticRow label="Support bounds" value={formatRegion(details.currentObjectSupportMaskBounds || details.objectSupportMaskBounds)} />
    </div>
  );
};

const RuntimeReadiness = ({ readiness }) => {
  if (!readiness) {
    return <div className="text-xs text-gray-400">Runtime checks are unavailable.</div>;
  }

  return (
    <div className="space-y-1 text-xs">
      {readiness.checks.map(check => (
        <div
          key={check.id}
          className={cx(
            'rounded-md border px-2 py-1',
            check.ok ? 'border-emerald-900 bg-emerald-950/30 text-emerald-200' :
              check.severity === 'blocker' ? 'border-red-900 bg-red-950/40 text-red-200' :
                'border-yellow-900 bg-yellow-950/40 text-yellow-200'
          )}
        >
          <div className="flex justify-between gap-2">
            <span>{check.label}</span>
            <span className="font-mono">{check.ok ? 'OK' : 'MISSING'}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-gray-400">{check.detail}</div>
        </div>
      ))}
    </div>
  );
};

const LogsSection = () => {
  const [discoveredTags, setDiscoveredTags] = useState([]);
  const [enabledTags, setEnabledTags] = useState([]);

  useEffect(() => {
    const updateTags = (discovered, enabled) => {
      setDiscoveredTags(discovered);
      setEnabledTags(enabled);
    };

    updateTags(logger.getAllTags(), logger.getEnabledTags());
    return logger.addListener(updateTags);
  }, []);

  return (
    <div className="space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-1">
        {Object.entries(LOG_TAG_PRESETS).map(([presetId, preset]) => (
          <button
            key={presetId}
            type="button"
            onClick={() => logger.applyPreset(presetId)}
            className="min-h-10 rounded-md border border-white/10 bg-white/5 px-2 text-[10px] text-gray-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="grid gap-1">
        {discoveredTags.map(tag => (
          <label key={tag} className="flex min-h-9 items-center gap-2 text-gray-300">
            <input
              type="checkbox"
              checked={enabledTags.includes(tag)}
              onChange={() => logger.toggleTag(tag)}
            />
            <span className="font-mono text-[10px]">{tag}</span>
          </label>
        ))}
      </div>
    </div>
  );
};

const MeshControls = ({ discoveredMeshes, hiddenMeshes, onMeshVisibilityChange, onRotationChange }) => {
  const [rotation, setRotation] = useState({ x: 0, y: 0, z: 0 });

  const updateRotation = (axis, value) => {
    const next = { ...rotation, [axis]: value };
    setRotation(next);
    onRotationChange?.(next);
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="grid gap-2">
        {['x', 'y', 'z'].map(axis => (
          <label key={axis} className="grid gap-1 text-gray-300">
            <span>{axis.toUpperCase()} rotation: {(rotation[axis] * 180 / Math.PI).toFixed(0)} deg</span>
            <input
              type="range"
              min={-Math.PI}
              max={Math.PI}
              step={0.1}
              value={rotation[axis]}
              onChange={event => updateRotation(axis, parseFloat(event.target.value))}
            />
          </label>
        ))}
      </div>
      <div className="grid gap-1">
        {discoveredMeshes.length === 0 && <div className="text-gray-400">Meshes appear after the model loads.</div>}
        {discoveredMeshes.map(meshName => (
          <label key={meshName} className="flex min-h-9 items-center gap-2 text-gray-300">
            <input
              type="checkbox"
              checked={!hiddenMeshes.has(meshName)}
              onChange={() => onMeshVisibilityChange?.(meshName, hiddenMeshes.has(meshName))}
            />
            <span className="truncate font-mono text-[10px]">{meshName}</span>
          </label>
        ))}
      </div>
    </div>
  );
};

const VoiceControls = ({
  microphoneMode,
  onToggleMicrophoneMode,
  voiceActivityThreshold,
  onVoiceActivityThresholdChange,
  microphoneActive,
  currentViseme,
  audioEnergy,
  isVoiceActive,
  onMicrophoneGainChange,
  onToggleMicrophoneDebug,
  onResetMicrophoneBaseline,
  microphoneGain,
  microphoneDebugMode,
  ttsData,
}) => (
  <div className="space-y-3 text-xs">
    <button
      type="button"
      onClick={() => onToggleMicrophoneMode?.(!microphoneMode)}
      className={cx(
        'flex min-h-11 w-full items-center justify-center gap-2 rounded-md border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
        microphoneMode ? 'border-emerald-500 bg-emerald-950 text-emerald-100' : 'border-white/10 bg-white/5 text-gray-200'
      )}
    >
      {microphoneMode ? <Mic size={16} aria-hidden="true" /> : <MicOff size={16} aria-hidden="true" />}
      {microphoneMode ? 'Microphone mode on' : 'Microphone mode off'}
    </button>
    <div className="grid grid-cols-2 gap-2">
      <MetricPill label="Mic" value={microphoneActive ? 'active' : 'idle'} tone={microphoneActive ? 'good' : 'neutral'} />
      <MetricPill label="Voice" value={isVoiceActive ? 'active' : 'silent'} tone={isVoiceActive ? 'good' : 'neutral'} />
      <MetricPill label="Energy" value={`${Math.round((audioEnergy || 0) * 100)}%`} />
      <MetricPill label="Viseme" value={currentViseme || 'M'} />
    </div>
    <label className="grid gap-1 text-gray-300">
      <span>Voice threshold</span>
      <input
        type="range"
        min="0.005"
        max="0.2"
        step="0.005"
        value={voiceActivityThreshold}
        onChange={event => onVoiceActivityThresholdChange?.(parseFloat(event.target.value))}
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
        onChange={event => onMicrophoneGainChange?.(parseFloat(event.target.value))}
      />
    </label>
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={() => onToggleMicrophoneDebug?.(!microphoneDebugMode)}
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
    {ttsData?.error && <div className="rounded-md border border-red-900 bg-red-950/50 p-2 text-red-200">{ttsData.error}</div>}
  </div>
);

const ModelControls = ({
  anchorTrackingMode,
  onConfigChange,
  discoveredMeshes,
  hiddenMeshes,
  onMeshVisibilityChange,
  onRotationChange,
}) => {
  const selectedMode = anchorTrackingMode === RECONSTRUCTION_POSE_MODEL
    ? 'auto'
    : anchorTrackingMode;

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-1">
        {ADVANCED_POSE_OPTIONS.map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => onConfigChange?.({ anchorTrackingMode: mode })}
            className={cx(
              'min-h-10 rounded-md border px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
              selectedMode === mode ? 'border-emerald-500 bg-emerald-950 text-emerald-100' : 'border-white/10 bg-white/5 text-gray-300'
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <MeshControls
        discoveredMeshes={discoveredMeshes}
        hiddenMeshes={hiddenMeshes}
        onMeshVisibilityChange={onMeshVisibilityChange}
        onRotationChange={onRotationChange}
      />
    </div>
  );
};

const SystemControls = ({
  runtimeReadiness,
  detectionEnabled,
  showStats,
  onToggleStats,
  onConfigChange,
  metrics,
}) => {
  const [detectionInterval, setDetectionInterval] = useState(4);

  return (
    <div className="space-y-3">
      <RuntimeReadiness readiness={runtimeReadiness} />
      <div className="grid grid-cols-2 gap-2 text-xs">
        <button
          type="button"
          onClick={() => onToggleStats?.()}
          className="min-h-10 rounded-md border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          {showStats ? 'Hide canvas debug' : 'Show canvas debug'}
        </button>
        <button
          type="button"
          onClick={() => onConfigChange?.({ detectionEnabled: !detectionEnabled })}
          className={cx(
            'min-h-10 rounded-md border hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
            detectionEnabled ? 'border-yellow-500 bg-yellow-950 text-yellow-100' : 'border-white/10 bg-white/5 text-gray-200'
          )}
        >
          Detection {detectionEnabled ? 'on' : 'off'}
        </button>
      </div>
      <label className="grid gap-1 text-xs text-gray-300">
        <span>Detection interval: {detectionInterval} frames</span>
        <input
          type="range"
          min="1"
          max="8"
          value={detectionInterval}
          onChange={event => {
            const value = parseInt(event.target.value);
            setDetectionInterval(value);
            onConfigChange?.({ detectionInterval: value });
          }}
        />
      </label>
      <div className="grid gap-1 text-xs">
        {Object.entries(metrics).slice(0, 12).map(([name, metric]) => (
          <MetricPill
            key={name}
            label={name}
            value={metric.value !== null ? `${typeof metric.value === 'number' ? metric.value.toFixed(1) : metric.value}${metric.unit ? ` ${metric.unit}` : ''}` : 'N/A'}
            tone={metric.isRed ? 'bad' : 'neutral'}
          />
        ))}
      </div>
      <LogsSection />
    </div>
  );
};

const FieldControls = ({
  cameraState,
  detectionEnabled = false,
  activeTrackId,
  showStats,
  onToggleStats,
  onUnlock,
  onStop,
  onConfigChange,
  metrics = {},
  depthState = null,
  anchorDiagnostics,
  anchorTrackingMode = 'sparse-reconstruction',
  runtimeReadiness,
  personalityData,
  ttsData,
  onGeneratePersonality,
  onSpeakGreeting,
  discoveredMeshes = [],
  hiddenMeshes = new Set(),
  onMeshVisibilityChange,
  onRotationChange,
  microphoneMode = false,
  onToggleMicrophoneMode,
  voiceActivityThreshold = 0.02,
  onVoiceActivityThresholdChange,
  microphoneActive = false,
  currentViseme = 'M',
  audioEnergy = 0,
  isVoiceActive = false,
  onMicrophoneGainChange,
  onToggleMicrophoneDebug,
  onResetMicrophoneBaseline,
  microphoneGain = 3.0,
  microphoneDebugMode = false,
  isVisible,
  onVisibilityChange,
}) => {
  const [internalVisible, setInternalVisible] = useState(false);
  const [activeTab, setActiveTab] = useState('anchor');
  const visible = isVisible ?? internalVisible;
  const setVisible = onVisibilityChange ?? setInternalVisible;

  return (
    <>
      <CompactHud
        cameraState={cameraState}
        anchorDiagnostics={anchorDiagnostics}
        activeTrackId={activeTrackId}
        microphoneMode={microphoneMode}
        microphoneActive={microphoneActive}
        ttsData={ttsData}
        detectionEnabled={detectionEnabled}
        onUnlock={onUnlock}
        onStop={onStop}
        onToggleMicrophoneMode={onToggleMicrophoneMode}
        onOpenDebug={() => setVisible(true)}
      />

      {visible && (
        <aside className="fixed inset-x-0 bottom-0 z-50 flex max-h-[82dvh] flex-col overflow-hidden rounded-t-xl border border-white/10 bg-black/90 pb-[env(safe-area-inset-bottom)] text-white shadow-2xl backdrop-blur-xl overscroll-contain md:inset-y-3 md:left-auto md:right-3 md:max-h-none md:w-[24rem] md:rounded-xl md:pb-0">
          <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Gauge size={17} aria-hidden="true" />
              <div>
                <div className="text-sm font-semibold">Field controls</div>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close debug drawer"
              onClick={() => setVisible(false)}
              className="ml-auto grid h-10 w-10 place-items-center rounded-md border border-white/10 bg-white/5 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>

          <div className="grid shrink-0 grid-cols-4 border-b border-white/10">
            {TAB_IDS.map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cx(
                  'min-h-11 border-r border-white/10 text-xs capitalize last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70',
                  activeTab === tab ? 'bg-white text-black' : 'bg-transparent text-gray-300 hover:bg-white/10'
                )}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {activeTab === 'anchor' && (
              <>
                <DrawerSection title="Anchor">
                  <AnchorDiagnostics diagnostics={anchorDiagnostics} />
                </DrawerSection>
                <DrawerSection title="3D reconstruction">
                  <ReconstructionPreviewSection details={{
                    ...(anchorDiagnostics?.details || {}),
                    poseModel: anchorDiagnostics?.details?.poseModel || anchorTrackingMode,
                    reconstructionDepthStatus: anchorDiagnostics?.details?.reconstructionDepthStatus ?? depthState?.state,
                    reconstructionDepthProvider: anchorDiagnostics?.details?.reconstructionDepthProvider ?? depthState?.provider,
                    reconstructionDepthInferenceTime: anchorDiagnostics?.details?.reconstructionDepthInferenceTime ?? depthState?.processingTime,
                  }} embedded />
                </DrawerSection>
              </>
            )}

            {activeTab === 'voice' && (
              <>
                <DrawerSection title="Voice">
                  <VoiceControls
                    microphoneMode={microphoneMode}
                    onToggleMicrophoneMode={onToggleMicrophoneMode}
                    voiceActivityThreshold={voiceActivityThreshold}
                    onVoiceActivityThresholdChange={onVoiceActivityThresholdChange}
                    microphoneActive={microphoneActive}
                    currentViseme={currentViseme}
                    audioEnergy={audioEnergy}
                    isVoiceActive={isVoiceActive}
                    onMicrophoneGainChange={onMicrophoneGainChange}
                    onToggleMicrophoneDebug={onToggleMicrophoneDebug}
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
                  />
                </DrawerSection>
              </>
            )}

            {activeTab === 'model' && (
              <DrawerSection title="Model">
                <ModelControls
                  anchorTrackingMode={anchorTrackingMode}
                  onConfigChange={onConfigChange}
                  discoveredMeshes={discoveredMeshes}
                  hiddenMeshes={hiddenMeshes}
                  onMeshVisibilityChange={onMeshVisibilityChange}
                  onRotationChange={onRotationChange}
                />
              </DrawerSection>
            )}

            {activeTab === 'system' && (
              <DrawerSection title="System">
                <SystemControls
                  runtimeReadiness={runtimeReadiness}
                  detectionEnabled={detectionEnabled}
                  showStats={showStats}
                  onToggleStats={onToggleStats}
                  onConfigChange={onConfigChange}
                  metrics={metrics}
                />
              </DrawerSection>
            )}
          </div>

          <div className={cx('grid shrink-0 gap-2 border-t border-white/10 p-3', activeTrackId ? 'grid-cols-2' : 'grid-cols-1')}>
            {activeTrackId && (
              <button
                type="button"
                onClick={onUnlock}
                className="min-h-11 rounded-md border border-emerald-500/40 bg-emerald-950/50 text-sm text-emerald-100 hover:bg-emerald-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                Clear anchor
              </button>
            )}
            <button
              type="button"
              onClick={onStop}
              className="min-h-11 rounded-md border border-red-500/40 bg-red-950/50 text-sm text-red-100 hover:bg-red-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Stop camera
            </button>
          </div>
        </aside>
      )}
    </>
  );
};

export default FieldControls;
