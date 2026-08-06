export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const normalizeAngle = (value) => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

const vectorNorm = (vector) => Math.hypot(...vector);

export const normalizeVector = (vector) => {
  const length = Math.max(vectorNorm(vector), 1e-9);
  return vector.map((value) => value / length);
};

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const projectWithRows = (point, rowX, rowY) => ({
  x: rowX[0] * point.x + rowX[1] * point.y + rowX[2] * point.z + rowX[3],
  y: rowY[0] * point.x + rowY[1] * point.y + rowY[2] * point.z + rowY[3],
});

const solveLinearSystemPairInPlace = (matrix, leftValues, rightValues) => {
  const size = matrix.length;
  matrix.forEach((row, index) => {
    row.push(leftValues[index], rightValues[index]);
  });

  for (let pivot = 0; pivot < size; pivot++) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < size; row++) {
      if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[bestRow][pivot])) {
        bestRow = row;
      }
    }

    if (Math.abs(matrix[bestRow][pivot]) < 1e-9) {
      return null;
    }

    [matrix[pivot], matrix[bestRow]] = [matrix[bestRow], matrix[pivot]];
    const divisor = matrix[pivot][pivot];
    for (let column = pivot; column < size + 2; column++) {
      matrix[pivot][column] /= divisor;
    }

    for (let row = 0; row < size; row++) {
      if (row === pivot) continue;
      const factor = matrix[row][pivot];
      for (let column = pivot; column < size + 2; column++) {
        matrix[row][column] -= factor * matrix[pivot][column];
      }
    }
  }

  return {
    left: matrix.map((row) => row[size]),
    right: matrix.map((row) => row[size + 1]),
  };
};

export const solveLeastSquaresPair = (rows, leftValues, rightValues) => {
  const width = rows[0].length;
  const normal = Array.from({ length: width }, () => new Array(width).fill(0));
  const leftRhs = new Array(width).fill(0);
  const rightRhs = new Array(width).fill(0);

  rows.forEach((row, rowIndex) => {
    for (let i = 0; i < width; i++) {
      leftRhs[i] += row[i] * leftValues[rowIndex];
      rightRhs[i] += row[i] * rightValues[rowIndex];
      for (let j = 0; j < width; j++) {
        normal[i][j] += row[i] * row[j];
      }
    }
  });

  for (let index = 0; index < width; index++) {
    normal[index][index] += 1e-6;
  }

  return solveLinearSystemPairInPlace(normal, leftRhs, rightRhs);
};

export const jacobiEigenSymmetric = (matrix) => {
  const size = matrix.length;
  const a = matrix.map((row) => [...row]);
  const vectors = Array.from({ length: size }, (_rowEntry, row) =>
    Array.from({ length: size }, (_columnEntry, column) => (row === column ? 1 : 0)),
  );

  for (let iteration = 0; iteration < size * size * 20; iteration++) {
    let p = 0;
    let q = 1;
    let maxOffDiagonal = 0;

    for (let row = 0; row < size; row++) {
      for (let column = row + 1; column < size; column++) {
        const value = Math.abs(a[row][column]);
        if (value > maxOffDiagonal) {
          maxOffDiagonal = value;
          p = row;
          q = column;
        }
      }
    }

    if (maxOffDiagonal < 1e-8) break;

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;

    for (let index = 0; index < size; index++) {
      if (index !== p && index !== q) {
        const aip = a[index][p];
        const aiq = a[index][q];
        a[index][p] = c * aip - s * aiq;
        a[p][index] = a[index][p];
        a[index][q] = s * aip + c * aiq;
        a[q][index] = a[index][q];
      }

      const vip = vectors[index][p];
      const viq = vectors[index][q];
      vectors[index][p] = c * vip - s * viq;
      vectors[index][q] = s * vip + c * viq;
    }

    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = 0;
    a[q][p] = 0;
  }

  return a
    .map((row, index) => ({
      value: row[index],
      vector: vectors.map((vectorRow) => vectorRow[index]),
    }))
    .sort((left, right) => right.value - left.value);
};

export const affineCameraObservability = (observations) => {
  const count = observations.length;
  if (count < 4) {
    return 0;
  }

  let x = 0;
  let y = 0;
  let z = 0;
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (const { point } of observations) {
    x += point.x;
    y += point.y;
    z += point.z;
    xx += point.x * point.x;
    xy += point.x * point.y;
    xz += point.x * point.z;
    yy += point.y * point.y;
    yz += point.y * point.z;
    zz += point.z * point.z;
  }
  xx -= (x * x) / count;
  xy -= (x * y) / count;
  xz -= (x * z) / count;
  yy -= (y * y) / count;
  yz -= (y * z) / count;
  zz -= (z * z) / count;

  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  const isotropicVariance = (xx + yy + zz) / 3;
  return clamp(determinant / Math.max(isotropicVariance ** 3, 1e-9), 0, 1);
};

const fitCameraRows = (candidates) => {
  const rows = candidates.map((item) => [item.point.x, item.point.y, item.point.z, 1]);
  const xValues = candidates.map((item) => item.current.x);
  const yValues = candidates.map((item) => item.current.y);
  const solution = solveLeastSquaresPair(rows, xValues, yValues);

  return solution ? { rowX: solution.left, rowY: solution.right } : null;
};

export const fitAffineCamera = (observations, minInliers) => {
  const scoreFit = (candidate) => {
    const candidateResiduals = observations.map((item) => {
      const projected = projectWithRows(item.point, candidate.rowX, candidate.rowY);
      return {
        ...item,
        residual: Math.hypot(projected.x - item.current.x, projected.y - item.current.y),
      };
    });
    const candidateInliers = candidateResiduals.filter((item) => item.residual <= 6);
    const candidateAverageResidual = candidateInliers.length
      ? candidateInliers.reduce((sum, item) => sum + item.residual, 0) / candidateInliers.length
      : Infinity;

    return {
      candidate,
      residuals: candidateResiduals,
      inliers: candidateInliers,
      score: candidateInliers.length * 100 - candidateAverageResidual,
    };
  };

  const sampleSets = [];
  for (let index = 0; index <= observations.length - 4; index++) {
    sampleSets.push([index, index + 1, index + 2, index + 3]);
  }
  for (let offset = 0; offset < Math.min(observations.length, 20); offset++) {
    sampleSets.push([
      offset % observations.length,
      (offset + 7) % observations.length,
      (offset + 13) % observations.length,
      (offset + 19) % observations.length,
    ]);
  }

  const initialFit = fitCameraRows(observations);
  const candidates = [
    initialFit,
    ...sampleSets
      .map((indices) => fitCameraRows(indices.map((index) => observations[index])))
      .filter(Boolean),
  ].filter(Boolean);
  const best = candidates.map(scoreFit).sort((left, right) => right.score - left.score)[0];

  if (!best) {
    return { success: false, reason: 'Degenerate reconstruction pose fit' };
  }

  const residuals = best.residuals;
  const sorted = residuals.map((item) => item.residual).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(6, Math.min(14, median * 2.8));
  const inliers = residuals.filter((item) => item.residual <= threshold);

  if (inliers.length < minInliers) {
    return {
      success: false,
      reason: 'Insufficient reconstruction pose inliers',
      inlierCount: inliers.length,
    };
  }

  const refinedFit = fitCameraRows(inliers);
  if (!refinedFit) {
    return { success: false, reason: 'Degenerate refined reconstruction pose fit' };
  }

  const refinedResiduals = inliers.map((item) => {
    const projected = projectWithRows(item.point, refinedFit.rowX, refinedFit.rowY);
    return Math.hypot(projected.x - item.current.x, projected.y - item.current.y);
  });
  const averageResidual = refinedResiduals.reduce((sum, value) => sum + value, 0) / refinedResiduals.length;

  return {
    success: true,
    rowX: refinedFit.rowX,
    rowY: refinedFit.rowY,
    inlierCount: inliers.length,
    inlierRatio: inliers.length / observations.length,
    averageResidual,
    poseObs: affineCameraObservability(inliers),
  };
};

export const rowScale = (rowX, rowY) =>
  Math.sqrt(Math.max(vectorNorm(rowX.slice(0, 3)) * vectorNorm(rowY.slice(0, 3)), 1e-9));

export const rowRotation = (rowX, rowY) => Math.atan2(rowY[0], rowX[0]);
