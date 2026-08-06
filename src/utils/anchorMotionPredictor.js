export const ANCHOR_PRESENTATION_MOTION_CONFIG = Object.freeze({
  model: 'bounded-constant-velocity',
  maxPredictionAgeMs: 1000 / 15,
  maxPresentationSpeedPxPerMs: 12 / (1000 / 30),
  maxPresentationStepPx: 12,
});

const copyPosition = ({ x, y, z }) => ({ x, y, z });

const assertPosition = (position) => {
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    throw new TypeError('Anchor motion samples require finite x, y, and z coordinates');
  }
};

const assertTimestamp = (timestamp) => {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError('Anchor motion timestamps must be finite and non-negative');
  }
};

const assertPositive = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
};

const clampVectorLength = (x, y, maxLength) => {
  const length = Math.hypot(x, y);
  if (length <= maxLength || length === 0) {
    return { x, y };
  }
  const scale = maxLength / length;
  return { x: x * scale, y: y * scale };
};

export class AnchorMotionPredictor {
  constructor({
    maxPredictionAgeMs = ANCHOR_PRESENTATION_MOTION_CONFIG.maxPredictionAgeMs,
    maxPresentationSpeedPxPerMs = ANCHOR_PRESENTATION_MOTION_CONFIG.maxPresentationSpeedPxPerMs,
    maxPresentationStepPx = ANCHOR_PRESENTATION_MOTION_CONFIG.maxPresentationStepPx,
  } = {}) {
    assertPositive(maxPredictionAgeMs, 'Maximum prediction age');
    assertPositive(maxPresentationSpeedPxPerMs, 'Maximum presentation speed');
    assertPositive(maxPresentationStepPx, 'Maximum presentation step');
    this.maxPredictionAgeMs = maxPredictionAgeMs;
    this.maxPresentationSpeedPxPerMs = maxPresentationSpeedPxPerMs;
    this.maxPresentationStepPx = maxPresentationStepPx;
    this.reset();
  }

  observe(position, timestamp) {
    assertPosition(position);
    assertTimestamp(timestamp);
    if (this.sample && timestamp <= this.sample.timestamp) {
      throw new RangeError('Anchor motion sample timestamps must increase');
    }

    let velocity = { x: 0, y: 0 };
    if (this.sample) {
      const elapsed = timestamp - this.sample.timestamp;
      velocity = clampVectorLength(
        (position.x - this.sample.position.x) / elapsed,
        (position.y - this.sample.position.y) / elapsed,
        this.maxPresentationSpeedPxPerMs,
      );
    }

    this.sample = {
      position: copyPosition(position),
      timestamp,
      velocity,
    };
  }

  project(timestamp) {
    assertTimestamp(timestamp);
    if (!this.sample) {
      return null;
    }
    if (timestamp < this.sample.timestamp || timestamp < this.lastProjectionAt) {
      throw new RangeError('Anchor motion projection timestamps must not move backwards');
    }

    const predictionAge = Math.min(timestamp - this.sample.timestamp, this.maxPredictionAgeMs);
    const target = {
      x: this.sample.position.x + this.sample.velocity.x * predictionAge,
      y: this.sample.position.y + this.sample.velocity.y * predictionAge,
      z: this.sample.position.z,
    };
    if (!this.projectedPosition) {
      this.projectedPosition = target;
      this.lastProjectionAt = timestamp;
      return copyPosition(target);
    }

    const elapsed = timestamp - this.lastProjectionAt;
    const maxStep = Math.min(this.maxPresentationStepPx, this.maxPresentationSpeedPxPerMs * elapsed);
    const delta = clampVectorLength(
      target.x - this.projectedPosition.x,
      target.y - this.projectedPosition.y,
      maxStep,
    );
    this.projectedPosition = {
      x: this.projectedPosition.x + delta.x,
      y: this.projectedPosition.y + delta.y,
      z: target.z,
    };
    this.lastProjectionAt = timestamp;
    return copyPosition(this.projectedPosition);
  }

  reset() {
    this.sample = null;
    this.projectedPosition = null;
    this.lastProjectionAt = -Infinity;
  }
}
