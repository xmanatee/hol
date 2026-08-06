import { normalizeAngle } from './anchor.reconstruction.math.js';

export const createSimilarityHypothesisWorkspace = () => ({
  solution: new Float64Array(4),
  bestSolution: new Float64Array(4),
  score: new Float64Array(2),
});

export const fitSimilarityHypothesis = (left, right, solution) => {
  const sourceDeltaX = right.reference.x - left.reference.x;
  const sourceDeltaY = right.reference.y - left.reference.y;
  const targetDeltaX = right.current.x - left.current.x;
  const targetDeltaY = right.current.y - left.current.y;
  const sourceDistance = Math.hypot(sourceDeltaX, sourceDeltaY);
  const targetDistance = Math.hypot(targetDeltaX, targetDeltaY);

  if (sourceDistance < 12 || targetDistance < 4) {
    return false;
  }

  const scale = targetDistance / sourceDistance;
  const rotation = Math.atan2(targetDeltaY, targetDeltaX) - Math.atan2(sourceDeltaY, sourceDeltaX);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  solution[0] = left.current.x - scale * (cos * left.reference.x - sin * left.reference.y);
  solution[1] = left.current.y - scale * (sin * left.reference.x + cos * left.reference.y);
  solution[2] = scale;
  solution[3] = normalizeAngle(rotation);
  return true;
};

export const scoreSimilarityHypothesis = (observations, transform, residualThreshold, score) => {
  const cos = Math.cos(transform[3]);
  const sin = Math.sin(transform[3]);
  let inlierCount = 0;
  let residualSum = 0;

  for (const observation of observations) {
    const projectedX =
      transform[0] + transform[2] * (cos * observation.reference.x - sin * observation.reference.y);
    const projectedY =
      transform[1] + transform[2] * (sin * observation.reference.x + cos * observation.reference.y);
    const residualX = projectedX - observation.current.x;
    const residualY = projectedY - observation.current.y;
    if (Math.abs(residualX) > residualThreshold || Math.abs(residualY) > residualThreshold) {
      continue;
    }

    const residual = Math.hypot(residualX, residualY);
    if (residual <= residualThreshold) {
      inlierCount++;
      residualSum += residual;
    }
  }

  score[0] = inlierCount;
  score[1] = inlierCount ? residualSum / inlierCount : Infinity;
};
