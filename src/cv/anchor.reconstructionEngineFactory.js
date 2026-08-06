import { SparseObjectReconstructor } from './anchor.reconstruction.js';
import { ParametricSurfaceReconstructor } from './anchor.parametricSurface.js';
import { DirectPhotometricReconstructor } from './anchor.directPhotometric.js';
import { modelFromRegion } from './anchor.parametricGeometry.js';
import {
  DEPTH_FUSION_POSE_MODEL,
  DIRECT_PHOTOMETRIC_POSE_MODEL,
  PARAMETRIC_SURFACE_POSE_MODEL,
  RECONSTRUCTION_POSE_MODEL,
} from './anchor.reconstructionModes.js';

class LazyDepthFusionReconstructor {
  constructor(config = {}) {
    this.config = config;
    this.impl = null;
    this.cameraParams = null;
    this.anchorReference = { x: 0, y: 0 };
    this.templateRegion = { x: 0, y: 0, width: 1, height: 1 };
    this.targetClass = null;
    this.surfaceModel = modelFromRegion(this.templateRegion, this.targetClass);
    this.frames = [];
    this.state = 'mapping';
    this.lastFailureReason = 'Loading depth fusion reconstructor';
    this.ready = import('./anchor.depthFusion.js').then(({ DepthFusionReconstructor }) => {
      this.impl = new DepthFusionReconstructor(this.config);
      if (this.state === 'inactive') {
        this.impl.dispose();
        this.impl = null;
        return null;
      }
      if (this.cameraParams) {
        this.impl.configure({ cameraParams: this.cameraParams });
      }
      this.impl.reset({
        anchorReference: this.anchorReference,
        templateRegion: this.templateRegion,
        targetClass: this.targetClass,
      });
      return this.impl;
    });
  }

  configure({ cameraParams } = {}) {
    this.cameraParams = cameraParams ? { ...cameraParams } : null;
    this.impl?.configure({ cameraParams: this.cameraParams });
  }

  dispose() {
    if (this.impl) {
      this.impl.dispose();
      this.impl = null;
    }
    this.state = 'inactive';
  }

  reset({ anchorReference, templateRegion = this.templateRegion, targetClass = null }) {
    this.anchorReference = { x: anchorReference.x, y: anchorReference.y };
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.surfaceModel = modelFromRegion(this.templateRegion, this.targetClass);
    this.frames = [];
    this.state = 'mapping';
    this.lastFailureReason = 'Loading depth fusion reconstructor';
    this.impl?.reset({
      anchorReference: this.anchorReference,
      templateRegion: this.templateRegion,
      targetClass: this.targetClass,
    });
  }

  updateReferenceRegion(templateRegion, targetClass = this.targetClass) {
    this.templateRegion = { ...templateRegion };
    this.targetClass = targetClass;
    this.surfaceModel = modelFromRegion(this.templateRegion, this.targetClass);
    this.impl?.updateReferenceRegion(this.templateRegion, this.targetClass);
  }

  addFrameFromTrackedPoints(trackedPoints, timestamp, context) {
    return this.impl
      ? this.impl.addFrameFromTrackedPoints(trackedPoints, timestamp, context)
      : this.getState(context);
  }

  estimatePoseFromTrackedPoints(trackedPoints, options) {
    if (this.impl) {
      return this.impl.estimatePoseFromTrackedPoints(trackedPoints, options);
    }

    return {
      success: false,
      method: DEPTH_FUSION_POSE_MODEL,
      reason: this.lastFailureReason,
    };
  }

  getState() {
    if (this.impl) {
      return this.impl.getState(...arguments);
    }

    return {
      state: this.state,
      ready: false,
      poseModel: DEPTH_FUSION_POSE_MODEL,
      frameCount: this.frames.length,
      landmarkCount: 0,
      depthQuality: 0,
      statistics: {
        mapConfidence: 0,
        observationCount: 0,
      },
      lastFailureReason: this.lastFailureReason,
      depthStatus: 'loading',
      depthProvider: null,
      depthInferenceTime: 0,
      depthFrameTimestamp: 0,
      preview: {
        points: [],
        edges: [],
        surface: {
          model: this.surfaceModel,
          faces: [],
        },
      },
    };
  }
}

export const createReconstructionEngine = (mode) => {
  switch (mode) {
    case RECONSTRUCTION_POSE_MODEL:
      return new SparseObjectReconstructor();
    case PARAMETRIC_SURFACE_POSE_MODEL:
      return new ParametricSurfaceReconstructor();
    case DIRECT_PHOTOMETRIC_POSE_MODEL:
      return new DirectPhotometricReconstructor();
    case DEPTH_FUSION_POSE_MODEL:
      return new LazyDepthFusionReconstructor();
  }

  throw new Error(`Unsupported reconstruction mode: ${mode}`);
};
