import { SparseObjectReconstructor } from './anchor.reconstruction.js';
import { ParametricSurfaceReconstructor } from './anchor.parametricSurface.js';
import { DirectPhotometricReconstructor } from './anchor.directPhotometric.js';
import {
  DEPTH_FUSION_POSE_MODEL,
  DIRECT_PHOTOMETRIC_POSE_MODEL,
  PARAMETRIC_SURFACE_POSE_MODEL,
  RECONSTRUCTION_POSE_MODEL,
} from './anchor.reconstructionModes.js';

export const createReconstructionEngine = async (mode) => {
  switch (mode) {
    case RECONSTRUCTION_POSE_MODEL:
      return new SparseObjectReconstructor();
    case PARAMETRIC_SURFACE_POSE_MODEL:
      return new ParametricSurfaceReconstructor();
    case DIRECT_PHOTOMETRIC_POSE_MODEL:
      return new DirectPhotometricReconstructor();
    case DEPTH_FUSION_POSE_MODEL: {
      const { DepthFusionReconstructor } = await import('./anchor.depthFusion.js');
      return new DepthFusionReconstructor();
    }
  }

  throw new Error(`Unsupported reconstruction mode: ${mode}`);
};
