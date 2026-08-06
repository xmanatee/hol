import { clamp, solveLeastSquaresPair } from './anchor.reconstruction.math.js';
import {
  createAffineHypothesisWorkspace,
  fitAffineHypothesis,
  scoreAffineHypothesis,
} from './anchor.affineHypothesis.js';
import {
  createSimilarityHypothesisWorkspace,
  fitSimilarityHypothesis,
  scoreSimilarityHypothesis,
} from './anchor.similarityHypothesis.js';

export const MOBILE_AFFINE_SAMPLE_WINDOW = 28;

export const EMPTY_RECONSTRUCTION_STATS = {
  averageSupport: 0,
  averageReliability: 0,
  matureLandmarks: 0,
  geometricConsistency: 0,
  mapConfidence: 0,
  mappedFrames: 0,
};

export const transformPointAffine2 = (point, transform) => ({
  x: transform.rowX[0] * point.x + transform.rowX[1] * point.y + transform.rowX[2],
  y: transform.rowY[0] * point.x + transform.rowY[1] * point.y + transform.rowY[2],
});

export const affineVerticalScale = (transform) => Math.hypot(transform.rowX[1], transform.rowY[1]);

export const affineRotation = (transform) => Math.atan2(transform.rowY[0], transform.rowX[0]);

export const readinessFromGeometry = (consistency) => clamp((consistency - 0.45) / 0.22, 0, 1);

export const toActiveObservations = (trackedPoints) =>
  trackedPoints
    .filter((point) => point.status === 'active')
    .filter((point) => Number.isFinite(point.original?.x))
    .filter((point) => Number.isFinite(point.original?.y))
    .filter((point) => Number.isFinite(point.current?.x))
    .filter((point) => Number.isFinite(point.current?.y))
    .map((point) => ({
      id: point.id,
      reference: { x: point.original.x, y: point.original.y },
      current: { x: point.current.x, y: point.current.y },
      quality: (point.response || 0) + (point.stabilityScore || 0) + Math.min(point.age || 0, 30) / 30,
    }));

export const transformPoint2 = (point, transform) => {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.tx + transform.scale * (cos * point.x - sin * point.y),
    y: transform.ty + transform.scale * (sin * point.x + cos * point.y),
  };
};

const fitSimilarity = (matches) => {
  const sourceCentroid = matches.reduce(
    (sum, match) => ({
      x: sum.x + match.reference.x / matches.length,
      y: sum.y + match.reference.y / matches.length,
    }),
    { x: 0, y: 0 },
  );
  const targetCentroid = matches.reduce(
    (sum, match) => ({
      x: sum.x + match.current.x / matches.length,
      y: sum.y + match.current.y / matches.length,
    }),
    { x: 0, y: 0 },
  );

  let a = 0;
  let b = 0;
  let denominator = 0;
  matches.forEach((match) => {
    const sourceX = match.reference.x - sourceCentroid.x;
    const sourceY = match.reference.y - sourceCentroid.y;
    const targetX = match.current.x - targetCentroid.x;
    const targetY = match.current.y - targetCentroid.y;
    const weight = clamp(match.quality || 1, 0.2, 3);

    a += (sourceX * targetX + sourceY * targetY) * weight;
    b += (sourceX * targetY - sourceY * targetX) * weight;
    denominator += (sourceX * sourceX + sourceY * sourceY) * weight;
  });

  const scale = Math.hypot(a, b) / Math.max(denominator, 1e-6);
  const rotation = Math.atan2(b, a);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return {
    tx: targetCentroid.x - scale * (cos * sourceCentroid.x - sin * sourceCentroid.y),
    ty: targetCentroid.y - scale * (sin * sourceCentroid.x + cos * sourceCentroid.y),
    scale,
    rotation,
  };
};

const triangleArea = (a, b, c) =>
  Math.abs(
    (b.reference.x - a.reference.x) * (c.reference.y - a.reference.y) -
      (b.reference.y - a.reference.y) * (c.reference.x - a.reference.x),
  ) * 0.5;

const referenceDistanceSq = (left, right) => {
  const dx = left.reference.x - right.reference.x;
  const dy = left.reference.y - right.reference.y;
  return dx * dx + dy * dy;
};

const selectAffineHypothesisSample = (observations, maxSample) => {
  const sorted = [...observations].sort((left, right) => right.quality - left.quality);
  const limit = Math.min(sorted.length, maxSample);
  if (sorted.length <= limit) {
    return sorted;
  }

  const qualityCount = Math.max(6, Math.floor(limit * 0.45));
  const sample = sorted.slice(0, qualityCount);
  const selected = new Set(sample);
  const remaining = sorted.filter((observation) => !selected.has(observation));
  const maxQuality = Math.max(1, ...remaining.map((observation) => observation.quality || 0));

  while (sample.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((candidate, index) => {
      const spread = Math.sqrt(
        sample.reduce(
          (distance, selectedObservation) =>
            Math.min(distance, referenceDistanceSq(candidate, selectedObservation)),
          Infinity,
        ),
      );
      const score = spread + ((candidate.quality || 0) / maxQuality) * 8;
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    });
    sample.push(remaining.splice(bestIndex, 1)[0]);
  }

  return sample;
};

const selectQualityHypothesisSample = (observations, maxSample) => {
  const sorted = [...observations].sort((left, right) => right.quality - left.quality);
  return sorted.slice(0, Math.min(sorted.length, maxSample));
};

const fitAffine = (matches) => {
  const rows = matches.map((match) => [match.reference.x, match.reference.y, 1]);
  const solution = solveLeastSquaresPair(
    rows,
    matches.map((match) => match.current.x),
    matches.map((match) => match.current.y),
  );
  return solution ? { rowX: solution.left, rowY: solution.right } : null;
};

const scoreTransform = (observations, transform, residualThreshold) => {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  const inliers = [];
  let residualSum = 0;

  for (const observation of observations) {
    const projectedX =
      transform.tx + transform.scale * (cos * observation.reference.x - sin * observation.reference.y);
    const projectedY =
      transform.ty + transform.scale * (sin * observation.reference.x + cos * observation.reference.y);
    const residualX = projectedX - observation.current.x;
    const residualY = projectedY - observation.current.y;
    if (Math.abs(residualX) > residualThreshold || Math.abs(residualY) > residualThreshold) {
      continue;
    }

    const residual = Math.hypot(residualX, residualY);

    if (residual <= residualThreshold) {
      inliers.push(observation);
      residualSum += residual;
    }
  }

  return {
    inliers,
    averageResidual: inliers.length ? residualSum / inliers.length : Infinity,
    inlierRatio: inliers.length / observations.length,
  };
};

const scoreAffineTransform = (observations, transform, residualThreshold) => {
  const inliers = [];
  let residualSum = 0;

  for (const observation of observations) {
    const projectedX =
      transform.rowX[0] * observation.reference.x +
      transform.rowX[1] * observation.reference.y +
      transform.rowX[2];
    const projectedY =
      transform.rowY[0] * observation.reference.x +
      transform.rowY[1] * observation.reference.y +
      transform.rowY[2];
    const residualX = projectedX - observation.current.x;
    const residualY = projectedY - observation.current.y;
    if (Math.abs(residualX) > residualThreshold || Math.abs(residualY) > residualThreshold) {
      continue;
    }

    const residual = Math.hypot(residualX, residualY);

    if (residual <= residualThreshold) {
      inliers.push(observation);
      residualSum += residual;
    }
  }

  return {
    inliers,
    averageResidual: inliers.length ? residualSum / inliers.length : Infinity,
    inlierRatio: inliers.length / observations.length,
  };
};

export const fitRobustSimilarity = (
  observations,
  { minInliers = 8, threshold = 10, maxSample = 42 } = {},
) => {
  if (observations.length < minInliers) {
    return { success: false, reason: 'Insufficient observations for robust similarity fit' };
  }

  const sorted = [...observations].sort((left, right) => right.quality - left.quality);
  const sample = sorted.slice(0, Math.min(sorted.length, maxSample));
  const workspace = createSimilarityHypothesisWorkspace();
  let hasBest = false;
  let bestInlierCount = 0;
  let bestAverageResidual = Infinity;

  for (let leftIndex = 0; leftIndex < sample.length - 1; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < sample.length; rightIndex++) {
      if (
        !fitSimilarityHypothesis(sample[leftIndex], sample[rightIndex], workspace.solution) ||
        workspace.solution[2] < 0.08 ||
        workspace.solution[2] > 8
      ) {
        continue;
      }

      scoreSimilarityHypothesis(observations, workspace.solution, threshold, workspace.score);
      const inlierCount = workspace.score[0];
      const averageResidual = workspace.score[1];
      if (
        !hasBest ||
        inlierCount > bestInlierCount ||
        (inlierCount === bestInlierCount && averageResidual < bestAverageResidual)
      ) {
        hasBest = true;
        bestInlierCount = inlierCount;
        bestAverageResidual = averageResidual;
        workspace.bestSolution.set(workspace.solution);
      }
    }
  }

  if (!hasBest || bestInlierCount < minInliers) {
    return { success: false, reason: 'No robust similarity consensus' };
  }

  const bestTransform = {
    tx: workspace.bestSolution[0],
    ty: workspace.bestSolution[1],
    scale: workspace.bestSolution[2],
    rotation: workspace.bestSolution[3],
  };
  const best = scoreTransform(observations, bestTransform, threshold);
  const refinedTransform = fitSimilarity(best.inliers);
  const refined = scoreTransform(observations, refinedTransform, Math.max(6, bestAverageResidual * 2.8));
  if (refined.inliers.length < minInliers) {
    return { success: false, reason: 'Refined similarity consensus too small' };
  }

  const residualScore = clamp(1 - refined.averageResidual / 16, 0, 1);
  return {
    success: true,
    transform: refinedTransform,
    inliers: refined.inliers,
    inlierCount: refined.inliers.length,
    inlierRatio: refined.inlierRatio,
    averageResidual: refined.averageResidual,
    confidence: clamp(refined.inlierRatio * 0.65 + residualScore * 0.35, 0, 1),
  };
};

export const fitRobustAffine2D = (
  observations,
  {
    minInliers = 8,
    threshold = 10,
    maxSample = MOBILE_AFFINE_SAMPLE_WINDOW,
    sampleCoverage = 'quality',
  } = {},
) => {
  if (observations.length < minInliers) {
    return { success: false, reason: 'Insufficient observations for robust affine fit' };
  }

  const sample =
    sampleCoverage === 'spatial'
      ? selectAffineHypothesisSample(observations, maxSample)
      : selectQualityHypothesisSample(observations, maxSample);
  const workspace = createAffineHypothesisWorkspace();
  let hasBest = false;
  let bestInlierCount = 0;
  let bestAverageResidual = Infinity;

  for (let a = 0; a < sample.length - 2; a++) {
    for (let b = a + 1; b < sample.length - 1; b++) {
      for (let c = b + 1; c < sample.length; c++) {
        if (triangleArea(sample[a], sample[b], sample[c]) < 48) {
          continue;
        }

        if (!fitAffineHypothesis(sample[a], sample[b], sample[c], workspace)) {
          continue;
        }

        scoreAffineHypothesis(observations, workspace.solution, threshold, workspace.score);
        const inlierCount = workspace.score[0];
        const averageResidual = workspace.score[1];
        if (
          !hasBest ||
          inlierCount > bestInlierCount ||
          (inlierCount === bestInlierCount && averageResidual < bestAverageResidual)
        ) {
          hasBest = true;
          bestInlierCount = inlierCount;
          bestAverageResidual = averageResidual;
          workspace.bestSolution.set(workspace.solution);
        }
      }
    }
  }

  if (!hasBest || bestInlierCount < minInliers) {
    return { success: false, reason: 'No robust affine consensus' };
  }

  const bestTransform = {
    rowX: Array.from(workspace.bestSolution.subarray(0, 3)),
    rowY: Array.from(workspace.bestSolution.subarray(3, 6)),
  };
  const best = scoreAffineTransform(observations, bestTransform, threshold);
  const refinedTransform = fitAffine(best.inliers);
  if (!refinedTransform) {
    return { success: false, reason: 'Refined affine fit failed' };
  }

  const refined = scoreAffineTransform(
    observations,
    refinedTransform,
    Math.max(5, bestAverageResidual * 2.4),
  );
  if (refined.inliers.length < minInliers) {
    return { success: false, reason: 'Refined affine consensus too small' };
  }

  const residualScore = clamp(1 - refined.averageResidual / 14, 0, 1);
  return {
    success: true,
    transform: refinedTransform,
    inliers: refined.inliers,
    inlierCount: refined.inliers.length,
    inlierRatio: refined.inlierRatio,
    averageResidual: refined.averageResidual,
    confidence: clamp(refined.inlierRatio * 0.62 + residualScore * 0.38, 0, 1),
  };
};

export const selectCoherentObservations = (
  observations,
  {
    minInliers = 8,
    threshold = 10,
    minInlierRatio = 0.45,
    model = 'similarity',
    maxSample,
    sampleCoverage,
  } = {},
) => {
  const fit =
    model === 'affine'
      ? fitRobustAffine2D(observations, { minInliers, threshold, maxSample, sampleCoverage })
      : fitRobustSimilarity(observations, { minInliers, threshold, maxSample });
  if (!fit.success) {
    return {
      success: false,
      reason: fit.reason,
      observations: [],
      consistency: 0,
    };
  }

  const residualScore = clamp(1 - fit.averageResidual / Math.max(threshold, 1), 0, 1);
  const consistency = clamp(fit.inlierRatio * 0.72 + residualScore * 0.28, 0, 1);
  if (fit.inlierRatio < minInlierRatio) {
    return {
      success: false,
      reason: 'Tracked points do not preserve coherent object geometry',
      observations: fit.inliers,
      consistency,
    };
  }

  return {
    success: true,
    observations: fit.inliers,
    consistency,
    fit,
  };
};

export const boundsForPoints = (points) =>
  points.reduce(
    (bounds, point) => ({
      min: {
        x: Math.min(bounds.min.x, point.x),
        y: Math.min(bounds.min.y, point.y),
        z: Math.min(bounds.min.z, point.z),
      },
      max: {
        x: Math.max(bounds.max.x, point.x),
        y: Math.max(bounds.max.y, point.y),
        z: Math.max(bounds.max.z, point.z),
      },
    }),
    {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    },
  );
