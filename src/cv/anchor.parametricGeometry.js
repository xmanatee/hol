import { clamp } from './anchor.reconstruction.math.js';

export const SURFACE_MODEL_PLANE = 'plane';
export const SURFACE_MODEL_CYLINDER = 'cylinder';
export const SURFACE_MODEL_TAPERED_CYLINDER = 'tapered-cylinder';
export const SURFACE_MODEL_ELLIPSOID = 'ellipsoid';

export const modelFromRegion = (region = { width: 1, height: 1 }, targetClass = null) => {
  const label = String(targetClass || '').toLowerCase();
  if (/book|laptop|keyboard|cell phone|tablet|tv|screen|sign|box/.test(label)) return SURFACE_MODEL_PLANE;
  if (/cup|mug|vase/.test(label)) return SURFACE_MODEL_TAPERED_CYLINDER;
  if (/ball|sphere|round/.test(label)) return SURFACE_MODEL_ELLIPSOID;
  if (/can|bottle|jar|container/.test(label)) return SURFACE_MODEL_CYLINDER;

  const aspect = region.width / Math.max(region.height, 1);
  if (aspect <= 0.62) return SURFACE_MODEL_CYLINDER;
  if (aspect <= 0.78) return SURFACE_MODEL_TAPERED_CYLINDER;
  return SURFACE_MODEL_PLANE;
};

const cylinderPoint = (reference, bounds, model) => {
  const width = Math.max(1, bounds.max.x - bounds.min.x);
  const height = Math.max(1, bounds.max.y - bounds.min.y);
  const u = clamp((reference.x - bounds.min.x) / width, 0, 1);
  const v = clamp((reference.y - bounds.min.y) / height, 0, 1);
  const angle = (u - 0.5) * Math.PI * 0.92;
  const baseRadius = width * 0.34;
  const radius = model === SURFACE_MODEL_TAPERED_CYLINDER
    ? baseRadius * (0.86 + v * 0.28)
    : baseRadius;

  return {
    x: Math.sin(angle) * radius,
    y: (v - 0.5) * height,
    z: Math.cos(angle) * radius - radius,
  };
};

const ellipsoidCoordinates = (reference, bounds) => {
  const width = Math.max(1, bounds.max.x - bounds.min.x);
  const height = Math.max(1, bounds.max.y - bounds.min.y);
  const radiusX = width * 0.5;
  const radiusY = height * 0.5;
  const radiusZ = Math.min(width, height) * 0.44;
  const centerX = (bounds.min.x + bounds.max.x) * 0.5;
  const centerY = (bounds.min.y + bounds.max.y) * 0.5;
  const rawX = clamp((reference.x - centerX) / radiusX, -0.98, 0.98);
  const rawY = clamp((reference.y - centerY) / radiusY, -0.98, 0.98);
  const radial = Math.hypot(rawX, rawY);
  const scale = radial > 0.98 ? 0.98 / radial : 1;
  const nx = rawX * scale;
  const ny = rawY * scale;
  const nz = Math.sqrt(Math.max(0.0001, 1 - nx * nx - ny * ny));

  return {
    nx,
    ny,
    nz,
    radiusX,
    radiusY,
    radiusZ,
  };
};

const ellipsoidPoint = (reference, bounds) => {
  const { nx, ny, nz, radiusX, radiusY, radiusZ } = ellipsoidCoordinates(reference, bounds);
  return {
    x: nx * radiusX,
    y: ny * radiusY,
    z: nz * radiusZ - radiusZ,
  };
};

export const pointForSurfaceModel = (reference, bounds, model) => {
  if (model === SURFACE_MODEL_PLANE) {
    return {
      x: reference.x - (bounds.min.x + bounds.max.x) / 2,
      y: reference.y - (bounds.min.y + bounds.max.y) / 2,
      z: 0,
    };
  }

  if (model === SURFACE_MODEL_ELLIPSOID) {
    return ellipsoidPoint(reference, bounds);
  }

  return cylinderPoint(reference, bounds, model);
};

export const normalForSurfaceModel = (reference, bounds, model) => {
  if (model === SURFACE_MODEL_PLANE) {
    return { x: 0, y: 0, z: 1 };
  }

  if (model === SURFACE_MODEL_ELLIPSOID) {
    const { nx, ny, nz, radiusX, radiusY, radiusZ } = ellipsoidCoordinates(reference, bounds);
    const normal = {
      x: nx / radiusX,
      y: ny / radiusY,
      z: nz / radiusZ,
    };
    const length = Math.max(Math.hypot(normal.x, normal.y, normal.z), 1e-9);
    return {
      x: normal.x / length,
      y: normal.y / length,
      z: normal.z / length,
    };
  }

  const width = Math.max(1, bounds.max.x - bounds.min.x);
  const u = clamp((reference.x - bounds.min.x) / width, 0, 1);
  const angle = (u - 0.5) * Math.PI * 0.92;

  return {
    x: Math.sin(angle),
    y: 0,
    z: Math.cos(angle),
  };
};

export const depthQualityForSurfaceModel = model => {
  if (model === SURFACE_MODEL_PLANE) return 0.02;
  if (model === SURFACE_MODEL_ELLIPSOID) return 0.32;
  if (model === SURFACE_MODEL_TAPERED_CYLINDER) return 0.22;
  return 0.18;
};

export const surfaceMeshForModel = (bounds, model) => {
  const columns = model === SURFACE_MODEL_PLANE ? 4 : model === SURFACE_MODEL_ELLIPSOID ? 11 : 9;
  const rows = model === SURFACE_MODEL_ELLIPSOID ? 11 : 7;
  const points = [];
  const edges = [];
  const faces = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const id = row * columns + column;
      const reference = {
        x: bounds.min.x + (bounds.max.x - bounds.min.x) * column / (columns - 1),
        y: bounds.min.y + (bounds.max.y - bounds.min.y) * row / (rows - 1),
      };
      points.push({
        id,
        ...pointForSurfaceModel(reference, bounds, model),
        reliability: 0.72,
      });
      if (column > 0) edges.push({ from: id - 1, to: id, reliability: 0.72 });
      if (row > 0) edges.push({ from: id - columns, to: id, reliability: 0.72 });
      if (column > 0 && row > 0) {
        const topLeft = id - columns - 1;
        const topRight = id - columns;
        const bottomLeft = id - 1;
        faces.push({ points: [topLeft, topRight, id], reliability: 0.72 });
        faces.push({ points: [topLeft, id, bottomLeft], reliability: 0.72 });
      }
    }
  }

  return { points, edges, faces };
};
