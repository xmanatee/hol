const clamp01 = value => Math.max(0, Math.min(1, value));

const sourceBias = source => {
  if (source === 'sparse-reconstruction') return 0.1;
  if (source === 'parametric-surface') return 0.09;
  if (source === 'direct-photometric') return 0.08;
  if (source === 'planar-homography') return 0.04;
  if (source === 'object-pose-affine') return 0.02;
  return 0;
};

const rejectionReason = ({ candidate, requireOverlayOwnership }) => {
  if (requireOverlayOwnership && (candidate.objectOwnedRatio ?? 0) < 0.45) {
    return 'insufficient-object-ownership';
  }
  if ((candidate.inliers ?? 0) < 8 || (candidate.residual ?? Infinity) > 6.5) {
    return 'weak-geometry';
  }
  if ((Number.isFinite(candidate.contourFitResidual) && candidate.contourFitResidual > 7) ||
      (Number.isFinite(candidate.silhouetteCoverage) && candidate.silhouetteCoverage < 0.22)) {
    return 'silhouette-mismatch';
  }
  if ((candidate.confidence ?? 0) < 0.24) {
    return 'low-confidence';
  }
  if (requireOverlayOwnership && candidate.overlayEligible === false) {
    return 'overlay-not-owned';
  }
  return null;
};

const candidateScore = candidate => {
  const residualScore = clamp01(1 - (candidate.residual ?? 8) / 6.5);
  const inlierScore = clamp01((candidate.inliers ?? 0) / 28);
  const ownershipScore = clamp01(candidate.objectOwnedRatio ?? 0);
  const confidenceScore = clamp01(candidate.confidence ?? 0);
  const continuityScore = clamp01(candidate.continuity ?? 0.5);
  const mapScore = clamp01(candidate.mapMaturity ?? 0);
  const contourScore = Number.isFinite(candidate.contourFitResidual)
    ? clamp01(1 - candidate.contourFitResidual / 7)
    : 0.5;
  const silhouetteScore = Number.isFinite(candidate.silhouetteCoverage)
    ? clamp01(candidate.silhouetteCoverage)
    : 0.5;
  const overlayScore = candidate.overlayEligible === false ? -0.12 : 0.03;

  return ownershipScore * 0.28 +
    confidenceScore * 0.17 +
    inlierScore * 0.14 +
    residualScore * 0.14 +
    contourScore * 0.1 +
    silhouetteScore * 0.09 +
    continuityScore * 0.08 +
    mapScore * 0.1 +
    overlayScore +
    sourceBias(candidate.source);
};

export const scorePoseCandidates = ({ candidates, requireOverlayOwnership = true }) => {
  const rejected = {};
  const scored = candidates.map(candidate => {
    const reason = rejectionReason({ candidate, requireOverlayOwnership });
    const score = candidateScore(candidate);
    const record = {
      ...candidate,
      score,
      rejectionReason: reason,
      overlayAllowed: !reason && candidate.overlayEligible !== false,
    };

    if (reason) {
      rejected[candidate.source] = { reason, score };
    }

    return record;
  });
  const selected = scored
    .filter(candidate => !candidate.rejectionReason)
    .sort((left, right) => right.score - left.score)[0] || null;

  return {
    selected,
    rejected,
    candidates: scored,
  };
};
