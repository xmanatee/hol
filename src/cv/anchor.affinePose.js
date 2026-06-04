const DEFAULT_MIN_CORRESPONDENCES = 8;
const DEFAULT_MIN_INLIER_RATIO = 0.7;
const DEFAULT_MAX_RESIDUAL = 5;
const DEFAULT_MIN_SPREAD = 18;
const DEFAULT_MAX_HYPOTHESES = 96;
const EPSILON = 1e-9;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalize2 = vector => {
  const length = Math.hypot(vector.x, vector.y);
  return {
    x: vector.x / length,
    y: vector.y / length
  };
};

const normalize3 = vector => {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length
  };
};

const solve3x3 = (matrix, values) => {
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i]
  ] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);

  if (Math.abs(determinant) < EPSILON) return null;

  const [x, y, z] = values;

  return [
    (x * (e * i - f * h) - b * (y * i - f * z) + c * (y * h - e * z)) / determinant,
    (a * (y * i - f * z) - x * (d * i - f * g) + c * (d * z - y * g)) / determinant,
    (a * (e * z - y * h) - b * (d * z - y * g) + x * (d * h - e * g)) / determinant
  ];
};

const fitAffine = correspondences => {
  const sums = correspondences.reduce((acc, correspondence) => {
    const { prev, curr } = correspondence;
    acc.xx += prev.x * prev.x;
    acc.xy += prev.x * prev.y;
    acc.yy += prev.y * prev.y;
    acc.x += prev.x;
    acc.y += prev.y;
    acc.u += curr.x;
    acc.v += curr.y;
    acc.xu += prev.x * curr.x;
    acc.yu += prev.y * curr.x;
    acc.xv += prev.x * curr.y;
    acc.yv += prev.y * curr.y;
    return acc;
  }, {
    xx: 0,
    xy: 0,
    yy: 0,
    x: 0,
    y: 0,
    u: 0,
    v: 0,
    xu: 0,
    yu: 0,
    xv: 0,
    yv: 0
  });

  const normal = [
    [sums.xx, sums.xy, sums.x],
    [sums.xy, sums.yy, sums.y],
    [sums.x, sums.y, correspondences.length]
  ];
  const xSolution = solve3x3(normal, [sums.xu, sums.yu, sums.u]);
  const ySolution = solve3x3(normal, [sums.xv, sums.yv, sums.v]);

  if (!xSolution || !ySolution) return null;

  return {
    a: xSolution[0],
    b: xSolution[1],
    tx: xSolution[2],
    c: ySolution[0],
    d: ySolution[1],
    ty: ySolution[2]
  };
};

const transformPoint = (point, affine) => ({
  x: affine.a * point.x + affine.b * point.y + affine.tx,
  y: affine.c * point.x + affine.d * point.y + affine.ty
});

const residualFor = (correspondence, affine) => {
  const predicted = transformPoint(correspondence.prev, affine);
  return Math.hypot(predicted.x - correspondence.curr.x, predicted.y - correspondence.curr.y);
};

const collectInliers = (correspondences, affine, maxResidual) => {
  const residuals = correspondences.map(correspondence => ({
    correspondence,
    residual: residualFor(correspondence, affine)
  }));
  const inliers = residuals
    .filter(item => item.residual <= maxResidual)
    .map(item => item.correspondence);
  const totalResidual = residuals.reduce((sum, item) => sum + item.residual, 0);

  return {
    inliers,
    averageResidual: totalResidual / residuals.length
  };
};

const createTriples = (length, maxHypotheses) => {
  const triples = [];
  let seed = length * 2654435761;

  while (triples.length < maxHypotheses) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const first = seed % length;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const second = seed % length;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const third = seed % length;

    if (first !== second && first !== third && second !== third) {
      triples.push([first, second, third]);
    }
  }

  return triples;
};

const measureSpread = correspondences => {
  const xs = correspondences.map(correspondence => correspondence.prev.x);
  const ys = correspondences.map(correspondence => correspondence.prev.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  return {
    width,
    height,
    minAxis: Math.min(width, height)
  };
};

const estimateSingularValues = affine => {
  const { a, b, c, d } = affine;
  const p = a * a + c * c;
  const q = a * b + c * d;
  const r = b * b + d * d;
  const trace = p + r;
  const determinant = Math.max(0, p * r - q * q);
  const root = Math.sqrt(Math.max(0, trace * trace * 0.25 - determinant));
  const large = Math.sqrt(Math.max(EPSILON, trace * 0.5 + root));
  const small = Math.sqrt(Math.max(EPSILON, trace * 0.5 - root));

  return { large, small };
};

const smallestOutputAxis = affine => {
  const { a, b, c, d } = affine;
  const m00 = a * a + b * b;
  const m01 = a * c + b * d;
  const m11 = c * c + d * d;
  const trace = m00 + m11;
  const determinant = Math.max(0, m00 * m11 - m01 * m01);
  const lambda = trace * 0.5 - Math.sqrt(Math.max(0, trace * trace * 0.25 - determinant));

  if (Math.abs(m01) > EPSILON) {
    return normalize2({ x: m01, y: lambda - m00 });
  }

  return m00 <= m11 ? { x: 1, y: 0 } : { x: 0, y: 1 };
};

const chooseNormalSign = (axis, xyMagnitude, z, previousNormal) => {
  const positive = normalize3({ x: axis.x * xyMagnitude, y: axis.y * xyMagnitude, z });
  const negative = normalize3({ x: -axis.x * xyMagnitude, y: -axis.y * xyMagnitude, z });

  if (previousNormal && Math.hypot(previousNormal.x, previousNormal.y) > 0.05) {
    const positiveDot = positive.x * previousNormal.x + positive.y * previousNormal.y + positive.z * previousNormal.z;
    const negativeDot = negative.x * previousNormal.x + negative.y * previousNormal.y + negative.z * previousNormal.z;
    return positiveDot >= negativeDot ? positive : negative;
  }

  if (Math.abs(axis.x) >= Math.abs(axis.y)) {
    return axis.x >= 0 ? positive : negative;
  }

  return axis.y >= 0 ? positive : negative;
};

const decomposeAffinePose = (affine, previousNormal) => {
  const { large, small } = estimateSingularValues(affine);
  const ratio = clamp(small / large, 0.12, 1);
  const xyMagnitude = ratio > 0.965 ? 0 : Math.sqrt(Math.max(0, 1 - ratio * ratio));
  const axis = smallestOutputAxis(affine);
  const normal = xyMagnitude === 0
    ? { x: 0, y: 0, z: 1 }
    : chooseNormalSign(axis, xyMagnitude, ratio, previousNormal);
  const determinant = affine.a * affine.d - affine.b * affine.c;

  return {
    normal,
    rotation: Math.atan2(affine.c - affine.b, affine.a + affine.d),
    scale: Math.sqrt(Math.max(EPSILON, Math.abs(determinant))),
    foreshortening: ratio
  };
};

export class AffineParallaxPoseEstimator {
  estimatePose(correspondences, options = {}) {
    const minCorrespondences = options.minCorrespondences ?? DEFAULT_MIN_CORRESPONDENCES;
    if (correspondences.length < minCorrespondences) {
      return { success: false, reason: 'Insufficient affine correspondences' };
    }

    const spread = measureSpread(correspondences);
    const minSpread = options.minSpread ?? DEFAULT_MIN_SPREAD;
    if (spread.minAxis < minSpread) {
      return { success: false, reason: 'Degenerate affine spread' };
    }

    const maxResidual = options.maxResidual ?? DEFAULT_MAX_RESIDUAL;
    const maxHypotheses = options.maxHypotheses ?? DEFAULT_MAX_HYPOTHESES;
    const triples = createTriples(correspondences.length, maxHypotheses);
    let best = null;

    for (const triple of triples) {
      const affine = fitAffine(triple.map(index => correspondences[index]));
      if (!affine) continue;

      const candidate = collectInliers(correspondences, affine, maxResidual);
      if (!best || candidate.inliers.length > best.inliers.length) {
        best = candidate;
      }
    }

    if (!best) return { success: false, reason: 'Affine pose unavailable' };

    const minInlierRatio = options.minInlierRatio ?? DEFAULT_MIN_INLIER_RATIO;
    const inlierRatio = best.inliers.length / correspondences.length;
    if (inlierRatio < minInlierRatio) {
      return { success: false, reason: 'Low affine inlier ratio' };
    }

    const affine = fitAffine(best.inliers);
    if (!affine) return { success: false, reason: 'Affine pose unavailable' };

    const refined = collectInliers(correspondences, affine, maxResidual);
    const averageResidual = refined.averageResidual;
    const pose = decomposeAffinePose(affine, options.previousNormal);
    const residualScore = clamp(1 - averageResidual / (maxResidual * 1.5), 0, 1);
    const spreadScore = clamp(spread.minAxis / 48, 0, 1);
    const confidence = clamp(inlierRatio * 0.45 + residualScore * 0.35 + spreadScore * 0.2, 0, 1);

    return {
      success: true,
      method: 'affine-parallax',
      affine,
      normal: pose.normal,
      rotation: pose.rotation,
      scale: pose.scale,
      foreshortening: pose.foreshortening,
      confidence,
      inlierCount: refined.inliers.length,
      inlierRatio,
      averageResidual
    };
  }
}
