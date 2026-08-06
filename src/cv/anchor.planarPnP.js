const MIN_PLANAR_PNP_POINTS = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const measureReferenceSpread = (correspondences) => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const correspondence of correspondences) {
    minX = Math.min(minX, correspondence.prev.x);
    maxX = Math.max(maxX, correspondence.prev.x);
    minY = Math.min(minY, correspondence.prev.y);
    maxY = Math.max(maxY, correspondence.prev.y);
  }
  const width = maxX - minX;
  const height = maxY - minY;

  return {
    width,
    height,
    minAxis: Math.min(width, height),
  };
};

const normalizeNormal = (normal) => {
  const length = Math.hypot(normal.x, normal.y, normal.z);
  const normalized = {
    x: normal.x / length,
    y: normal.y / length,
    z: normal.z / length,
  };

  return normalized.z >= 0 ? normalized : { x: -normalized.x, y: -normalized.y, z: -normalized.z };
};

const populatePointWorkspace = ({ cv, correspondences, anchorReference, workspace }) => {
  workspace.objectPoints.create(correspondences.length, 1, cv.CV_32FC3);
  workspace.imagePoints.create(correspondences.length, 1, cv.CV_32FC2);
  const objectPoints = workspace.objectPoints.data32F;
  const imagePoints = workspace.imagePoints.data32F;

  for (let index = 0; index < correspondences.length; index++) {
    const correspondence = correspondences[index];
    const objectIndex = index * 3;
    const imageIndex = index * 2;
    objectPoints[objectIndex] = correspondence.prev.x - anchorReference.x;
    objectPoints[objectIndex + 1] = correspondence.prev.y - anchorReference.y;
    objectPoints[objectIndex + 2] = 0;
    imagePoints[imageIndex] = correspondence.curr.x;
    imagePoints[imageIndex + 1] = correspondence.curr.y;
  }
};

const calculateAverageResidual = ({
  rotation,
  translation,
  correspondences,
  anchorReference,
  cameraParams,
}) => {
  let total = 0;

  for (const correspondence of correspondences) {
    const x = correspondence.prev.x - anchorReference.x;
    const y = correspondence.prev.y - anchorReference.y;
    const cameraX = rotation[0] * x + rotation[1] * y + translation[0];
    const cameraY = rotation[3] * x + rotation[4] * y + translation[1];
    const cameraZ = rotation[6] * x + rotation[7] * y + translation[2];
    const projectedX = cameraParams.cx + (cameraParams.fx * cameraX) / cameraZ;
    const projectedY = cameraParams.cy + (cameraParams.fy * cameraY) / cameraZ;

    total += Math.hypot(projectedX - correspondence.curr.x, projectedY - correspondence.curr.y);
  }

  return total / correspondences.length;
};

const angularDistance = (left, right) => {
  const dot = left.x * right.x + left.y * right.y + left.z * right.z;
  return Math.acos(clamp(dot, -1, 1));
};

const hasOpposingTilt = (left, right) => left.x * right.x + left.y * right.y < 0;

const solvePlanarCandidate = ({
  cv,
  workspace,
  cameraMatrix,
  distortionCoefficients,
  correspondences,
  anchorReference,
  cameraParams,
  initialPose = null,
}) => {
  if (initialPose) {
    workspace.rotationVector.data64F.set(initialPose.rotationVector);
    workspace.translation.data64F.set(initialPose.translation);
  }

  const solved = cv.solvePnP(
    workspace.objectPoints,
    workspace.imagePoints,
    cameraMatrix,
    distortionCoefficients,
    workspace.rotationVector,
    workspace.translation,
    initialPose !== null,
    cv.SOLVEPNP_ITERATIVE,
  );
  if (!solved) {
    return null;
  }

  cv.Rodrigues(workspace.rotationVector, workspace.rotationMatrix);
  const rotationVector = Array.from(workspace.rotationVector.data64F);
  const rotation = Array.from(workspace.rotationMatrix.data64F);
  const translation = Array.from(workspace.translation.data64F);
  const normal = normalizeNormal({
    x: rotation[2],
    y: rotation[5],
    z: rotation[8],
  });

  return {
    normal,
    rotationVector,
    rotation,
    translation,
    averageResidual: calculateAverageResidual({
      rotation,
      translation,
      correspondences,
      anchorReference,
      cameraParams,
    }),
  };
};

const selectPlanarCandidate = ({ fresh, temporal, previousPose }) => {
  if (!fresh) return temporal ? { ...temporal, branchSelection: 'temporal-fallback' } : null;
  if (!temporal) return { ...fresh, branchSelection: 'fresh' };

  if (!hasOpposingTilt(fresh.normal, temporal.normal)) {
    return { ...fresh, branchSelection: 'fresh' };
  }

  return angularDistance(temporal.normal, previousPose.normal) <
    angularDistance(fresh.normal, previousPose.normal)
    ? { ...temporal, branchSelection: 'temporal-branch' }
    : { ...fresh, branchSelection: 'fresh-branch' };
};

export const createPlanarPnPWorkspace = (cv) => ({
  objectPoints: new cv.Mat(),
  imagePoints: new cv.Mat(),
  rotationVector: new cv.Mat(3, 1, cv.CV_64F),
  translation: new cv.Mat(3, 1, cv.CV_64F),
  rotationMatrix: new cv.Mat(3, 3, cv.CV_64F),
});

export const disposePlanarPnPWorkspace = (workspace) => {
  workspace.objectPoints.delete();
  workspace.imagePoints.delete();
  workspace.rotationVector.delete();
  workspace.translation.delete();
  workspace.rotationMatrix.delete();
};

export const estimatePlanarPnPPose = ({
  cv,
  correspondences,
  anchorReference,
  cameraParams,
  cameraMatrix,
  distortionCoefficients,
  workspace,
  previousPose = null,
}) => {
  if (correspondences.length < MIN_PLANAR_PNP_POINTS) {
    return {
      success: false,
      method: 'planar-pnp',
      reason: 'Insufficient planar PnP correspondences',
      inlierCount: correspondences.length,
    };
  }

  populatePointWorkspace({ cv, correspondences, anchorReference, workspace });
  const sharedSolveInput = {
    cv,
    workspace,
    cameraMatrix,
    distortionCoefficients,
    correspondences,
    anchorReference,
    cameraParams,
  };
  const fresh = solvePlanarCandidate(sharedSolveInput);
  const needsTemporalCandidate =
    previousPose && (!fresh || hasOpposingTilt(fresh.normal, previousPose.normal));
  const temporal = needsTemporalCandidate
    ? solvePlanarCandidate({ ...sharedSolveInput, initialPose: previousPose })
    : null;
  const pose = selectPlanarCandidate({ fresh, temporal, previousPose });

  if (!pose) {
    return {
      success: false,
      method: 'planar-pnp',
      reason: 'Planar PnP solve failed',
      inlierCount: correspondences.length,
    };
  }

  const referenceSpread = measureReferenceSpread(correspondences);
  const residualScore = clamp(1 - pose.averageResidual / 4, 0, 1);
  const spreadScore = clamp(referenceSpread.minAxis / 52, 0, 1);

  return {
    success: true,
    method: 'planar-pnp',
    branchSelection: pose.branchSelection,
    normal: pose.normal,
    rotationVector: pose.rotationVector,
    rotation: pose.rotation,
    translation: pose.translation,
    confidence: clamp(residualScore * 0.72 + spreadScore * 0.28, 0, 1),
    inlierCount: correspondences.length,
    inlierRatio: 1,
    averageResidual: pose.averageResidual,
    foreshortening: pose.normal.z,
    referenceSpread,
  };
};
