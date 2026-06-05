const distance3 = (left, right) => Math.hypot(
  left.x - right.x,
  left.y - right.y,
  left.z - right.z
);

const cross2 = (origin, left, right) => (
  (left.x - origin.x) * (right.y - origin.y) -
  (left.y - origin.y) * (right.x - origin.x)
);

const convexHull = points => {
  if (points.length < 3) {
    return points.map(point => point.id);
  }

  const sorted = [...points].sort((left, right) => (
    left.x === right.x ? left.y - right.y : left.x - right.x
  ));
  const lower = [];
  sorted.forEach(point => {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  });

  const upper = [];
  [...sorted].reverse().forEach(point => {
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  });

  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map(point => point.id);
};

const nearestEdges = points => {
  const edgeKeys = new Set();
  const edges = [];

  points.forEach(point => {
    [...points]
      .filter(candidate => candidate.id !== point.id)
      .map(candidate => ({
        candidate,
        distance: distance3(point, candidate),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 3)
      .forEach(({ candidate, distance }) => {
        const from = Math.min(point.id, candidate.id);
        const to = Math.max(point.id, candidate.id);
        const key = `${from}:${to}`;
        if (edgeKeys.has(key)) {
          return;
        }

        edgeKeys.add(key);
        edges.push({
          from,
          to,
          distance,
          reliability: ((point.reliability || 0) + (candidate.reliability || 0)) / 2,
        });
      });
  });

  return edges.sort((left, right) => left.distance - right.distance);
};

export const createSurfacePreview = points => ({
  hull: convexHull(points),
  edges: nearestEdges(points),
});

export const emptySurfacePreview = () => ({
  hull: [],
  edges: [],
});
