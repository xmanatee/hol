const distance3 = (left, right) => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);

const cross2 = (origin, left, right) =>
  (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);

const convexHull = (points) => {
  if (points.length < 3) {
    return points.map((point) => point.id);
  }

  const sorted = [...points].sort((left, right) =>
    left.x === right.x ? left.y - right.y : left.x - right.x,
  );
  const lower = [];
  sorted.forEach((point) => {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  });

  const upper = [];
  [...sorted].reverse().forEach((point) => {
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  });

  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map((point) => point.id);
};

const nearestNeighbors = (points, limit) =>
  points.map((point) => {
    const nearest = [];

    points.forEach((candidate) => {
      if (candidate.id === point.id) {
        return;
      }

      const distance = distance3(point, candidate);
      if (nearest.length < limit) {
        nearest.push({ candidate, distance });
        nearest.sort((left, right) => left.distance - right.distance);
        return;
      }

      if (distance < nearest[nearest.length - 1].distance) {
        nearest[nearest.length - 1] = { candidate, distance };
        nearest.sort((left, right) => left.distance - right.distance);
      }
    });

    return { point, nearest };
  });

const nearestEdges = (neighborRows) => {
  const edgeKeys = new Set();
  const edges = [];

  neighborRows.forEach(({ point, nearest }) => {
    nearest.slice(0, 3).forEach(({ candidate, distance }) => {
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

const faceKey = (ids) => [...ids].sort((left, right) => left - right).join(':');

const nearestFaces = (neighborRows) => {
  const faces = [];
  const keys = new Set();

  neighborRows.forEach(({ point, nearest }) => {
    const candidates = nearest.map((item) => item.candidate);

    for (let leftIndex = 0; leftIndex < candidates.length - 1; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex++) {
        const left = candidates[leftIndex];
        const right = candidates[rightIndex];
        const area = Math.abs(cross2(point, left, right));
        if (area < 6) {
          continue;
        }

        const ids = [point.id, left.id, right.id];
        const key = faceKey(ids);
        if (keys.has(key)) {
          continue;
        }

        keys.add(key);
        faces.push({
          points: ids,
          reliability: ((point.reliability || 0) + (left.reliability || 0) + (right.reliability || 0)) / 3,
        });
      }
    }
  });

  return faces.slice(0, Math.max(0, neighborRows.length * 2));
};

export const createSurfacePreview = (points) => {
  const neighborRows = nearestNeighbors(points, 6);
  return {
    hull: convexHull(points),
    edges: nearestEdges(neighborRows),
    faces: nearestFaces(neighborRows),
  };
};

export const emptySurfacePreview = () => ({
  hull: [],
  edges: [],
  faces: [],
});
