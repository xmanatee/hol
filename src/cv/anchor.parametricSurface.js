import { clamp, normalizeAngle } from './anchor.reconstruction.math.js';
import {
  boundsForPoints,
  fitRobustSimilarity,
  toActiveObservations,
  transformPoint2,
} from './anchor.reconstructionRobust.js';

export const PARAMETRIC_SURFACE_POSE_MODEL = 'parametric-surface';

const emptyStats = {
  averageSupport: 0,
  averageReliability: 0,
  matureLandmarks: 0,
  mapConfidence: 0,
  mappedFrames: 0,
};

const modelFromRegion = (region, targetClass = null) => {
  const label = String(targetClass || '').toLowerCase();
  if (/book|laptop|keyboard|cell phone|tablet|tv|screen|sign|box/.test(label)) return 'plane';
  if (/cup|mug|vase/.test(label)) return 'tapered-cylinder';
  if (/can|bottle|jar|container/.test(label)) return 'cylinder';

  const aspect = region.width / region.height;
  if (aspect <= 0.62) return 'cylinder';
  if (aspect <= 0.78) return 'tapered-cylinder';
  return 'plane';
};

const cylinderPoint = (reference, bounds, model) => {
  const width = Math.max(1, bounds.max.x - bounds.min.x);
  const height = Math.max(1, bounds.max.y - bounds.min.y);
  const u = clamp((reference.x - bounds.min.x) / width, 0, 1);
  const v = clamp((reference.y - bounds.min.y) / height, 0, 1);
  const angle = (u - 0.5) * Math.PI * 0.92;
  const baseRadius = width * 0.34;
  const radius = model === 'tapered-cylinder' ? baseRadius * (0.86 + v * 0.28) : baseRadius;

  return {
    x: Math.sin(angle) * radius,
    y: (v - 0.5) * height,
    z: Math.cos(angle) * radius - radius,
  };
};

const pointForModel = (reference, bounds, model) => {
  if (model === 'plane') {
    return {
      x: reference.x - (bounds.min.x + bounds.max.x) / 2,
      y: reference.y - (bounds.min.y + bounds.max.y) / 2,
      z: 0,
    };
  }

  return cylinderPoint(reference, bounds, model);
};

const surfaceMesh = (bounds, model) => {
  const columns = model === 'plane' ? 4 : 9;
  const rows = 7;
  const points = [];
  const edges = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const id = row * columns + column;
      const reference = {
        x: bounds.min.x + (bounds.max.x - bounds.min.x) * column / (columns - 1),
        y: bounds.min.y + (bounds.max.y - bounds.min.y) * row / (rows - 1),
      };
      points.push({ id, ...pointForModel(reference, bounds, model), reliability: 0.72 });
      if (column > 0) edges.push({ from: id - 1, to: id, reliability: 0.72 });
      if (row > 0) edges.push({ from: id - columns, to: id, reliability: 0.72 });
    }
  }

  return { points, edges };
};

export class ParametricSurfaceReconstructor {
  constructor(config = {}) {
    this.minFrames = config.minFrames ?? 5;
    this.minLandmarks = config.minLandmarks ?? 12;
    this.maxFrames = config.maxFrames ?? 24;
    this.reset({
      anchorReference: { x: 0, y: 0 },
      templateRegion: { x: 0, y: 0, width: 1, height: 1 },
    });
  }

  reset({ anchorReference, templateRegion = { x: 0, y: 0, width: 1, height: 1 }, targetClass = null }) {
    this.anchorReference = { x: anchorReference.x, y: anchorReference.y };
    this.templateRegion = { ...templateRegion };
    this.frames = [];
    this.stats = new Map();
    this.model = modelFromRegion(templateRegion, targetClass);
    this.state = 'mapping';
    this.lastFailureReason = null;
  }

  addFrameFromTrackedPoints(trackedPoints, timestamp = performance.now()) {
    const observations = toActiveObservations(trackedPoints);
    this._recordStats(observations);

    if (observations.length < this.minLandmarks) {
      this.lastFailureReason = 'Insufficient surface observations';
      return this.getState();
    }

    this.frames.push({ timestamp, observations });
    if (this.frames.length > this.maxFrames) {
      this.frames = this.frames.slice(-this.maxFrames);
    }
    this.state = this.frames.length >= this.minFrames ? 'ready' : 'mapping';
    this.lastFailureReason = this.state === 'ready' ? null : 'Move object through more surface views';
    return this.getState();
  }

  estimatePoseFromTrackedPoints(trackedPoints) {
    const observations = toActiveObservations(trackedPoints);
    const fit = fitRobustSimilarity(observations, {
      minInliers: this.minLandmarks,
      threshold: this.model === 'plane' ? 8 : 13,
    });

    if (!fit.success || this.state !== 'ready') {
      return {
        success: false,
        method: PARAMETRIC_SURFACE_POSE_MODEL,
        reason: fit.reason || this.lastFailureReason,
      };
    }

    const position = transformPoint2(this.anchorReference, fit.transform);
    const normal = this._estimateNormal(fit.transform, fit.inliers);
    const preview = this._createPreview({
      transform: fit.transform,
      normal,
      anchor: position,
    });

    return {
      success: true,
      method: PARAMETRIC_SURFACE_POSE_MODEL,
      position: { x: position.x, y: position.y, z: 0 },
      normal,
      planarTransform: {
        scale: fit.transform.scale / this._referenceScale(),
        rotation: normalizeAngle(fit.transform.rotation - this._referenceRotation()),
        confidence: fit.confidence,
        inlierCount: fit.inlierCount,
        method: PARAMETRIC_SURFACE_POSE_MODEL,
      },
      confidence: fit.confidence,
      inlierCount: fit.inlierCount,
      inlierRatio: fit.inlierRatio,
      averageResidual: fit.averageResidual,
      depthQuality: this.model === 'plane' ? 0.02 : 0.18,
      landmarkCount: this.stats.size,
      preview,
    };
  }

  getState() {
    return {
      state: this.state,
      ready: this.state === 'ready',
      poseModel: PARAMETRIC_SURFACE_POSE_MODEL,
      frameCount: this.frames.length,
      landmarkCount: this.stats.size,
      depthQuality: this.model === 'plane' ? 0.02 : 0.18,
      statistics: this._statistics(),
      lastFailureReason: this.lastFailureReason,
      preview: this._createPreview(),
    };
  }

  _recordStats(observations) {
    observations.forEach(observation => {
      const previous = this.stats.get(observation.id);
      this.stats.set(observation.id, {
        id: observation.id,
        reference: observation.reference,
        observations: (previous?.observations || 0) + 1,
        quality: (previous?.quality || 0) + observation.quality,
      });
    });
  }

  _referenceBounds() {
    const points = [...this.stats.values()].map(item => ({ ...item.reference, z: 0 }));
    if (points.length) return boundsForPoints(points);

    return {
      min: { x: this.templateRegion.x, y: this.templateRegion.y, z: 0 },
      max: {
        x: this.templateRegion.x + this.templateRegion.width,
        y: this.templateRegion.y + this.templateRegion.height,
        z: 0,
      },
    };
  }

  _referenceScale() {
    const stateFrame = this.frames[0];
    if (!stateFrame) return 1;
    const fit = fitRobustSimilarity(stateFrame.observations, { minInliers: 4, threshold: 6 });
    return fit.success ? fit.transform.scale : 1;
  }

  _referenceRotation() {
    const stateFrame = this.frames[0];
    if (!stateFrame) return 0;
    const fit = fitRobustSimilarity(stateFrame.observations, { minInliers: 4, threshold: 6 });
    return fit.success ? fit.transform.rotation : 0;
  }

  _estimateNormal(transform, inliers) {
    const referenceWidth = this._referenceBounds().max.x - this._referenceBounds().min.x;
    const currentWidth = inliers.reduce((range, item) => ({
      min: Math.min(range.min, item.current.x),
      max: Math.max(range.max, item.current.x),
    }), { min: Infinity, max: -Infinity });
    const widthRatio = (currentWidth.max - currentWidth.min) / Math.max(referenceWidth * transform.scale, 1);
    const surfaceTilt = this.model === 'plane' ? 0 : Math.sqrt(clamp(1 - widthRatio * widthRatio, 0.03, 0.92));
    const x = Math.sin(transform.rotation) * 0.34 + surfaceTilt * 0.56;
    const y = -Math.cos(transform.rotation) * surfaceTilt * 0.12;
    const z = Math.sqrt(Math.max(0.2, 1 - x * x - y * y));
    return { x, y, z };
  }

  _statistics() {
    const stats = [...this.stats.values()];
    if (!stats.length) return emptyStats;
    const averageSupport = stats.reduce((sum, item) => sum + item.observations / Math.max(this.frames.length, 1), 0) / stats.length;
    const averageReliability = stats.reduce((sum, item) => sum + clamp(item.quality / Math.max(item.observations, 1) / 3, 0, 1), 0) / stats.length;
    const matureLandmarks = stats.filter(item => item.observations >= this.minFrames).length;

    return {
      averageSupport,
      averageReliability,
      matureLandmarks,
      mapConfidence: clamp(averageSupport * 0.45 + averageReliability * 0.3 + matureLandmarks / Math.max(this.minLandmarks, 1) * 0.25, 0, 1),
      mappedFrames: this.frames.length,
    };
  }

  _createPreview(current = null) {
    const bounds = this._referenceBounds();
    const mesh = surfaceMesh(bounds, this.model);
    const points = [...this.stats.values()].slice(0, 96).map(item => ({
      id: item.id,
      ...pointForModel(item.reference, bounds, this.model),
      reference: item.reference,
      reliability: clamp(item.observations / Math.max(this.frames.length, 1), 0, 1),
      observations: item.observations,
      support: clamp(item.observations / Math.max(this.frames.length, 1), 0, 1),
      variance: 0,
    }));
    const anchor = pointForModel(this.anchorReference, bounds, this.model);

    return {
      ready: this.state === 'ready',
      poseModel: PARAMETRIC_SURFACE_POSE_MODEL,
      frameCount: this.frames.length,
      landmarkCount: this.stats.size,
      depthQuality: this.model === 'plane' ? 0.02 : 0.18,
      statistics: this._statistics(),
      points,
      anchor,
      bounds: boundsForPoints([...points, anchor]),
      surface: {
        model: this.model,
        hull: mesh.points.map(point => point.id),
        edges: mesh.edges,
        mesh: mesh.points,
      },
      current: current ? {
        points: points.map(point => ({
          id: point.id,
          ...transformPoint2(point.reference, current.transform),
          reliability: point.reliability,
        })),
        anchor: current.anchor,
        normal: current.normal,
        planarTransform: {
          scale: current.transform.scale / this._referenceScale(),
          rotation: normalizeAngle(current.transform.rotation - this._referenceRotation()),
        },
        surface: {
          model: this.model,
          hull: mesh.points.map(point => point.id),
          edges: mesh.edges,
          mesh: mesh.points,
        },
      } : null,
    };
  }
}
