import test from 'node:test';
import assert from 'node:assert/strict';

import { scorePoseCandidates } from './poseCandidateArbiter.js';

const pose = overrides => ({
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
  overlayEligible: true,
  ...overrides,
});

test('pose arbiter prefers object-owned surface candidates over higher-confidence background drift', () => {
  const result = scorePoseCandidates({
    candidates: [
      pose({
        source: 'reference_similarity_transform',
        confidence: 0.95,
        inliers: 40,
        residual: 1.1,
        objectOwnedRatio: 0.22,
        overlayEligible: false,
      }),
      pose({
        source: 'sparse-reconstruction',
        confidence: 0.7,
        inliers: 16,
        residual: 2.2,
        objectOwnedRatio: 0.86,
        mapMaturity: 0.74,
      }),
    ],
    requireOverlayOwnership: true,
  });

  assert.equal(result.selected.source, 'sparse-reconstruction');
  assert.equal(result.selected.overlayAllowed, true);
  assert.equal(result.rejected.reference_similarity_transform.reason, 'insufficient-object-ownership');
});

test('pose arbiter records rejection reasons for unusable reconstruction candidates', () => {
  const result = scorePoseCandidates({
    candidates: [
      pose({
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
    requireOverlayOwnership: true,
  });

  assert.equal(result.selected.source, 'planar-homography');
  assert.equal(result.rejected['sparse-reconstruction'].reason, 'weak-geometry');
  assert.ok(result.rejected['sparse-reconstruction'].score < result.selected.score);
});

test('pose arbiter rejects candidates that violate object silhouette evidence', () => {
  const result = scorePoseCandidates({
    candidates: [
      pose({
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
    requireOverlayOwnership: true,
  });

  assert.equal(result.selected.source, 'planar-homography');
  assert.equal(result.rejected['sparse-reconstruction'].reason, 'silhouette-mismatch');
});
