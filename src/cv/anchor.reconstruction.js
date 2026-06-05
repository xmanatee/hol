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

export const RECONSTRUCTION_POSE_MODEL = 'sparse-reconstruction';

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const subtract3 = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];

const pointDistance3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const normalizeObjectVector = vector => {
  const normalized = normalizeVector(vector);
  return { x: normalized[0], y: normalized[1], z: normalized[2] };
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

export class SparseObjectReconstructor {
  constructor(config = {}) {
    this.minFrames = config.minFrames ?? 6;
    this.minLandmarks = config.minLandmarks ?? 18;
    this.minPoseLandmarks = config.minPoseLandmarks ?? 10;
    this.maxFrames = config.maxFrames ?? 18;
    this.maxBuildFrames = config.maxBuildFrames ?? 10;
    this.rebuildInterval = config.rebuildInterval ?? 4;
    this.minObservationRatio = config.minObservationRatio ?? 0.58;
    this.maxMappedLandmarks = config.maxMappedLandmarks ?? 72;
    this.reset({ anchorReference: { x: 0, y: 0 } });
    this.state = 'inactive';
  }

  reset({ anchorReference }) {
    this.anchorReference = { x: anchorReference.x, y: anchorReference.y };
    this.frames = [];
    this.map = null;
    this.state = 'mapping';
    this.lastFailureReason = null;
    this.framesSinceBuild = 0;
    this.frameIndex = 0;
    this.landmarkStats = new Map();
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
    this._updateLandmarkStats(observations, this.frameIndex);

    if (observations.length < this.minLandmarks) {
      this.state = this.map ? 'ready' : 'mapping';
      this.lastFailureReason = 'Insufficient active landmarks for reconstruction';
      return this.getState();
    }

    this.frames.push({ timestamp, frameIndex: this.frameIndex, observations });
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

    const observations = trackedPoints
      .filter(point => point.status === 'active')
      .filter(point => this.map.landmarks.has(point.id))
      .map(point => ({
        id: point.id,
        point: this.map.landmarks.get(point.id).point,
        current: { x: point.current.x, y: point.current.y },
      }));

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
    const residualScore = clamp(1 - pose.averageResidual / 12, 0, 1);
    const coverageScore = clamp(pose.inlierCount / Math.max(this.map.landmarks.size * 0.62, this.minPoseLandmarks), 0, 1);
    const confidence = clamp(pose.inlierRatio * 0.5 + residualScore * 0.3 + coverageScore * 0.2, 0, 1);

    return {
      success: true,
      method: RECONSTRUCTION_POSE_MODEL,
      position: { x: projectedAnchor.x, y: projectedAnchor.y, z: 0 },
      normal,
      planarTransform: {
        scale: currentScale / this.map.referenceScale,
        rotation: normalizeAngle(rowRotation(pose.rowX, pose.rowY) - this.map.referenceRotation),
        confidence,
        inlierCount: pose.inlierCount,
        method: RECONSTRUCTION_POSE_MODEL,
      },
      confidence,
      inlierCount: pose.inlierCount,
      inlierRatio: pose.inlierRatio,
      averageResidual: pose.averageResidual,
      depthQuality: this.map.depthQuality,
      landmarkCount: this.map.landmarks.size,
      preview: this._createPreview({
        rowX: pose.rowX,
        rowY: pose.rowY,
        normal,
        anchor: projectedAnchor,
        planarTransform: {
          scale: currentScale / this.map.referenceScale,
          rotation: normalizeAngle(rowRotation(pose.rowX, pose.rowY) - this.map.referenceRotation),
        },
      }),
    };
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

    const landmarks = this._createLandmarks({ frames, ids, eigen, centeredRows });
    const referencePose = fitAffineCamera([...landmarks.values()].map(item => ({
      point: item.point,
      current: item.reference,
    })), this.minPoseLandmarks);

    if (!referencePose.success) {
      this.lastFailureReason = referencePose.reason;
      return;
    }

    const anchorPoint = interpolateAnchorPoint(landmarks, this.anchorReference);
    const surface = this._estimateLocalSurface([...landmarks.values()], anchorPoint);

    this.map = {
      landmarks,
      anchorPoint,
      surface: surface ? { ...surface, poseReliable: false } : null,
      referenceScale: rowScale(referencePose.rowX, referencePose.rowY),
      referenceRotation: rowRotation(referencePose.rowX, referencePose.rowY),
      depthQuality: Math.sqrt(eigen[2].value) / Math.max(Math.sqrt(eigen[1].value), 1e-9),
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

  _createLandmarks({ frames, ids, eigen, centeredRows }) {
    const landmarks = new Map();

    ids.forEach((id, pointIndex) => {
      const stat = this.landmarkStats.get(id);
      const coords = eigen.map(component => {
        const singular = Math.sqrt(component.value);
        const rootSingular = Math.sqrt(singular);
        const numerator = component.vector.reduce((sum, value, rowIndex) => (
          sum + value * centeredRows[rowIndex][pointIndex]
        ), 0);
        return numerator / Math.max(rootSingular, 1e-9);
      });
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

    return {
      averageSupport,
      averageReliability,
      matureLandmarks,
      mapConfidence: clamp(averageSupport * 0.42 + averageReliability * 0.38 + clamp(matureLandmarks / this.minLandmarks, 0, 1) * 0.2, 0, 1),
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
      surface: createSurfacePreview(points),
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
        surface: createSurfacePreview(points),
      } : null,
    };
  }
}
