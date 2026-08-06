import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LOG_TAG_PRESETS, logger } from '../../utils/logger.js';
import { collectRuntimeReadiness } from '../../utils/runtimeReadiness.js';
import { DrawerSection, DynamicText, MetricPill } from './FieldControlPrimitives.jsx';
import { cx } from './uiClassNames.js';

const RuntimeReadiness = ({ readiness }) => (
  <div className="space-y-1 text-xs">
    {readiness.checks.map((check) => (
      <div
        key={check.id}
        className={cx(
          'rounded-md border px-2 py-1',
          check.ok
            ? 'border-emerald-900 bg-emerald-950/30 text-emerald-200'
            : check.severity === 'blocker'
              ? 'border-red-900 bg-red-950/40 text-red-200'
              : 'border-yellow-900 bg-yellow-950/40 text-yellow-200',
        )}
      >
        <div className="flex min-w-0 justify-between gap-2">
          <DynamicText className="flex-1">{check.label}</DynamicText>
          <span className="shrink-0 font-mono">{check.ok ? 'OK' : 'MISSING'}</span>
        </div>
        <DynamicText className="mt-0.5 block text-[10px] text-gray-400">{check.detail}</DynamicText>
      </div>
    ))}
  </div>
);

const RuntimeReadinessLoading = () => (
  <div role="status" aria-live="polite" className="rounded-md border border-white/10 px-2 py-2 text-xs">
    Checking runtime readiness…
  </div>
);

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
        {discoveredTags.map((tag) => (
          <label key={tag} className="flex min-h-9 min-w-0 items-center gap-2 text-gray-300">
            <input
              className="shrink-0"
              type="checkbox"
              checked={enabledTags.includes(tag)}
              onChange={() => logger.toggleTag(tag)}
            />
            <DynamicText className="font-mono text-[10px]">{tag}</DynamicText>
          </label>
        ))}
      </div>
    </div>
  );
};

const MetricsGrid = ({ metricStore }) => {
  const metrics = useSyncExternalStore(
    metricStore.subscribe,
    metricStore.getSnapshot,
    metricStore.getSnapshot,
  );

  return (
    <div className="grid gap-1 text-xs">
      {Object.entries(metrics)
        .slice(0, 12)
        .map(([name, metric]) => (
          <MetricPill
            key={name}
            label={name}
            value={
              metric.value !== null
                ? `${typeof metric.value === 'number' ? metric.value.toFixed(1) : metric.value}${metric.unit ? ` ${metric.unit}` : ''}`
                : 'N/A'
            }
            tone={metric.isRed ? 'bad' : 'neutral'}
          />
        ))}
    </div>
  );
};

export const FieldControlsSystem = ({ showStats, onShowStatsChange, metricStore }) => {
  const [runtimeReadiness, setRuntimeReadiness] = useState(null);
  const readinessCollectedRef = useRef(false);

  useEffect(() => {
    if (readinessCollectedRef.current) {
      return;
    }
    readinessCollectedRef.current = true;
    setRuntimeReadiness(collectRuntimeReadiness());
  }, []);

  return (
    <DrawerSection title="System">
      <div className="space-y-3">
        {runtimeReadiness ? <RuntimeReadiness readiness={runtimeReadiness} /> : <RuntimeReadinessLoading />}
        <div className="text-xs">
          <button
            type="button"
            aria-pressed={showStats}
            onClick={() => onShowStatsChange(!showStats)}
            className="min-h-10 w-full rounded-md border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {showStats ? 'Hide canvas debug' : 'Show canvas debug'}
          </button>
        </div>
        <MetricsGrid metricStore={metricStore} />
        <LogsSection />
      </div>
    </DrawerSection>
  );
};
