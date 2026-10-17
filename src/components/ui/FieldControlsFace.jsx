import { DrawerSection, DynamicText } from './FieldControlPrimitives.jsx';

export const FieldControlsFace = ({
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
    <DrawerSection title="Face">
      <p className="mb-3 text-xs text-gray-300">The face follows the selected surface automatically.</p>
      <details className="text-xs">
        <summary className="min-h-11 cursor-pointer py-3 text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
          Rig adjustments
        </summary>
        <div className="space-y-3">
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
              <label key={meshName} className="flex min-h-11 min-w-0 items-center gap-2 text-gray-300">
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
      </details>
    </DrawerSection>
  );
};
