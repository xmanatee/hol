import { clamp, normalizeAngle, solveLeastSquares } from './anchor.reconstruction.math.js';

export const toActiveObservations = trackedPoints => trackedPoints
  .filter(point => point.status === 'active')
  .filter(point => Number.isFinite(point.original?.x))
  .filter(point => Number.isFinite(point.original?.y))
  .filter(point => Number.isFinite(point.current?.x))
  .filter(point => Number.isFinite(point.current?.y))
  .map(point => ({
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

const fitSimilarity = matches => {
  const sourceCentroid = matches.reduce((sum, match) => ({
    x: sum.x + match.reference.x / matches.length,
    y: sum.y + match.reference.y / matches.length,
  }), { x: 0, y: 0 });
  const targetCentroid = matches.reduce((sum, match) => ({
    x: sum.x + match.current.x / matches.length,
    y: sum.y + match.current.y / matches.length,
  }), { x: 0, y: 0 });

  let a = 0;
  let b = 0;
  let denominator = 0;
  matches.forEach(match => {
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

const fitFromPair = (left, right) => {
  const sourceDelta = {
    x: right.reference.x - left.reference.x,
    y: right.reference.y - left.reference.y,
  };
  const targetDelta = {
    x: right.current.x - left.current.x,
    y: right.current.y - left.current.y,
  };
  const sourceDistance = Math.hypot(sourceDelta.x, sourceDelta.y);
  const targetDistance = Math.hypot(targetDelta.x, targetDelta.y);

  if (sourceDistance < 12 || targetDistance < 4) {
    return null;
  }

  const scale = targetDistance / sourceDistance;
  const rotation = Math.atan2(targetDelta.y, targetDelta.x) - Math.atan2(sourceDelta.y, sourceDelta.x);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return {
    tx: left.current.x - scale * (cos * left.reference.x - sin * left.reference.y),
    ty: left.current.y - scale * (sin * left.reference.x + cos * left.reference.y),
    scale,
    rotation: normalizeAngle(rotation),
  };
};

const triangleArea = (a, b, c) => Math.abs(
  (b.reference.x - a.reference.x) * (c.reference.y - a.reference.y) -
  (b.reference.y - a.reference.y) * (c.reference.x - a.reference.x)
) * 0.5;

const fitAffine = matches => {
  const rows = matches.map(match => [match.reference.x, match.reference.y, 1]);
  const rowX = solveLeastSquares(rows, matches.map(match => match.current.x));
  const rowY = solveLeastSquares(rows, matches.map(match => match.current.y));
  return rowX && rowY ? { rowX, rowY } : null;
};

const transformPointAffine = (point, transform) => ({
  x: transform.rowX[0] * point.x + transform.rowX[1] * point.y + transform.rowX[2],
  y: transform.rowY[0] * point.x + transform.rowY[1] * point.y + transform.rowY[2],
});

export const scoreTransform = (observations, transform, residualThreshold) => {
  const residuals = observations.map(observation => {
    const projected = transformPoint2(observation.reference, transform);
    return {
      observation,
      residual: Math.hypot(projected.x - observation.current.x, projected.y - observation.current.y),
    };
  });
  const inliers = residuals.filter(item => item.residual <= residualThreshold);
  const averageResidual = inliers.length
    ? inliers.reduce((sum, item) => sum + item.residual, 0) / inliers.length
    : Infinity;

  return {
    inliers: inliers.map(item => item.observation),
    averageResidual,
    inlierRatio: inliers.length / observations.length,
  };
};

const scoreAffineTransform = (observations, transform, residualThreshold) => {
  const residuals = observations.map(observation => {
    const projected = transformPointAffine(observation.reference, transform);
    return {
      observation,
      residual: Math.hypot(projected.x - observation.current.x, projected.y - observation.current.y),
    };
  });
  const inliers = residuals.filter(item => item.residual <= residualThreshold);
  const averageResidual = inliers.length
    ? inliers.reduce((sum, item) => sum + item.residual, 0) / inliers.length
    : Infinity;

  return {
    inliers: inliers.map(item => item.observation),
    averageResidual,
    inlierRatio: inliers.length / observations.length,
  };
};

export const fitRobustSimilarity = (observations, { minInliers = 8, threshold = 10, maxSample = 42 } = {}) => {
  if (observations.length < minInliers) {
    return { success: false, reason: 'Insufficient observations for robust similarity fit' };
  }

  const sorted = [...observations].sort((left, right) => right.quality - left.quality);
  const sample = sorted.slice(0, Math.min(sorted.length, maxSample));
  let best = null;

  for (let leftIndex = 0; leftIndex < sample.length - 1; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < sample.length; rightIndex++) {
      const transform = fitFromPair(sample[leftIndex], sample[rightIndex]);
      if (!transform || transform.scale < 0.08 || transform.scale > 8) {
        continue;
      }

      const scored = scoreTransform(observations, transform, threshold);
      if (!best ||
          scored.inliers.length > best.inliers.length ||
          (scored.inliers.length === best.inliers.length && scored.averageResidual < best.averageResidual)) {
        best = { transform, ...scored };
      }
    }
  }

  if (!best || best.inliers.length < minInliers) {
    return { success: false, reason: 'No robust similarity consensus' };
  }

  const refinedTransform = fitSimilarity(best.inliers);
  const refined = scoreTransform(observations, refinedTransform, Math.max(6, best.averageResidual * 2.8));
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

export const fitRobustAffine2D = (observations, { minInliers = 8, threshold = 10, maxSample = 34 } = {}) => {
  if (observations.length < minInliers) {
    return { success: false, reason: 'Insufficient observations for robust affine fit' };
  }

  const sorted = [...observations].sort((left, right) => right.quality - left.quality);
  const sample = sorted.slice(0, Math.min(sorted.length, maxSample));
  let best = null;

  for (let a = 0; a < sample.length - 2; a++) {
    for (let b = a + 1; b < sample.length - 1; b++) {
      for (let c = b + 1; c < sample.length; c++) {
        if (triangleArea(sample[a], sample[b], sample[c]) < 48) {
          continue;
        }

        const transform = fitAffine([sample[a], sample[b], sample[c]]);
        if (!transform) {
          continue;
        }

        const scored = scoreAffineTransform(observations, transform, threshold);
        if (!best ||
            scored.inliers.length > best.inliers.length ||
            (scored.inliers.length === best.inliers.length && scored.averageResidual < best.averageResidual)) {
          best = { transform, ...scored };
        }
      }
    }
  }

  if (!best || best.inliers.length < minInliers) {
    return { success: false, reason: 'No robust affine consensus' };
  }

  const refinedTransform = fitAffine(best.inliers);
  if (!refinedTransform) {
    return { success: false, reason: 'Refined affine fit failed' };
  }

  const refined = scoreAffineTransform(observations, refinedTransform, Math.max(5, best.averageResidual * 2.4));
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
  { minInliers = 8, threshold = 10, minInlierRatio = 0.45, model = 'similarity', maxSample } = {}
) => {
  const fit = model === 'affine'
    ? fitRobustAffine2D(observations, { minInliers, threshold, maxSample })
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

export const boundsForPoints = points => points.reduce((bounds, point) => ({
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
}), {
  min: { x: Infinity, y: Infinity, z: Infinity },
  max: { x: -Infinity, y: -Infinity, z: -Infinity },
});
