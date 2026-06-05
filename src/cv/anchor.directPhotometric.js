import { clamp, normalizeAngle } from './anchor.reconstruction.math.js';
import {
  boundsForPoints,
  fitRobustSimilarity,
  toActiveObservations,
  transformPoint2,
} from './anchor.reconstructionRobust.js';
import { descriptorDistance, samplePatchDescriptor } from './anchor.photometricDescriptors.js';

export const DIRECT_PHOTOMETRIC_POSE_MODEL = 'direct-photometric';

const emptyStats = {
  averageSupport: 0,
  averageReliability: 0,
  matureLandmarks: 0,
  mapConfidence: 0,
  mappedFrames: 0,
};

export class DirectPhotometricReconstructor {
  constructor(config = {}) {
    this.minFrames = config.minFrames ?? 5;
    this.minSurfels = config.minSurfels ?? 12;
    this.maxFrames = config.maxFrames ?? 24;
    this.reset({
      anchorReference: { x: 0, y: 0 },
      templateRegion: { x: 0, y: 0, width: 1, height: 1 },
    });
  }

  reset({ anchorReference, templateRegion = { x: 0, y: 0, width: 1, height: 1 } }) {
    this.anchorReference = { x: anchorReference.x, y: anchorReference.y };
    this.templateRegion = { ...templateRegion };
    this.frames = [];
    this.surfels = new Map();
    this.state = 'mapping';
    this.lastFailureReason = null;
  }

  addFrameFromTrackedPoints(trackedPoints, timestamp = performance.now(), grayImage = null) {
    const observations = toActiveObservations(trackedPoints)
      .map(observation => this._attachPhotometricData(observation, grayImage))
      .filter(observation => observation.photometric);
    this._recordSurfels(observations);

    if (observations.length < this.minSurfels) {
      this.lastFailureReason = 'Insufficient photometric surfels';
      return this.getState();
    }

    this.frames.push({ timestamp, observations });
    if (this.frames.length > this.maxFrames) {
      this.frames = this.frames.slice(-this.maxFrames);
    }
    this.state = this.frames.length >= this.minFrames ? 'ready' : 'mapping';
    this.lastFailureReason = this.state === 'ready' ? null : 'Move object through more photometric views';
    return this.getState();
  }

  estimatePoseFromTrackedPoints(trackedPoints, grayImage = null) {
    const observations = toActiveObservations(trackedPoints)
      .map(observation => this._attachPhotometricData(observation, grayImage))
      .filter(observation => this._isUsableObservation(observation));
    const fit = fitRobustSimilarity(observations, { minInliers: this.minSurfels, threshold: 12 });

    if (!fit.success || this.state !== 'ready') {
      return {
        success: false,
        method: DIRECT_PHOTOMETRIC_POSE_MODEL,
        reason: fit.reason || this.lastFailureReason,
      };
    }

    const position = transformPoint2(this.anchorReference, fit.transform);
    const normal = this._estimateNormal(fit.transform);
    const preview = this._createPreview({
      transform: fit.transform,
      anchor: position,
      normal,
    });

    return {
      success: true,
      method: DIRECT_PHOTOMETRIC_POSE_MODEL,
      position: { x: position.x, y: position.y, z: 0 },
      normal,
      planarTransform: {
        scale: fit.transform.scale / this._referenceScale(),
        rotation: normalizeAngle(fit.transform.rotation - this._referenceRotation()),
        confidence: fit.confidence,
        inlierCount: fit.inlierCount,
        method: DIRECT_PHOTOMETRIC_POSE_MODEL,
      },
      confidence: fit.confidence,
      inlierCount: fit.inlierCount,
      inlierRatio: fit.inlierRatio,
      averageResidual: fit.averageResidual,
      depthQuality: 0.12,
      landmarkCount: this.surfels.size,
      preview,
    };
  }

  getState() {
    return {
      state: this.state,
      ready: this.state === 'ready',
      poseModel: DIRECT_PHOTOMETRIC_POSE_MODEL,
      frameCount: this.frames.length,
      landmarkCount: this.surfels.size,
      depthQuality: 0.12,
      statistics: this._statistics(),
      lastFailureReason: this.lastFailureReason,
      preview: this._createPreview(),
    };
  }

  _attachPhotometricData(observation, grayImage) {
    const photometric = samplePatchDescriptor(grayImage, observation.current);
    return photometric
      ? { ...observation, quality: observation.quality + clamp(photometric.gradient / 36, 0, 2), photometric }
      : observation;
  }

  _recordSurfels(observations) {
    observations.forEach(observation => {
      const previous = this.surfels.get(observation.id);
      const residual = previous?.descriptor
        ? descriptorDistance(previous.descriptor, observation.photometric.values)
        : 0;
      const observationsCount = (previous?.observations || 0) + 1;
      const descriptor = previous
        ? previous.descriptor.map((value, index) => value + (observation.photometric.values[index] - value) / observationsCount)
        : observation.photometric.values;

      this.surfels.set(observation.id, {
        id: observation.id,
        reference: observation.reference,
        observations: observationsCount,
        descriptor,
        gradient: (previous?.gradient || 0) + (observation.photometric.gradient - (previous?.gradient || 0)) / observationsCount,
        residualMean: (previous?.residualMean || 0) + (residual - (previous?.residualMean || 0)) / observationsCount,
        quality: (previous?.quality || 0) + observation.quality,
      });
    });
  }

  _isUsableObservation(observation) {
    const surfel = this.surfels.get(observation.id);
    if (!surfel || !observation.photometric) {
      return false;
    }

    return surfel.observations >= Math.max(3, this.minFrames - 2) &&
      surfel.gradient >= 6;
  }

  _referenceFit() {
    const frame = this.frames[0];
    if (!frame) return null;
    const fit = fitRobustSimilarity(frame.observations, { minInliers: 4, threshold: 6 });
    return fit.success ? fit.transform : null;
  }

  _referenceScale() {
    return this._referenceFit()?.scale || 1;
  }

  _referenceRotation() {
    return this._referenceFit()?.rotation || 0;
  }

  _referenceBounds() {
    const points = [...this.surfels.values()].map(item => ({ ...item.reference, z: 0 }));
    return points.length
      ? boundsForPoints(points)
      : {
        min: { x: this.templateRegion.x, y: this.templateRegion.y, z: 0 },
        max: {
          x: this.templateRegion.x + this.templateRegion.width,
          y: this.templateRegion.y + this.templateRegion.height,
          z: 0,
        },
      };
  }

  _estimateNormal(transform) {
    const x = Math.sin(transform.rotation) * 0.48;
    const y = -Math.cos(transform.rotation) * 0.12;
    const z = Math.sqrt(Math.max(0.25, 1 - x * x - y * y));
    return { x, y, z };
  }

  _statistics() {
    const surfels = [...this.surfels.values()];
    if (!surfels.length) return emptyStats;

    const averageSupport = surfels.reduce((sum, item) => sum + item.observations / Math.max(this.frames.length, 1), 0) / surfels.length;
    const averageReliability = surfels.reduce((sum, item) => {
      const gradientScore = clamp(item.gradient / 30, 0, 1);
      const residualScore = clamp(1 - item.residualMean / 1.8, 0, 1);
      return sum + gradientScore * 0.62 + residualScore * 0.38;
    }, 0) / surfels.length;
    const matureLandmarks = surfels.filter(item => item.observations >= this.minFrames && item.gradient >= 6).length;
    const frameProgress = clamp(this.frames.length / Math.max(this.minFrames, 1), 0, 1);

    return {
      averageSupport,
      averageReliability,
      matureLandmarks,
      mapConfidence: clamp(
        averageSupport * 0.28 +
        averageReliability * 0.27 +
        matureLandmarks / Math.max(this.minSurfels, 1) * 0.28 +
        frameProgress * 0.17,
        0,
        1
      ),
      mappedFrames: this.frames.length,
    };
  }

  _createPreview(current = null) {
    const bounds = this._referenceBounds();
    const points = [...this.surfels.values()].slice(0, 96).map(item => ({
      id: item.id,
      x: item.reference.x - (bounds.min.x + bounds.max.x) / 2,
      y: item.reference.y - (bounds.min.y + bounds.max.y) / 2,
      z: clamp(item.gradient / 2, 0, 32),
      reference: item.reference,
      reliability: clamp(item.observations / Math.max(this.frames.length, 1), 0, 1),
      observations: item.observations,
      support: clamp(item.observations / Math.max(this.frames.length, 1), 0, 1),
      variance: item.residualMean,
    }));
    const anchor = {
      x: this.anchorReference.x - (bounds.min.x + bounds.max.x) / 2,
      y: this.anchorReference.y - (bounds.min.y + bounds.max.y) / 2,
      z: 0,
    };

    return {
      ready: this.state === 'ready',
      poseModel: DIRECT_PHOTOMETRIC_POSE_MODEL,
      frameCount: this.frames.length,
      landmarkCount: this.surfels.size,
      depthQuality: 0.12,
      statistics: this._statistics(),
      points,
      anchor,
      bounds: boundsForPoints([...points, anchor]),
      surface: {
        model: 'photometric-surfels',
        hull: points.map(point => point.id),
        edges: [],
        mesh: points,
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
          model: 'photometric-surfels',
          hull: points.map(point => point.id),
          edges: [],
          mesh: points,
        },
      } : null,
    };
  }
}
