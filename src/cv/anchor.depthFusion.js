import { clamp, normalizeAngle } from './anchor.reconstruction.math.js';
import { fitRobustSimilarity, toActiveObservations, transformPoint2 } from './anchor.reconstructionRobust.js';
import { modelFromRegion } from './anchor.parametricGeometry.js';
import { calculateDepthGeometry, calculateDepthQuality, median } from './anchor.depthFusion.geometry.js';
import { DepthFusionSurfelMap } from './anchor.depthFusion.surfels.js';
import { DEPTH_FUSION_POSE_MODEL } from './anchor.reconstructionModes.js';
import { copyImageData } from '../utils/imageDataTransfer.js';

export { DEPTH_FUSION_POSE_MODEL };

const depthQualityFromSurfels = (surfels) => {
  if (surfels.size < 3) return 0;

  const bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };

  surfels.forEach((surfel) => {
    bounds.minX = Math.min(bounds.minX, surfel.x);
    bounds.minY = Math.min(bounds.minY, surfel.y);
    bounds.minZ = Math.min(bounds.minZ, surfel.z);
    bounds.maxX = Math.max(bounds.maxX, surfel.x);
    bounds.maxY = Math.max(bounds.maxY, surfel.y);
    bounds.maxZ = Math.max(bounds.maxZ, surfel.z);
  });

  return clamp(
    (bounds.maxZ - bounds.minZ) / Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1),
    0,
    1,
  );
};

export class DepthFusionReconstructor {
  constructor(config = {}) {
    this.minFrames = config.minFrames ?? 3;
    this.minSurfels = config.minSurfels ?? 90;
    this.minPoseLandmarks = config.minPoseLandmarks ?? 10;
    this.maxSurfels = config.maxSurfels ?? 1400;
    this.sampleStride = config.sampleStride ?? 5;
    this.voxelSize = config.voxelSize ?? 7;
    this.maxTemporalDepthJump = config.maxTemporalDepthJump ?? 38;
    this.cameraParams = null;
    this.surfelMap = new DepthFusionSurfelMap({
      maxSurfels: this.maxSurfels,
      sampleStride: this.sampleStride,
      voxelSize: this.voxelSize,
      maxTemporalDepthJump: this.maxTemporalDepthJump,
    });
    this.reset({
      anchorReference: { x: 0, y: 0 },
      templateRegion: { x: 0, y: 0, width: 1, height: 1 },
    });
  }

  configure({ cameraParams } = {}) {
    this.cameraParams = cameraParams ? { ...cameraParams } : null;
    this.pendingDepthSource = null;
  }

  dispose() {
    this.frames = [];
    this.surfelMap.reset();
    this.pendingPoseEvidence = null;
    this.pendingDepthSource = null;
  }

  reset({ anchorReference, templateRegion = { x: 0, y: 0, width: 1, height: 1 }, targetClass = null }) {
    this.anchorReference = { x: anchorReference.x, y: anchorReference.y };
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.surfaceModel = modelFromRegion(templateRegion, targetClass);
    this.frames = [];
    this.surfelMap.reset();
    this.consistency = [];
    this.state = 'mapping';
    this.lastFailureReason = 'Waiting for depth map';
    this.lastDepthStatus = 'idle';
    this.lastDepthProvider = null;
    this.lastDepthInferenceTime = 0;
    this.lastDepthTimestamp = 0;
    this.lastConsumedDepthTimestamp = null;
    this.pendingPoseEvidence = null;
    this.pendingDepthSource = null;
  }

  updateReferenceRegion(templateRegion, targetClass = this.targetClass) {
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.surfaceModel = modelFromRegion(templateRegion, targetClass);
    this.pendingPoseEvidence = null;
    this.pendingDepthSource = null;
  }

  get surfels() {
    return this.surfelMap.surfels;
  }

  addFrameFromTrackedPoints(trackedPoints, _timestamp, context = {}) {
    this.pendingPoseEvidence = null;
    const previousSource = this.pendingDepthSource;
    const requestedAt = context.depthRequestTimestamp ?? null;
    if (requestedAt !== null) {
      if (!Number.isFinite(requestedAt) || requestedAt < 0) {
        throw new TypeError('Depth source timestamp must be finite and non-negative');
      }
      this.pendingDepthSource = this._captureDepthSource(trackedPoints, requestedAt, context);
    }
    const stateOptions = { includePreview: context.includePreview !== false };
    const depthFrame = context.depthFrame;
    const depthStatus = context.depthState?.state || (depthFrame ? 'ready' : this.lastDepthStatus);
    this.lastDepthStatus = depthStatus;

    if (!depthFrame) {
      if (depthStatus === 'error') {
        this.pendingDepthSource = null;
      }
      this.lastFailureReason = context.depthState?.error || 'Waiting for depth map';
      return this.getState(stateOptions);
    }

    if (this.lastConsumedDepthTimestamp !== null && depthFrame.timestamp <= this.lastConsumedDepthTimestamp) {
      return this.getState(stateOptions);
    }
    const source = [previousSource, this.pendingDepthSource].find(
      (candidate) => candidate?.timestamp === depthFrame.timestamp,
    );
    if (!source) {
      this.lastFailureReason = 'Depth source frame is unavailable';
      return this.getState(stateOptions);
    }
    if (source === this.pendingDepthSource) {
      this.pendingDepthSource = null;
    }
    this.lastConsumedDepthTimestamp = depthFrame.timestamp;
    if (source.failureReason) {
      this.lastFailureReason = source.failureReason;
      return this.getState(stateOptions);
    }
    if (
      depthFrame.sourceWidth !== source.imageData.width ||
      depthFrame.sourceHeight !== source.imageData.height
    ) {
      this.lastFailureReason = 'Depth source raster mismatch';
      return this.getState(stateOptions);
    }
    const fused = this.surfelMap.fuse({
      depthFrame,
      fit: source.fit,
      objectSupportMask: source.objectSupportMask,
      imageData: source.imageData,
      timestamp: source.timestamp,
      templateRegion: source.templateRegion,
      cameraParams: source.cameraParams,
    });

    if (fused.accepted < this.minSurfels * 0.22) {
      this.lastFailureReason = `Depth frame rejected: ${fused.accepted} stable surfels`;
      return this.getState(stateOptions);
    }

    this.frames.push({
      timestamp: source.timestamp,
      accepted: fused.accepted,
      rejected: fused.rejected,
      consistency: fused.consistency,
    });
    this.consistency.push(fused.consistency);
    if (this.frames.length > 18) {
      this.frames = this.frames.slice(-18);
      this.consistency = this.consistency.slice(-18);
    }

    this.lastDepthProvider = depthFrame.provider || null;
    this.lastDepthInferenceTime = depthFrame.processingTime || 0;
    this.lastDepthTimestamp = depthFrame.timestamp;
    const stats = this._statistics();
    this.state = this.frames.length >= this.minFrames && stats.mapConfidence >= 0.5 ? 'ready' : 'mapping';
    this.lastFailureReason = this.state === 'ready' ? null : 'Collecting stable depth keyframes';
    return this._createState(stats, stateOptions);
  }

  _captureDepthSource(trackedPoints, timestamp, { objectSupportMask, imageData }) {
    let failureReason = !objectSupportMask
      ? 'Waiting for object support mask'
      : !imageData
        ? 'Waiting for RGB frame'
        : !this.cameraParams
          ? 'Waiting for camera intrinsics'
          : null;
    if (failureReason) {
      return { timestamp, failureReason };
    }

    const evidence = this._createPoseEvidence(trackedPoints);
    this.pendingPoseEvidence = evidence;
    if (evidence.observations.length < this.minPoseLandmarks) {
      failureReason = 'Insufficient landmarks for depth fusion pose';
    } else {
      const fit = this._completePoseEvidence(evidence);
      if (fit.success) {
        return {
          timestamp,
          fit: { ...fit.transform },
          imageData: copyImageData(imageData),
          objectSupportMask: {
            ...objectSupportMask,
            bbox: { ...objectSupportMask.bbox },
            data: new Uint8Array(objectSupportMask.data),
          },
          templateRegion: { ...this.templateRegion },
          cameraParams: { ...this.cameraParams },
        };
      }
      failureReason = fit.reason;
    }
    return { timestamp, failureReason };
  }

  estimatePoseFromTrackedPoints(trackedPoints, { includePreview = true } = {}) {
    // Mapping and pose are one synchronous service transaction; the next producer invalidates this loan.
    const poseEvidence =
      this.pendingPoseEvidence?.trackedPoints === trackedPoints
        ? this.pendingPoseEvidence
        : this._createPoseEvidence(trackedPoints);
    this.pendingPoseEvidence = null;
    const fit = this._completePoseEvidence(poseEvidence);
    const stats = this._statistics();

    if (!fit.success || this.state !== 'ready') {
      return {
        success: false,
        method: DEPTH_FUSION_POSE_MODEL,
        reason: fit.reason || this.lastFailureReason,
      };
    }

    const position = transformPoint2(this.anchorReference, fit.transform);
    const frameCount = this.frames.length;
    const points = includePreview
      ? this.surfelMap.previewPoints({ limit: this.maxSurfels, frameCount })
      : null;
    const { normal, depthQuality } = points
      ? calculateDepthGeometry(points)
      : this.surfelMap.measureGeometry();

    const result = {
      success: true,
      method: DEPTH_FUSION_POSE_MODEL,
      position: { x: position.x, y: position.y, z: 0 },
      normal,
      planarTransform: {
        scale: fit.transform.scale,
        rotation: normalizeAngle(fit.transform.rotation),
        confidence: Math.min(fit.confidence, stats.mapConfidence),
        inlierCount: fit.inlierCount,
        method: DEPTH_FUSION_POSE_MODEL,
      },
      confidence: Math.min(fit.confidence, stats.mapConfidence),
      inlierCount: fit.inlierCount,
      inlierRatio: fit.inlierRatio,
      averageResidual: fit.averageResidual,
      depthQuality,
      landmarkCount: this.surfelMap.size,
    };

    if (!includePreview) {
      return result;
    }

    return {
      ...result,
      preview: this._createPreview(
        {
          anchor: { ...this.anchorReference, z: median(points.map((point) => point.z)) },
          current: {
            anchor: position,
            normal,
            planarTransform: {
              scale: fit.transform.scale,
              rotation: normalizeAngle(fit.transform.rotation),
              confidence: fit.confidence,
              inlierCount: fit.inlierCount,
              method: DEPTH_FUSION_POSE_MODEL,
            },
          },
          points: points.slice(0, this.surfelMap.previewPointLimit),
        },
        stats,
      ),
    };
  }

  _createPoseEvidence(trackedPoints) {
    return {
      trackedPoints,
      observations: toActiveObservations(trackedPoints),
      fit: null,
      fitEvaluated: false,
    };
  }

  _fitPoseObservations(observations) {
    return fitRobustSimilarity(observations, {
      minInliers: this.minPoseLandmarks,
      threshold: 12,
    });
  }

  _completePoseEvidence(evidence) {
    if (!evidence.fitEvaluated) {
      evidence.fit = this._fitPoseObservations(evidence.observations);
      evidence.fitEvaluated = true;
    }
    return evidence.fit;
  }

  getState(options = {}) {
    return this._createState(this._statistics(), options);
  }

  _createState(stats, { includePreview = true } = {}) {
    const frameCount = this.frames.length;
    const state = {
      state: this.state,
      ready: this.state === 'ready',
      poseModel: DEPTH_FUSION_POSE_MODEL,
      frameCount,
      landmarkCount: this.surfelMap.size,
      depthQuality: depthQualityFromSurfels(this.surfelMap.surfels),
      statistics: stats,
      lastFailureReason: this.lastFailureReason,
      depthStatus: this.lastDepthStatus,
      depthProvider: this.lastDepthProvider,
      depthInferenceTime: this.lastDepthInferenceTime,
      depthFrameTimestamp: this.lastDepthTimestamp,
    };

    if (!includePreview) {
      return state;
    }

    const points = this.surfelMap.previewPoints({ limit: this.maxSurfels, frameCount });
    return {
      ...state,
      depthQuality: calculateDepthQuality(points),
      preview: this._createPreview(
        {
          points: points.slice(0, this.surfelMap.previewPointLimit),
        },
        stats,
      ),
    };
  }

  _statistics() {
    return this.surfelMap.statistics({
      frameCount: this.frames.length,
      minFrames: this.minFrames,
      minSurfels: this.minSurfels,
      consistency: this.consistency,
    });
  }

  _createPreview(
    { anchor = this.anchorReference, current = null, points = null } = {},
    statistics = this._statistics(),
  ) {
    return this.surfelMap.createPreview({
      poseModel: DEPTH_FUSION_POSE_MODEL,
      anchor,
      current,
      frameCount: this.frames.length,
      statistics,
      points,
    });
  }
}
