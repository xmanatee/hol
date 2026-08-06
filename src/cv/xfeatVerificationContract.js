export const XFEAT_VERIFICATION_CONTRACT = Object.freeze({
  minimumFeatureCount: 500,
  minimumRecoveryInlierCount: 15,
  maximumAnchorError: 7.5,
});

const EVIDENCE_FIELDS = Object.freeze(['anchorError', 'featureCount', 'recoveryInlierCount']);

const requireCount = (value, owner) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${owner} must be a non-negative integer`);
  }
};

export const assertXFeatVerificationContract = (evidence) => {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('XFeat verification evidence must be an object');
  }
  const fields = Object.keys(evidence).sort();
  if (
    fields.length !== EVIDENCE_FIELDS.length ||
    fields.some((field, index) => field !== EVIDENCE_FIELDS[index])
  ) {
    throw new TypeError(`XFeat verification evidence fields must be ${EVIDENCE_FIELDS.join(', ')}`);
  }

  requireCount(evidence.featureCount, 'XFeat featureCount');
  requireCount(evidence.recoveryInlierCount, 'XFeat recoveryInlierCount');
  if (!Number.isFinite(evidence.anchorError) || evidence.anchorError < 0) {
    throw new TypeError('XFeat anchorError must be finite and non-negative');
  }

  if (evidence.featureCount < XFEAT_VERIFICATION_CONTRACT.minimumFeatureCount) {
    throw new Error(
      `XFeat featureCount ${evidence.featureCount} is below ${XFEAT_VERIFICATION_CONTRACT.minimumFeatureCount}`,
    );
  }
  if (evidence.recoveryInlierCount < XFEAT_VERIFICATION_CONTRACT.minimumRecoveryInlierCount) {
    throw new Error(
      `XFeat recoveryInlierCount ${evidence.recoveryInlierCount} is below ${XFEAT_VERIFICATION_CONTRACT.minimumRecoveryInlierCount}`,
    );
  }
  if (evidence.anchorError > XFEAT_VERIFICATION_CONTRACT.maximumAnchorError) {
    throw new Error(
      `XFeat anchorError ${evidence.anchorError} exceeds ${XFEAT_VERIFICATION_CONTRACT.maximumAnchorError}`,
    );
  }

  return evidence;
};
