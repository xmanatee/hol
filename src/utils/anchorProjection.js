const DEFAULT_FOV = 63;
const DEFAULT_CAMERA_DISTANCE = 3;
const MIN_SCALE = 0.28;
const MAX_SCALE = 1.35;
const NORMAL_TILT_LIMIT = 0.95;
const NORMAL_TILT_GAIN = 1.12;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const getAnchorPixelSize = (activeAnchor, width, height) => {
  const detection = activeAnchor.sourceDetection;
  if (detection) {
    return Math.max(detection.x2 - detection.x1, detection.y2 - detection.y1);
  }
  return Math.min(width, height) * 0.18;
};

const isLiveAnchorState = (anchorState) => {
  return anchorState?.anchored && anchorState.state !== 'lost' && anchorState.state !== 'inactive';
};

export const computeAnchorOverlayTransform = ({
  width,
  height,
  activeAnchor,
  anchorState,
  fov = DEFAULT_FOV,
  cameraDistance = DEFAULT_CAMERA_DISTANCE,
  renderWidth = width,
  renderHeight = height,
}) => {
  if (!width || !height || !renderWidth || !renderHeight || !activeAnchor?.position || !isLiveAnchorState(anchorState)) {
    return {
      visible: false,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: MIN_SCALE,
    };
  }

  const fovRadians = fov * Math.PI / 180;
  const viewHeight = 2 * Math.tan(fovRadians / 2) * cameraDistance;
  const viewWidth = viewHeight * (renderWidth / renderHeight);
  const clampedX = clamp(activeAnchor.position.x, 0, width);
  const clampedY = clamp(activeAnchor.position.y, 0, height);
  const worldX = (clampedX / width - 0.5) * viewWidth;
  const worldY = (0.5 - clampedY / height) * viewHeight;
  const anchorPixelSize = getAnchorPixelSize(activeAnchor, width, height);
  const worldPixelSize = anchorPixelSize / height * viewHeight;
  const scale = clamp(worldPixelSize * 0.7, MIN_SCALE, MAX_SCALE);
  const normal = anchorState.normal || { x: 0, y: 0, z: 1 };
  const pitch = Math.atan2(normal.y, Math.max(0.001, normal.z)) * NORMAL_TILT_GAIN;
  const yaw = -Math.atan2(normal.x, Math.max(0.001, normal.z)) * NORMAL_TILT_GAIN;

  return {
    visible: true,
    position: [worldX, worldY, 0],
    rotation: [
      clamp(pitch, -NORMAL_TILT_LIMIT, NORMAL_TILT_LIMIT),
      clamp(yaw, -NORMAL_TILT_LIMIT, NORMAL_TILT_LIMIT),
      0,
    ],
    scale,
  };
};
