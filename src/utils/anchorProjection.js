import {
  createCameraViewportTransform,
  sourceLengthToViewport,
  sourcePointToViewport,
} from './cameraViewport.js';

const DEFAULT_FOV = 63;
const DEFAULT_CAMERA_DISTANCE = 3;
const MIN_SCALE = 0.28;
const MAX_SCALE = 1.35;
const NORMAL_TILT_LIMIT = 0.95;
const NORMAL_TILT_GAIN = 1.12;
const MIN_VISIBLE_NORMAL_Z = 0.12;
const TRACKED_SCALE_MIN = 0.45;
const TRACKED_SCALE_MAX = 2.2;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const getAnchorPixelSize = (activeAnchor, anchorState, width, height) => {
  const objectRegion =
    anchorState.metrics?.reconstructionRegion ||
    anchorState.metrics?.trackingRegion ||
    anchorState.metrics?.currentObjectSupportMaskBounds ||
    anchorState.metrics?.objectSupportMaskBounds;
  if (objectRegion) {
    return Math.max(objectRegion.width, objectRegion.height);
  }

  const templateRegion = anchorState.metrics?.templateRegion;
  if (templateRegion) {
    return Math.max(templateRegion.width, templateRegion.height);
  }

  const selectionRegion = activeAnchor.selectionRegion;
  if (selectionRegion) {
    return Math.max(selectionRegion.x2 - selectionRegion.x1, selectionRegion.y2 - selectionRegion.y1);
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
  mirrored = false,
  presentationPosition = null,
}) => {
  if (
    !width ||
    !height ||
    !renderWidth ||
    !renderHeight ||
    !activeAnchor?.position ||
    !isLiveAnchorState(anchorState)
  ) {
    return {
      visible: false,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: MIN_SCALE,
    };
  }

  const fovRadians = (fov * Math.PI) / 180;
  const viewHeight = 2 * Math.tan(fovRadians / 2) * cameraDistance;
  const viewWidth = viewHeight * (renderWidth / renderHeight);
  const viewportTransform = createCameraViewportTransform({
    sourceWidth: width,
    sourceHeight: height,
    viewportWidth: renderWidth,
    viewportHeight: renderHeight,
    mirrored,
  });
  const livePosition = presentationPosition || anchorState.position || activeAnchor.position;
  const viewportPosition = sourcePointToViewport({
    point: livePosition,
    transform: viewportTransform,
  });
  const worldX = (viewportPosition.x / renderWidth - 0.5) * viewWidth;
  const worldY = (0.5 - viewportPosition.y / renderHeight) * viewHeight;
  const anchorPixelSize = getAnchorPixelSize(activeAnchor, anchorState, width, height);
  const viewportPixelSize = sourceLengthToViewport({
    length: anchorPixelSize,
    transform: viewportTransform,
  });
  const worldPixelSize = (viewportPixelSize / renderHeight) * viewHeight;
  const planarTransform = anchorState.planarTransform || activeAnchor.planarTransform || {};
  const trackedScale = clamp(planarTransform.scale ?? 1, TRACKED_SCALE_MIN, TRACKED_SCALE_MAX);
  const scale = clamp(worldPixelSize * 0.7 * trackedScale, MIN_SCALE, MAX_SCALE);
  const trackedNormal = anchorState.normal || { x: 0, y: 0, z: 1 };
  const normal = mirrored ? { ...trackedNormal, x: -trackedNormal.x } : trackedNormal;

  if (normal.z < MIN_VISIBLE_NORMAL_Z) {
    return {
      visible: false,
      position: [worldX, worldY, 0],
      rotation: [0, 0, 0],
      scale,
    };
  }

  const pitch = Math.atan2(normal.y, Math.max(0.001, normal.z)) * NORMAL_TILT_GAIN;
  const yaw = -Math.atan2(normal.x, Math.max(0.001, normal.z)) * NORMAL_TILT_GAIN;
  const trackedRotation = planarTransform.rotation ?? 0;
  const roll = mirrored ? trackedRotation : -trackedRotation;

  return {
    visible: true,
    position: [worldX, worldY, 0],
    rotation: [
      clamp(pitch, -NORMAL_TILT_LIMIT, NORMAL_TILT_LIMIT),
      clamp(yaw, -NORMAL_TILT_LIMIT, NORMAL_TILT_LIMIT),
      roll,
    ],
    scale,
  };
};
