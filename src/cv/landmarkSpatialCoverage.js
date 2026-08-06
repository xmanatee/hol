import { isPointInsideObjectSupport } from './objectSupportMask.js';

export const LANDMARK_COVERAGE_CELL_SIZE = 42;

const createCoverageGrid = (objectSupportMask, cellSize) => ({
  bbox: objectSupportMask.bbox,
  cellSize,
  columns: Math.max(1, Math.ceil(objectSupportMask.bbox.width / cellSize)),
  rows: Math.max(1, Math.ceil(objectSupportMask.bbox.height / cellSize)),
});

const cellKeyForPoint = (point, grid) => {
  const column = Math.floor((point.x - grid.bbox.x) / grid.cellSize);
  const row = Math.floor((point.y - grid.bbox.y) / grid.cellSize);
  if (column < 0 || column >= grid.columns || row < 0 || row >= grid.rows) {
    return null;
  }
  return `${column}:${row}`;
};

const compareKeypoints = (left, right) =>
  right.keypoint.response - left.keypoint.response || left.index - right.index;

const distributeTier = ({ candidates, grid, occupancy }) => {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = cellKeyForPoint(candidate.keypoint.pt, grid);
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  }

  const buckets = [...groups.entries()].map(([key, group]) => ({
    key,
    occupancy: occupancy.get(key) || 0,
    candidates: group.sort(compareKeypoints),
  }));
  const ordered = [];

  while (buckets.length) {
    buckets.sort(
      (left, right) =>
        left.occupancy - right.occupancy ||
        compareKeypoints(left.candidates[0], right.candidates[0]) ||
        left.key.localeCompare(right.key),
    );
    const bucket = buckets[0];
    ordered.push(bucket.candidates.shift().keypoint);
    bucket.occupancy += 1;
    occupancy.set(bucket.key, bucket.occupancy);
    if (!bucket.candidates.length) {
      buckets.shift();
    }
  }

  return ordered;
};

export const summarizeLandmarkMaskCoverage = ({
  objectSupportMask,
  points,
  cellSize = LANDMARK_COVERAGE_CELL_SIZE,
}) => {
  const grid = createCoverageGrid(objectSupportMask, cellSize);
  const occupied = new Set(
    points
      .filter((point) => isPointInsideObjectSupport(objectSupportMask, point))
      .map((point) => cellKeyForPoint(point, grid)),
  );
  const cellCount = grid.columns * grid.rows;

  return {
    cellCount,
    occupiedCells: occupied.size,
    coverage: occupied.size / cellCount,
  };
};

export const summarizeLandmarkRefreshCoverage = (frames) => {
  const refreshes = frames
    .map((frame) => frame.metrics)
    .filter(
      (metrics) =>
        Number.isFinite(metrics?.landmarkRefreshCoverageBefore) &&
        Number.isFinite(metrics?.landmarkRefreshCoverageAfter) &&
        Number.isFinite(metrics?.landmarkRefreshOccupiedBefore) &&
        Number.isFinite(metrics?.landmarkRefreshOccupiedAfter),
    );

  return {
    landmarkRefreshCoverageFrames: refreshes.length,
    landmarkRefreshCoverageGain: refreshes.reduce(
      (sum, metrics) => sum + metrics.landmarkRefreshCoverageAfter - metrics.landmarkRefreshCoverageBefore,
      0,
    ),
    landmarkRefreshNewOccupiedCells: refreshes.reduce(
      (sum, metrics) => sum + metrics.landmarkRefreshOccupiedAfter - metrics.landmarkRefreshOccupiedBefore,
      0,
    ),
  };
};

export const orderKeypointsByMaskCoverage = ({
  keypoints,
  existingPoints,
  objectSupportMask,
  cellSize = LANDMARK_COVERAGE_CELL_SIZE,
}) => {
  const grid = createCoverageGrid(objectSupportMask, cellSize);
  const occupancy = new Map();
  for (const point of existingPoints) {
    if (!isPointInsideObjectSupport(objectSupportMask, point)) {
      continue;
    }
    const key = cellKeyForPoint(point, grid);
    occupancy.set(key, (occupancy.get(key) || 0) + 1);
  }

  const inside = [];
  const outside = [];
  keypoints.forEach((keypoint, index) => {
    const candidate = { keypoint, index };
    if (isPointInsideObjectSupport(objectSupportMask, keypoint.pt)) {
      inside.push(candidate);
    } else {
      outside.push(candidate);
    }
  });
  const corners = inside.filter((candidate) => candidate.keypoint.bootstrapOnly !== true);
  const bootstrap = inside.filter((candidate) => candidate.keypoint.bootstrapOnly === true);

  return [
    ...distributeTier({ candidates: corners, grid, occupancy }),
    ...distributeTier({ candidates: bootstrap, grid, occupancy }),
    ...outside.sort(compareKeypoints).map((candidate) => candidate.keypoint),
  ];
};
