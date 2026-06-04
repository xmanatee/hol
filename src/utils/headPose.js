const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const computeHeadLocalRotation = (manualRotation = { x: 0, y: 0, z: 0 }) => ({
  x: manualRotation.x,
  y: manualRotation.y,
  z: manualRotation.z,
});

export const computeEyeGazeRotation = ({
  eyePosition,
  cameraPosition,
  maxYaw = 0.32,
  maxPitch = 0.22,
}) => {
  const dx = cameraPosition.x - eyePosition.x;
  const dy = cameraPosition.y - eyePosition.y;
  const dz = cameraPosition.z - eyePosition.z;
  const yaw = clamp(Math.atan2(dx, Math.max(0.0001, dz)), -maxYaw, maxYaw);
  const pitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -maxPitch, maxPitch);

  return { x: pitch, y: yaw, z: 0 };
};
