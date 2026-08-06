import test from 'node:test';
import assert from 'node:assert/strict';

import {
  arbitratePoseCandidates,
  selectPoseNormalOwner,
  selectPosePositionOwner,
} from './poseCandidateArbiter.js';

const pose = (overrides) => ({
  role: 'planar',
  source: 'planar-homography',
  position: { x: 100, y: 90, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  planarTransform: { scale: 1, rotation: 0 },
  inliers: 18,
  residual: 1.8,
  confidence: 0.7,
  objectOwnedRatio: 0.82,
  continuity: 0.8,
  mapMaturity: 0.4,
  attachmentEligible: true,
  ...overrides,
});

test('pose arbiter prefers object-owned surface candidates over higher-confidence background drift', () => {
  const result = arbitratePoseCandidates({
    candidates: [
      pose({
        role: 'tracker',
        source: 'reference_similarity_transform',
        confidence: 0.95,
        inliers: 40,
        residual: 1.1,
        objectOwnedRatio: 0.22,
        attachmentEligible: false,
      }),
      pose({
        role: 'reconstruction',
        source: 'sparse-reconstruction',
        confidence: 0.7,
        inliers: 16,
        residual: 2.2,
        objectOwnedRatio: 0.86,
        mapMaturity: 0.74,
      }),
    ],
    requireObjectOwnership: true,
  });

  assert.equal(result.selectedOverlay.source, 'sparse-reconstruction');
  assert.equal(result.selectedAttachment.source, 'sparse-reconstruction');
  assert.equal(result.selectedPosition.source, 'sparse-reconstruction');
  assert.equal(result.selectedOverlay.overlayAllowed, true);
  assert.equal(result.rejected.reference_similarity_transform.reason, 'insufficient-object-ownership');
});

test('pose arbiter records rejection reasons for unusable reconstruction candidates', () => {
  const result = arbitratePoseCandidates({
    candidates: [
      pose({
        role: 'reconstruction',
        source: 'sparse-reconstruction',
        inliers: 7,
        residual: 8.5,
        confidence: 0.58,
        objectOwnedRatio: 0.78,
        mapMaturity: 0.7,
      }),
      pose({
        source: 'planar-homography',
        inliers: 18,
        residual: 2,
        confidence: 0.62,
        objectOwnedRatio: 0.74,
      }),
    ],
    requireObjectOwnership: true,
  });

  assert.equal(result.selectedOverlay.source, 'planar-homography');
  assert.equal(result.rejected['sparse-reconstruction'].reason, 'weak-geometry');
  assert.ok(result.rejected['sparse-reconstruction'].score < result.selectedOverlay.score);
});

test('pose arbiter rejects candidates that violate object silhouette evidence', () => {
  const result = arbitratePoseCandidates({
    candidates: [
      pose({
        role: 'reconstruction',
        source: 'sparse-reconstruction',
        inliers: 24,
        residual: 1.4,
        confidence: 0.82,
        objectOwnedRatio: 0.88,
        contourFitResidual: 9.2,
        silhouetteCoverage: 0.18,
      }),
      pose({
        source: 'planar-homography',
        inliers: 18,
        residual: 2.1,
        confidence: 0.64,
        objectOwnedRatio: 0.76,
        contourFitResidual: 2.4,
        silhouetteCoverage: 0.52,
      }),
    ],
    requireObjectOwnership: true,
  });

  assert.equal(result.selectedOverlay.source, 'planar-homography');
  assert.equal(result.rejected['sparse-reconstruction'].reason, 'silhouette-mismatch');
});

test('pose arbiter exposes role-specific position and overlay capabilities', () => {
  const result = arbitratePoseCandidates({
    candidates: [
      pose({
        role: 'tracker',
        source: 'reference_similarity_transform',
        normal: null,
        attachmentEligible: false,
      }),
      pose({
        role: 'reconstruction',
        source: 'sparse-reconstruction',
        positionRejectionReason: 'High pose residual',
        attachmentEligible: false,
      }),
    ],
    requireObjectOwnership: true,
  });

  assert.equal(result.byRole.tracker.positionAllowed, true);
  assert.equal(result.byRole.tracker.normalAllowed, false);
  assert.equal(result.byRole.tracker.transformAllowed, true);
  assert.equal(result.byRole.tracker.overlayAllowed, false);
  assert.equal(result.byRole.reconstruction.positionAllowed, false);
  assert.equal(result.byRole.reconstruction.normalAllowed, true);
  assert.equal(result.byRole.reconstruction.transformAllowed, true);
  assert.equal(result.byRole.reconstruction.positionRejectionReason, 'High pose residual');
  assert.equal(result.selectedOverlay, null);
  assert.equal(result.selectedAttachment, null);
});

test('pose arbiter keeps position eligibility independent from normal eligibility', () => {
  const result = arbitratePoseCandidates({
    candidates: [pose({ normal: null })],
  });

  assert.equal(result.byRole.planar.positionAllowed, true);
  assert.equal(result.byRole.planar.normalAllowed, false);
  assert.equal(result.byRole.planar.normalRejectionReason, 'Normal unavailable');
});

test('pose arbiter validates numerical capabilities independently', () => {
  const result = arbitratePoseCandidates({
    candidates: [
      pose({
        normal: { x: NaN, y: 0, z: 1 },
        planarTransform: { scale: 1, rotation: undefined },
      }),
    ],
  });

  assert.equal(result.byRole.planar.positionAllowed, true);
  assert.equal(result.byRole.planar.normalAllowed, false);
  assert.equal(result.byRole.planar.normalRejectionReason, 'Invalid normal');
  assert.equal(result.byRole.planar.transformAllowed, false);
  assert.equal(result.byRole.planar.transformRejectionReason, 'Invalid transform');
});

test('pose arbiter rejects zero-length normals', () => {
  const result = arbitratePoseCandidates({
    candidates: [pose({ normal: { x: 0, y: 0, z: 0 } })],
  });

  assert.equal(result.byRole.planar.positionAllowed, true);
  assert.equal(result.byRole.planar.normalAllowed, false);
  assert.equal(result.byRole.planar.normalRejectionReason, 'Invalid normal');
});

test('pose arbiter requires unique semantic roles and diagnostic sources', () => {
  assert.throws(
    () =>
      arbitratePoseCandidates({
        candidates: [pose({ source: 'planar-homography' }), pose({ source: 'direct-photometric' })],
      }),
    /Duplicate pose candidate role: planar/,
  );
  assert.throws(
    () =>
      arbitratePoseCandidates({
        candidates: [pose({ source: '' })],
      }),
    /Pose candidate source is required/,
  );
  assert.throws(
    () =>
      arbitratePoseCandidates({
        candidates: [
          pose({ role: 'planar', source: 'shared-source' }),
          pose({ role: 'object', source: 'shared-source' }),
        ],
      }),
    /Duplicate pose candidate source: shared-source/,
  );
});

test('position ownership follows one explicit precedence table', () => {
  const arbitration = arbitratePoseCandidates({
    candidates: [
      pose({ role: 'reconstruction', source: 'sparse-reconstruction' }),
      pose({ role: 'planar', source: 'planar-homography' }),
      pose({ role: 'object', source: 'object-pose-affine' }),
      pose({
        role: 'tracker',
        source: 'reference_similarity_transform',
        normal: null,
        attachmentEligible: false,
      }),
    ],
  });
  const basePolicy = {
    preferPlanar: false,
    usePlanarPatch: false,
    useArbiterPlanar: false,
    reconstructionAllowed: true,
    holdDepthFusionTracker: false,
    reconstructionConsistentWithTracker: true,
    useStrongReconstruction: false,
    useModerateReconstruction: false,
    useArbiterReconstruction: false,
    suppressImmatureReconstruction: false,
    suppressPlanarTargetReconstruction: false,
    holdPlanarTrackerAttachment: false,
    useTrackedReconstructionTransform: false,
    useBlendedReconstructionTransform: false,
  };

  assert.deepEqual(
    selectPosePositionOwner({
      arbitration,
      policy: { ...basePolicy, preferPlanar: true },
    }),
    { role: 'planar', transform: 'planar', reason: 'planar-evidence' },
  );
  assert.deepEqual(
    selectPosePositionOwner({
      arbitration,
      policy: { ...basePolicy, holdDepthFusionTracker: true },
    }),
    {
      role: 'tracker',
      transform: 'tracker-reconstruction',
      reason: 'depth-fusion-tracker-spine',
    },
  );
  assert.deepEqual(
    selectPosePositionOwner({
      arbitration,
      policy: {
        ...basePolicy,
        reconstructionConsistentWithTracker: false,
      },
    }),
    {
      role: 'tracker',
      transform: 'tracker-reconstruction',
      reason: 'reconstruction-inconsistent-with-tracker',
    },
  );
  assert.deepEqual(
    selectPosePositionOwner({
      arbitration,
      policy: { ...basePolicy, useBlendedReconstructionTransform: true },
    }),
    {
      role: 'reconstruction',
      transform: 'blended-reconstruction',
      reason: 'reconstruction-evidence',
    },
  );
  assert.deepEqual(
    selectPosePositionOwner({
      arbitration,
      policy: {
        ...basePolicy,
        reconstructionAllowed: false,
        holdPlanarTrackerAttachment: true,
      },
    }),
    { role: 'tracker', transform: 'tracker', reason: 'planar-pose-dropout' },
  );
});

test('position ownership does not hold a tracker rejected for weak geometry over reconstruction', () => {
  const arbitration = arbitratePoseCandidates({
    candidates: [
      pose({
        role: 'reconstruction',
        source: 'direct-photometric',
        inliers: 18,
        residual: 5.5,
        confidence: 0.88,
        mapMaturity: 0.82,
      }),
      pose({
        role: 'tracker',
        source: 'reference_similarity_transform',
        normal: null,
        inliers: 17,
        residual: 20,
        confidence: 0,
        attachmentEligible: false,
      }),
    ],
  });

  assert.equal(arbitration.byRole.tracker.positionQualityRejectionReason, 'weak-geometry');
  assert.deepEqual(
    selectPosePositionOwner({
      arbitration,
      policy: {
        preferPlanar: false,
        usePlanarPatch: false,
        useArbiterPlanar: false,
        reconstructionAllowed: true,
        releaseWeakTracker: true,
        holdDepthFusionTracker: true,
        reconstructionConsistentWithTracker: false,
        useStrongReconstruction: false,
        useModerateReconstruction: false,
        useArbiterReconstruction: false,
        suppressImmatureReconstruction: false,
        suppressPlanarTargetReconstruction: false,
        holdPlanarTrackerAttachment: false,
        useTrackedReconstructionTransform: false,
        useBlendedReconstructionTransform: false,
      },
    }),
    {
      role: 'reconstruction',
      transform: 'reconstruction',
      reason: 'reconstruction-evidence',
    },
  );

  assert.deepEqual(
    selectPosePositionOwner({
      arbitration,
      policy: {
        preferPlanar: false,
        usePlanarPatch: false,
        useArbiterPlanar: false,
        reconstructionAllowed: true,
        releaseWeakTracker: false,
        holdDepthFusionTracker: true,
        reconstructionConsistentWithTracker: false,
        useStrongReconstruction: false,
        useModerateReconstruction: false,
        useArbiterReconstruction: false,
        suppressImmatureReconstruction: false,
        suppressPlanarTargetReconstruction: false,
        holdPlanarTrackerAttachment: false,
        useTrackedReconstructionTransform: false,
        useBlendedReconstructionTransform: false,
      },
    }),
    {
      role: 'tracker',
      transform: 'tracker-reconstruction',
      reason: 'depth-fusion-tracker-spine',
    },
  );
});

test('position ownership falls through unusable candidates without bypassing validation', () => {
  const arbitration = arbitratePoseCandidates({
    candidates: [
      pose({
        role: 'reconstruction',
        source: 'sparse-reconstruction',
        positionRejectionReason: 'High pose residual',
      }),
      pose({
        role: 'planar',
        source: 'planar-homography',
        positionRejectionReason: 'Low pose inlier ratio',
      }),
      pose({ role: 'object', source: 'object-pose-affine' }),
      pose({
        role: 'tracker',
        source: 'reference_similarity_transform',
        normal: null,
        attachmentEligible: false,
      }),
    ],
  });

  assert.deepEqual(
    selectPosePositionOwner({
      arbitration,
      policy: {
        preferPlanar: true,
        usePlanarPatch: true,
        useArbiterPlanar: true,
        reconstructionAllowed: true,
        holdDepthFusionTracker: false,
        reconstructionConsistentWithTracker: true,
        useStrongReconstruction: true,
        useModerateReconstruction: true,
        useArbiterReconstruction: true,
        suppressImmatureReconstruction: false,
        suppressPlanarTargetReconstruction: false,
        holdPlanarTrackerAttachment: false,
        useTrackedReconstructionTransform: false,
        useBlendedReconstructionTransform: false,
      },
    }),
    { role: 'object', transform: 'object', reason: 'object-pose-evidence' },
  );
});

test('normal ownership follows one explicit evidence precedence table', () => {
  const arbitration = arbitratePoseCandidates({
    candidates: [
      pose({ role: 'reconstruction', source: 'sparse-reconstruction' }),
      pose({ role: 'planar', source: 'planar-homography' }),
      pose({ role: 'object', source: 'object-pose-affine' }),
      pose({
        role: 'tracker',
        source: 'reference_similarity_transform',
        normal: null,
        attachmentEligible: false,
      }),
    ],
  });
  const basePolicy = {
    exposeSelectedPlanarSurface: false,
    preferPlanar: false,
    preferForeshortenedObject: false,
    preferLocalPlanarByConfidence: false,
  };

  assert.deepEqual(
    selectPoseNormalOwner({
      arbitration,
      policy: { ...basePolicy, exposeSelectedPlanarSurface: true },
    }),
    { role: 'reconstruction', reason: 'selected-planar-surface' },
  );
  assert.deepEqual(
    selectPoseNormalOwner({
      arbitration,
      policy: { ...basePolicy, preferPlanar: true },
    }),
    { role: 'planar', reason: 'planar-target-evidence' },
  );
  assert.deepEqual(
    selectPoseNormalOwner({
      arbitration,
      policy: basePolicy,
    }),
    { role: 'reconstruction', reason: 'reconstruction-surface-evidence' },
  );
});

test('normal ownership falls through rejected candidates without changing position eligibility', () => {
  const arbitration = arbitratePoseCandidates({
    candidates: [
      pose({
        role: 'reconstruction',
        source: 'sparse-reconstruction',
        normalRejectionReason: 'weak-inconsistent-reconstruction-normal',
      }),
      pose({
        role: 'planar',
        source: 'planar-homography',
        normalRejectionReason: 'low-normal-confidence',
      }),
      pose({ role: 'object', source: 'object-pose-affine' }),
    ],
  });

  assert.deepEqual(
    selectPoseNormalOwner({
      arbitration,
      policy: {
        exposeSelectedPlanarSurface: true,
        preferPlanar: true,
        preferForeshortenedObject: true,
        preferLocalPlanarByConfidence: true,
      },
    }),
    { role: 'object', reason: 'object-foreshortening-evidence' },
  );
  assert.equal(arbitration.byRole.reconstruction.positionAllowed, true);
  assert.equal(arbitration.byRole.reconstruction.normalAllowed, false);
  assert.equal(
    arbitration.byRole.reconstruction.normalRejectionReason,
    'weak-inconsistent-reconstruction-normal',
  );
  assert.equal(arbitration.byRole.planar.positionAllowed, true);
  assert.equal(arbitration.byRole.planar.normalAllowed, false);
});

test('normal ownership can prefer stronger planar evidence over a face-on object pose', () => {
  const arbitration = arbitratePoseCandidates({
    candidates: [
      pose({ role: 'local', source: 'homography' }),
      pose({ role: 'object', source: 'object-pose-affine' }),
    ],
  });

  assert.deepEqual(
    selectPoseNormalOwner({
      arbitration,
      policy: {
        exposeSelectedPlanarSurface: false,
        preferPlanar: false,
        preferForeshortenedObject: false,
        preferLocalPlanarByConfidence: true,
      },
    }),
    { role: 'local', reason: 'stronger-planar-normal-evidence' },
  );
});
