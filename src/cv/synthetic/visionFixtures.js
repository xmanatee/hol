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

const backgroundBase = (x, y, imageData, frameIndex, seed, variant) => {
  const vignette = Math.hypot(x / imageData.width - 0.5, y / imageData.height - 0.5);
  const grain = noise(x * 0.09, y * 0.09, seed + frameIndex * 0.17) - 0.5;
  const movingOffset = Math.sin(frameIndex * 0.21 + seed) * 16;

  if (variant === 'shelf') {
    const panel = (Math.floor((x + movingOffset) / 84) % 2) * 12;
    const horizontal = Math.abs((y % 96) - 48) < 2 ? -22 : 0;
    const base = 96 - vignette * 42 + grain * 22 + panel + horizontal;
    return [
      clamp(base + 24, 18, 214),
      clamp(base + 18, 18, 214),
      clamp(base + 10, 18, 214),
      255,
    ];
  }

  if (variant === 'busy') {
    const block = ((Math.floor((x + movingOffset) / 58) + Math.floor((y - movingOffset * 0.4) / 42)) % 2) * 26;
    const diagonal = Math.abs(((x + y + frameIndex * 2) % 120) - 60) < 4 ? -28 : 0;
    const base = 104 - vignette * 48 + grain * 26 + block + diagonal;
    return [
      clamp(base + 8, 20, 220),
      clamp(base + 18, 20, 220),
      clamp(base + 28, 20, 220),
      255,
    ];
  }

  if (variant === 'window') {
    const brightBand = x > imageData.width * 0.58 && y < imageData.height * 0.7 ? 38 : 0;
    const blind = Math.abs(((y + frameIndex * 1.7) % 54) - 27) < 3 ? -34 : 0;
    const base = 118 - vignette * 46 + grain * 20 + brightBand + blind;
    return [
      clamp(base + 24, 28, 238),
      clamp(base + 26, 28, 238),
      clamp(base + 18, 28, 238),
      255,
    ];
  }

  if (variant === 'kitchen') {
    const tile = (Math.floor((x + movingOffset * 0.5) / 52) + Math.floor(y / 52)) % 2 ? 10 : -6;
    const grout = Math.abs((x % 52) - 26) < 1 || Math.abs((y % 52) - 26) < 1 ? -30 : 0;
    const base = 112 - vignette * 38 + grain * 22 + tile + grout;
    return [
      clamp(base + 30, 22, 230),
      clamp(base + 25, 22, 230),
      clamp(base + 18, 22, 230),
      255,
    ];
  }

  const deskLine = y > imageData.height * 0.62 ? 18 : 0;
  const stripe = (Math.floor((x + y * 0.35) / 46) % 2) * 5;
  const base = 116 - vignette * 56 + grain * 18 + deskLine + stripe;
  return [
    clamp(base + 18, 20, 210),
    clamp(base + 12, 20, 210),
    clamp(base + 4, 20, 210),
    255,
  ];
};

const drawMovingBackgroundObject = (imageData, frameIndex, seed, variant) => {
  if (variant === 'desk') return;

  const width = variant === 'busy' ? 82 : 118;
  const height = variant === 'busy' ? 34 : 24;
  const centerX = imageData.width * (0.18 + 0.64 * noise(frameIndex * 0.06, seed, 4));
  const centerY = imageData.height * (0.17 + 0.26 * noise(seed, frameIndex * 0.04, 7));
  const color = variant === 'busy' ? [34, 46, 58] : [62, 54, 44];

  for (let y = Math.floor(centerY - height / 2); y <= Math.ceil(centerY + height / 2); y++) {
    for (let x = Math.floor(centerX - width / 2); x <= Math.ceil(centerX + width / 2); x++) {
      blendPixel(imageData, x, y, color, 0.5);
    }
  }
};

const fillBackground = (imageData, frameIndex, seed, variant = 'desk') => {
  for (let y = 0; y < imageData.height; y++) {
    for (let x = 0; x < imageData.width; x++) {
      setPixel(imageData, x, y, backgroundBase(x, y, imageData, frameIndex, seed, variant));
    }
  }

  drawMovingBackgroundObject(imageData, frameIndex, seed, variant);
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

const cupTexture = (u, v) => {
  const ceramicNoise = (noise(u * 86, v * 74, 31) - 0.5) * 22;
  const verticalRib = Math.floor(u * 42) % 6 === 0;
  const logo = u > 0.28 && u < 0.72 && v > 0.28 && v < 0.58 &&
    Math.abs(Math.sin((u - 0.25) * Math.PI * 4) * 0.08 + 0.43 - v) < 0.022;
  const darkBand = v > 0.72 && v < 0.86;
  const rim = v < 0.08 || v > 0.93;
  const check = ((Math.floor(u * 18) + Math.floor(v * 22)) % 2) === 0;

  if (logo) return [44 + ceramicNoise * 0.2, 84 + ceramicNoise * 0.2, 128 + ceramicNoise * 0.2, 255];
  if (darkBand && check) return [38 + ceramicNoise * 0.3, 42 + ceramicNoise * 0.3, 48 + ceramicNoise * 0.3, 255];
  if (rim) return [228 + ceramicNoise * 0.25, 224 + ceramicNoise * 0.25, 212 + ceramicNoise * 0.25, 255];
  if (verticalRib) return [172 + ceramicNoise, 154 + ceramicNoise * 0.7, 136 + ceramicNoise * 0.45, 255];

  return [196 + ceramicNoise, 184 + ceramicNoise * 0.8, 164 + ceramicNoise * 0.55, 255];
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

const phoneTexture = (u, v) => {
  const glassNoise = (noise(u * 130, v * 180, 61) - 0.5) * 16;
  const bezel = u < 0.06 || u > 0.94 || v < 0.05 || v > 0.95;
  const glare = Math.abs((u - 0.72) + (v - 0.22) * 0.68) < 0.035;
  const iconColumn = Math.floor((u - 0.14) * 6);
  const iconRow = Math.floor((v - 0.2) * 8);
  const iconGrid = u > 0.14 && u < 0.86 && v > 0.2 && v < 0.82 &&
    iconColumn >= 0 &&
    iconRow >= 0 &&
    Math.abs(((u - 0.14) * 6) % 1 - 0.5) < 0.27 &&
    Math.abs(((v - 0.2) * 8) % 1 - 0.5) < 0.22;
  const qr = u > 0.64 && u < 0.86 && v > 0.68 && v < 0.9 &&
    ((Math.floor(u * 74) + Math.floor(v * 86)) % 5 < 2);
  const cameraIsland = u > 0.12 && u < 0.32 && v > 0.08 && v < 0.2;

  if (bezel) return [10 + glassNoise, 12 + glassNoise, 16 + glassNoise, 255];
  if (cameraIsland) return [34 + glassNoise, 36 + glassNoise, 42 + glassNoise, 255];
  if (qr) return [220 + glassNoise * 0.2, 224 + glassNoise * 0.2, 232 + glassNoise * 0.2, 255];
  if (glare) return [192 + glassNoise * 0.2, 216 + glassNoise * 0.2, 238 + glassNoise * 0.2, 255];
  if (iconGrid) {
    const colorPick = (iconColumn + iconRow * 3) % 5;
    const colors = [
      [60, 118, 196],
      [58, 154, 112],
      [190, 92, 78],
      [202, 158, 62],
      [128, 96, 178],
    ];
    const color = colors[colorPick];
    return [color[0] + glassNoise, color[1] + glassNoise, color[2] + glassNoise, 255];
  }

  return [24 + glassNoise, 34 + glassNoise, 52 + glassNoise, 255];
};

const bottleTexture = (u, v) => {
  const n = (noise(u * 120, v * 115, 73) - 0.5) * 24;
  const label = v > 0.22 && v < 0.72;
  const labelStripe = label && Math.abs(u - 0.52) < 0.055;
  const barcode = label && u > 0.66 && u < 0.86 && v > 0.48 && v < 0.66 && Math.floor(u * 145) % 4 < 2;
  const smallText = label && u > 0.18 && u < 0.58 && v > 0.34 && v < 0.6 &&
    ((Math.floor(u * 130) + Math.floor(v * 170)) % 11 < 3);
  const emboss = Math.floor(v * 88) % 13 === 0;
  const shoulder = v < 0.16;

  if (barcode) return [34 + n * 0.15, 38 + n * 0.15, 42 + n * 0.15, 255];
  if (smallText) return [28 + n * 0.1, 56 + n * 0.1, 84 + n * 0.1, 255];
  if (labelStripe) return [236 + n * 0.2, 216 + n * 0.2, 82 + n * 0.2, 255];
  if (label) return [224 + n * 0.25, 236 + n * 0.2, 230 + n * 0.2, 255];
  if (emboss) return [42 + n, 106 + n * 0.6, 124 + n * 0.45, 255];
  if (shoulder) return [36 + n, 120 + n * 0.7, 142 + n * 0.5, 255];
  return [30 + n, 96 + n * 0.65, 118 + n * 0.45, 255];
};

const pouchTexture = (u, v) => {
  const crinkle = Math.sin(u * 44 + Math.sin(v * 19) * 2.2) * 18 +
    Math.cos(v * 38 + u * 5) * 16 +
    (noise(u * 170, v * 150, 89) - 0.5) * 28;
  const seal = v < 0.08 || v > 0.9 || u < 0.06 || u > 0.94;
  const logo = u > 0.22 && u < 0.76 && v > 0.18 && v < 0.44 &&
    Math.abs(Math.sin((u - 0.2) * Math.PI * 4.4) * 0.06 + 0.31 - v) < 0.025;
  const productPhoto = u > 0.18 && u < 0.82 && v > 0.52 && v < 0.8 &&
    ((Math.floor(u * 28) + Math.floor(v * 31)) % 2 === 0);
  const nutrition = u > 0.62 && u < 0.88 && v > 0.42 && v < 0.86;
  const rows = nutrition && Math.floor(v * 92) % 6 === 0;

  if (seal) return [150 + crinkle, 52 + crinkle * 0.18, 28 + crinkle * 0.12, 255];
  if (logo) return [250 + crinkle * 0.1, 238 + crinkle * 0.1, 210 + crinkle * 0.1, 255];
  if (rows) return [34 + crinkle * 0.1, 34 + crinkle * 0.1, 30 + crinkle * 0.1, 255];
  if (nutrition) return [230 + crinkle * 0.15, 226 + crinkle * 0.15, 206 + crinkle * 0.15, 255];
  if (productPhoto) return [202 + crinkle * 0.25, 136 + crinkle * 0.18, 54 + crinkle * 0.12, 255];
  return [196 + crinkle, 64 + crinkle * 0.24, 34 + crinkle * 0.18, 255];
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

const drawPlaneFrame = ({
  kind,
  frameIndex,
  pose,
  objectWidth,
  objectHeight,
  anchorUv,
  reference,
  occluded,
  texture,
  backgroundSeed,
  backgroundVariant,
}) => {
  const width = DEFAULT_WIDTH;
  const height = DEFAULT_HEIGHT;
  const camera = DEFAULT_CAMERA;
  const imageData = createImageData(width, height);
  fillBackground(imageData, frameIndex, backgroundSeed, backgroundVariant);

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
  if (variant === 'depth-book') {
    return {
      yaw: Math.sin(t * Math.PI * 1.35) * 34 * Math.PI / 180,
      pitch: Math.sin(t * Math.PI * 1.7) * 16 * Math.PI / 180,
      roll: Math.sin(t * Math.PI * 2.05) * 12 * Math.PI / 180,
      tx: Math.sin(t * Math.PI * 2.4) * 34,
      ty: Math.sin(t * Math.PI * 1.8) * 22,
      distance: 780 - Math.sin(t * Math.PI) * 170,
    };
  }

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
  backgroundVariant = 'desk',
  backgroundSeed = kind.length,
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
    backgroundSeed,
    backgroundVariant,
  }));

  return {
    kind,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    targetClass: 'book',
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      hasMovingBackground: true,
      backgroundVariant,
      targetClass: 'book',
      targetModel: 'planar-homography',
    },
  };
};

const phonePoseAt = (index, count) => {
  const t = index / Math.max(1, count - 1);
  return {
    yaw: (Math.sin(t * Math.PI * 1.65) * 32 + 8) * Math.PI / 180,
    pitch: (Math.sin(t * Math.PI * 1.35 + 0.5) * 18 - 4) * Math.PI / 180,
    roll: Math.sin(t * Math.PI * 2.1) * 16 * Math.PI / 180,
    tx: -20 + Math.sin(t * Math.PI * 2.4) * 32,
    ty: Math.cos(t * Math.PI * 1.7) * 22,
    distance: 680 - Math.sin(t * Math.PI * 1.05) * 130,
  };
};

export const createGlossyPhoneSequence = ({
  frameCount = 34,
  occlusionFrames = [12, 13, 25],
  backgroundVariant = 'window',
  backgroundSeed = 67,
} = {}) => {
  const objectWidth = 126;
  const objectHeight = 244;
  const anchorUv = { u: 0.52, v: 0.56 };
  const referencePose = phonePoseAt(0, frameCount);
  const reference = createPlaneGroundTruth({
    pose: referencePose,
    camera: DEFAULT_CAMERA,
    objectWidth,
    objectHeight,
    anchorUv,
  });
  const occlusionSet = new Set(occlusionFrames);
  const frames = Array.from({ length: frameCount }, (_, index) => drawPlaneFrame({
    kind: 'glossy-phone',
    frameIndex: index,
    pose: phonePoseAt(index, frameCount),
    objectWidth,
    objectHeight,
    anchorUv,
    reference,
    occluded: occlusionSet.has(index),
    texture: phoneTexture,
    backgroundSeed,
    backgroundVariant,
  }));

  return {
    kind: 'glossy-phone',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    targetClass: 'cell phone',
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      hasMovingBackground: true,
      backgroundVariant,
      targetClass: 'cell phone',
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

const bottlePoseAt = (index, count) => {
  const t = index / Math.max(1, count - 1);
  return {
    yaw: (Math.sin(t * Math.PI * 1.7) * 38 - 10) * Math.PI / 180,
    pitch: Math.sin(t * Math.PI * 1.45 + 0.2) * 10 * Math.PI / 180,
    roll: Math.sin(t * Math.PI * 1.55) * 8 * Math.PI / 180,
    tx: 12 + Math.sin(t * Math.PI * 2.2) * 26,
    ty: Math.cos(t * Math.PI * 1.5) * 18,
    distance: 700 - Math.sin(t * Math.PI) * 86,
  };
};

const drawBottleFrame = ({ frameIndex, frameCount, occluded, reference, backgroundSeed, backgroundVariant }) => {
  const imageData = createImageData(DEFAULT_WIDTH, DEFAULT_HEIGHT);
  fillBackground(imageData, frameIndex, backgroundSeed, backgroundVariant);
  const pose = bottlePoseAt(frameIndex, frameCount);
  const bodyRadius = 50;
  const bodyHeight = 220;
  const projected = [];
  const strips = 42;

  for (let strip = 0; strip < strips; strip++) {
    const a0 = -Math.PI * 0.5 + strip / strips * Math.PI;
    const a1 = -Math.PI * 0.5 + (strip + 1) / strips * Math.PI;
    const quad3 = [
      { x: Math.sin(a0) * bodyRadius, y: -bodyHeight / 2, z: Math.cos(a0) * bodyRadius - bodyRadius },
      { x: Math.sin(a1) * bodyRadius, y: -bodyHeight / 2, z: Math.cos(a1) * bodyRadius - bodyRadius },
      { x: Math.sin(a1) * bodyRadius, y: bodyHeight / 2, z: Math.cos(a1) * bodyRadius - bodyRadius },
      { x: Math.sin(a0) * bodyRadius, y: bodyHeight / 2, z: Math.cos(a0) * bodyRadius - bodyRadius },
    ];
    const quad = quad3.map(point => project3(point, pose, DEFAULT_CAMERA));
    projected.push(...quad);
    const shade = clamp(0.42 + Math.cos((a0 + a1) * 0.5) * 0.32 + projectNormal(pose).z * 0.17, 0.3, 1);
    drawQuad(imageData, quad, (u, v) => bottleTexture((strip + u) / strips, v), shade);
  }

  const neckWidth = 42;
  const neckHeight = 58;
  const neckCorners = [
    { x: -neckWidth / 2, y: -bodyHeight / 2 - neckHeight, z: -bodyRadius * 0.55 },
    { x: neckWidth / 2, y: -bodyHeight / 2 - neckHeight, z: -bodyRadius * 0.55 },
    { x: neckWidth / 2, y: -bodyHeight / 2, z: -bodyRadius * 0.55 },
    { x: -neckWidth / 2, y: -bodyHeight / 2, z: -bodyRadius * 0.55 },
  ].map(point => project3(point, pose, DEFAULT_CAMERA));
  projected.push(...neckCorners);
  drawQuad(imageData, neckCorners, (u, v) => bottleTexture(u, v * 0.18), 0.82);

  const boundingBox = bboxFor(projected);
  if (occluded) drawOcclusion(imageData, boundingBox, frameIndex, 'label-bottle');
  const groundTruth = createLocalSurfaceGroundTruth({
    pose,
    camera: DEFAULT_CAMERA,
    anchorPoint: { x: 0, y: 0, z: 0 },
    basisXPoint: { x: 42, y: 0, z: 0 },
    basisYPoint: { x: 0, y: 42, z: 0 },
    reference,
  });

  return {
    imageData,
    corners: projected.map(point => ({ x: point.x, y: point.y })),
    boundingBox,
    groundTruth,
  };
};

export const createLabelBottleSequence = ({
  frameCount = 34,
  occlusionFrames = [9, 10, 26],
  backgroundVariant = 'kitchen',
  backgroundSeed = 79,
} = {}) => {
  const reference = createLocalSurfaceGroundTruth({
    pose: bottlePoseAt(0, frameCount),
    camera: DEFAULT_CAMERA,
    anchorPoint: { x: 0, y: 0, z: 0 },
    basisXPoint: { x: 42, y: 0, z: 0 },
    basisYPoint: { x: 0, y: 42, z: 0 },
  });
  const occlusionSet = new Set(occlusionFrames);
  const frames = Array.from({ length: frameCount }, (_, index) => drawBottleFrame({
    frameIndex: index,
    frameCount,
    occluded: occlusionSet.has(index),
    reference,
    backgroundSeed,
    backgroundVariant,
  }));

  return {
    kind: 'label-bottle',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    targetClass: 'bottle',
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      hasMovingBackground: true,
      backgroundVariant,
      targetClass: 'bottle',
      targetModel: 'curved-sparse-reconstruction',
    },
  };
};

const drawCylinderFrame = ({ frameIndex, frameCount, occluded, reference, backgroundSeed, backgroundVariant }) => {
  const width = DEFAULT_WIDTH;
  const height = DEFAULT_HEIGHT;
  const camera = DEFAULT_CAMERA;
  const imageData = createImageData(width, height);
  fillBackground(imageData, frameIndex, backgroundSeed, backgroundVariant);
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

export const createCylindricalCanSequence = ({
  frameCount = 30,
  occlusionFrames = [12, 13, 14],
  backgroundVariant = 'desk',
  backgroundSeed = 29,
} = {}) => {
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
    backgroundSeed,
    backgroundVariant,
  }));

  return {
    kind: 'cylindrical-can',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    targetClass: 'can',
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      hasMovingBackground: true,
      backgroundVariant,
      targetClass: 'can',
      targetModel: 'curved-sparse-reconstruction',
    },
  };
};

const cupPoseAt = (index, count) => {
  const t = index / Math.max(1, count - 1);
  return {
    yaw: Math.sin(t * Math.PI * 1.55) * 36 * Math.PI / 180,
    pitch: Math.sin(t * Math.PI * 1.25) * 11 * Math.PI / 180,
    roll: Math.sin(t * Math.PI * 1.85) * 9 * Math.PI / 180,
    tx: -14 + Math.sin(t * Math.PI * 2.1) * 30,
    ty: Math.cos(t * Math.PI * 1.4) * 18,
    distance: 720 - Math.sin(t * Math.PI) * 120,
  };
};

const drawCupFrame = ({ frameIndex, frameCount, occluded, reference, backgroundSeed, backgroundVariant }) => {
  const imageData = createImageData(DEFAULT_WIDTH, DEFAULT_HEIGHT);
  fillBackground(imageData, frameIndex, backgroundSeed, backgroundVariant);
  const pose = cupPoseAt(frameIndex, frameCount);
  const objectHeight = 188;
  const strips = 46;
  const projected = [];

  for (let strip = 0; strip < strips; strip++) {
    const a0 = -Math.PI * 0.52 + strip / strips * Math.PI * 1.04;
    const a1 = -Math.PI * 0.52 + (strip + 1) / strips * Math.PI * 1.04;
    const pointAt = (angle, y) => {
      const v = (y + objectHeight / 2) / objectHeight;
      const radius = 58 + v * 22;
      return {
        x: Math.sin(angle) * radius,
        y,
        z: Math.cos(angle) * radius - radius,
      };
    };
    const p0 = pointAt(a0, -objectHeight / 2);
    const p1 = pointAt(a1, -objectHeight / 2);
    const p2 = pointAt(a1, objectHeight / 2);
    const p3 = pointAt(a0, objectHeight / 2);
    const quad = [p0, p1, p2, p3].map(point => project3(point, pose, DEFAULT_CAMERA));
    projected.push(...quad);
    const shade = clamp(0.48 + Math.cos((a0 + a1) * 0.5) * 0.28 + projectNormal(pose).z * 0.16, 0.34, 1);
    drawQuad(imageData, quad, (u, v) => cupTexture((strip + u) / strips, v), shade);
  }

  const boundingBox = bboxFor(projected);
  if (occluded) drawOcclusion(imageData, boundingBox, frameIndex, 'textured-cup');
  const groundTruth = createLocalSurfaceGroundTruth({
    pose,
    camera: DEFAULT_CAMERA,
    anchorPoint: { x: 0, y: 0, z: 0 },
    basisXPoint: { x: 42, y: 0, z: 0 },
    basisYPoint: { x: 0, y: 42, z: 0 },
    reference,
  });

  return {
    imageData,
    corners: projected.map(point => ({ x: point.x, y: point.y })),
    boundingBox,
    groundTruth,
  };
};

export const createTexturedCupSequence = ({
  frameCount = 32,
  occlusionFrames = [15, 16, 17],
  backgroundVariant = 'desk',
  backgroundSeed = 53,
} = {}) => {
  const occlusionSet = new Set(occlusionFrames);
  const reference = createLocalSurfaceGroundTruth({
    pose: cupPoseAt(0, frameCount),
    camera: DEFAULT_CAMERA,
    anchorPoint: { x: 0, y: 0, z: 0 },
    basisXPoint: { x: 42, y: 0, z: 0 },
    basisYPoint: { x: 0, y: 42, z: 0 },
  });
  const frames = Array.from({ length: frameCount }, (_, index) => drawCupFrame({
    frameIndex: index,
    frameCount,
    occluded: occlusionSet.has(index),
    reference,
    backgroundSeed,
    backgroundVariant,
  }));

  return {
    kind: 'textured-cup',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    targetClass: 'cup',
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      hasMovingBackground: true,
      backgroundVariant,
      targetClass: 'cup',
      targetModel: 'tapered-curved-sparse-reconstruction',
    },
  };
};

const pouchPoseAt = (index, count) => {
  const t = index / Math.max(1, count - 1);
  return {
    yaw: (Math.sin(t * Math.PI * 1.25) * 26 - 7) * Math.PI / 180,
    pitch: (Math.sin(t * Math.PI * 1.9 + 0.2) * 19) * Math.PI / 180,
    roll: Math.sin(t * Math.PI * 2.3) * 13 * Math.PI / 180,
    tx: 22 + Math.sin(t * Math.PI * 2.0) * 36,
    ty: Math.cos(t * Math.PI * 1.6) * 19,
    distance: 735 - Math.sin(t * Math.PI * 1.15) * 105,
  };
};

export const createSnackPouchSequence = ({
  frameCount = 34,
  occlusionFrames = [11, 12, 21],
  backgroundVariant = 'busy',
  backgroundSeed = 97,
} = {}) => {
  const objectWidth = 210;
  const objectHeight = 236;
  const anchorUv = { u: 0.48, v: 0.57 };
  const referencePose = pouchPoseAt(0, frameCount);
  const reference = createPlaneGroundTruth({
    pose: referencePose,
    camera: DEFAULT_CAMERA,
    objectWidth,
    objectHeight,
    anchorUv,
  });
  const occlusionSet = new Set(occlusionFrames);
  const frames = Array.from({ length: frameCount }, (_, index) => drawPlaneFrame({
    kind: 'snack-pouch',
    frameIndex: index,
    pose: pouchPoseAt(index, frameCount),
    objectWidth,
    objectHeight,
    anchorUv,
    reference,
    occluded: occlusionSet.has(index),
    texture: pouchTexture,
    backgroundSeed,
    backgroundVariant,
  }));

  return {
    kind: 'snack-pouch',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    targetClass: 'bag',
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      hasMovingBackground: true,
      backgroundVariant,
      targetClass: 'bag',
      targetModel: 'planar-homography',
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

const createRigidBoxFrame = ({ frameIndex, frameCount, occluded, reference, backgroundSeed, backgroundVariant }) => {
  const imageData = createImageData(DEFAULT_WIDTH, DEFAULT_HEIGHT);
  fillBackground(imageData, frameIndex, backgroundSeed, backgroundVariant);
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

export const createRigidBoxSequence = ({
  frameCount = 28,
  occlusionFrames = [10, 11, 12],
  backgroundVariant = 'desk',
  backgroundSeed = 41,
} = {}) => {
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
    backgroundSeed,
    backgroundVariant,
  }));

  return {
    kind: 'rigid-box',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    targetClass: 'box',
    camera: DEFAULT_CAMERA,
    frames,
    metadata: {
      hasBackground: true,
      hasDarkRegions: true,
      hasFineTexture: true,
      hasLightingVariation: true,
      hasOcclusion: occlusionFrames.length > 0,
      hasMovingBackground: true,
      backgroundVariant,
      targetClass: 'box',
      targetModel: 'multi-plane-sparse-reconstruction',
    },
  };
};

export const createSyntheticObjectSuite = () => [
  createPlanarBookSequence({ kind: 'planar-book' }),
  createPlanarBookSequence({ kind: 'dark-book' }),
  createPlanarBookSequence({ kind: 'depth-book', frameCount: 36, occlusionFrames: [18, 19, 20] }),
  createCylindricalCanSequence(),
  createTexturedCupSequence(),
  createRigidBoxSequence(),
  createGlossyPhoneSequence(),
  createLabelBottleSequence(),
  createSnackPouchSequence(),
];
