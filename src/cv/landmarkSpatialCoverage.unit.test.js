import test from 'node:test';
import assert from 'node:assert/strict';

import {
  orderKeypointsByMaskCoverage,
  summarizeLandmarkMaskCoverage,
  summarizeLandmarkRefreshCoverage,
} from './landmarkSpatialCoverage.js';

const createMask = () => ({
  width: 180,
  height: 120,
  data: new Uint8Array(180 * 120).fill(255),
  bbox: { x: 0, y: 0, width: 180, height: 120 },
});

const keypoint = (x, y, response = 1, bootstrapOnly = false) => ({
  pt: { x, y },
  response,
  bootstrapOnly,
});

test('landmark growth visits under-covered mask cells before adding to a dense cell', () => {
  const objectSupportMask = createMask();
  const existingPoints = Array.from({ length: 8 }, (_, index) => ({
    x: 8 + index * 5,
    y: 18,
  }));
  const denseCandidates = [keypoint(14, 22), keypoint(32, 24)];
  const uncoveredCandidates = [keypoint(72, 18), keypoint(132, 20), keypoint(74, 78), keypoint(134, 80)];

  const ordered = orderKeypointsByMaskCoverage({
    keypoints: [...denseCandidates, ...uncoveredCandidates],
    existingPoints,
    objectSupportMask,
    cellSize: 60,
  });

  assert.deepEqual(
    ordered.slice(0, uncoveredCandidates.length).map((point) => point.pt),
    uncoveredCandidates.map((point) => point.pt),
  );
  assert.deepEqual(
    ordered.slice(uncoveredCandidates.length).map((point) => point.pt),
    denseCandidates.map((point) => point.pt),
  );
});

test('landmark growth balances repeated candidates across equally covered cells', () => {
  const objectSupportMask = createMask();
  const ordered = orderKeypointsByMaskCoverage({
    keypoints: [keypoint(72, 18, 1), keypoint(78, 24, 0.9), keypoint(84, 30, 0.8), keypoint(132, 20, 0.7)],
    existingPoints: [],
    objectSupportMask,
    cellSize: 60,
  });

  assert.deepEqual(
    ordered.slice(0, 2).map((point) => point.pt),
    [
      { x: 72, y: 18 },
      { x: 132, y: 20 },
    ],
  );
});

test('real corners remain ahead of bootstrap points while retaining coverage balance', () => {
  const objectSupportMask = createMask();
  const ordered = orderKeypointsByMaskCoverage({
    keypoints: [keypoint(132, 20, 0.04, true), keypoint(18, 20, 1), keypoint(72, 18, 1)],
    existingPoints: [{ x: 18, y: 18 }],
    objectSupportMask,
    cellSize: 60,
  });

  assert.deepEqual(
    ordered.map((point) => point.pt),
    [
      { x: 72, y: 18 },
      { x: 18, y: 20 },
      { x: 132, y: 20 },
    ],
  );
});

test('coverage summary uses the same mask-aligned grid as growth ordering', () => {
  const summary = summarizeLandmarkMaskCoverage({
    objectSupportMask: createMask(),
    points: [
      { x: 12, y: 12 },
      { x: 24, y: 18 },
      { x: 74, y: 20 },
      { x: 132, y: 82 },
    ],
    cellSize: 60,
  });

  assert.deepEqual(summary, {
    cellCount: 6,
    occupiedCells: 3,
    coverage: 0.5,
  });
});

test('refresh coverage summary ignores unrelated frames and accumulates map growth', () => {
  const summary = summarizeLandmarkRefreshCoverage([
    { metrics: {} },
    {
      metrics: {
        landmarkRefreshCoverageBefore: 0.25,
        landmarkRefreshCoverageAfter: 0.5,
        landmarkRefreshOccupiedBefore: 2,
        landmarkRefreshOccupiedAfter: 4,
      },
    },
    {
      metrics: {
        landmarkRefreshCoverageBefore: 0.5,
        landmarkRefreshCoverageAfter: 0.625,
        landmarkRefreshOccupiedBefore: 4,
        landmarkRefreshOccupiedAfter: 5,
      },
    },
  ]);

  assert.deepEqual(summary, {
    landmarkRefreshCoverageFrames: 2,
    landmarkRefreshCoverageGain: 0.375,
    landmarkRefreshNewOccupiedCells: 3,
  });
});
