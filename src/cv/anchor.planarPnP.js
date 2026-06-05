const MIN_PLANAR_PNP_POINTS = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const measureReferenceSpread = correspondences => {
  const xs = correspondences.map(correspondence => correspondence.prev.x);
  const ys = correspondences.map(correspondence => correspondence.prev.y);

  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    minAxis: Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
  };
};

const normalizeNormal = normal => {
  const length = Math.hypot(normal.x, normal.y, normal.z);
  const normalized = {
    x: normal.x / length,
    y: normal.y / length,
    z: normal.z / length,
  };

  return normalized.z >= 0
    ? normalized
    : { x: -normalized.x, y: -normalized.y, z: -normalized.z };
};

const createPointArrays = (correspondences, anchorReference) => {
  const objectPoints = [];
  const imagePoints = [];

  correspondences.forEach(correspondence => {
    objectPoints.push(
      correspondence.prev.x - anchorReference.x,
      correspondence.prev.y - anchorReference.y,
      0
    );
    imagePoints.push(correspondence.curr.x, correspondence.curr.y);
  });

  return { objectPoints, imagePoints };
};

const calculateAverageResidual = ({ rotation, translation, objectPoints, imagePoints, cameraParams }) => {
  let total = 0;
  let count = 0;

  for (let index = 0; index < objectPoints.length; index += 3) {
    const x = objectPoints[index];
    const y = objectPoints[index + 1];
    const cameraX = rotation[0] * x + rotation[1] * y + translation[0];
    const cameraY = rotation[3] * x + rotation[4] * y + translation[1];
    const cameraZ = rotation[6] * x + rotation[7] * y + translation[2];
    const projectedX = cameraParams.cx + cameraParams.fx * cameraX / cameraZ;
    const projectedY = cameraParams.cy + cameraParams.fy * cameraY / cameraZ;
    const imageIndex = count * 2;

    total += Math.hypot(projectedX - imagePoints[imageIndex], projectedY - imagePoints[imageIndex + 1]);
    count++;
  }

  return total / count;
};

export const estimatePlanarPnPPose = ({ cv, correspondences, anchorReference, cameraParams }) => {
  if (correspondences.length < MIN_PLANAR_PNP_POINTS) {
    return {
      success: false,
      method: 'planar-pnp',
      reason: 'Insufficient planar PnP correspondences',
      inlierCount: correspondences.length,
    };
  }

  const { objectPoints, imagePoints } = createPointArrays(correspondences, anchorReference);
  const objectMat = cv.matFromArray(correspondences.length, 1, cv.CV_32FC3, objectPoints);
  const imageMat = cv.matFromArray(correspondences.length, 1, cv.CV_32FC2, imagePoints);
  const cameraMat = cv.matFromArray(3, 3, cv.CV_64F, [
    cameraParams.fx, 0, cameraParams.cx,
    0, cameraParams.fy, cameraParams.cy,
    0, 0, 1,
  ]);
  const distCoeffs = cv.Mat.zeros(4, 1, cv.CV_64F);
  const rvec = new cv.Mat();
  const tvec = new cv.Mat();
  const rotationMat = new cv.Mat();

  const solved = cv.solvePnP(
    objectMat,
    imageMat,
    cameraMat,
    distCoeffs,
    rvec,
    tvec,
    false,
    cv.SOLVEPNP_ITERATIVE
  );

  let result;
  if (solved) {
    cv.Rodrigues(rvec, rotationMat);
    const rotation = Array.from(rotationMat.data64F);
    const translation = Array.from(tvec.data64F);
    const normal = normalizeNormal({
      x: rotation[2],
      y: rotation[5],
      z: rotation[8],
    });
    const averageResidual = calculateAverageResidual({
      rotation,
      translation,
      objectPoints,
      imagePoints,
      cameraParams,
    });
    const referenceSpread = measureReferenceSpread(correspondences);
    const residualScore = clamp(1 - averageResidual / 4, 0, 1);
    const spreadScore = clamp(referenceSpread.minAxis / 52, 0, 1);

    result = {
      success: true,
      method: 'planar-pnp',
      normal,
      rotation,
      translation,
      confidence: clamp(residualScore * 0.72 + spreadScore * 0.28, 0, 1),
      inlierCount: correspondences.length,
      inlierRatio: 1,
      averageResidual,
      foreshortening: normal.z,
      referenceSpread,
    };
  } else {
    result = {
      success: false,
      method: 'planar-pnp',
      reason: 'Planar PnP solve failed',
      inlierCount: correspondences.length,
    };
  }

  objectMat.delete();
  imageMat.delete();
  cameraMat.delete();
  distCoeffs.delete();
  rvec.delete();
  tvec.delete();
  rotationMat.delete();

  return result;
};
