const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;
const DEFAULT_CAMERA = {
  fx: 690,
  fy: 690,
  cx: DEFAULT_WIDTH / 2,
  cy: DEFAULT_HEIGHT / 2,
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const normalizeAngle = value => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

const noise = (x, y, seed = 1) => {
  const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return value - Math.floor(value);
};

const createImageData = (width, height) => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
});

const setPixel = (imageData, x, y, color) => {
  if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) return;
  const index = (y * imageData.width + x) * 4;
  imageData.data[index] = color[0];
  imageData.data[index + 1] = color[1];
  imageData.data[index + 2] = color[2];
  imageData.data[index + 3] = color[3] ?? 255;
};

const blendPixel = (imageData, x, y, color, alpha) => {
  if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) return;
  const index = (y * imageData.width + x) * 4;
  const inverse = 1 - alpha;
  imageData.data[index] = imageData.data[index] * inverse + color[0] * alpha;
  imageData.data[index + 1] = imageData.data[index + 1] * inverse + color[1] * alpha;
  imageData.data[index + 2] = imageData.data[index + 2] * inverse + color[2] * alpha;
  imageData.data[index + 3] = 255;
};

const fillBackground = (imageData, frameIndex, seed) => {
  for (let y = 0; y < imageData.height; y++) {
    for (let x = 0; x < imageData.width; x++) {
      const vignette = Math.hypot(x / imageData.width - 0.5, y / imageData.height - 0.5);
      const grain = noise(x * 0.09, y * 0.09, seed + frameIndex * 0.17) - 0.5;
      const deskLine = y > imageData.height * 0.62 ? 18 : 0;
      const stripe = (Math.floor((x + y * 0.35) / 46) % 2) * 5;
      const base = 116 - vignette * 56 + grain * 18 + deskLine + stripe;
      setPixel(imageData, x, y, [
        clamp(base + 18, 20, 210),
        clamp(base + 12, 20, 210),
        clamp(base + 4, 20, 210),
        255,
      ]);
    }
  }
};

const rotate3 = (point, pose) => {
  const yaw = pose.yaw || 0;
  const pitch = pose.pitch || 0;
  const roll = pose.roll || 0;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);

  const rollPoint = {
    x: cr * point.x - sr * point.y,
    y: sr * point.x + cr * point.y,
    z: point.z,
  };
  const pitchPoint = {
    x: rollPoint.x,
    y: cp * rollPoint.y - sp * rollPoint.z,
    z: sp * rollPoint.y + cp * rollPoint.z,
  };
  return {
    x: cy * pitchPoint.x + sy * pitchPoint.z,
    y: pitchPoint.y,
    z: -sy * pitchPoint.x + cy * pitchPoint.z,
  };
};

const project3 = (point, pose, camera) => {
  const rotated = rotate3(point, pose);
  const x = rotated.x + (pose.tx || 0);
  const y = rotated.y + (pose.ty || 0);
  const z = rotated.z + pose.distance;
  return {
    x: camera.cx + camera.fx * x / z,
    y: camera.cy + camera.fy * y / z,
    z,
  };
};

const projectNormal = pose => {
  const normal = rotate3({ x: 0, y: 0, z: 1 }, pose);
  const length = Math.hypot(normal.x, normal.y, normal.z);
  const result = {
    x: normal.x / length,
    y: normal.y / length,
    z: normal.z / length,
  };
  return result.z >= 0 ? result : { x: -result.x, y: -result.y, z: -result.z };
};

const bboxFor = points => {
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 18;

  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
    x1: minX - pad,
    y1: minY - pad,
    x2: maxX + pad,
    y2: maxY + pad,
  };
};

const barycentric = (point, a, b, c) => {
  const v0 = { x: b.x - a.x, y: b.y - a.y };
  const v1 = { x: c.x - a.x, y: c.y - a.y };
  const v2 = { x: point.x - a.x, y: point.y - a.y };
  const denominator = v0.x * v1.y - v1.x * v0.y;
  if (Math.abs(denominator) < 1e-7) return null;

  const u = (v2.x * v1.y - v1.x * v2.y) / denominator;
  const v = (v0.x * v2.y - v2.x * v0.y) / denominator;
  return {
    u,
    v,
    w: 1 - u - v,
  };
};

const drawTriangle = (imageData, triangle, uvTriangle, texture, shade = 1) => {
  const minX = Math.max(0, Math.floor(Math.min(...triangle.map(point => point.x))));
  const maxX = Math.min(imageData.width - 1, Math.ceil(Math.max(...triangle.map(point => point.x))));
  const minY = Math.max(0, Math.floor(Math.min(...triangle.map(point => point.y))));
  const maxY = Math.min(imageData.height - 1, Math.ceil(Math.max(...triangle.map(point => point.y))));
  const [a, b, c] = triangle;
  const [ua, ub, uc] = uvTriangle;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const weights = barycentric({ x: x + 0.5, y: y + 0.5 }, a, b, c);
      if (!weights || weights.u < -0.001 || weights.v < -0.001 || weights.w < -0.001) continue;

      const u = ua.u * weights.w + ub.u * weights.u + uc.u * weights.v;
      const v = ua.v * weights.w + ub.v * weights.u + uc.v * weights.v;
      const color = texture(u, v).map((channel, index) => index < 3 ? clamp(channel * shade, 0, 255) : channel);
      setPixel(imageData, x, y, color);
    }
  }
};

const drawQuad = (imageData, points, texture, shade = 1) => {
  const uvs = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 },
  ];
  drawTriangle(imageData, [points[0], points[1], points[2]], [uvs[0], uvs[1], uvs[2]], texture, shade);
  drawTriangle(imageData, [points[0], points[2], points[3]], [uvs[0], uvs[2], uvs[3]], texture, shade);
};

const drawShadow = (imageData, points, frameIndex) => {
  const shifted = points.map(point => ({
    x: point.x + 16 + frameIndex * 0.2,
    y: point.y + 20,
  }));
  const texture = () => [0, 0, 0, 255];
  const minX = Math.max(0, Math.floor(Math.min(...shifted.map(point => point.x))));
  const maxX = Math.min(imageData.width - 1, Math.ceil(Math.max(...shifted.map(point => point.x))));
  const minY = Math.max(0, Math.floor(Math.min(...shifted.map(point => point.y))));
  const maxY = Math.min(imageData.height - 1, Math.ceil(Math.max(...shifted.map(point => point.y))));
  const mask = createImageData(imageData.width, imageData.height);
  drawQuad(mask, shifted, texture, 1);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const alpha = mask.data[(y * mask.width + x) * 4 + 3] > 0 ? 0.22 : 0;
      if (alpha) blendPixel(imageData, x, y, [0, 0, 0], alpha);
    }
  }
};

const drawOcclusion = (imageData, bbox, frameIndex, variant) => {
  const width = Math.max(22, bbox.width * 0.18);
  const centerX = bbox.x + bbox.width * (0.45 + Math.sin(frameIndex * 0.7) * 0.18);
  const startY = bbox.y + bbox.height * 0.08;
  const endY = bbox.y + bbox.height * 0.92;
  const color = variant === 'dark-book' ? [24, 22, 22] : [42, 39, 35];

  for (let y = Math.floor(startY); y <= Math.ceil(endY); y++) {
    const drift = (y - startY) * 0.18;
    for (let x = Math.floor(centerX - width / 2 + drift); x <= Math.ceil(centerX + width / 2 + drift); x++) {
      blendPixel(imageData, x, y, color, 0.78);
    }
  }
};

const bookTexture = variant => (u, v) => {
  const fineGrid = ((Math.floor(u * 34) + Math.floor(v * 48)) % 2) * 42;
  const printNoise = (noise(u * 90, v * 120, variant === 'dark-book' ? 11 : 5) - 0.5) * 34;
  const spine = u < 0.13;
  const darkBlock = u > 0.58 && u < 0.94 && v > 0.66 && v < 0.86;
  const lightTitle = u > 0.19 && u < 0.88 && v > 0.16 && v < 0.27;
  const barcode = u > 0.7 && u < 0.92 && v > 0.08 && v < 0.15 && Math.floor(u * 160) % 3 === 0;
  const diagonal = Math.abs((u - 0.5) + (v - 0.5) * 0.55) < 0.035;
  const base = variant === 'dark-book'
    ? [38 + fineGrid * 0.15, 42 + fineGrid * 0.08, 54 + fineGrid * 0.22]
    : [34 + fineGrid * 0.15, 90 + fineGrid * 0.22, 138 + fineGrid * 0.18];

  if (spine) return [18 + printNoise, 22 + printNoise * 0.5, 32 + printNoise * 0.5, 255];
  if (darkBlock) return [18 + printNoise * 0.2, 20 + printNoise * 0.2, 26 + printNoise * 0.2, 255];
  if (lightTitle) return [226 + printNoise * 0.2, 230 + printNoise * 0.2, 218 + printNoise * 0.2, 255];
  if (barcode) return [240, 238, 224, 255];
  if (diagonal) return [220, 196, 68, 255];

  const letter = (
    (u > 0.22 && u < 0.28 && v > 0.34 && v < 0.57) ||
    (u > 0.34 && u < 0.4 && v > 0.34 && v < 0.57) ||
    (u > 0.46 && u < 0.66 && v > 0.39 && v < 0.45) ||
    (u > 0.46 && u < 0.66 && v > 0.52 && v < 0.58)
  );
  if (letter) return variant === 'dark-book' ? [206, 218, 238, 255] : [236, 246, 252, 255];

  return [
    clamp(base[0] + printNoise, 0, 255),
    clamp(base[1] + printNoise, 0, 255),
    clamp(base[2] + printNoise, 0, 255),
    255,
  ];
};

const canTexture = (u, v) => {
  const stripe = Math.abs(u - 0.5) < 0.06 || Math.abs(u - 0.22) < 0.035;
  const textBand = v > 0.28 && v < 0.65 && (
    (u > 0.28 && u < 0.35) ||
    (u > 0.41 && u < 0.48) ||
    (u > 0.54 && u < 0.61) ||
    (u > 0.67 && u < 0.74)
  );
  const nutritionPanel = u > 0.48 && u < 0.78 && v > 0.34 && v < 0.78;
  const panelBorder = nutritionPanel && (
    Math.abs(u - 0.48) < 0.008 ||
    Math.abs(u - 0.78) < 0.008 ||
    Math.abs(v - 0.34) < 0.008 ||
    Math.abs(v - 0.78) < 0.008
  );
  const panelRows = nutritionPanel && Math.floor(v * 82) % 7 === 0;
  const panelColumns = nutritionPanel && Math.floor(u * 96) % 11 === 0;
  const smallPrint = nutritionPanel &&
    ((Math.floor(u * 150) + Math.floor(v * 120)) % 9 < 2) &&
    Math.floor(v * 55) % 3 === 0;
  const logoCurve = v > 0.38 && v < 0.62 && Math.abs(Math.sin((u - 0.14) * Math.PI * 5.8) * 0.08 + 0.5 - v) < 0.018;
  const logoShadow = v > 0.36 && v < 0.64 && Math.abs(Math.sin((u - 0.12) * Math.PI * 5.8) * 0.08 + 0.53 - v) < 0.012;
  const frontDots = u > 0.38 && u < 0.68 && v > 0.2 && v < 0.82 &&
    Math.floor(u * 70) % 8 === 0 &&
    Math.floor(v * 76) % 8 === 0;
  const ridges = Math.floor(v * 70) % 12 === 0;
  const speckle = (noise(u * 110, v * 95, 19) - 0.5) * 28;

  if (panelBorder || panelRows || panelColumns) return [26 + speckle * 0.1, 24, 22, 255];
  if (smallPrint) return [36 + speckle * 0.1, 34, 32, 255];
  if (logoShadow) return [92, 12, 16, 255];
  if (logoCurve || frontDots) return [252 + speckle * 0.1, 246 + speckle * 0.1, 230 + speckle * 0.1, 255];
  if (textBand || stripe) return [244 + speckle * 0.2, 238 + speckle * 0.2, 224 + speckle * 0.2, 255];
  if (ridges) return [126 + speckle, 20, 24, 255];
  return [166 + speckle, 28 + speckle * 0.15, 36 + speckle * 0.12, 255];
};

const boxTexture = face => (u, v) => {
  const grid = ((Math.floor(u * 16) + Math.floor(v * 19)) % 2) * 36;
  const label = u > 0.18 && u < 0.82 && v > 0.22 && v < 0.42;
  const darkCorner = u > 0.68 && v > 0.66;
  const n = (noise(u * 70, v * 85, face * 13) - 0.5) * 30;

  if (label) return [226 + n * 0.2, 220 + n * 0.2, 190 + n * 0.2, 255];
  if (darkCorner) return [34 + n * 0.2, 30 + n * 0.2, 24 + n * 0.2, 255];
  return [132 + grid + n, 86 + grid * 0.42 + n, 52 + grid * 0.22 + n, 255];
};

const createPlaneGroundTruth = ({ pose, camera, objectWidth, objectHeight, anchorUv, reference = null }) => {
  const modelPoint = uv => ({
    x: (uv.u - 0.5) * objectWidth,
    y: (uv.v - 0.5) * objectHeight,
    z: 0,
  });
  const anchor = project3(modelPoint(anchorUv), pose, camera);
  const basis = 42;
  const basisX = project3({
    ...modelPoint(anchorUv),
    x: modelPoint(anchorUv).x + basis,
  }, pose, camera);
  const basisY = project3({
    ...modelPoint(anchorUv),
    y: modelPoint(anchorUv).y + basis,
  }, pose, camera);
  const vectorX = { x: basisX.x - anchor.x, y: basisX.y - anchor.y };
  const vectorY = { x: basisY.x - anchor.x, y: basisY.y - anchor.y };
  const rawScale = Math.sqrt(Math.max(1e-9, Math.hypot(vectorX.x, vectorX.y) * Math.hypot(vectorY.x, vectorY.y))) / basis;
  const rawRoll = Math.atan2(vectorX.y, vectorX.x);
  const referenceScale = reference?.rawScale ?? rawScale;
  const referenceRoll = reference?.rawRoll ?? rawRoll;

  return {
    anchor: { x: anchor.x, y: anchor.y },
    normal: projectNormal(pose),
    rawScale,
    rawRoll,
    scale: rawScale / referenceScale,
    roll: normalizeAngle(rawRoll - referenceRoll),
  };
};

const createLocalSurfaceGroundTruth = ({ pose, camera, anchorPoint, basisXPoint, basisYPoint, reference = null }) => {
  const anchor = project3(anchorPoint, pose, camera);
  const basisX = project3(basisXPoint, pose, camera);
  const basisY = project3(basisYPoint, pose, camera);
  const modelBasisX = Math.hypot(
    basisXPoint.x - anchorPoint.x,
    basisXPoint.y - anchorPoint.y,
    basisXPoint.z - anchorPoint.z
  );
  const modelBasisY = Math.hypot(
    basisYPoint.x - anchorPoint.x,
    basisYPoint.y - anchorPoint.y,
    basisYPoint.z - anchorPoint.z
  );
  const vectorX = { x: basisX.x - anchor.x, y: basisX.y - anchor.y };
  const vectorY = { x: basisY.x - anchor.x, y: basisY.y - anchor.y };
  const rawScale = Math.sqrt(Math.max(1e-9, (
    Math.hypot(vectorX.x, vectorX.y) / modelBasisX
  ) * (
    Math.hypot(vectorY.x, vectorY.y) / modelBasisY
  )));
  const rawRoll = Math.atan2(vectorX.y, vectorX.x);
  const referenceScale = reference?.rawScale ?? rawScale;
  const referenceRoll = reference?.rawRoll ?? rawRoll;

  return {
    anchor: { x: anchor.x, y: anchor.y },
    normal: projectNormal(pose),
    rawScale,
    rawRoll,
    scale: rawScale / referenceScale,
    roll: normalizeAngle(rawRoll - referenceRoll),
  };
};

const drawPlaneFrame = ({ kind, frameIndex, pose, objectWidth, objectHeight, anchorUv, reference, occluded, texture }) => {
  const width = DEFAULT_WIDTH;
  const height = DEFAULT_HEIGHT;
  const camera = DEFAULT_CAMERA;
  const imageData = createImageData(width, height);
  fillBackground(imageData, frameIndex, kind.length);

  const modelCorners = [
    { x: -objectWidth / 2, y: -objectHeight / 2, z: 0 },
    { x: objectWidth / 2, y: -objectHeight / 2, z: 0 },
    { x: objectWidth / 2, y: objectHeight / 2, z: 0 },
    { x: -objectWidth / 2, y: objectHeight / 2, z: 0 },
  ];
  const corners = modelCorners.map(point => project3(point, pose, camera));
  const normal = projectNormal(pose);
  const shade = clamp(0.58 + normal.z * 0.34 - Math.abs(normal.x) * 0.18 + Math.sin(frameIndex * 0.37) * 0.04, 0.46, 1);
  drawShadow(imageData, corners, frameIndex);
  drawQuad(imageData, corners, texture, shade);

  const boundingBox = bboxFor(corners);
  if (occluded) drawOcclusion(imageData, boundingBox, frameIndex, kind);

  const groundTruth = createPlaneGroundTruth({
    pose,
    camera,
    objectWidth,
    objectHeight,
    anchorUv,
    reference,
  });

  return {
    imageData,
    corners: corners.map(point => ({ x: point.x, y: point.y })),
    boundingBox,
    groundTruth,
  };
};

const bookPoseAt = (index, count, variant) => {
  const t = index / Math.max(1, count - 1);
  return {
    yaw: (Math.sin(t * Math.PI * 1.24) * 28 - 10) * Math.PI / 180,
    pitch: (Math.sin(t * Math.PI * 1.8 + 0.4) * 13) * Math.PI / 180,
    roll: (Math.sin(t * Math.PI * 1.5 - 0.2) * 9) * Math.PI / 180,
    tx: Math.sin(t * Math.PI * 2.1) * 28 + (variant === 'dark-book' ? -18 : 0),
    ty: Math.cos(t * Math.PI * 1.6) * 18,
    distance: 720 - Math.sin(t * Math.PI * 1.1) * 90,
  };
};

export const createPlanarBookSequence = ({
  kind = 'planar-book',
  frameCount = 32,
  occlusionFrames = [14, 15, 16, 17],
} = {}) => {
  const objectWidth = 205;
  const objectHeight = 285;
  const anchorUv = { u: 0.54, v: 0.55 };
  const referencePose = bookPoseAt(0, frameCount, kind);
  const reference = createPlaneGroundTruth({
    pose: referencePose,
    camera: DEFAULT_CAMERA,
    objectWidth,
    objectHeight,
    anchorUv,
  });
  const occlusionSet = new Set(occlusionFrames);
  const frames = Array.from({ length: frameCount }, (_, index) => drawPlaneFrame({
    kind,
    frameIndex: index,
    pose: bookPoseAt(index, frameCount, kind),
    objectWidth,
    objectHeight,
    anchorUv,
    reference,
    occluded: occlusionSet.has(index),
    texture: bookTexture(kind),
  }));

  return {
    kind,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      targetModel: 'planar-homography',
    },
  };
};

const canPoseAt = (index, count) => {
  const t = index / Math.max(1, count - 1);
  return {
    yaw: (Math.sin(t * Math.PI * 1.45) * 42 - 6) * Math.PI / 180,
    pitch: Math.sin(t * Math.PI * 1.7) * 8 * Math.PI / 180,
    roll: Math.sin(t * Math.PI * 1.2) * 7 * Math.PI / 180,
    tx: 18 + Math.sin(t * Math.PI * 1.8) * 34,
    ty: Math.cos(t * Math.PI * 1.3) * 16,
    distance: 690 - Math.sin(t * Math.PI) * 70,
  };
};

const drawCylinderFrame = ({ frameIndex, frameCount, occluded, reference }) => {
  const width = DEFAULT_WIDTH;
  const height = DEFAULT_HEIGHT;
  const camera = DEFAULT_CAMERA;
  const imageData = createImageData(width, height);
  fillBackground(imageData, frameIndex, 29);
  const pose = canPoseAt(frameIndex, frameCount);
  const radius = 66;
  const objectHeight = 205;
  const anchorPoint = { x: 0, y: 0, z: 0 };
  const basisXPoint = { x: 42, y: 0, z: 0 };
  const basisYPoint = { x: 0, y: 42, z: 0 };
  const strips = 44;
  const projected = [];

  for (let strip = 0; strip < strips; strip++) {
    const a0 = -Math.PI * 0.52 + strip / strips * Math.PI * 1.04;
    const a1 = -Math.PI * 0.52 + (strip + 1) / strips * Math.PI * 1.04;
    const p0 = { x: Math.sin(a0) * radius, y: -objectHeight / 2, z: Math.cos(a0) * radius - radius };
    const p1 = { x: Math.sin(a1) * radius, y: -objectHeight / 2, z: Math.cos(a1) * radius - radius };
    const p2 = { x: Math.sin(a1) * radius, y: objectHeight / 2, z: Math.cos(a1) * radius - radius };
    const p3 = { x: Math.sin(a0) * radius, y: objectHeight / 2, z: Math.cos(a0) * radius - radius };
    const quad = [p0, p1, p2, p3].map(point => project3(point, pose, camera));
    projected.push(...quad);
    const shade = clamp(0.42 + Math.cos((a0 + a1) * 0.5) * 0.35 + projectNormal(pose).z * 0.16, 0.28, 1);
    drawQuad(imageData, quad, (u, v) => canTexture((strip + u) / strips, v), shade);
  }

  const boundingBox = bboxFor(projected);
  if (occluded) drawOcclusion(imageData, boundingBox, frameIndex, 'cylindrical-can');
  const groundTruth = createLocalSurfaceGroundTruth({
    pose,
    camera,
    anchorPoint,
    basisXPoint,
    basisYPoint,
    reference,
  });

  return {
    imageData,
    corners: projected.map(point => ({ x: point.x, y: point.y })),
    boundingBox,
    groundTruth,
  };
};

export const createCylindricalCanSequence = ({ frameCount = 30, occlusionFrames = [12, 13, 14] } = {}) => {
  const occlusionSet = new Set(occlusionFrames);
  const reference = createLocalSurfaceGroundTruth({
    pose: canPoseAt(0, frameCount),
    camera: DEFAULT_CAMERA,
    anchorPoint: { x: 0, y: 0, z: 0 },
    basisXPoint: { x: 42, y: 0, z: 0 },
    basisYPoint: { x: 0, y: 42, z: 0 },
  });
  const frames = Array.from({ length: frameCount }, (_, index) => drawCylinderFrame({
    frameIndex: index,
    frameCount,
    occluded: occlusionSet.has(index),
    reference,
  }));

  return {
    kind: 'cylindrical-can',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      targetModel: 'curved-sparse-reconstruction',
    },
  };
};

const boxPoseAt = (frameIndex, frameCount) => {
  const t = frameIndex / Math.max(1, frameCount - 1);
  return {
    yaw: (-24 + Math.sin(t * Math.PI * 1.3) * 34) * Math.PI / 180,
    pitch: (8 + Math.sin(t * Math.PI * 1.6) * 12) * Math.PI / 180,
    roll: Math.sin(t * Math.PI * 1.7) * 8 * Math.PI / 180,
    tx: -24 + Math.sin(t * Math.PI * 1.5) * 28,
    ty: Math.sin(t * Math.PI * 1.1) * 16,
    distance: 760 - Math.sin(t * Math.PI) * 60,
  };
};

const createRigidBoxFrame = ({ frameIndex, frameCount, occluded, reference }) => {
  const imageData = createImageData(DEFAULT_WIDTH, DEFAULT_HEIGHT);
  fillBackground(imageData, frameIndex, 41);
  const pose = boxPoseAt(frameIndex, frameCount);
  const w = 210;
  const h = 175;
  const d = 78;
  const faces = [
    {
      corners: [
        { x: -w / 2, y: -h / 2, z: -d / 2 },
        { x: w / 2, y: -h / 2, z: -d / 2 },
        { x: w / 2, y: h / 2, z: -d / 2 },
        { x: -w / 2, y: h / 2, z: -d / 2 },
      ],
      texture: boxTexture(1),
      shade: 0.92,
    },
    {
      corners: [
        { x: w / 2, y: -h / 2, z: -d / 2 },
        { x: w / 2, y: -h / 2, z: d / 2 },
        { x: w / 2, y: h / 2, z: d / 2 },
        { x: w / 2, y: h / 2, z: -d / 2 },
      ],
      texture: boxTexture(2),
      shade: 0.66,
    },
  ];
  const projected = [];
  faces.forEach(face => {
    const corners = face.corners.map(point => project3(point, pose, DEFAULT_CAMERA));
    projected.push(...corners);
    drawQuad(imageData, corners, face.texture, face.shade);
  });
  const boundingBox = bboxFor(projected);
  if (occluded) drawOcclusion(imageData, boundingBox, frameIndex, 'rigid-box');
  const anchorPoint = { x: 0, y: 0, z: -d / 2 };
  const groundTruth = createLocalSurfaceGroundTruth({
    pose,
    camera: DEFAULT_CAMERA,
    anchorPoint,
    basisXPoint: { x: 42, y: 0, z: -d / 2 },
    basisYPoint: { x: 0, y: 42, z: -d / 2 },
    reference,
  });

  return {
    imageData,
    corners: projected.map(point => ({ x: point.x, y: point.y })),
    boundingBox,
    groundTruth,
  };
};

export const createRigidBoxSequence = ({ frameCount = 28, occlusionFrames = [10, 11, 12] } = {}) => {
  const occlusionSet = new Set(occlusionFrames);
  const d = 78;
  const reference = createLocalSurfaceGroundTruth({
    pose: boxPoseAt(0, frameCount),
    camera: DEFAULT_CAMERA,
    anchorPoint: { x: 0, y: 0, z: -d / 2 },
    basisXPoint: { x: 42, y: 0, z: -d / 2 },
    basisYPoint: { x: 0, y: 42, z: -d / 2 },
  });
  const frames = Array.from({ length: frameCount }, (_, index) => createRigidBoxFrame({
    frameIndex: index,
    frameCount,
    occluded: occlusionSet.has(index),
    reference,
  }));

  return {
    kind: 'rigid-box',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      targetModel: 'multi-plane-sparse-reconstruction',
    },
  };
};

export const createSyntheticObjectSuite = () => [
  createPlanarBookSequence({ kind: 'planar-book' }),
  createPlanarBookSequence({ kind: 'dark-book' }),
  createCylindricalCanSequence(),
  createRigidBoxSequence(),
];
