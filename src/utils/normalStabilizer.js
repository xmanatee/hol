const DEFAULT_NORMAL = { x: 0, y: 0, z: 1 };

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const normalize = (normal) => {
  const zPositive = normal.z < 0 ? { x: -normal.x, y: -normal.y, z: -normal.z } : normal;
  const length = Math.hypot(zPositive.x, zPositive.y, zPositive.z) || 1;

  return {
    x: zPositive.x / length,
    y: zPositive.y / length,
    z: zPositive.z / length,
  };
};

const dot = (a, b) => clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const weightedAverage = (samples) => {
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0) || 1;
  const summed = samples.reduce(
    (acc, sample) => ({
      x: acc.x + sample.normal.x * sample.weight,
      y: acc.y + sample.normal.y * sample.weight,
      z: acc.z + sample.normal.z * sample.weight,
    }),
    { x: 0, y: 0, z: 0 },
  );

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
    const foreshortening = options.foreshortening ?? 1;
    const measurementTilt = Math.hypot(measurement.x, measurement.y);
    const currentTilt = this.current ? Math.hypot(this.current.x, this.current.y) : 0;
    const xyDot = this.current ? this.current.x * measurement.x + this.current.y * measurement.y : 0;
    const mirrorFlipFromTurnedPose = currentTilt > 0.28 && measurementTilt > 0.45 && xyDot < -0.08;
    const reacquiredPose = options.reacquired === true && confidence >= 0.42 && (options.inliers ?? 0) >= 8;
    const trustedExternalPose =
      options.trusted === true && confidence >= 0.55 && (options.inliers ?? 0) >= 12;
    const highSupportMirrorTurn = confidence >= 0.82 && (options.inliers ?? 0) >= 14 && foreshortening < 0.72;
    if (
      this.current &&
      mirrorFlipFromTurnedPose &&
      !reacquiredPose &&
      !trustedExternalPose &&
      !highSupportMirrorTurn
    ) {
      return this.getNormal();
    }
    const confidentForeshortenedTurn =
      foreshortening < 0.9 && confidence >= 0.5 && (options.inliers ?? 0) >= 12 && measurementTilt > 0.18;
    const confidentWideTurn =
      foreshortening < 0.72 &&
      confidence >= 0.55 &&
      (options.inliers ?? 0) >= 8 &&
      measurementTilt > 0.45 &&
      (!mirrorFlipFromTurnedPose || highSupportMirrorTurn);
    const confidentFaceOnReturn =
      foreshortening > 0.96 &&
      confidence >= 0.5 &&
      (options.inliers ?? 0) >= 10 &&
      measurementTilt < 0.11 &&
      currentTilt > 0.12;
    const trustedPoseChange =
      confidentForeshortenedTurn ||
      confidentWideTurn ||
      confidentFaceOnReturn ||
      reacquiredPose ||
      trustedExternalPose;

    this.history.push({ normal: measurement, weight, trustedPoseChange });
    if (this.history.length > this.historySize) {
      this.history.shift();
    }
    if (reacquiredPose) {
      this.history = [{ normal: measurement, weight, trustedPoseChange }];
    }

    const componentMedian = normalize({
      x: median(this.history.map((sample) => sample.normal.x)),
      y: median(this.history.map((sample) => sample.normal.y)),
      z: median(this.history.map((sample) => sample.normal.z)),
    });
    const accepted = this.history.filter((sample) => {
      return (
        this.history.length < 4 ||
        sample.trustedPoseChange ||
        angularDistanceBetweenNormals(sample.normal, componentMedian) <= this.outlierRadians
      );
    });
    const target = trustedPoseChange
      ? measurement
      : weightedAverage(accepted.length ? accepted : this.history);

    if (!this.current) {
      this.current = target;
      return this.getNormal();
    }

    const angle = angularDistanceBetweenNormals(this.current, target);
    if (angle < this.deadbandRadians) {
      return this.getNormal();
    }

    const speedRatio = clamp(angle / this.fastAngleRadians, 0, 1);
    let alpha =
      (this.baseAlpha + (this.fastAlpha - this.baseAlpha) * speedRatio) * (0.65 + confidence * 0.35);
    if (trustedPoseChange) {
      alpha = Math.max(alpha, 0.44 * (0.75 + confidence * 0.25));
    }
    if (confidentWideTurn) {
      alpha = Math.max(alpha, 0.62 * (0.75 + confidence * 0.25));
    }
    if (trustedExternalPose) {
      alpha = Math.max(alpha, 0.64 * (0.75 + confidence * 0.25));
    }
    if (reacquiredPose) {
      alpha = Math.max(alpha, 0.82 * (0.75 + confidence * 0.25));
    }

    this.current = normalize({
      x: this.current.x + (target.x - this.current.x) * alpha,
      y: this.current.y + (target.y - this.current.y) * alpha,
      z: this.current.z + (target.z - this.current.z) * alpha,
    });

    return this.getNormal();
  }
}
