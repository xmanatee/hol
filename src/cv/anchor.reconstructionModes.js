import { SparseObjectReconstructor, RECONSTRUCTION_POSE_MODEL } from './anchor.reconstruction.js';
import {
  ParametricSurfaceReconstructor,
  PARAMETRIC_SURFACE_POSE_MODEL,
} from './anchor.parametricSurface.js';
import {
  DirectPhotometricReconstructor,
  DIRECT_PHOTOMETRIC_POSE_MODEL,
} from './anchor.directPhotometric.js';

export {
  RECONSTRUCTION_POSE_MODEL,
  PARAMETRIC_SURFACE_POSE_MODEL,
  DIRECT_PHOTOMETRIC_POSE_MODEL,
};

export const RECONSTRUCTION_MODES = [
  {
    id: RECONSTRUCTION_POSE_MODEL,
    label: 'Sparse SfM',
    description: 'Descriptor/landmark-style sparse structure map',
  },
  {
    id: PARAMETRIC_SURFACE_POSE_MODEL,
    label: 'Surface Fit',
    description: 'Plane/cylinder/cup constrained surface model',
  },
  {
    id: DIRECT_PHOTOMETRIC_POSE_MODEL,
    label: 'Photometric',
    description: 'Gradient surfel map with photometric consistency',
  },
];

export const RECONSTRUCTION_MODE_IDS = new Set(RECONSTRUCTION_MODES.map(mode => mode.id));

export const createReconstructionEngine = mode => {
  switch (mode) {
    case RECONSTRUCTION_POSE_MODEL:
      return new SparseObjectReconstructor();
    case PARAMETRIC_SURFACE_POSE_MODEL:
      return new ParametricSurfaceReconstructor();
    case DIRECT_PHOTOMETRIC_POSE_MODEL:
      return new DirectPhotometricReconstructor();
  }

  throw new Error(`Unsupported reconstruction mode: ${mode}`);
};

export const isReconstructionMode = mode => RECONSTRUCTION_MODE_IDS.has(mode);
