import {
  fitRobustAffine2D,
  fitRobustSimilarity,
  transformPointAffine2,
} from './anchor.reconstructionRobust.js';
import { assessRelocalizationGeometry, RELOCALIZATION_GEOMETRY_DEFAULTS } from './relocalizationGeometry.js';

export const RELOCALIZATION_DEFAULTS = Object.freeze({
  ...RELOCALIZATION_GEOMETRY_DEFAULTS,
  minMatches: 5,
  minInliers: 5,
  minAffineInliers: 6,
  minInlierRatio: 0.5,
  inlierThreshold: 10,
});

const similarityToAffine = ({ scale, rotation, tx, ty }) => ({
  rowX: [scale * Math.cos(rotation), -scale * Math.sin(rotation), tx],
  rowY: [scale * Math.sin(rotation), scale * Math.cos(rotation), ty],
});

export const recoverMatchedKeyframe = (keyframe, observations, options = {}) => {
  const config = { ...RELOCALIZATION_DEFAULTS, methodLabel: 'Recovery', ...options };
  const { methodLabel } = config;
  const failure = (reason, inlierCount = 0) => ({
    success: false,
    reason: `${methodLabel}: ${reason}`,
    matchCount: observations.length,
    inlierCount,
    keyframeId: keyframe.id,
  });
  if (observations.length < config.minMatches) {
    return failure(`Only ${observations.length} reciprocal descriptor matches`);
  }

  const fits = [
    {
      ...fitRobustAffine2D(observations, {
        minInliers: config.minInliers,
        threshold: config.inlierThreshold,
        maxSample: 20,
        sampleCoverage: 'spatial',
      }),
      model: 'affine',
    },
    {
      ...fitRobustSimilarity(observations, {
        minInliers: config.minInliers,
        threshold: config.inlierThreshold,
        maxSample: 24,
      }),
      model: 'similarity',
    },
  ];
  const assessed = fits.map((candidate) => {
    if (!candidate.success) return candidate;
    if (
      candidate.inlierCount < (candidate.model === 'affine' ? config.minAffineInliers : config.minInliers)
    ) {
      return { ...candidate, success: false, reason: `Insufficient ${candidate.model} inliers` };
    }
    if (candidate.inlierRatio < config.minInlierRatio) {
      return { ...candidate, success: false, reason: `Low ${candidate.model} inlier ratio` };
    }
    const transform =
      candidate.model === 'similarity' ? similarityToAffine(candidate.transform) : candidate.transform;
    const geometry = assessRelocalizationGeometry(
      { ...candidate, transform },
      { ...config, methodLabel: candidate.model },
    );
    return { ...candidate, transform, geometry, success: geometry.valid, reason: geometry.reason };
  });
  const [affine, similarity] = assessed;
  // Extra affine degrees of freedom must earn additional support, not just a closer fit.
  const fit =
    affine.success &&
    (!similarity.success ||
      (affine.inlierCount >= similarity.inlierCount + 2 &&
        affine.averageResidual <= similarity.averageResidual))
      ? affine
      : similarity.success
        ? similarity
        : null;
  if (!fit) {
    const rejected = assessed.toSorted(
      (left, right) => (right.inlierCount ?? 0) - (left.inlierCount ?? 0),
    )[0];
    return failure(rejected.reason, rejected.inlierCount ?? 0);
  }
  const inlierMatches = fit.inliers.map((inlier) => ({
    id: inlier.id,
    reference: { ...inlier.landmarkReference },
    point: {
      x:
        inlier.current.x +
        fit.transform.rowX[0] * inlier.referenceOffset.x +
        fit.transform.rowX[1] * inlier.referenceOffset.y,
      y:
        inlier.current.y +
        fit.transform.rowY[0] * inlier.referenceOffset.x +
        fit.transform.rowY[1] * inlier.referenceOffset.y,
    },
    response: inlier.response,
  }));
  return {
    success: true,
    transform: {
      type: 'affine',
      rowX: [...fit.transform.rowX],
      rowY: [...fit.transform.rowY],
      confidence: fit.confidence,
      averageResidual: fit.averageResidual,
      model: fit.model,
      determinant: fit.geometry.determinant,
      anisotropy: fit.geometry.anisotropy,
      referenceSpread: fit.geometry.referenceSpread,
      querySpread: fit.geometry.querySpread,
    },
    anchorPoint: transformPointAffine2(keyframe.anchorPoint, fit.transform),
    inlierMatches,
    matchCount: observations.length,
    inlierCount: fit.inlierCount,
    inlierRatio: fit.inlierRatio,
    averageResidual: fit.averageResidual,
    confidence: fit.confidence,
    keyframeId: keyframe.id,
  };
};

export const selectRelocalizationResult = (results) =>
  results.toSorted(
    (left, right) =>
      Number(right.success) - Number(left.success) ||
      (right.inlierCount ?? 0) - (left.inlierCount ?? 0) ||
      (left.success
        ? right.inlierRatio - left.inlierRatio || left.averageResidual - right.averageResidual
        : right.matchCount - left.matchCount),
  )[0] ?? null;
