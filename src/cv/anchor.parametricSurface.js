import { clamp, normalizeAngle } from './anchor.reconstruction.math.js';
import {
  boundsForPoints,
  fitRobustAffine2D,
  fitRobustSimilarity,
  selectCoherentObservations,
  toActiveObservations,
  transformPoint2,
} from './anchor.reconstructionRobust.js';
import {
  depthQualityForSurfaceModel,
  modelFromRegion,
  normalForSurfaceModel as normalForModel,
  pointForSurfaceModel as pointForModel,
  surfaceMeshForModel as surfaceMesh,
} from './anchor.parametricGeometry.js';

export const PARAMETRIC_SURFACE_POSE_MODEL = 'parametric-surface';

const emptyStats = {
  averageSupport: 0,
  averageReliability: 0,
  matureLandmarks: 0,
  geometricConsistency: 0,
  mapConfidence: 0,
  mappedFrames: 0,
};

const rotateNormal = (rotation, normal) => {
  const rotated = {
    x: rotation[0] * normal.x + rotation[1] * normal.y + rotation[2] * normal.z,
    y: rotation[3] * normal.x + rotation[4] * normal.y + rotation[5] * normal.z,
    z: rotation[6] * normal.x + rotation[7] * normal.y + rotation[8] * normal.z,
  };
  const length = Math.max(Math.hypot(rotated.x, rotated.y, rotated.z), 1e-9);
  const normalized = {
    x: rotated.x / length,
    y: rotated.y / length,
    z: rotated.z / length,
  };

  return normalized.z >= 0
    ? normalized
    : { x: -normalized.x, y: -normalized.y, z: -normalized.z };
};

const transformPointAffine2 = (point, transform) => ({
  x: transform.rowX[0] * point.x + transform.rowX[1] * point.y + transform.rowX[2],
  y: transform.rowY[0] * point.x + transform.rowY[1] * point.y + transform.rowY[2],
});

const affineVerticalScale = transform => Math.hypot(transform.rowX[1], transform.rowY[1]);

const affineRotation = transform => Math.atan2(transform.rowY[0], transform.rowX[0]);

const readinessFromGeometry = consistency => clamp((consistency - 0.45) / 0.22, 0, 1);

export class ParametricSurfaceReconstructor {
  constructor(config = {}) {
    this.minFrames = config.minFrames ?? 5;
    this.minLandmarks = config.minLandmarks ?? 12;
    this.maxFrames = config.maxFrames ?? 24;
    this.cv = null;
    this.cameraParams = null;
    this.reset({
      anchorReference: { x: 0, y: 0 },
      templateRegion: { x: 0, y: 0, width: 1, height: 1 },
    });
  }

  configure({ cv, cameraParams }) {
    this.cv = cv;
    this.cameraParams = { ...cameraParams };
  }

  reset({ anchorReference, templateRegion = { x: 0, y: 0, width: 1, height: 1 }, targetClass = null }) {
    this.anchorReference = { x: anchorReference.x, y: anchorReference.y };
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.frames = [];
    this.stats = new Map();
    this.consistency = [];
    this.model = modelFromRegion(templateRegion, targetClass);
    this.state = 'mapping';
    this.lastFailureReason = null;
    this.referencePnpTransform = null;
    this.referenceFitCache = null;
  }

  updateReferenceRegion(templateRegion, targetClass = this.targetClass) {
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.model = modelFromRegion(templateRegion, targetClass);
    this.referenceFitCache = null;
  }

  addFrameFromTrackedPoints(trackedPoints, timestamp = performance.now(), optionsOrGrayImage = null, options = {}) {
    const stateOptions = optionsOrGrayImage?.includePreview === false ? optionsOrGrayImage : options;
    const observations = toActiveObservations(trackedPoints);

    if (observations.length < this.minLandmarks) {
      this.lastFailureReason = 'Insufficient surface observations';
      return this.getState(stateOptions);
    }

    const consensus = this._consensusOptions();
    const coherent = selectCoherentObservations(observations, {
      minInliers: this.minLandmarks,
      threshold: consensus.threshold,
      minInlierRatio: consensus.minInlierRatio,
      model: consensus.model,
    });
    if (!coherent.success) {
      this.lastFailureReason = coherent.reason;
      return this.getState(stateOptions);
    }

    this._recordStats(coherent.observations);
    this.frames.push({ timestamp, observations: coherent.observations });
    this.consistency.push(coherent.consistency);
    if (this.frames.length > this.maxFrames) {
      this.frames = this.frames.slice(-this.maxFrames);
      this.consistency = this.consistency.slice(-this.maxFrames);
    }
    this.state = this.frames.length >= this.minFrames && this._statistics().mapConfidence >= 0.42 ? 'ready' : 'mapping';
    this.lastFailureReason = this.state === 'ready' ? null : 'Move object through more surface views';
    return this.getState(stateOptions);
  }

  estimatePoseFromTrackedPoints(trackedPoints) {
    if (this.state !== 'ready') {
      return {
        success: false,
        method: PARAMETRIC_SURFACE_POSE_MODEL,
        reason: this.lastFailureReason || 'Move object through more surface views',
      };
    }

    const rawObservations = toActiveObservations(trackedPoints);
    const consensus = this._poseConsensusOptions();
    const coherent = selectCoherentObservations(rawObservations, {
      minInliers: consensus.minInliers,
      threshold: consensus.threshold,
      minInlierRatio: consensus.minInlierRatio,
      model: consensus.model,
    });
    const observations = coherent.success ? coherent.observations : [];
    const fit = this._fitAttachmentTransform(observations, {
      minInliers: consensus.minInliers,
      threshold: consensus.threshold,
    });

    if (!fit.success) {
      return {
        success: false,
        method: PARAMETRIC_SURFACE_POSE_MODEL,
        reason: coherent.reason || fit.reason || this.lastFailureReason,
      };
    }

    const position = this._transformReferencePoint(this.anchorReference, fit);
    const pnpPose = this._estimatePnPPose(observations);
    const usePnPProjection = pnpPose && this._shouldUsePnPAnchorProjection(pnpPose, position);
    const usePnPTransform = usePnPProjection &&
      Number.isFinite(pnpPose.scale) &&
      Number.isFinite(pnpPose.rotation);
    const anchorPosition = usePnPProjection
      ? pnpPose.position
      : position;
    const planarTransform = usePnPTransform
      ? {
        scale: pnpPose.scale,
        rotation: pnpPose.rotation,
      }
      : {
        scale: this._transformScale(fit) / this._referenceScale(),
        rotation: normalizeAngle(this._transformRotation(fit) - this._referenceRotation()),
      };
    const normal = pnpPose?.normal || this._estimateNormal(fit, fit.inliers);
    const preview = this._createPreview({
      fit,
      normal,
      anchor: anchorPosition,
    });

    return {
      success: true,
      method: PARAMETRIC_SURFACE_POSE_MODEL,
      position: { x: anchorPosition.x, y: anchorPosition.y, z: 0 },
      normal,
      planarTransform: {
        scale: planarTransform.scale,
        rotation: planarTransform.rotation,
        confidence: fit.confidence,
        inlierCount: fit.inlierCount,
        method: PARAMETRIC_SURFACE_POSE_MODEL,
      },
      confidence: fit.confidence,
      inlierCount: fit.inlierCount,
      inlierRatio: fit.inlierRatio,
      averageResidual: fit.averageResidual,
      depthQuality: depthQualityForSurfaceModel(this.model),
      landmarkCount: this.stats.size,
      pnpInlierCount: pnpPose?.inlierCount || 0,
      pnpAverageResidual: pnpPose?.averageResidual || null,
      preview,
    };
  }

  getState({ includePreview = true } = {}) {
    const state = {
      state: this.state,
      ready: this.state === 'ready',
      poseModel: PARAMETRIC_SURFACE_POSE_MODEL,
      frameCount: this.frames.length,
      landmarkCount: this.stats.size,
      depthQuality: depthQualityForSurfaceModel(this.model),
      statistics: this._statistics(),
      lastFailureReason: this.lastFailureReason,
    };
    if (includePreview) {
      state.preview = this._createPreview();
    }
    return state;
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
    const fit = this._referenceFit();
    return fit.success ? this._transformScale(fit) : 1;
  }

  _referenceRotation() {
    const fit = this._referenceFit();
    return fit.success ? this._transformRotation(fit) : 0;
  }

  _referenceFit() {
    const stateFrame = this.frames[0];
    if (!stateFrame) {
      return { success: false };
    }
    if (this.referenceFitCache?.frame === stateFrame) {
      return this.referenceFitCache.fit;
    }

    const fit = this._fitAttachmentTransform(stateFrame.observations, { minInliers: 4, threshold: 6 });
    this.referenceFitCache = { frame: stateFrame, fit };
    return fit;
  }

  _coherenceModel() {
    return this.model === 'plane' ? 'similarity' : 'affine';
  }

  _consensusOptions() {
    return this.model === 'plane'
      ? { model: 'similarity', threshold: 8, minInlierRatio: 0.5 }
      : { model: 'affine', threshold: 18, minInlierRatio: 0.36 };
  }

  _poseConsensusOptions() {
    const options = this._consensusOptions();
    const statistics = this._statistics();
    const compactMatureSurface = this.state === 'ready' &&
      this.model !== 'plane' &&
      /mug/i.test(this.targetClass || '') &&
      statistics.mapConfidence >= 0.62 &&
      statistics.matureLandmarks >= 16;

    return {
      ...options,
      minInliers: compactMatureSurface ? 8 : this.minLandmarks,
      minInlierRatio: compactMatureSurface
        ? Math.min(options.minInlierRatio, 0.3)
        : options.minInlierRatio,
    };
  }

  _fitAttachmentTransform(observations, options) {
    if (this._coherenceModel() === 'affine') {
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

  _estimateNormal(fit, inliers) {
    const referenceWidth = this._referenceBounds().max.x - this._referenceBounds().min.x;
    const currentWidth = inliers.reduce((range, item) => ({
      min: Math.min(range.min, item.current.x),
      max: Math.max(range.max, item.current.x),
    }), { min: Infinity, max: -Infinity });
    const widthRatio = (currentWidth.max - currentWidth.min) / Math.max(referenceWidth * this._transformScale(fit), 1);
    const surfaceTilt = this.model === 'plane' ? 0 : Math.sqrt(clamp(1 - widthRatio * widthRatio, 0.03, 0.92));
    const rotation = this._transformRotation(fit);
    const x = Math.sin(rotation) * 0.34 + surfaceTilt * 0.56;
    const y = -Math.cos(rotation) * surfaceTilt * 0.12;
    const z = Math.sqrt(Math.max(0.2, 1 - x * x - y * y));
    return { x, y, z };
  }

  _estimatePnPPose(observations) {
    if (!this.cv || !this.cameraParams || observations.length < 8 || this.model === 'plane') {
      return null;
    }

    const bounds = this._referenceBounds();
    const pnpSolution = this._solvePnPPose(observations, bounds);
    if (!pnpSolution) {
      return null;
    }

    const currentTransform = this._projectPnPSurfaceTransform({
      rotation: pnpSolution.rotation,
      translation: pnpSolution.translation,
      bounds,
    });
    const referenceTransform = this._referencePnPTransform(bounds, observations);

    return {
      normal: rotateNormal(pnpSolution.rotation, normalForModel(this.anchorReference, bounds, this.model)),
      inlierCount: pnpSolution.inlierCount,
      averageResidual: pnpSolution.averageResidual,
      position: currentTransform.position,
      scale: referenceTransform ? currentTransform.rawScale / referenceTransform.rawScale : null,
      rotation: referenceTransform ? normalizeAngle(currentTransform.rawRotation - referenceTransform.rawRotation) : null,
      anchorEccentricity: currentTransform.anchorEccentricity,
    };
  }

  _solvePnPPose(observations, bounds) {
    const objectPoints = [];
    const imagePoints = [];

    observations.forEach(observation => {
      const point = pointForModel(observation.reference, bounds, this.model);
      objectPoints.push(point.x, point.y, point.z);
      imagePoints.push(observation.current.x, observation.current.y);
    });

    const cv = this.cv;
    const objectMat = cv.matFromArray(observations.length, 1, cv.CV_32FC3, objectPoints);
    const imageMat = cv.matFromArray(observations.length, 1, cv.CV_32FC2, imagePoints);
    const cameraMat = cv.matFromArray(3, 3, cv.CV_64F, [
      this.cameraParams.fx, 0, this.cameraParams.cx,
      0, this.cameraParams.fy, this.cameraParams.cy,
      0, 0, 1,
    ]);
    const distCoeffs = cv.Mat.zeros(4, 1, cv.CV_64F);
    const rvec = new cv.Mat();
    const tvec = new cv.Mat();
    const inliers = new cv.Mat();
    const rotationMat = new cv.Mat();
    const solved = cv.solvePnPRansac(
      objectMat,
      imageMat,
      cameraMat,
      distCoeffs,
      rvec,
      tvec,
      false,
      100,
      5,
      0.98,
      inliers,
      cv.SOLVEPNP_ITERATIVE
    );
    let result = null;

    if (solved && inliers.rows >= Math.max(10, Math.ceil(observations.length * 0.45))) {
      cv.Rodrigues(rvec, rotationMat);
      const rotation = Array.from(rotationMat.data64F);
      const translation = Array.from(tvec.data64F);
      const averageResidual = this._calculatePnPResidual({
        rotation,
        translation,
        objectPoints,
        imagePoints,
      });

      if (averageResidual <= 7) {
        result = {
          inlierCount: inliers.rows,
          averageResidual,
          rotation,
          translation,
        };
      }
    }

    objectMat.delete();
    imageMat.delete();
    cameraMat.delete();
    distCoeffs.delete();
    rvec.delete();
    tvec.delete();
    inliers.delete();
    rotationMat.delete();

    return result;
  }

  _referencePnPTransform(bounds, observations) {
    if (this.referencePnpTransform) return this.referencePnpTransform;

    const referenceObservations = observations.map(observation => ({
      ...observation,
      current: observation.reference,
    }));
    const referencePose = this._solvePnPPose(referenceObservations, bounds);
    if (!referencePose) return null;

    this.referencePnpTransform = this._projectPnPSurfaceTransform({
      rotation: referencePose.rotation,
      translation: referencePose.translation,
      bounds,
    });
    return this.referencePnpTransform;
  }

  _projectPnPPoint({ point, rotation, translation }) {
    const cameraX = rotation[0] * point.x + rotation[1] * point.y + rotation[2] * point.z + translation[0];
    const cameraY = rotation[3] * point.x + rotation[4] * point.y + rotation[5] * point.z + translation[1];
    const cameraZ = rotation[6] * point.x + rotation[7] * point.y + rotation[8] * point.z + translation[2];

    return {
      x: this.cameraParams.cx + this.cameraParams.fx * cameraX / cameraZ,
      y: this.cameraParams.cy + this.cameraParams.fy * cameraY / cameraZ,
    };
  }

  _projectPnPSurfaceTransform({ rotation, translation, bounds }) {
    const width = Math.max(1, bounds.max.x - bounds.min.x);
    const height = Math.max(1, bounds.max.y - bounds.min.y);
    const basis = clamp(Math.min(width, height) * 0.18, 16, 30);
    const yDirection = this.anchorReference.y + basis <= bounds.max.y ? 1 : -1;
    const anchorPoint = pointForModel(this.anchorReference, bounds, this.model);
    const tangentX = this._surfaceTangentX(bounds);
    const tangentY = { x: 0, y: yDirection, z: 0 };
    const projectedAnchor = this._projectPnPPoint({
      point: anchorPoint,
      rotation,
      translation,
    });
    const projectedX = this._projectPnPPoint({
      point: {
        x: anchorPoint.x + tangentX.x * basis,
        y: anchorPoint.y + tangentX.y * basis,
        z: anchorPoint.z + tangentX.z * basis,
      },
      rotation,
      translation,
    });
    const projectedY = this._projectPnPPoint({
      point: {
        x: anchorPoint.x + tangentY.x * basis,
        y: anchorPoint.y + tangentY.y * basis,
        z: anchorPoint.z + tangentY.z * basis,
      },
      rotation,
      translation,
    });
    const vectorX = {
      x: projectedX.x - projectedAnchor.x,
      y: projectedX.y - projectedAnchor.y,
    };
    const vectorY = {
      x: projectedY.x - projectedAnchor.x,
      y: projectedY.y - projectedAnchor.y,
    };

    return {
      position: projectedAnchor,
      rawScale: Math.sqrt(
        Math.max(1e-9, Math.hypot(vectorX.x, vectorX.y) / basis) *
        Math.max(1e-9, Math.hypot(vectorY.x, vectorY.y) / basis)
      ),
      rawRotation: normalizeAngle(Math.atan2(vectorX.y, vectorX.x)),
      anchorEccentricity: this._anchorEccentricity(bounds),
    };
  }

  _surfaceTangentX(bounds) {
    const normal = normalForModel(this.anchorReference, bounds, this.model);
    const tangent = { x: normal.z, y: 0, z: -normal.x };
    const length = Math.max(Math.hypot(tangent.x, tangent.z), 1e-9);

    return {
      x: tangent.x / length,
      y: 0,
      z: tangent.z / length,
    };
  }

  _anchorEccentricity(bounds) {
    const width = Math.max(1, bounds.max.x - bounds.min.x);
    const height = Math.max(1, bounds.max.y - bounds.min.y);
    const u = (this.anchorReference.x - bounds.min.x) / width;
    const v = (this.anchorReference.y - bounds.min.y) / height;

    return Math.hypot((u - 0.5) * 2, (v - 0.5) * 2);
  }

  _shouldUsePnPAnchorProjection(pnpPose, similarityPosition) {
    const pnpDelta = Math.hypot(
      pnpPose.position.x - similarityPosition.x,
      pnpPose.position.y - similarityPosition.y
    );

    return pnpPose.anchorEccentricity >= 0.42 &&
      pnpPose.averageResidual <= 4.5 &&
      pnpDelta >= 2.5;
  }

  _calculatePnPResidual({ rotation, translation, objectPoints, imagePoints }) {
    let total = 0;
    let count = 0;

    for (let index = 0; index < objectPoints.length; index += 3) {
      const x = objectPoints[index];
      const y = objectPoints[index + 1];
      const z = objectPoints[index + 2];
      const cameraX = rotation[0] * x + rotation[1] * y + rotation[2] * z + translation[0];
      const cameraY = rotation[3] * x + rotation[4] * y + rotation[5] * z + translation[1];
      const cameraZ = rotation[6] * x + rotation[7] * y + rotation[8] * z + translation[2];
      const imageIndex = count * 2;
      const projectedX = this.cameraParams.cx + this.cameraParams.fx * cameraX / cameraZ;
      const projectedY = this.cameraParams.cy + this.cameraParams.fy * cameraY / cameraZ;

      total += Math.hypot(projectedX - imagePoints[imageIndex], projectedY - imagePoints[imageIndex + 1]);
      count++;
    }

    return total / Math.max(count, 1);
  }

  _statistics() {
    const stats = [...this.stats.values()];
    if (!stats.length) return emptyStats;
    const averageSupport = stats.reduce((sum, item) => sum + item.observations / Math.max(this.frames.length, 1), 0) / stats.length;
    const averageReliability = stats.reduce((sum, item) => sum + clamp(item.quality / Math.max(item.observations, 1) / 3, 0, 1), 0) / stats.length;
    const matureLandmarks = stats.filter(item => item.observations >= this.minFrames).length;
    const geometricConsistency = this.consistency.reduce((sum, value) => sum + value / Math.max(this.consistency.length, 1), 0);
    const frameProgress = clamp(this.frames.length / Math.max(this.minFrames, 1), 0, 1);
    const matureScore = clamp(matureLandmarks / Math.max(this.minLandmarks, 1), 0, 1);
    const geometryReadiness = readinessFromGeometry(geometricConsistency);

    return {
      averageSupport,
      averageReliability,
      matureLandmarks,
      geometricConsistency,
      mapConfidence: frameProgress * geometryReadiness * clamp(
        averageSupport * 0.34 +
        averageReliability * 0.24 +
        matureScore * 0.22 +
        geometricConsistency * 0.2,
        0,
        1
      ),
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
      depthQuality: depthQualityForSurfaceModel(this.model),
      statistics: this._statistics(),
      points,
      anchor,
      bounds: boundsForPoints([...points, anchor]),
      surface: {
        model: this.model,
        hull: mesh.points.map(point => point.id),
        edges: mesh.edges,
        faces: mesh.faces,
        mesh: mesh.points,
      },
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
          model: this.model,
          hull: mesh.points.map(point => point.id),
          edges: mesh.edges,
          faces: mesh.faces,
          mesh: mesh.points,
        },
      } : null,
    };
  }
}
