export const RELOCALIZATION_GEOMETRY_DEFAULTS = Object.freeze({
  minSpatialSpread: 18,
  minMinorSpread: 6,
  minLinearScale: 0.3,
  maxLinearScale: 3,
  maxAffineAnisotropy: 2.4,
  maxAverageResidual: 5.5,
});

const pointSupport = (entries, selectPoint) => {
  if (entries.length === 0) return { spread: 0, minorSpread: 0 };
  let x = 0;
  let y = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const entry of entries) {
    const point = selectPoint(entry);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    x += point.x;
    y += point.y;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  x /= entries.length;
  y /= entries.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const entry of entries) {
    const point = selectPoint(entry);
    const dx = point.x - x;
    const dy = point.y - y;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const major = (xx + yy + Math.hypot(xx - yy, 2 * xy)) / 2;
  const minor = major === 0 ? 0 : Math.max(0, (xx * yy - xy * xy) / major);
  return {
    spread: Math.hypot(maxX - minX, maxY - minY),
    // Twice the RMS extent along the least-supported axis, in working-image pixels.
    minorSpread: 2 * Math.sqrt(minor / entries.length),
  };
};

export const assessRelocalizationGeometry = (fit, options = {}) => {
  const {
    minSpatialSpread,
    minMinorSpread,
    minLinearScale,
    maxLinearScale,
    maxAffineAnisotropy,
    maxAverageResidual,
    methodLabel = 'ORB',
  } = { ...RELOCALIZATION_GEOMETRY_DEFAULTS, ...options };
  const reject = (reason) => ({ valid: false, reason: `${methodLabel} ${reason}` });
  if (![...fit.transform.rowX, ...fit.transform.rowY].every(Number.isFinite)) {
    return reject('geometry contains non-finite affine coefficients');
  }
  if (!Number.isFinite(fit.averageResidual) || fit.averageResidual < 0) {
    return reject('geometry contains an invalid residual');
  }
  const [a, b] = fit.transform.rowX;
  const [c, d] = fit.transform.rowY;
  const determinant = a * d - b * c;
  // Singular values measure extrema over every direction, including shear collapse.
  const maxScale = (Math.hypot(a + d, c - b) + Math.hypot(a - d, c + b)) / 2;
  const minScale = maxScale === 0 ? 0 : Math.abs(determinant) / maxScale;
  const anisotropy = maxScale / minScale;
  if (![determinant, minScale, maxScale].every(Number.isFinite)) {
    return reject('geometry contains non-finite principal scales');
  }
  if (determinant <= 0) return reject('geometry implies a reflected or collapsed view');
  if (minScale < minLinearScale || maxScale > maxLinearScale) {
    return reject(`geometry scale ${minScale.toFixed(2)}-${maxScale.toFixed(2)} is implausible`);
  }
  if (anisotropy > maxAffineAnisotropy) {
    return reject(`affine anisotropy ${anisotropy.toFixed(2)} is implausible`);
  }
  const reference = pointSupport(fit.inliers, (inlier) => inlier.reference);
  const query = pointSupport(fit.inliers, (inlier) => inlier.current);
  if (
    !reference ||
    !query ||
    ![reference.spread, reference.minorSpread, query.spread, query.minorSpread].every(Number.isFinite)
  ) {
    return reject('geometry contains non-finite inlier coordinates');
  }
  if (reference.spread < minSpatialSpread || query.spread < minSpatialSpread) {
    return reject(
      `inliers are spatially concentrated (${reference.spread.toFixed(1)}px/${query.spread.toFixed(1)}px)`,
    );
  }
  if (reference.minorSpread < minMinorSpread || query.minorSpread < minMinorSpread) {
    return reject(
      `inliers lack two-dimensional support (${reference.minorSpread.toFixed(1)}px/${query.minorSpread.toFixed(1)}px)`,
    );
  }
  if (fit.averageResidual > maxAverageResidual) {
    return reject(`geometric residual ${fit.averageResidual.toFixed(2)}px is too high`);
  }
  return {
    valid: true,
    reason: null,
    determinant,
    minScale,
    maxScale,
    anisotropy,
    referenceSpread: reference.spread,
    querySpread: query.spread,
    referenceMinorSpread: reference.minorSpread,
    queryMinorSpread: query.minorSpread,
  };
};
