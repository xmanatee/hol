import { clamp, normalizeAngle } from './anchor.reconstruction.math.js';
import { fitRobustSimilarity, toActiveObservations, transformPoint2 } from './anchor.reconstructionRobust.js';
import { modelFromRegion } from './anchor.parametricGeometry.js';
import { calculateDepthGeometry, calculateDepthQuality, median } from './anchor.depthFusion.geometry.js';
import { DepthFusionSurfelMap } from './anchor.depthFusion.surfels.js';
import { DEPTH_FUSION_POSE_MODEL } from './anchor.reconstructionModes.js';

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
  }

  dispose() {
    this.frames = [];
    this.surfelMap.reset();
    this.pendingPoseEvidence = null;
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
  }

  updateReferenceRegion(templateRegion, targetClass = this.targetClass) {
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.surfaceModel = modelFromRegion(templateRegion, targetClass);
    this.pendingPoseEvidence = null;
  }

  get surfels() {
    return this.surfelMap.surfels;
  }

  addFrameFromTrackedPoints(trackedPoints, timestamp = performance.now(), context = {}) {
    this.pendingPoseEvidence = null;
    const stateOptions = { includePreview: context.includePreview !== false };
    const depthFrame = context.depthFrame;
    const depthStatus = context.depthState?.state || (depthFrame ? 'ready' : this.lastDepthStatus);
    this.lastDepthStatus = depthStatus;

    if (!depthFrame) {
      this.lastFailureReason = context.depthState?.error || 'Waiting for depth map';
      return this.getState(stateOptions);
    }

    if (!context.objectSupportMask) {
      this.lastFailureReason = 'Waiting for object support mask';
      return this.getState(stateOptions);
    }

    if (!context.imageData) {
      this.lastFailureReason = 'Waiting for RGB frame';
      return this.getState(stateOptions);
    }

    if (!this.cameraParams) {
      this.lastFailureReason = 'Waiting for camera intrinsics';
      return this.getState(stateOptions);
    }

    if (this.lastConsumedDepthTimestamp !== null && depthFrame.timestamp <= this.lastConsumedDepthTimestamp) {
      return this.getState(stateOptions);
    }

    const poseEvidence = this._createPoseEvidence(trackedPoints);
    this.pendingPoseEvidence = poseEvidence;
    if (poseEvidence.observations.length < this.minPoseLandmarks) {
      this.lastFailureReason = 'Insufficient landmarks for depth fusion pose';
      return this.getState(stateOptions);
    }

    const fit = this._completePoseEvidence(poseEvidence);
    if (!fit.success) {
      this.lastFailureReason = fit.reason;
      return this.getState(stateOptions);
    }

    this.lastConsumedDepthTimestamp = depthFrame.timestamp;

    const fused = this.surfelMap.fuse({
      depthFrame,
      fit: fit.transform,
      objectSupportMask: context.objectSupportMask,
      imageData: context.imageData,
      timestamp,
      templateRegion: this.templateRegion,
      cameraParams: this.cameraParams,
    });

    if (fused.accepted < this.minSurfels * 0.22) {
      this.lastFailureReason = `Depth frame rejected: ${fused.accepted} stable surfels`;
      return this.getState(stateOptions);
    }

    this.frames.push({
      timestamp,
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
    this.lastDepthTimestamp = depthFrame.timestamp || timestamp;
    const stats = this._statistics();
    this.state = this.frames.length >= this.minFrames && stats.mapConfidence >= 0.5 ? 'ready' : 'mapping';
    this.lastFailureReason = this.state === 'ready' ? null : 'Collecting stable depth keyframes';
    return this._createState(stats, stateOptions);
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
