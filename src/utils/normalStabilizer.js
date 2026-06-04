const DEFAULT_NORMAL = { x: 0, y: 0, z: 1 };

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const normalize = (normal) => {
  const zPositive = normal.z < 0
    ? { x: -normal.x, y: -normal.y, z: -normal.z }
    : normal;
  const length = Math.hypot(zPositive.x, zPositive.y, zPositive.z) || 1;

  return {
    x: zPositive.x / length,
    y: zPositive.y / length,
    z: zPositive.z / length,
  };
};

const dot = (a, b) => clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const weightedAverage = samples => {
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0) || 1;
  const summed = samples.reduce((acc, sample) => ({
    x: acc.x + sample.normal.x * sample.weight,
    y: acc.y + sample.normal.y * sample.weight,
    z: acc.z + sample.normal.z * sample.weight,
  }), { x: 0, y: 0, z: 0 });

  return normalize({
    x: summed.x / totalWeight,
    y: summed.y / totalWeight,
    z: summed.z / totalWeight,
  });
};

export const angularDistanceBetweenNormals = (a, b) => {
  return Math.acos(dot(normalize(a), normalize(b)));
};

export class SurfaceNormalStabilizer {
  constructor(options = {}) {
    this.historySize = options.historySize ?? 9;
    this.deadbandRadians = options.deadbandRadians ?? 0.028;
    this.outlierRadians = options.outlierRadians ?? 0.22;
    this.baseAlpha = options.baseAlpha ?? 0.07;
    this.fastAlpha = options.fastAlpha ?? 0.28;
    this.fastAngleRadians = options.fastAngleRadians ?? 0.42;
    this.history = [];
    this.current = null;
  }

  reset(normal = null) {
    this.history = [];
    this.current = normal ? normalize(normal) : null;
  }

  getNormal() {
    return this.current ? { ...this.current } : { ...DEFAULT_NORMAL };
  }

  update(normal, options = {}) {
    const measurement = normalize(normal ?? DEFAULT_NORMAL);
    const confidence = clamp(options.confidence ?? 1, 0, 1);
    const inlierWeight = clamp((options.inliers ?? 0) / 25, 0, 1);
    const weight = clamp(confidence * 0.75 + inlierWeight * 0.25, 0.2, 1);

    this.history.push({ normal: measurement, weight });
    if (this.history.length > this.historySize) {
      this.history.shift();
    }

    const componentMedian = normalize({
      x: median(this.history.map(sample => sample.normal.x)),
      y: median(this.history.map(sample => sample.normal.y)),
      z: median(this.history.map(sample => sample.normal.z)),
    });
    const accepted = this.history.filter(sample => {
      return this.history.length < 4 ||
        angularDistanceBetweenNormals(sample.normal, componentMedian) <= this.outlierRadians;
    });
    const target = weightedAverage(accepted.length ? accepted : this.history);

    if (!this.current) {
      this.current = target;
      return this.getNormal();
    }

    const angle = angularDistanceBetweenNormals(this.current, target);
    if (angle < this.deadbandRadians) {
      return this.getNormal();
    }

    const speedRatio = clamp(angle / this.fastAngleRadians, 0, 1);
    const alpha = (this.baseAlpha + (this.fastAlpha - this.baseAlpha) * speedRatio) * (0.65 + confidence * 0.35);

    this.current = normalize({
      x: this.current.x + (target.x - this.current.x) * alpha,
      y: this.current.y + (target.y - this.current.y) * alpha,
      z: this.current.z + (target.z - this.current.z) * alpha,
    });

    return this.getNormal();
  }
}
