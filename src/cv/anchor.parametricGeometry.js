import { clamp } from './anchor.reconstruction.math.js';

export const SURFACE_MODEL_PLANE = 'plane';
export const SURFACE_MODEL_CYLINDER = 'cylinder';
export const SURFACE_MODEL_TAPERED_CYLINDER = 'tapered-cylinder';
export const SURFACE_MODEL_ELLIPSOID = 'ellipsoid';
export const SURFACE_MODEL_BOX = 'box';

export const modelFromRegion = (region = { width: 1, height: 1 }, targetClass = null) => {
  const label = String(targetClass || '').toLowerCase();
  if (/shelf|shelves|bookcase|cabinet|drawer|rack|wardrobe|closet|box|package|crate/.test(label)) {
    return SURFACE_MODEL_BOX;
  }
  if (/face|head|portrait|mask/.test(label)) return SURFACE_MODEL_ELLIPSOID;
  if (/book|notebook|paper|document|poster|photo|picture|painting|card|ticket|label|badge|laptop|keyboard|cell phone|smartphone|phone|tablet|tv|screen|sign|whiteboard/.test(label)) {
    return SURFACE_MODEL_PLANE;
  }
  if (/cup|mug|vase/.test(label)) return SURFACE_MODEL_TAPERED_CYLINDER;
  if (/ball|sphere|round/.test(label)) return SURFACE_MODEL_ELLIPSOID;
  if (/can|bottle|jar|container/.test(label)) return SURFACE_MODEL_CYLINDER;

  const aspect = region.width / Math.max(region.height, 1);
  if (aspect <= 0.62) return SURFACE_MODEL_CYLINDER;
  if (aspect <= 0.78) return SURFACE_MODEL_TAPERED_CYLINDER;
  return SURFACE_MODEL_PLANE;
};

const boxCoordinates = (reference, bounds) => {
  const width = Math.max(1, bounds.max.x - bounds.min.x);
  const height = Math.max(1, bounds.max.y - bounds.min.y);
  const centerX = (bounds.min.x + bounds.max.x) * 0.5;
  const centerY = (bounds.min.y + bounds.max.y) * 0.5;
  const u = clamp((reference.x - bounds.min.x) / width, 0, 1);
  const v = clamp((reference.y - bounds.min.y) / height, 0, 1);
  const depth = Math.min(width, height) * 0.24;
  const bevel = 0.16;
  const left = clamp((bevel - u) / bevel, 0, 1);
  const right = clamp((u - (1 - bevel)) / bevel, 0, 1);
  const top = clamp((bevel - v) / bevel, 0, 1);
  const bottom = clamp((v - (1 - bevel)) / bevel, 0, 1);
  const side = Math.max(left, right);
  const cap = Math.max(top, bottom) * (1 - side * 0.35);

  return {
    x: (reference.x - centerX) * (1 - side * 0.22),
    y: (reference.y - centerY) * (1 - cap * 0.16),
    z: -depth * Math.max(side, cap * 0.72),
    sideSign: right > left ? 1 : left > right ? -1 : 0,
    capSign: bottom > top ? 1 : top > bottom ? -1 : 0,
    side,
    cap,
  };
};

const boxPoint = (reference, bounds) => {
  const coordinates = boxCoordinates(reference, bounds);
  return {
    x: coordinates.x,
    y: coordinates.y,
    z: coordinates.z,
  };
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

  if (model === SURFACE_MODEL_BOX) {
    return boxPoint(reference, bounds);
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

  if (model === SURFACE_MODEL_BOX) {
    const { sideSign, capSign, side, cap } = boxCoordinates(reference, bounds);
    const rawNormal = {
      x: sideSign * side * 0.74,
      y: capSign * cap * 0.48,
      z: 1,
    };
    const length = Math.max(Math.hypot(rawNormal.x, rawNormal.y, rawNormal.z), 1e-9);
    return {
      x: rawNormal.x / length,
      y: rawNormal.y / length,
      z: rawNormal.z / length,
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
  if (model === SURFACE_MODEL_BOX) return 0.14;
  if (model === SURFACE_MODEL_TAPERED_CYLINDER) return 0.22;
  return 0.18;
};

export const surfaceMeshForModel = (bounds, model) => {
  const columns = model === SURFACE_MODEL_PLANE ? 4 : model === SURFACE_MODEL_ELLIPSOID ? 11 : 9;
  const rows = model === SURFACE_MODEL_ELLIPSOID ? 11 : model === SURFACE_MODEL_BOX ? 9 : 7;
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
