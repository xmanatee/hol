import { createCameraViewportTransform } from './cameraViewport.js';

// PnP reference coordinates are pixels in the initial view, not calibrated metres.
export const createPlanarSurfaceAttachment = ({ pose, cameraParams, referenceBounds }) => {
  const rotation = pose.rotation;
  const translation = pose.translation;
  if (rotation == null && translation == null) return null;
  if (
    !rotation ||
    !translation ||
    rotation.length !== 9 ||
    translation.length !== 3 ||
    ![...rotation, ...translation].every(Number.isFinite) ||
    translation[2] <= 0 ||
    !cameraParams ||
    ![cameraParams.fx, cameraParams.fy, cameraParams.cx, cameraParams.cy].every(Number.isFinite) ||
    cameraParams.fx <= 0 ||
    cameraParams.fy <= 0 ||
    !referenceBounds ||
    !Number.isFinite(referenceBounds.width) ||
    !Number.isFinite(referenceBounds.height) ||
    referenceBounds.width <= 0 ||
    referenceBounds.height <= 0
  ) {
    throw new TypeError('Invalid planar surface pose');
  }
  for (let row = 0; row < 3; row++) {
    for (let other = row; other < 3; other++) {
      let dot = 0;
      for (let column = 0; column < 3; column++)
        dot += rotation[row * 3 + column] * rotation[other * 3 + column];
      if (Math.abs(dot - (row === other ? 1 : 0)) > 0.001)
        throw new TypeError('Planar rotation must be orthonormal');
    }
  }
  const determinant =
    rotation[0] * (rotation[4] * rotation[8] - rotation[5] * rotation[7]) -
    rotation[1] * (rotation[3] * rotation[8] - rotation[5] * rotation[6]) +
    rotation[2] * (rotation[3] * rotation[7] - rotation[4] * rotation[6]);
  if (Math.abs(determinant - 1) > 0.001) throw new TypeError('Planar rotation must preserve orientation');
  return {
    kind: 'planar-pnp',
    units: 'reference-pixels',
    rotation: Array.from(rotation),
    translation: Array.from(translation),
    intrinsics: { ...cameraParams },
    faceSize: Math.min(referenceBounds.width, referenceBounds.height) * 0.55,
  };
};

// Writes into renderer-owned matrices; no per-render Three.js allocations.
export const writePlanarSurfaceMatrices = ({
  attachment,
  modelMatrix,
  projectionMatrix,
  width,
  height,
  renderWidth,
  renderHeight,
  cameraDistance,
  mirrored = false,
}) => {
  const viewport = createCameraViewportTransform({
    sourceWidth: width,
    sourceHeight: height,
    viewportWidth: renderWidth,
    viewportHeight: renderHeight,
  });
  const { fx, fy, cx, cy } = attachment.intrinsics;
  const principalX = cx * viewport.scale + viewport.offsetX;
  const principalY = cy * viewport.scale + viewport.offsetY;
  const near = 0.1;
  const far = 100_000;
  const mirror = mirrored ? -1 : 1;
  projectionMatrix.set(
    (mirror * 2 * fx * viewport.scale) / renderWidth,
    0,
    mirror * (1 - (2 * principalX) / renderWidth),
    0,
    0,
    (2 * fy * viewport.scale) / renderHeight,
    (2 * principalY) / renderHeight - 1,
    0,
    0,
    0,
    -(far + near) / (far - near),
    (-2 * far * near) / (far - near),
    0,
    0,
    -1,
    0,
  );
  const r = attachment.rotation;
  const t = attachment.translation;
  const s = attachment.faceSize;
  // OpenCV: right/down/forward. Three.js camera and head: right/up/backward.
  modelMatrix.set(
    r[0] * s,
    -r[1] * s,
    -r[2] * s,
    t[0],
    -r[3] * s,
    r[4] * s,
    r[5] * s,
    -t[1],
    -r[6] * s,
    r[7] * s,
    r[8] * s,
    cameraDistance - t[2],
    0,
    0,
    0,
    1,
  );
};
