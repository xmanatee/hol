import { clamp, normalizeAngle } from './anchor.reconstruction.math.js';
import {
  EMPTY_RECONSTRUCTION_STATS,
  affineRotation,
  affineVerticalScale,
  boundsForPoints,
  fitRobustAffine2D,
  fitRobustSimilarity,
  MOBILE_AFFINE_SAMPLE_WINDOW,
  readinessFromGeometry,
  selectCoherentObservations,
  toActiveObservations,
  transformPointAffine2,
  transformPoint2,
} from './anchor.reconstructionRobust.js';
import { descriptorDistance, samplePatchDescriptor } from './anchor.photometricDescriptors.js';
import { createSurfacePreview } from './anchor.reconstruction.preview.js';
import { modelFromRegion, SURFACE_MODEL_PLANE } from './anchor.parametricGeometry.js';
import { DIRECT_PHOTOMETRIC_POSE_MODEL } from './anchor.reconstructionModes.js';

export { DIRECT_PHOTOMETRIC_POSE_MODEL };

const SIMILARITY_RECOVERY_MIN_INLIERS = 8;
const SIMILARITY_RECOVERY_MIN_INLIER_RATIO = 0.62;
const SIMILARITY_RECOVERY_MAX_RESIDUAL = 5.4;
const SIMILARITY_RECOVERY_THRESHOLD = 14;

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
    this.frameObservationCache = null;
    this.referenceFitCache = null;
    this.state = 'mapping';
    this.lastFailureReason = null;
  }

  updateReferenceRegion(templateRegion, targetClass = this.targetClass) {
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.surfaceModel = modelFromRegion(templateRegion, targetClass);
    this.referenceFitCache = null;
  }

  addFrameFromTrackedPoints(trackedPoints, timestamp = performance.now(), grayImage = null, options = {}) {
    const observations = this._photometricObservationsFromTrackedPoints(trackedPoints, grayImage);

    if (observations.length < this.minSurfels) {
      this.lastFailureReason = 'Insufficient photometric surfels';
      return this.getState(options);
    }

    const consensus = this._consensusOptions();
    const coherent = selectCoherentObservations(observations, {
      minInliers: this.minSurfels,
      threshold: consensus.threshold,
      minInlierRatio: consensus.minInlierRatio,
      model: consensus.model,
      maxSample: consensus.maxSample,
      sampleCoverage: consensus.sampleCoverage,
    });
    if (!coherent.success) {
      this.lastFailureReason = coherent.reason;
      return this.getState(options);
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
    return this.getState(options);
  }

  estimatePoseFromTrackedPoints(trackedPoints, grayImage = null, { includePreview = true } = {}) {
    if (this.state !== 'ready') {
      return {
        success: false,
        method: DIRECT_PHOTOMETRIC_POSE_MODEL,
        reason: this.lastFailureReason || 'Move object through more photometric views',
      };
    }

    const rawObservations = this._photometricObservationsFromTrackedPoints(trackedPoints, grayImage)
      .filter(observation => this._isUsableObservation(observation));
    const consensus = this._consensusOptions();
    const coherent = selectCoherentObservations(rawObservations, {
      minInliers: this.minSurfels,
      threshold: consensus.threshold,
      minInlierRatio: consensus.minInlierRatio,
      model: consensus.model,
      maxSample: consensus.maxSample,
      sampleCoverage: consensus.sampleCoverage,
    });
    const observations = coherent.success ? coherent.observations : rawObservations;
    const fit = this._fitAttachmentTransform(observations, {
      minInliers: this.minSurfels,
      threshold: consensus.threshold,
      maxSample: consensus.maxSample,
      sampleCoverage: consensus.sampleCoverage,
      allowSimilarityRecovery: true,
    });

    if (!fit.success) {
      return {
        success: false,
        method: DIRECT_PHOTOMETRIC_POSE_MODEL,
        reason: coherent.reason || fit.reason || this.lastFailureReason,
      };
    }

    const position = this._transformReferencePoint(this.anchorReference, fit);
    const normal = this._estimateNormal(fit);
    const confidence = fit.recoveryKind
      ? Math.min(fit.confidence, 0.72)
      : fit.confidence;
    const result = {
      success: true,
      method: DIRECT_PHOTOMETRIC_POSE_MODEL,
      position: { x: position.x, y: position.y, z: 0 },
      normal,
      planarTransform: {
        scale: this._transformScale(fit) / this._referenceScale(),
        rotation: normalizeAngle(this._transformRotation(fit) - this._referenceRotation()),
        confidence,
        inlierCount: fit.inlierCount,
        method: DIRECT_PHOTOMETRIC_POSE_MODEL,
      },
      confidence,
      inlierCount: fit.inlierCount,
      inlierRatio: fit.inlierRatio,
      averageResidual: fit.averageResidual,
      depthQuality: 0.12,
      landmarkCount: this.surfels.size,
      recoveryKind: fit.recoveryKind || null,
    };

    if (!includePreview) {
      return result;
    }

    return {
      ...result,
      preview: this._createPreview({
        fit,
        anchor: position,
        normal,
      }),
    };
  }

  getState({ includePreview = true } = {}) {
    const state = {
      state: this.state,
      ready: this.state === 'ready',
      poseModel: DIRECT_PHOTOMETRIC_POSE_MODEL,
      frameCount: this.frames.length,
      landmarkCount: this.surfels.size,
      depthQuality: 0.12,
      statistics: this._statistics(),
      lastFailureReason: this.lastFailureReason,
    };
    if (includePreview) {
      state.preview = this._createPreview();
    }
    return state;
  }

  _attachPhotometricData(observation, grayImage) {
    const photometric = samplePatchDescriptor(grayImage, observation.current);
    return photometric
      ? { ...observation, quality: observation.quality + clamp(photometric.gradient / 36, 0, 2), photometric }
      : observation;
  }

  _photometricObservationsFromTrackedPoints(trackedPoints, grayImage) {
    if (this.frameObservationCache?.trackedPoints === trackedPoints &&
        this.frameObservationCache?.grayImage === grayImage) {
      return this.frameObservationCache.observations;
    }

    const observations = toActiveObservations(trackedPoints)
      .map(observation => this._attachPhotometricData(observation, grayImage))
      .filter(observation => observation.photometric);
    this.frameObservationCache = { trackedPoints, grayImage, observations };
    return observations;
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
    if (this.referenceFitCache?.frame === frame) {
      return this.referenceFitCache.fit;
    }

    const fit = this._fitAttachmentTransform(frame.observations, { minInliers: 4, threshold: 8 });
    const referenceFit = fit.success ? fit : null;
    this.referenceFitCache = { frame, fit: referenceFit };
    return referenceFit;
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
      : {
        model: 'affine',
        threshold: 18,
        minInlierRatio: 0.36,
        maxSample: MOBILE_AFFINE_SAMPLE_WINDOW,
        sampleCoverage: 'spatial',
      };
  }

  _fitAttachmentTransform(observations, options = {}) {
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

      const recoveryFit = options.allowSimilarityRecovery
        ? this._fitSimilarityRecovery(observations, options)
        : null;
      if (recoveryFit) {
        return recoveryFit;
      }

      return fit;
    }

    const fit = fitRobustSimilarity(observations, options);
    return fit.success
      ? { ...fit, transformKind: 'similarity' }
      : fit;
  }

  _fitSimilarityRecovery(observations, options) {
    if (!/mug/i.test(this.targetClass || '')) {
      return null;
    }

    if (observations.length < SIMILARITY_RECOVERY_MIN_INLIERS) {
      return null;
    }

    const fit = fitRobustSimilarity(observations, {
      minInliers: SIMILARITY_RECOVERY_MIN_INLIERS,
      threshold: Math.min(options.threshold ?? SIMILARITY_RECOVERY_THRESHOLD, SIMILARITY_RECOVERY_THRESHOLD),
      maxSample: options.maxSample,
    });
    if (!fit.success ||
        fit.inlierRatio < SIMILARITY_RECOVERY_MIN_INLIER_RATIO ||
        fit.averageResidual > SIMILARITY_RECOVERY_MAX_RESIDUAL) {
      return null;
    }

    return {
      ...fit,
      transformKind: 'similarity',
      recoveryKind: 'similarity-after-affine-failure',
    };
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
    if (!surfels.length) return EMPTY_RECONSTRUCTION_STATS;

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
