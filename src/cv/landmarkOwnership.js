export const LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES = 2;
export const RECOVERY_LANDMARK_MAP_CONFIRMATION_FRAMES = 4;

export const ownershipEvidenceFramesFor = (point) =>
  point.recoveryOwnershipProbation === true
    ? RECOVERY_LANDMARK_MAP_CONFIRMATION_FRAMES
    : LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES;

export const isConfirmedObjectOwnedLandmark = (point) =>
  point.objectOwned !== false && point.objectOwnedStreak >= LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES;

export const isReconstructionEligibleLandmark = (point) =>
  isConfirmedObjectOwnedLandmark(point) &&
  (point.recoveryOwnershipProbation !== true ||
    point.objectOwnedStreak >= RECOVERY_LANDMARK_MAP_CONFIRMATION_FRAMES);

export const isProbationaryObjectOwnedLandmark = (point) =>
  point.objectOwned === true && point.objectOwnedStreak < LANDMARK_OWNERSHIP_CONFIRMATION_FRAMES;
