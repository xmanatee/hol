const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const computeHeadLocalRotation = (manualRotation = { x: 0, y: 0, z: 0 }) => ({
  x: manualRotation.x,
  y: manualRotation.y,
  z: manualRotation.z,
});

export const writeEyeGazeRotation = (eyePosition, cameraPosition, target, maxYaw, maxPitch) => {
  const dx = cameraPosition.x - eyePosition.x;
  const dy = cameraPosition.y - eyePosition.y;
  const dz = cameraPosition.z - eyePosition.z;
  target.x = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -maxPitch, maxPitch);
  target.y = clamp(Math.atan2(dx, Math.max(0.0001, dz)), -maxYaw, maxYaw);
  target.z = 0;
  return target;
};
