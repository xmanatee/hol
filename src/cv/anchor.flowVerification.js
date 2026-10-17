import { grayImageView } from './grayImageView.js';

const PATCH_RADIUS = 3;
const PATCH_AREA = (PATCH_RADIUS * 2 + 1) ** 2;
const MIN_PATCH_VARIANCE = 4;
const MIN_PATCH_CORRELATION = 0.8;
const MAX_ROUND_TRIP_ERROR = 1.5;

const sample = ({ data, stride }, x, y) => {
  const left = Math.floor(x);
  const top = Math.floor(y);
  const dx = x - left;
  const dy = y - top;
  const offset = top * stride + left;
  const upper = data[offset] * (1 - dx) + data[offset + 1] * dx;
  const lower = data[offset + stride] * (1 - dx) + data[offset + stride + 1] * dx;
  return upper * (1 - dy) + lower * dy;
};

const containsPatch = (image, point) =>
  point.x >= PATCH_RADIUS &&
  point.y >= PATCH_RADIUS &&
  point.x + PATCH_RADIUS + 1 < image.width &&
  point.y + PATCH_RADIUS + 1 < image.height;

// Zero-mean normalized correlation is invariant to positive affine exposure changes, not clipping.
const flowPatchCorrelation = (previous, current, reference, point) => {
  if (!containsPatch(previous, reference) || !containsPatch(current, point)) return null;
  let left = 0;
  let right = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  let product = 0;
  for (let y = -PATCH_RADIUS; y <= PATCH_RADIUS; y++) {
    for (let x = -PATCH_RADIUS; x <= PATCH_RADIUS; x++) {
      const a = sample(previous, reference.x + x, reference.y + y);
      const b = sample(current, point.x + x, point.y + y);
      left += a;
      right += b;
      leftSquared += a * a;
      rightSquared += b * b;
      product += a * b;
    }
  }
  const leftVariance = leftSquared - (left * left) / PATCH_AREA;
  const rightVariance = rightSquared - (right * right) / PATCH_AREA;
  if (Math.min(leftVariance, rightVariance) < PATCH_AREA * MIN_PATCH_VARIANCE) return null;
  return (product - (left * right) / PATCH_AREA) / Math.sqrt(leftVariance * rightVariance);
};

export const verifyFlowCandidates = (cv, previous, current, candidates, workspace, params) => {
  if (candidates.length === 0) return [];
  const previousView = grayImageView(previous);
  const currentView = grayImageView(current);
  const appearanceMatches = candidates.filter((candidate) => {
    const correlation = flowPatchCorrelation(
      previousView,
      currentView,
      candidate.reference,
      candidate.current,
    );
    return correlation !== null && correlation >= MIN_PATCH_CORRELATION;
  });
  if (appearanceMatches.length === 0) return [];
  const { verificationPoints, backwardPoints, backwardStatus, backwardError } = workspace;
  verificationPoints.create(appearanceMatches.length, 1, cv.CV_32FC2);
  backwardPoints.create(appearanceMatches.length, 1, cv.CV_32FC2);
  backwardStatus.create(appearanceMatches.length, 1, cv.CV_8UC1);
  backwardError.create(appearanceMatches.length, 1, cv.CV_32FC1);
  appearanceMatches.forEach((candidate, index) => {
    verificationPoints.data32F[index * 2] = candidate.current.x;
    verificationPoints.data32F[index * 2 + 1] = candidate.current.y;
  });
  cv.calcOpticalFlowPyrLK(
    current,
    previous,
    verificationPoints,
    backwardPoints,
    backwardStatus,
    backwardError,
    params.winSize,
    params.maxLevel,
    params.criteria,
  );
  const status = backwardStatus.data;
  const error = backwardError.data32F;
  const backwardCoordinates = backwardPoints.data32F;
  return appearanceMatches.filter(
    (candidate, index) =>
      status[index] === 1 &&
      Number.isFinite(error[index]) &&
      error[index] < candidate.effectiveThreshold &&
      Math.hypot(
        backwardCoordinates[index * 2] - candidate.reference.x,
        backwardCoordinates[index * 2 + 1] - candidate.reference.y,
      ) <= MAX_ROUND_TRIP_ERROR,
  );
};
