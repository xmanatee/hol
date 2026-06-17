import {
  clamp,
  normalizeAngle,
  normalizeVector,
  cross,
  projectWithRows,
  jacobiEigenSymmetric,
  fitAffineCamera,
  rowScale,
  rowRotation,
  solveLeastSquares,
} from './anchor.reconstruction.math.js';
import { createSurfacePreview, emptySurfacePreview } from './anchor.reconstruction.preview.js';
import {
  fitRobustSimilarity,
  selectCoherentObservations,
  transformPoint2,
} from './anchor.reconstructionRobust.js';
import {
  SURFACE_MODEL_PLANE,
  depthQualityForSurfaceModel,
  modelFromRegion,
  normalForSurfaceModel,
  pointForSurfaceModel,
  surfaceMeshForModel,
} from './anchor.parametricGeometry.js';

export const RECONSTRUCTION_POSE_MODEL = 'sparse-reconstruction';

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const subtract3 = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];

const pointDistance3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const normalizeObjectVector = vector => {
  const normalized = normalizeVector(vector);
  return { x: normalized[0], y: normalized[1], z: normalized[2] };
};

const addObjectVectors = (left, right) => ({
  x: left.x + right.x,
  y: left.y + right.y,
  z: left.z + right.z,
});

const scaleObjectVector = (vector, scale) => ({
  x: vector.x * scale,
  y: vector.y * scale,
  z: vector.z * scale,
});

const symmetricVectorToMatrix = vector => ([
  [vector[0], vector[1], vector[2]],
  [vector[1], vector[3], vector[4]],
  [vector[2], vector[4], vector[5]],
]);

const normalizeMetricMatrix = matrix => {
  const eigen = jacobiEigenSymmetric(matrix);
  const leading = Math.max(Math.abs(eigen[0].value), 1e-9);
  const positiveEigen = eigen.map(item => ({
    value: Math.max(item.value, leading * 1e-5),
    vector: item.vector,
  }));
  const normalizedTrace = positiveEigen.reduce((sum, item) => sum + item.value, 0) / 3;
  const result = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  positiveEigen.forEach(item => {
    const value = item.value / normalizedTrace;
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        result[row][column] += item.vector[row] * item.vector[column] * value;
      }
    }
  });

  return result;
};

const choleskyLower3 = matrix => {
  const l00 = Math.sqrt(Math.max(matrix[0][0], 1e-9));
  const l10 = matrix[1][0] / l00;
  const l20 = matrix[2][0] / l00;
  const l11 = Math.sqrt(Math.max(matrix[1][1] - l10 * l10, 1e-9));
  const l21 = (matrix[2][1] - l20 * l10) / l11;
  const l22 = Math.sqrt(Math.max(matrix[2][2] - l20 * l20 - l21 * l21, 1e-9));

  return [
    [l00, 0, 0],
    [l10, l11, 0],
    [l20, l21, l22],
  ];
};

const solveLower3 = (lower, vector) => {
  const x = vector[0] / lower[0][0];
  const y = (vector[1] - lower[1][0] * x) / lower[1][1];
  const z = (vector[2] - lower[2][0] * x - lower[2][1] * y) / lower[2][2];
  return [x, y, z];
};

const multiplyRowMatrix3 = (row, matrix) => ([
  row[0] * matrix[0][0] + row[1] * matrix[1][0] + row[2] * matrix[2][0],
  row[0] * matrix[0][1] + row[1] * matrix[1][1] + row[2] * matrix[2][1],
  row[0] * matrix[0][2] + row[1] * matrix[1][2] + row[2] * matrix[2][2],
]);

const metricEquationRows = (rowX, rowY) => [
  [
    rowX[0] * rowX[0] - rowY[0] * rowY[0],
    2 * (rowX[0] * rowX[1] - rowY[0] * rowY[1]),
    2 * (rowX[0] * rowX[2] - rowY[0] * rowY[2]),
    rowX[1] * rowX[1] - rowY[1] * rowY[1],
    2 * (rowX[1] * rowX[2] - rowY[1] * rowY[2]),
    rowX[2] * rowX[2] - rowY[2] * rowY[2],
  ],
  [
    rowX[0] * rowY[0],
    rowX[0] * rowY[1] + rowX[1] * rowY[0],
    rowX[0] * rowY[2] + rowX[2] * rowY[0],
    rowX[1] * rowY[1],
    rowX[1] * rowY[2] + rowX[2] * rowY[1],
    rowX[2] * rowY[2],
  ],
];

const metricUpgradeFromFactorization = (eigen, rowCount) => {
  const motionRows = Array.from({ length: rowCount }, (_, rowIndex) => (
    eigen.map(component => {
      const singular = Math.sqrt(Math.max(component.value, 0));
      return component.vector[rowIndex] * Math.sqrt(singular);
    })
  ));
  const equations = [];

  for (let row = 0; row < motionRows.length; row += 2) {
    equations.push(...metricEquationRows(motionRows[row], motionRows[row + 1]));
  }

  const normal = Array.from({ length: 6 }, () => new Array(6).fill(0));
  equations.forEach(equation => {
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < 6; column++) {
        normal[row][column] += equation[row] * equation[column];
      }
    }
  });

  const metricVector = jacobiEigenSymmetric(normal).at(-1).vector;
  const signedVector = metricVector[0] + metricVector[3] + metricVector[5] < 0
    ? metricVector.map(value => -value)
    : metricVector;
  const metricMatrix = normalizeMetricMatrix(symmetricVectorToMatrix(signedVector));
  const lower = choleskyLower3(metricMatrix);

  return {
    motionRows: motionRows.map(row => multiplyRowMatrix3(row, lower)),
    transformShape: coords => solveLower3(lower, coords),
  };
};

const cameraAxesFromRows = (rowX, rowY) => {
  const xAxis = normalizeVector(rowX.slice(0, 3));
  const yRaw = rowY.slice(0, 3);
  const yProjection = dot3(yRaw, xAxis);
  const yAxis = normalizeVector(yRaw.map((value, index) => value - yProjection * xAxis[index]));
  const zAxis = normalizeVector(cross(xAxis, yAxis));

  return { xAxis, yAxis, zAxis };
};

const projectSurfaceNormalToCamera = (surfaceNormal, rowX, rowY) => {
  if (!surfaceNormal) {
    return null;
  }

  const { xAxis, yAxis, zAxis } = cameraAxesFromRows(rowX, rowY);
  const normalModel = [surfaceNormal.x, surfaceNormal.y, surfaceNormal.z];
  const cameraNormal = normalizeVector([
    dot3(normalModel, xAxis),
    dot3(normalModel, yAxis),
    dot3(normalModel, zAxis),
  ]);
  const frontFacing = cameraNormal[2] >= 0
    ? cameraNormal
    : cameraNormal.map(value => -value);

  return { x: frontFacing[0], y: frontFacing[1], z: frontFacing[2] };
};

const interpolateAnchorPoint = (landmarks, anchorReference) => {
  const nearest = [...landmarks.values()]
    .map(item => ({
      point: item.point,
      distance: Math.hypot(item.reference.x - anchorReference.x, item.reference.y - anchorReference.y),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 14);
  const weighted = nearest.reduce((sum, item) => {
    const weight = 1 / (item.distance * item.distance + 36);
    return {
      x: sum.x + item.point.x * weight,
      y: sum.y + item.point.y * weight,
      z: sum.z + item.point.z * weight,
      weight: sum.weight + weight,
    };
  }, { x: 0, y: 0, z: 0, weight: 0 });

  return {
    x: weighted.x / weighted.weight,
    y: weighted.y / weighted.weight,
    z: weighted.z / weighted.weight,
  };
};

const calculateBounds = points => {
  const initial = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };

  return points.reduce((bounds, point) => ({
    min: {
      x: Math.min(bounds.min.x, point.x),
      y: Math.min(bounds.min.y, point.y),
      z: Math.min(bounds.min.z, point.z),
    },
    max: {
      x: Math.max(bounds.max.x, point.x),
      y: Math.max(bounds.max.y, point.y),
      z: Math.max(bounds.max.z, point.z),
    },
  }), initial);
};

const calculateDepthQuality = landmarks => {
  const bounds = calculateBounds([...landmarks.values()].map(item => item.point));
  const depth = bounds.max.z - bounds.min.z;
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  return clamp(depth / Math.max(width, height, 1e-9), 0, 1);
};

export class SparseObjectReconstructor {
  constructor(config = {}) {
    this.baseConfig = {
      minFrames: config.minFrames ?? 6,
      minLandmarks: config.minLandmarks ?? 18,
      minPoseLandmarks: config.minPoseLandmarks ?? 10,
      maxFrames: config.maxFrames ?? 18,
      maxBuildFrames: config.maxBuildFrames ?? 10,
      rebuildInterval: config.rebuildInterval ?? 4,
      minObservationRatio: config.minObservationRatio ?? 0.58,
      maxMappedLandmarks: config.maxMappedLandmarks ?? 72,
    };
    this._applyBaseConfig();
    this.reset({ anchorReference: { x: 0, y: 0 } });
    this.state = 'inactive';
  }

  configure({ cv, cameraParams }) {
    this.cv = cv;
    this.cameraParams = { ...cameraParams };
  }

  reset({ anchorReference, templateRegion = { x: 0, y: 0, width: 1, height: 1 }, targetClass = null }) {
    this.anchorReference = { x: anchorReference.x, y: anchorReference.y };
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.targetSurfaceModel = modelFromRegion(templateRegion, targetClass);
    this._applyTargetSurfaceConfig();
    this.frames = [];
    this.map = null;
    this.state = 'mapping';
    this.lastFailureReason = null;
    this.framesSinceBuild = 0;
    this.frameIndex = 0;
    this.landmarkStats = new Map();
  }

  updateReferenceRegion(templateRegion, targetClass = this.targetClass) {
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.targetSurfaceModel = modelFromRegion(templateRegion, targetClass);
    this._applyTargetSurfaceConfig();
  }

  _applyBaseConfig() {
    this.minFrames = this.baseConfig.minFrames;
    this.minLandmarks = this.baseConfig.minLandmarks;
    this.minPoseLandmarks = this.baseConfig.minPoseLandmarks;
    this.maxFrames = this.baseConfig.maxFrames;
    this.maxBuildFrames = this.baseConfig.maxBuildFrames;
    this.rebuildInterval = this.baseConfig.rebuildInterval;
    this.minObservationRatio = this.baseConfig.minObservationRatio;
    this.maxMappedLandmarks = this.baseConfig.maxMappedLandmarks;
  }

  _applyTargetSurfaceConfig() {
    this._applyBaseConfig();
    if (!this._usesTargetSurfacePrior()) {
      return;
    }

    this.minFrames = Math.min(this.minFrames, 4);
    this.minLandmarks = Math.min(this.minLandmarks, 14);
    this.minPoseLandmarks = Math.min(this.minPoseLandmarks, 8);
    this.maxBuildFrames = Math.min(this.maxBuildFrames, 8);
    this.minObservationRatio = Math.min(this.minObservationRatio, 0.46);
  }

  _mappingCoherenceOptions() {
    return {
      minInliers: this.minLandmarks,
      threshold: this._usesTargetSurfacePrior() ? 12 : 10,
      minInlierRatio: this._usesTargetSurfacePrior() ? 0.42 : 0.56,
      model: 'affine',
    };
  }

  addFrameFromTrackedPoints(trackedPoints, timestamp = performance.now()) {
    const observations = trackedPoints
      .filter(point => point.status === 'active')
      .filter(point => Number.isFinite(point.current.x) && Number.isFinite(point.current.y))
      .filter(point => Number.isFinite(point.original.x) && Number.isFinite(point.original.y))
      .map(point => ({
        id: point.id,
        current: { x: point.current.x, y: point.current.y },
        reference: { x: point.original.x, y: point.original.y },
        quality: (point.stabilityScore || 0) + Math.min(point.age || 0, 30) / 30 + (point.response || 0),
      }));

    this.frameIndex++;
    if (observations.length < this.minLandmarks) {
      this.state = this.map ? 'ready' : 'mapping';
      this.lastFailureReason = 'Insufficient active landmarks for reconstruction';
      return this.getState();
    }

    const coherent = selectCoherentObservations(observations, this._mappingCoherenceOptions());
    if (!coherent.success) {
      this.state = this.map ? 'ready' : 'mapping';
      this.lastFailureReason = coherent.reason;
      return this.getState();
    }

    this._updateLandmarkStats(coherent.observations, this.frameIndex);
    this.frames.push({
      timestamp,
      frameIndex: this.frameIndex,
      observations: coherent.observations,
      consistency: coherent.consistency,
    });
    if (this.frames.length > this.maxFrames) {
      this.frames = this.frames.slice(-this.maxFrames);
    }

    this.framesSinceBuild++;
    if (!this.map || this.framesSinceBuild >= this.rebuildInterval) {
      this._rebuildMap();
      this.framesSinceBuild = 0;
    }

    return this.getState();
  }

  estimatePoseFromTrackedPoints(trackedPoints) {
    if (!this.map) {
      return { success: false, method: RECONSTRUCTION_POSE_MODEL, reason: '3D reconstruction map is not ready' };
    }

    const observations = this._poseObservationsFromTrackedPoints(trackedPoints);
    const trackedFit = fitRobustSimilarity(this._activeReferenceObservations(trackedPoints), {
      minInliers: Math.max(8, this.minPoseLandmarks),
      threshold: 10,
    });

    if (observations.length < this.minPoseLandmarks) {
      return { success: false, method: RECONSTRUCTION_POSE_MODEL, reason: 'Insufficient reconstructed landmarks in view' };
    }

    const pose = fitAffineCamera(observations, this.minPoseLandmarks);
    if (!pose.success) {
      return { ...pose, method: RECONSTRUCTION_POSE_MODEL };
    }

    const rawNormal = normalizeVector(cross(pose.rowX.slice(0, 3), pose.rowY.slice(0, 3)));
    const viewNormal = rawNormal[2] >= 0 ? rawNormal : rawNormal.map(value => -value);
    const surface = this.map.surface?.poseReliable === false
      ? null
      : this.map.surface || this._estimateLocalSurface([...this.map.landmarks.values()], this.map.anchorPoint);
    const surfaceNormal = projectSurfaceNormalToCamera(surface?.normal, pose.rowX, pose.rowY);
    const normal = surfaceNormal || { x: viewNormal[0], y: viewNormal[1], z: viewNormal[2] };
    const currentScale = rowScale(pose.rowX, pose.rowY);
    const projectedAnchor = projectWithRows(this.map.anchorPoint, pose.rowX, pose.rowY);
    const surfaceTransform = this._usesTargetSurfacePrior()
      ? this._projectLocalSurfaceTransform({
        rowX: pose.rowX,
        rowY: pose.rowY,
        anchorPoint: this.map.anchorPoint,
        surface,
      })
      : null;
    const poseScale = surfaceTransform && this.map.referenceSurfaceScale
      ? surfaceTransform.scale / this.map.referenceSurfaceScale
      : currentScale / this.map.referenceScale;
    const poseRotation = surfaceTransform && Number.isFinite(this.map.referenceSurfaceRotation)
      ? normalizeAngle(surfaceTransform.rotation - this.map.referenceSurfaceRotation)
      : normalizeAngle(rowRotation(pose.rowX, pose.rowY) - this.map.referenceRotation);
    const trackedAnchor = trackedFit.success
      ? transformPoint2(this.anchorReference, trackedFit.transform)
      : null;
    const useProjectedSurfaceAnchor = this._shouldUseProjectedSurfaceAnchor({
      pose,
      trackedFit,
      projectedAnchor,
      trackedAnchor,
    });
    const attachmentAnchor = useProjectedSurfaceAnchor || !trackedAnchor ? projectedAnchor : trackedAnchor;
    const attachmentScale = useProjectedSurfaceAnchor || !trackedFit.success ? poseScale : trackedFit.transform.scale;
    const attachmentRotation = useProjectedSurfaceAnchor || !trackedFit.success ? poseRotation : trackedFit.transform.rotation;
    const attachmentMethod = useProjectedSurfaceAnchor || !trackedFit.success
      ? RECONSTRUCTION_POSE_MODEL
      : 'reference_similarity_transform';
    const residualScore = clamp(1 - pose.averageResidual / 12, 0, 1);
    const coverageScore = clamp(pose.inlierCount / Math.max(this.map.landmarks.size * 0.62, this.minPoseLandmarks), 0, 1);
    const confidence = clamp(pose.inlierRatio * 0.5 + residualScore * 0.3 + coverageScore * 0.2, 0, 1);

    return {
      success: true,
      method: RECONSTRUCTION_POSE_MODEL,
      position: { x: attachmentAnchor.x, y: attachmentAnchor.y, z: 0 },
      normal,
      planarTransform: {
        scale: attachmentScale,
        rotation: attachmentRotation,
        confidence,
        inlierCount: pose.inlierCount,
        method: attachmentMethod,
      },
      confidence,
      inlierCount: pose.inlierCount,
      inlierRatio: pose.inlierRatio,
      averageResidual: pose.averageResidual,
      depthQuality: this.map.depthQuality,
      landmarkCount: this.map.landmarks.size,
      completedLandmarkCount: observations.filter(observation => observation.completed).length,
      preview: this._createPreview({
        rowX: pose.rowX,
        rowY: pose.rowY,
        normal,
        anchor: attachmentAnchor,
        planarTransform: {
          scale: attachmentScale,
          rotation: attachmentRotation,
        },
      }),
    };
  }

  _activeReferenceObservations(trackedPoints) {
    return trackedPoints
      .filter(point => point.status === 'active')
      .filter(point => Number.isFinite(point.original?.x) && Number.isFinite(point.original?.y))
      .filter(point => Number.isFinite(point.current?.x) && Number.isFinite(point.current?.y))
      .map(point => ({
        id: point.id,
        reference: { x: point.original.x, y: point.original.y },
        current: { x: point.current.x, y: point.current.y },
        quality: (point.stabilityScore || 0) + Math.min(point.age || 0, 30) / 30 + (point.response || 0),
      }));
  }

  _shouldUseProjectedSurfaceAnchor({ pose, trackedFit, projectedAnchor, trackedAnchor }) {
    if (!this._usesTargetSurfacePrior()) {
      return false;
    }

    const averageResidual = pose.averageResidual ?? Infinity;
    const inlierCount = pose.inlierCount || 0;
    const mapConfidence = this.map?.statistics?.mapConfidence ?? 0;
    const highPrecisionSurfaceFit = inlierCount >= 30 &&
      averageResidual <= 3.4 &&
      mapConfidence >= 0.62;

    if (!trackedFit.success || !trackedAnchor) {
      return highPrecisionSurfaceFit ||
        (inlierCount >= 20 && averageResidual <= 5.5 && mapConfidence >= 0.58);
    }

    const anchorDisagreement = Math.hypot(
      projectedAnchor.x - trackedAnchor.x,
      projectedAnchor.y - trackedAnchor.y
    );
    const staleReferenceTransform = anchorDisagreement >= 24 &&
      inlierCount >= 18 &&
      averageResidual <= 6.5 &&
      mapConfidence >= 0.55 &&
      trackedFit.averageResidual <= 4.5;
    const weakTrackedSurfaceCorrection = anchorDisagreement >= 12 &&
      inlierCount >= 14 &&
      averageResidual <= 4.8 &&
      mapConfidence >= 0.72 &&
      (trackedFit.inlierCount || 0) <= 12 &&
      trackedFit.averageResidual <= 7.2;

    return highPrecisionSurfaceFit || staleReferenceTransform || weakTrackedSurfaceCorrection;
  }

  _poseObservationsFromTrackedPoints(trackedPoints) {
    if (this._usesTargetSurfacePrior() && this.map.referenceBounds) {
      const coherent = selectCoherentObservations(
        this._activeReferenceObservations(trackedPoints),
        {
          minInliers: Math.max(8, this.minPoseLandmarks),
          threshold: 10,
          minInlierRatio: 0.42,
          model: 'affine',
        }
      );

      if (coherent.success) {
        return coherent.observations.map(observation => ({
          id: observation.id,
          point: this.map.landmarks.get(observation.id)?.point || pointForSurfaceModel(
            observation.reference,
            this.map.referenceBounds,
            this.map.targetSurfaceModel
          ),
          current: observation.current,
          completed: false,
        }));
      }
    }

    const active = trackedPoints
      .filter(point => point.status === 'active')
      .filter(point => Number.isFinite(point.current.x) && Number.isFinite(point.current.y));
    const observations = active
      .filter(point => this.map.landmarks.has(point.id))
      .map(point => ({
        id: point.id,
        point: this.map.landmarks.get(point.id).point,
        current: { x: point.current.x, y: point.current.y },
        completed: false,
      }));

    if (observations.length >= this.minPoseLandmarks) {
      return observations;
    }

    const coherent = selectCoherentObservations(
      this._activeReferenceObservations(trackedPoints),
      {
        minInliers: Math.max(8, this.minPoseLandmarks),
        threshold: 10,
        minInlierRatio: 0.5,
        model: 'affine',
      }
    );

    if (!coherent.success) {
      return observations;
    }

    const activeIds = new Set(observations.map(observation => observation.id));
    const completed = [...this.map.landmarks.values()]
      .filter(landmark => !activeIds.has(landmark.id))
      .sort((left, right) => right.reliability - left.reliability)
      .slice(0, Math.max(0, this.minPoseLandmarks * 3 - observations.length))
      .map(landmark => ({
        id: landmark.id,
        point: landmark.point,
        current: this._projectReferenceWithTransform(landmark.reference, coherent.fit.transform),
        completed: true,
      }));

    return [...observations, ...completed];
  }

  _rebuildMap() {
    const frames = this.frames.slice(-this.maxBuildFrames);
    if (frames.length < this.minFrames) {
      this.lastFailureReason = 'Move the object: more calibration views are needed';
      return;
    }

    const supportedIds = this._supportedIds(frames);
    if (supportedIds.length < this.minLandmarks) {
      this.lastFailureReason = 'Move slower: too few statistically supported landmarks persisted across views';
      return;
    }

    const ids = supportedIds.slice(0, this.maxMappedLandmarks);
    const centeredRows = this._createCenteredMeasurementRows(frames, ids);
    if (!centeredRows) {
      this.lastFailureReason = 'Calibration views are too sparse for landmark completion';
      return;
    }
    const covariance = centeredRows.map(left => (
      centeredRows.map(right => left.reduce((sum, value, index) => sum + value * right[index], 0))
    ));
    const eigen = jacobiEigenSymmetric(covariance).filter(item => item.value > 1e-7).slice(0, 3);
    if (eigen.length < 3) {
      this.lastFailureReason = 'Calibration motion is nearly planar';
      return;
    }

    const metricUpgrade = metricUpgradeFromFactorization(eigen, centeredRows.length);
    const referenceBounds = this._referenceBoundsForIds(ids);
    const landmarks = this._createLandmarks({ frames, ids, eigen, centeredRows, metricUpgrade, referenceBounds });
    const referencePose = fitAffineCamera([...landmarks.values()].map(item => ({
      point: item.point,
      current: item.reference,
    })), this.minPoseLandmarks);

    if (!referencePose.success) {
      this.lastFailureReason = referencePose.reason;
      return;
    }

    const anchorPoint = interpolateAnchorPoint(landmarks, this.anchorReference);
    const surface = this._usesTargetSurfacePrior()
      ? this._createTargetSurface(referenceBounds)
      : this._estimateLocalSurface([...landmarks.values()], anchorPoint);
    const referenceSurfaceTransform = surface
      ? this._projectLocalSurfaceTransform({
        rowX: referencePose.rowX,
        rowY: referencePose.rowY,
        anchorPoint,
        surface,
      })
      : null;

    this.map = {
      landmarks,
      anchorPoint,
      surface: surface
        ? { ...surface, poseReliable: this._usesTargetSurfacePrior() }
        : null,
      targetSurfaceModel: this._usesTargetSurfacePrior() ? this.targetSurfaceModel : null,
      referenceBounds,
      referenceScale: rowScale(referencePose.rowX, referencePose.rowY),
      referenceRotation: rowRotation(referencePose.rowX, referencePose.rowY),
      referenceSurfaceScale: referenceSurfaceTransform?.scale || null,
      referenceSurfaceRotation: referenceSurfaceTransform?.rotation ?? null,
      depthQuality: this._usesTargetSurfacePrior()
        ? depthQualityForSurfaceModel(this.targetSurfaceModel)
        : calculateDepthQuality(landmarks),
      frameCount: frames.length,
      statistics: this._createMapStatistics(landmarks, frames),
    };
    this.state = 'ready';
    this.lastFailureReason = null;
  }

  _createCenteredMeasurementRows(frames, ids) {
    const centeredRows = [];
    frames.forEach(frame => {
      const byId = new Map(frame.observations.map(item => [item.id, item]));
      const completionTransform = this._estimateReferenceToCurrentTransform(frame, ids);
      if (!completionTransform) {
        return;
      }
      const points = ids.map(id => {
        const observation = byId.get(id);
        return observation?.current || this._projectReferenceWithTransform(
          this.landmarkStats.get(id).reference,
          completionTransform
        );
      });
      const centroid = points.reduce((sum, point) => ({
        x: sum.x + point.x / points.length,
        y: sum.y + point.y / points.length,
      }), { x: 0, y: 0 });
      centeredRows.push(points.map(point => point.x - centroid.x));
      centeredRows.push(points.map(point => point.y - centroid.y));
    });
    return centeredRows.length === frames.length * 2 ? centeredRows : null;
  }

  _usesTargetSurfacePrior() {
    return this.targetSurfaceModel && this.targetSurfaceModel !== SURFACE_MODEL_PLANE;
  }

  _referenceBoundsForIds(ids) {
    return calculateBounds(ids.map(id => ({
      ...this.landmarkStats.get(id).reference,
      z: 0,
    })));
  }

  _createTargetSurface(referenceBounds) {
    const normal = normalizeObjectVector(Object.values(normalForSurfaceModel(
      this.anchorReference,
      referenceBounds,
      this.targetSurfaceModel
    )));
    const tangentX = normalizeObjectVector([normal.z, 0, -normal.x]);
    const tangentY = normalizeObjectVector(cross(
      [normal.x, normal.y, normal.z],
      [tangentX.x, tangentX.y, tangentX.z]
    ));
    const centroid = pointForSurfaceModel(this.anchorReference, referenceBounds, this.targetSurfaceModel);

    return {
      normal,
      tangentX,
      tangentY,
      centroid,
      support: this.minLandmarks,
      planarity: 0.3,
    };
  }

  _projectLocalSurfaceTransform({ rowX, rowY, anchorPoint, surface }) {
    if (!surface?.tangentX || !surface?.tangentY) {
      return null;
    }

    const basis = 42;
    const projectedAnchor = projectWithRows(anchorPoint, rowX, rowY);
    const projectedX = projectWithRows(
      addObjectVectors(anchorPoint, scaleObjectVector(surface.tangentX, basis)),
      rowX,
      rowY
    );
    const projectedY = projectWithRows(
      addObjectVectors(anchorPoint, scaleObjectVector(surface.tangentY, basis)),
      rowX,
      rowY
    );
    const vectorX = {
      x: projectedX.x - projectedAnchor.x,
      y: projectedX.y - projectedAnchor.y,
    };
    const vectorY = {
      x: projectedY.x - projectedAnchor.x,
      y: projectedY.y - projectedAnchor.y,
    };

    return {
      scale: Math.sqrt(Math.max(1e-9, Math.hypot(vectorX.x, vectorX.y) * Math.hypot(vectorY.x, vectorY.y))) / basis,
      rotation: Math.atan2(vectorX.y, vectorX.x),
    };
  }

  _createLandmarks({ frames, ids, eigen, centeredRows, metricUpgrade, referenceBounds }) {
    const landmarks = new Map();

    ids.forEach((id, pointIndex) => {
      const stat = this.landmarkStats.get(id);
      const affineCoords = eigen.map(component => {
        const singular = Math.sqrt(component.value);
        const rootSingular = Math.sqrt(singular);
        const numerator = component.vector.reduce((sum, value, rowIndex) => (
          sum + value * centeredRows[rowIndex][pointIndex]
        ), 0);
        return numerator / Math.max(rootSingular, 1e-9);
      });
      const coords = this._usesTargetSurfacePrior()
        ? Object.values(pointForSurfaceModel(stat.reference, referenceBounds, this.targetSurfaceModel))
        : metricUpgrade.transformShape(affineCoords);
      landmarks.set(id, {
        id,
        point: { x: coords[0], y: coords[1], z: coords[2] },
        reference: stat.reference,
        observations: stat.observations,
        support: this._frameSupport(id, frames),
        reliability: this._landmarkReliability(stat),
        variance: stat.variance,
      });
    });

    return landmarks;
  }

  _estimateLocalSurface(landmarks, anchorPoint) {
    const local = landmarks
      .map(item => ({
        ...item,
        distance: pointDistance3(item.point, anchorPoint),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, Math.min(24, Math.max(8, Math.ceil(landmarks.length * 0.35))));

    if (local.length < 6) {
      return null;
    }

    const totalWeight = local.reduce((sum, item) => sum + 1 / (item.distance * item.distance + 144), 0);
    const centroid = local.reduce((sum, item) => {
      const weight = 1 / (item.distance * item.distance + 144);
      return {
        x: sum.x + item.point.x * weight / totalWeight,
        y: sum.y + item.point.y * weight / totalWeight,
        z: sum.z + item.point.z * weight / totalWeight,
      };
    }, { x: 0, y: 0, z: 0 });
    const covariance = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];

    local.forEach(item => {
      const vector = subtract3(item.point, centroid);
      const weight = 1 / (item.distance * item.distance + 144);
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
          covariance[row][column] += vector[row] * vector[column] * weight / totalWeight;
        }
      }
    });

    const eigen = jacobiEigenSymmetric(covariance);
    if (eigen.length < 3 || eigen[1].value < 1e-9) {
      return null;
    }

    const normal = normalizeObjectVector(eigen[2].vector);
    const tangentX = normalizeObjectVector(eigen[0].vector);
    const tangentY = normalizeObjectVector(cross(
      [normal.x, normal.y, normal.z],
      [tangentX.x, tangentX.y, tangentX.z]
    ));

    return {
      normal,
      tangentX,
      tangentY,
      centroid,
      support: local.length,
      planarity: clamp(1 - Math.sqrt(Math.max(eigen[2].value, 0)) / Math.max(Math.sqrt(Math.max(eigen[1].value, 1e-9)), 1e-9), 0, 1),
    };
  }

  _supportedIds(frames) {
    const counts = new Map();
    const quality = new Map();
    frames.forEach(frame => {
      frame.observations.forEach(item => {
        counts.set(item.id, (counts.get(item.id) || 0) + 1);
        quality.set(item.id, (quality.get(item.id) || 0) + item.quality);
      });
    });

    const minObservationCount = Math.max(this.minFrames, Math.ceil(frames.length * this.minObservationRatio));
    return [...counts.entries()]
      .filter(([, count]) => count >= minObservationCount)
      .map(([id]) => id)
      .sort((left, right) => {
        const leftStat = this.landmarkStats.get(left);
        const rightStat = this.landmarkStats.get(right);
        const supportScore = this._landmarkReliability(rightStat) - this._landmarkReliability(leftStat);
        return supportScore || quality.get(right) - quality.get(left);
      });
  }

  _updateLandmarkStats(observations, frameIndex) {
    observations.forEach(observation => {
      const previous = this.landmarkStats.get(observation.id);
      const nextCount = (previous?.observations || 0) + 1;
      const previousMean = previous?.mean || observation.current;
      const mean = {
        x: previousMean.x + (observation.current.x - previousMean.x) / nextCount,
        y: previousMean.y + (observation.current.y - previousMean.y) / nextCount,
      };
      const previousM2 = previous?.m2 || { x: 0, y: 0 };
      const m2 = {
        x: previousM2.x + (observation.current.x - previousMean.x) * (observation.current.x - mean.x),
        y: previousM2.y + (observation.current.y - previousMean.y) * (observation.current.y - mean.y),
      };
      const variance = nextCount > 1
        ? Math.sqrt((m2.x + m2.y) / Math.max(nextCount - 1, 1))
        : 0;
      const expectedPreviousFrame = frameIndex - 1;
      const activeStreak = previous?.lastFrameIndex === expectedPreviousFrame
        ? previous.activeStreak + 1
        : 1;

      this.landmarkStats.set(observation.id, {
        id: observation.id,
        reference: previous?.reference || observation.reference,
        observations: nextCount,
        firstFrameIndex: previous?.firstFrameIndex || frameIndex,
        lastFrameIndex: frameIndex,
        activeStreak,
        longestStreak: Math.max(previous?.longestStreak || 0, activeStreak),
        qualitySum: (previous?.qualitySum || 0) + observation.quality,
        mean,
        m2,
        variance,
      });
    });
  }

  _estimateReferenceToCurrentTransform(frame, ids) {
    const byId = new Map(frame.observations.map(item => [item.id, item]));
    const available = ids.map(id => byId.get(id)).filter(Boolean);
    if (available.length < 3) {
      return null;
    }

    const rows = available.map(item => [item.reference.x, item.reference.y, 1]);
    const rowX = solveLeastSquares(rows, available.map(item => item.current.x));
    const rowY = solveLeastSquares(rows, available.map(item => item.current.y));
    return rowX && rowY ? { rowX, rowY } : null;
  }

  _projectReferenceWithTransform(reference, transform) {
    return {
      x: transform.rowX[0] * reference.x + transform.rowX[1] * reference.y + transform.rowX[2],
      y: transform.rowY[0] * reference.x + transform.rowY[1] * reference.y + transform.rowY[2],
    };
  }

  _frameSupport(id, frames) {
    const observedFrames = frames.filter(frame => (
      frame.observations.some(observation => observation.id === id)
    )).length;
    return observedFrames / frames.length;
  }

  _landmarkReliability(stat) {
    const support = clamp(stat.observations / Math.max(this.frameIndex, 1), 0, 1);
    const quality = clamp((stat.qualitySum / Math.max(stat.observations, 1)) / 3, 0, 1);
    const streak = clamp(stat.longestStreak / Math.max(this.minFrames, 1), 0, 1);
    const varianceScore = clamp(1 - stat.variance / 80, 0, 1);
    return clamp(support * 0.4 + quality * 0.25 + streak * 0.2 + varianceScore * 0.15, 0, 1);
  }

  _createMapStatistics(landmarks, frames) {
    const mapped = [...landmarks.values()];
    const averageSupport = mapped.reduce((sum, item) => sum + item.support, 0) / mapped.length;
    const averageReliability = mapped.reduce((sum, item) => sum + item.reliability, 0) / mapped.length;
    const matureLandmarks = mapped.filter(item => item.reliability >= 0.62).length;
    const geometricConsistency = frames.reduce((sum, frame) => sum + frame.consistency / frames.length, 0);

    return {
      averageSupport,
      averageReliability,
      matureLandmarks,
      geometricConsistency,
      mapConfidence: clamp(
        averageSupport * 0.34 +
        averageReliability * 0.3 +
        clamp(matureLandmarks / this.minLandmarks, 0, 1) * 0.18 +
        geometricConsistency * 0.18,
        0,
        1
      ),
      mappedFrames: frames.length,
    };
  }

  getState() {
    return {
      state: this.state,
      ready: this.state === 'ready',
      poseModel: RECONSTRUCTION_POSE_MODEL,
      frameCount: this.frames.length,
      landmarkCount: this.map?.landmarks.size || 0,
      depthQuality: this.map?.depthQuality || 0,
      statistics: this.map?.statistics || {
        averageSupport: 0,
        averageReliability: 0,
        matureLandmarks: 0,
        geometricConsistency: 0,
        mapConfidence: 0,
        mappedFrames: 0,
      },
      lastFailureReason: this.lastFailureReason,
      preview: this._createPreview(),
    };
  }

  _createPreview(currentPose = null) {
    if (!this.map) {
      return {
        ready: false,
        poseModel: RECONSTRUCTION_POSE_MODEL,
        frameCount: this.frames.length,
        landmarkCount: 0,
        depthQuality: 0,
        statistics: {
          averageSupport: 0,
          averageReliability: 0,
          matureLandmarks: 0,
          geometricConsistency: 0,
          mapConfidence: 0,
          mappedFrames: 0,
        },
        points: [],
        anchor: null,
        bounds: null,
        surface: emptySurfacePreview(),
        current: null,
      };
    }

    const points = [...this.map.landmarks.values()]
      .sort((left, right) => left.id - right.id)
      .slice(0, 96)
      .map(item => ({
        id: item.id,
        x: item.point.x,
        y: item.point.y,
        z: item.point.z,
        reliability: item.reliability,
        observations: item.observations,
        support: item.support,
        variance: item.variance,
        reference: {
          x: item.reference.x,
          y: item.reference.y,
        },
      }));

    const anchor = {
      x: this.map.anchorPoint.x,
      y: this.map.anchorPoint.y,
      z: this.map.anchorPoint.z,
    };
    const bounds = calculateBounds([...points, { id: 'anchor', ...anchor }]);
    const surface = this._createPreviewSurface(points);

    return {
      ready: true,
      poseModel: RECONSTRUCTION_POSE_MODEL,
      frameCount: this.frames.length,
      landmarkCount: this.map.landmarks.size,
      depthQuality: this.map.depthQuality,
      statistics: this.map.statistics,
      points,
      anchor,
      bounds,
      surface,
      current: currentPose ? {
        points: points.map(point => ({
          id: point.id,
          ...projectWithRows(point, currentPose.rowX, currentPose.rowY),
          reliability: point.reliability,
        })),
        anchor: {
          x: currentPose.anchor.x,
          y: currentPose.anchor.y,
        },
        normal: currentPose.normal,
        planarTransform: currentPose.planarTransform,
        surface,
      } : null,
    };
  }

  _createPreviewSurface(points) {
    if (!this.map.targetSurfaceModel) {
      return createSurfacePreview(points);
    }

    const mesh = surfaceMeshForModel(this.map.referenceBounds, this.map.targetSurfaceModel);
    return {
      model: this.map.targetSurfaceModel,
      hull: mesh.points.map(point => point.id),
      edges: mesh.edges,
      faces: mesh.faces,
      mesh: mesh.points,
    };
  }
}
