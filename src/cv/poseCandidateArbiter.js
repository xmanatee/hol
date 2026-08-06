const clamp01 = (value) => Math.max(0, Math.min(1, value));

const sourceBias = (source) => {
  if (source === 'sparse-reconstruction') return 0.1;
  if (source === 'parametric-surface') return 0.09;
  if (source === 'direct-photometric') return 0.08;
  if (source === 'planar-homography') return 0.04;
  if (source === 'object-pose-affine') return 0.02;
  return 0;
};

const positionRejectionReason = (candidate) => {
  if (candidate.positionRejectionReason) {
    return candidate.positionRejectionReason;
  }
  if (!candidate.position) {
    return 'Position unavailable';
  }
  return Number.isFinite(candidate.position.x) && Number.isFinite(candidate.position.y)
    ? null
    : 'Invalid position';
};

const normalRejectionReason = (candidate) => {
  if (candidate.normalRejectionReason) {
    return candidate.normalRejectionReason;
  }
  if (candidate.normalEligible === false) {
    return 'Normal not eligible';
  }
  if (!candidate.normal) {
    return 'Normal unavailable';
  }
  const components = [candidate.normal.x, candidate.normal.y, candidate.normal.z];
  return components.every(Number.isFinite) && Math.hypot(...components) > 1e-6 ? null : 'Invalid normal';
};

const transformRejectionReason = (candidate) => {
  if (candidate.transformRejectionReason) {
    return candidate.transformRejectionReason;
  }
  if (!candidate.planarTransform) {
    return 'Transform unavailable';
  }
  return Number.isFinite(candidate.planarTransform.scale) &&
    Number.isFinite(candidate.planarTransform.rotation)
    ? null
    : 'Invalid transform';
};

export const poseMeasurementQualityRejectionReason = (candidate) => {
  if ((candidate.inliers ?? 0) < 8 || (candidate.residual ?? Infinity) > 6.5) {
    return 'weak-geometry';
  }
  if ((candidate.confidence ?? 0) < 0.24) {
    return 'low-confidence';
  }
  return null;
};

const positionQualityRejectionReason = (candidate) =>
  candidate.role === 'tracker' ? poseMeasurementQualityRejectionReason(candidate) : null;

const attachmentRejectionReason = ({ candidate, requireObjectOwnership }) => {
  if (requireObjectOwnership && (candidate.objectOwnedRatio ?? 0) < 0.45) {
    return 'insufficient-object-ownership';
  }
  const qualityReason = poseMeasurementQualityRejectionReason(candidate);
  if (qualityReason) {
    return qualityReason;
  }
  if (
    (Number.isFinite(candidate.contourFitResidual) && candidate.contourFitResidual > 7) ||
    (Number.isFinite(candidate.silhouetteCoverage) && candidate.silhouetteCoverage < 0.22)
  ) {
    return 'silhouette-mismatch';
  }
  if (candidate.attachmentEligible === false) {
    return 'attachment-not-owned';
  }
  return null;
};

const positionCandidateScore = (candidate) => {
  const residualScore = clamp01(1 - (candidate.residual ?? 14) / 14);
  const inlierScore = clamp01((candidate.inliers ?? 0) / 28);
  const ownershipScore = clamp01(candidate.objectOwnedRatio ?? 0);
  const confidenceScore = clamp01(candidate.confidence ?? 0);
  const continuityScore = clamp01(candidate.continuity ?? 0.5);
  const mapScore = clamp01(candidate.mapMaturity ?? 0);

  return (
    ownershipScore * 0.22 +
    confidenceScore * 0.24 +
    inlierScore * 0.2 +
    residualScore * 0.18 +
    continuityScore * 0.1 +
    mapScore * 0.06 +
    sourceBias(candidate.source)
  );
};

const candidateScore = (candidate) => {
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
  const attachmentScore = candidate.attachmentEligible === false ? -0.12 : 0.03;

  return (
    ownershipScore * 0.28 +
    confidenceScore * 0.17 +
    inlierScore * 0.14 +
    residualScore * 0.14 +
    contourScore * 0.1 +
    silhouetteScore * 0.09 +
    continuityScore * 0.08 +
    mapScore * 0.1 +
    attachmentScore +
    sourceBias(candidate.source)
  );
};

export const arbitratePoseCandidates = ({ candidates, requireObjectOwnership = true }) => {
  const roles = new Set();
  const sources = new Set();
  for (const candidate of candidates) {
    if (!candidate.role) {
      throw new Error('Pose candidate role is required');
    }
    if (roles.has(candidate.role)) {
      throw new Error(`Duplicate pose candidate role: ${candidate.role}`);
    }
    roles.add(candidate.role);
    if (typeof candidate.source !== 'string' || candidate.source.trim().length === 0) {
      throw new Error('Pose candidate source is required');
    }
    if (sources.has(candidate.source)) {
      throw new Error(`Duplicate pose candidate source: ${candidate.source}`);
    }
    sources.add(candidate.source);
  }

  const rejected = {};
  const scored = candidates.map((candidate) => {
    const positionReason = positionRejectionReason(candidate);
    const normalReason = normalRejectionReason(candidate);
    const transformReason = transformRejectionReason(candidate);
    const positionQualityReason = positionQualityRejectionReason(candidate);
    const attachmentReason = attachmentRejectionReason({
      candidate,
      requireObjectOwnership,
    });
    const score = candidateScore(candidate);
    const record = {
      ...candidate,
      score,
      positionScore: positionCandidateScore(candidate),
      positionRejectionReason: positionReason,
      positionQualityRejectionReason: positionQualityReason,
      positionAllowed: !positionReason,
      normalRejectionReason: normalReason,
      normalAllowed: !normalReason,
      transformRejectionReason: transformReason,
      transformAllowed: !transformReason,
      attachmentRejectionReason: attachmentReason,
      attachmentAllowed: !attachmentReason,
      rejectionReason: attachmentReason,
      overlayAllowed: !attachmentReason,
    };

    if (attachmentReason) {
      rejected[candidate.source] = { reason: attachmentReason, score };
    }

    return record;
  });
  const selectedOverlay =
    scored
      .filter((candidate) => candidate.overlayAllowed)
      .sort((left, right) => right.score - left.score)[0] || null;
  const selectedAttachment =
    scored
      .filter((candidate) => candidate.positionAllowed && candidate.attachmentAllowed)
      .sort((left, right) => right.score - left.score)[0] || null;
  const selectedPosition =
    scored
      .filter((candidate) => candidate.positionAllowed && !candidate.positionQualityRejectionReason)
      .sort((left, right) => right.positionScore - left.positionScore)[0] || null;
  const byRole = Object.fromEntries(scored.map((candidate) => [candidate.role, candidate]));

  return {
    selectedOverlay,
    selectedAttachment,
    selectedPosition,
    rejected,
    candidates: scored,
    byRole,
  };
};

export const selectPosePositionOwner = ({ arbitration, policy }) => {
  const { reconstruction, planar, object, tracker } = arbitration.byRole;
  const reconstructionAvailable = reconstruction?.positionAllowed && policy.reconstructionAllowed;
  const trackerPreferredForReconstructionHold =
    tracker?.positionAllowed && (!policy.releaseWeakTracker || !tracker.positionQualityRejectionReason);

  if (planar?.positionAllowed && (policy.preferPlanar || policy.usePlanarPatch || policy.useArbiterPlanar)) {
    return { role: 'planar', transform: 'planar', reason: 'planar-evidence' };
  }

  if (trackerPreferredForReconstructionHold && reconstructionAvailable && policy.holdDepthFusionTracker) {
    return {
      role: 'tracker',
      transform: policy.useBlendedReconstructionTransform
        ? 'blended-reconstruction'
        : 'tracker-reconstruction',
      reason: 'depth-fusion-tracker-spine',
    };
  }

  if (
    trackerPreferredForReconstructionHold &&
    reconstructionAvailable &&
    !policy.reconstructionConsistentWithTracker &&
    !policy.useStrongReconstruction &&
    !policy.useModerateReconstruction &&
    !policy.useArbiterReconstruction
  ) {
    return {
      role: 'tracker',
      transform: 'tracker-reconstruction',
      reason: 'reconstruction-inconsistent-with-tracker',
    };
  }

  const reconstructionTargetAllowed =
    (!policy.suppressImmatureReconstruction && !policy.suppressPlanarTargetReconstruction) ||
    policy.useStrongReconstruction ||
    policy.useModerateReconstruction ||
    policy.useArbiterReconstruction;
  if (reconstructionAvailable && reconstructionTargetAllowed) {
    const transform =
      policy.useTrackedReconstructionTransform && tracker?.positionAllowed
        ? 'tracker-reconstruction'
        : policy.useBlendedReconstructionTransform && tracker?.positionAllowed
          ? 'blended-reconstruction'
          : 'reconstruction';
    return { role: 'reconstruction', transform, reason: 'reconstruction-evidence' };
  }

  if (tracker?.positionAllowed && policy.holdPlanarTrackerAttachment) {
    return { role: 'tracker', transform: 'tracker', reason: 'planar-pose-dropout' };
  }

  if (object?.positionAllowed) {
    return { role: 'object', transform: 'object', reason: 'object-pose-evidence' };
  }

  return tracker?.positionAllowed
    ? { role: 'tracker', transform: 'tracker', reason: 'tracker-fallback' }
    : null;
};

export const selectPoseNormalOwner = ({ arbitration, policy }) => {
  const { reconstruction, planar, object, local } = arbitration.byRole;

  if (reconstruction?.normalAllowed && policy.exposeSelectedPlanarSurface) {
    return { role: 'reconstruction', reason: 'selected-planar-surface' };
  }

  if (planar?.normalAllowed && policy.preferPlanar) {
    return { role: 'planar', reason: 'planar-target-evidence' };
  }

  if (reconstruction?.normalAllowed) {
    return { role: 'reconstruction', reason: 'reconstruction-surface-evidence' };
  }

  if (object?.normalAllowed && policy.preferForeshortenedObject) {
    return { role: 'object', reason: 'object-foreshortening-evidence' };
  }

  if (local?.normalAllowed && policy.preferLocalPlanarByConfidence) {
    return { role: 'local', reason: 'stronger-planar-normal-evidence' };
  }

  if (object?.normalAllowed) {
    return { role: 'object', reason: 'object-pose-evidence' };
  }

  if (local?.normalAllowed) {
    return { role: 'local', reason: 'local-pose-evidence' };
  }

  return planar?.normalAllowed ? { role: 'planar', reason: 'planar-normal-fallback' } : null;
};
