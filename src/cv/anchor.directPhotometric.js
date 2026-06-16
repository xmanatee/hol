import { clamp, normalizeAngle } from './anchor.reconstruction.math.js';
import {
  boundsForPoints,
  fitRobustAffine2D,
  fitRobustSimilarity,
  selectCoherentObservations,
  toActiveObservations,
  transformPoint2,
} from './anchor.reconstructionRobust.js';
import { descriptorDistance, samplePatchDescriptor } from './anchor.photometricDescriptors.js';
import { createSurfacePreview } from './anchor.reconstruction.preview.js';
import { modelFromRegion, SURFACE_MODEL_PLANE } from './anchor.parametricGeometry.js';

export const DIRECT_PHOTOMETRIC_POSE_MODEL = 'direct-photometric';

const emptyStats = {
  averageSupport: 0,
  averageReliability: 0,
  matureLandmarks: 0,
  geometricConsistency: 0,
  mapConfidence: 0,
  mappedFrames: 0,
};

const transformPointAffine2 = (point, transform) => ({
  x: transform.rowX[0] * point.x + transform.rowX[1] * point.y + transform.rowX[2],
  y: transform.rowY[0] * point.x + transform.rowY[1] * point.y + transform.rowY[2],
});

const affineVerticalScale = transform => Math.hypot(transform.rowX[1], transform.rowY[1]);

const affineRotation = transform => Math.atan2(transform.rowY[0], transform.rowX[0]);

const readinessFromGeometry = consistency => clamp((consistency - 0.45) / 0.22, 0, 1);

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

  configure() {
    return null;
  }

  reset({ anchorReference, templateRegion = { x: 0, y: 0, width: 1, height: 1 }, targetClass = null }) {
    this.anchorReference = { x: anchorReference.x, y: anchorReference.y };
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.surfaceModel = modelFromRegion(templateRegion, targetClass);
    this.frames = [];
    this.surfels = new Map();
    this.consistency = [];
    this.state = 'mapping';
    this.lastFailureReason = null;
  }

  updateReferenceRegion(templateRegion, targetClass = this.targetClass) {
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.surfaceModel = modelFromRegion(templateRegion, targetClass);
  }

  addFrameFromTrackedPoints(trackedPoints, timestamp = performance.now(), grayImage = null) {
    const observations = toActiveObservations(trackedPoints)
      .map(observation => this._attachPhotometricData(observation, grayImage))
      .filter(observation => observation.photometric);

    if (observations.length < this.minSurfels) {
      this.lastFailureReason = 'Insufficient photometric surfels';
      return this.getState();
    }

    const consensus = this._consensusOptions();
    const coherent = selectCoherentObservations(observations, {
      minInliers: this.minSurfels,
      threshold: consensus.threshold,
      minInlierRatio: consensus.minInlierRatio,
      model: consensus.model,
    });
    if (!coherent.success) {
      this.lastFailureReason = coherent.reason;
      return this.getState();
    }

    this._recordSurfels(coherent.observations);
    this.frames.push({ timestamp, observations: coherent.observations });
    this.consistency.push(coherent.consistency);
    if (this.frames.length > this.maxFrames) {
      this.frames = this.frames.slice(-this.maxFrames);
      this.consistency = this.consistency.slice(-this.maxFrames);
    }
    this.state = this.frames.length >= this.minFrames && this._statistics().mapConfidence >= 0.45 ? 'ready' : 'mapping';
    this.lastFailureReason = this.state === 'ready' ? null : 'Move object through more photometric views';
    return this.getState();
  }

  estimatePoseFromTrackedPoints(trackedPoints, grayImage = null) {
    const rawObservations = toActiveObservations(trackedPoints)
      .map(observation => this._attachPhotometricData(observation, grayImage))
      .filter(observation => this._isUsableObservation(observation));
    const consensus = this._consensusOptions();
    const coherent = selectCoherentObservations(rawObservations, {
      minInliers: this.minSurfels,
      threshold: consensus.threshold,
      minInlierRatio: consensus.minInlierRatio,
      model: consensus.model,
    });
    const observations = coherent.success ? coherent.observations : [];
    const fit = this._fitAttachmentTransform(observations, {
      minInliers: this.minSurfels,
      threshold: consensus.threshold,
    });

    if (!fit.success || this.state !== 'ready') {
      return {
        success: false,
        method: DIRECT_PHOTOMETRIC_POSE_MODEL,
        reason: coherent.reason || fit.reason || this.lastFailureReason,
      };
    }

    const position = this._transformReferencePoint(this.anchorReference, fit);
    const normal = this._estimateNormal(fit);
    const preview = this._createPreview({
      fit,
      anchor: position,
      normal,
    });

    return {
      success: true,
      method: DIRECT_PHOTOMETRIC_POSE_MODEL,
      position: { x: position.x, y: position.y, z: 0 },
      normal,
      planarTransform: {
        scale: this._transformScale(fit) / this._referenceScale(),
        rotation: normalizeAngle(this._transformRotation(fit) - this._referenceRotation()),
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
    const fit = this._fitAttachmentTransform(frame.observations, { minInliers: 4, threshold: 8 });
    return fit.success ? fit : null;
  }

  _referenceScale() {
    const fit = this._referenceFit();
    return fit ? this._transformScale(fit) : 1;
  }

  _referenceRotation() {
    const fit = this._referenceFit();
    return fit ? this._transformRotation(fit) : 0;
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

  _consensusOptions() {
    return this.surfaceModel === SURFACE_MODEL_PLANE
      ? { model: 'similarity', threshold: 12, minInlierRatio: 0.45 }
      : { model: 'affine', threshold: 18, minInlierRatio: 0.36 };
  }

  _fitAttachmentTransform(observations, options) {
    if (this.surfaceModel !== SURFACE_MODEL_PLANE) {
      const fit = fitRobustAffine2D(observations, options);
      if (fit.success) {
        const similarityFit = fitRobustSimilarity(fit.inliers, {
          minInliers: Math.min(options.minInliers, fit.inliers.length),
          threshold: Math.max(10, options.threshold * 0.75),
        });
        return {
          ...fit,
          transformKind: 'affine',
          similarityTransform: similarityFit.success ? similarityFit.transform : null,
        };
      }
    }

    const fit = fitRobustSimilarity(observations, options);
    return fit.success
      ? { ...fit, transformKind: 'similarity' }
      : fit;
  }

  _transformReferencePoint(point, fit) {
    return fit.transformKind === 'affine'
      ? transformPointAffine2(point, fit.transform)
      : transformPoint2(point, fit.transform);
  }

  _transformScale(fit) {
    return fit.transformKind === 'affine'
      ? affineVerticalScale(fit.transform)
      : fit.transform.scale;
  }

  _transformRotation(fit) {
    if (fit.similarityTransform) {
      return fit.similarityTransform.rotation;
    }

    return fit.transformKind === 'affine'
      ? affineRotation(fit.transform)
      : fit.transform.rotation;
  }

  _estimateNormal(fit) {
    const rotation = this._transformRotation(fit);
    const x = Math.sin(rotation) * 0.48;
    const y = -Math.cos(rotation) * 0.12;
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
    const geometricConsistency = this.consistency.reduce((sum, value) => sum + value / Math.max(this.consistency.length, 1), 0);
    const matureScore = clamp(matureLandmarks / Math.max(this.minSurfels, 1), 0, 1);
    const geometryReadiness = readinessFromGeometry(geometricConsistency);

    return {
      averageSupport,
      averageReliability,
      matureLandmarks,
      geometricConsistency,
      mapConfidence: frameProgress * geometryReadiness * clamp(
        averageSupport * 0.23 +
        averageReliability * 0.23 +
        matureScore * 0.24 +
        frameProgress * 0.13 +
        geometricConsistency * 0.17,
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
    const surface = {
      ...createSurfacePreview(points),
      model: 'photometric-surfels',
      mesh: points,
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
      surface,
      current: current ? {
        points: points.map(point => ({
          id: point.id,
          ...this._transformReferencePoint(point.reference, current.fit),
          reliability: point.reliability,
        })),
        anchor: current.anchor,
        normal: current.normal,
        planarTransform: {
          scale: this._transformScale(current.fit) / this._referenceScale(),
          rotation: normalizeAngle(this._transformRotation(current.fit) - this._referenceRotation()),
        },
        surface: {
          ...surface,
          mesh: points,
        },
      } : null,
    };
  }
}
