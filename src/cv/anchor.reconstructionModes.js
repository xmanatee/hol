export const RECONSTRUCTION_POSE_MODEL = 'sparse-reconstruction';
export const PARAMETRIC_SURFACE_POSE_MODEL = 'parametric-surface';
export const DIRECT_PHOTOMETRIC_POSE_MODEL = 'direct-photometric';
export const DEPTH_FUSION_POSE_MODEL = 'depth-fusion';

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
  {
    id: DEPTH_FUSION_POSE_MODEL,
    label: 'Depth Fusion',
    description: 'Learned monocular depth fused into dense object surfels',
    requiresDepthFrame: true,
  },
];

export const RECONSTRUCTION_MODE_IDS = new Set(RECONSTRUCTION_MODES.map((mode) => mode.id));

export const isReconstructionMode = (mode) => RECONSTRUCTION_MODE_IDS.has(mode);
