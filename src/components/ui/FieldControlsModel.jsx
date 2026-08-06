import { RECONSTRUCTION_MODES, RECONSTRUCTION_POSE_MODEL } from '../../cv/anchor.reconstructionModes.js';
import { DrawerSection, DynamicText } from './FieldControlPrimitives.jsx';
import { cx } from './uiClassNames.js';

const ADVANCED_POSE_OPTIONS = [
  ['auto', 'Auto'],
  ...RECONSTRUCTION_MODES.filter((mode) => mode.id !== RECONSTRUCTION_POSE_MODEL).map((mode) => [
    mode.id,
    mode.label,
  ]),
  ['object-pose', 'Object pose'],
];

const MeshControls = ({
  discoveredMeshes,
  hiddenMeshes,
  rotation,
  onMeshVisibilityChange,
  onRotationChange,
}) => {
  const updateRotation = (axis, degrees) => {
    onRotationChange({ ...rotation, [axis]: (degrees * Math.PI) / 180 });
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="grid gap-2">
        {['x', 'y', 'z'].map((axis) => (
          <label key={axis} className="grid gap-1 text-gray-300">
            <span>
              {axis.toUpperCase()} rotation: {((rotation[axis] * 180) / Math.PI).toFixed(0)} deg
            </span>
            <input
              type="range"
              min="-180"
              max="180"
              step="1"
              value={Math.round((rotation[axis] * 180) / Math.PI)}
              onChange={(event) => updateRotation(axis, parseFloat(event.target.value))}
            />
          </label>
        ))}
      </div>
      <div className="grid gap-1">
        {discoveredMeshes.length === 0 && (
          <div className="text-gray-400">Meshes appear after the model loads.</div>
        )}
        {discoveredMeshes.map((meshName) => (
          <label key={meshName} className="flex min-h-9 min-w-0 items-center gap-2 text-gray-300">
            <input
              className="shrink-0"
              type="checkbox"
              checked={!hiddenMeshes.has(meshName)}
              onChange={(event) => onMeshVisibilityChange(meshName, event.target.checked)}
            />
            <DynamicText className="font-mono text-[10px]">{meshName}</DynamicText>
          </label>
        ))}
      </div>
    </div>
  );
};

export const FieldControlsModel = ({
  anchorTrackingMode,
  onAnchorTrackingModeChange,
  discoveredMeshes,
  hiddenMeshes,
  rotation,
  onMeshVisibilityChange,
  onRotationChange,
}) => {
  const selectedMode = anchorTrackingMode === RECONSTRUCTION_POSE_MODEL ? 'auto' : anchorTrackingMode;

  return (
    <DrawerSection title="Model">
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-2 gap-1">
          {ADVANCED_POSE_OPTIONS.map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={selectedMode === mode}
              onClick={() => onAnchorTrackingModeChange(mode)}
              className={cx(
                'min-h-10 rounded-md border px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
                selectedMode === mode
                  ? 'border-emerald-500 bg-emerald-950 text-emerald-100'
                  : 'border-white/10 bg-white/5 text-gray-300',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <MeshControls
          discoveredMeshes={discoveredMeshes}
          hiddenMeshes={hiddenMeshes}
          rotation={rotation}
          onMeshVisibilityChange={onMeshVisibilityChange}
          onRotationChange={onRotationChange}
        />
      </div>
    </DrawerSection>
  );
};
