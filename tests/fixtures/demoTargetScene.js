// Independent analytic ray renderer, never imported by the app or its geometry solver.
// Millimetre-like scene units; no oracle masks/points enter the application pipeline.
export const renderDemoTarget = ({
  scenario,
  width = 320,
  height = 240,
  cameraX = 0,
  cameraY = 0,
  yaw = 0,
  lightX = -0.5,
  labelCoverage = 'full',
}) => {
  const focal = width / (2 * Math.tan((63 * Math.PI) / 360));
  const distance = 600;
  const radius = 80;
  const data = new Uint8ClampedArray(width * height * 4);
  const mask = new Uint8Array(width * height);
  const tilt = 0.65;
  const sin = Math.sin(tilt);
  const cos = Math.cos(tilt);
  const project = ({ x, y, z }) => ({
    x: width / 2 + (focal * (x - cameraX)) / (distance - z),
    y: height / 2 + (focal * (y - cameraY)) / (distance - z),
  });
  const materialPoint =
    scenario === 'paper'
      ? { x: 0, y: 0, z: 0 }
      : { x: radius * Math.sin(yaw), y: 0, z: radius * Math.cos(yaw) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - width / 2) / focal;
      const dy = (y - height / 2) / focal;
      let hit = null;
      if (scenario === 'paper') {
        const t = (sin * cameraY - cos * distance) / (-sin * dy - cos);
        const u = cameraX + t * dx;
        const v = (cameraY + t * dy) / cos;
        if (Math.abs(u) <= 125 && Math.abs(v) <= 150) hit = { u, v, nx: 0, nz: cos, printed: true };
      } else {
        const sections =
          scenario === 'bottle-label'
            ? [
                [radius, 0, -80, 150],
                [160, 1, -130, -80],
                [30, 0, -205, -130],
              ]
            : [
                [radius, 0, -110, 110],
                [135, 0.5, -130, -110],
                [135, -0.5, 110, 130],
              ];
        let nearestDepth = Infinity;
        for (const [baseRadius, slope, minY, maxY] of sections) {
          const originRadius = baseRadius + slope * cameraY;
          const a = dx * dx + 1 - (slope * dy) ** 2;
          const b = 2 * (cameraX * dx - distance - originRadius * slope * dy);
          const c = cameraX * cameraX + distance * distance - originRadius ** 2;
          const discriminant = b * b - 4 * a * c;
          if (discriminant < 0) continue;
          const t = (-b - Math.sqrt(discriminant)) / (2 * a);
          if (t >= nearestDepth) continue;
          const py = cameraY + t * dy;
          if (py < minY || py > maxY) continue;
          const px = cameraX + t * dx;
          const pz = distance - t;
          const angle = Math.atan2(px, pz) - yaw;
          const wrappedAngle = Math.atan2(Math.sin(angle), Math.cos(angle));
          const printed =
            scenario === 'can' ||
            (py >= -75 && py <= 100 && (labelCoverage === 'full' || Math.abs(wrappedAngle) < 0.85));
          const r = baseRadius + slope * py;
          hit = { u: angle * radius, v: py, nx: px / r, nz: pz / r, printed };
          nearestDepth = t;
        }
      }
      const index = y * width + x;
      const offset = index * 4;
      if (hit) {
        const tx = Math.floor(hit.u * 1.6);
        const ty = Math.floor(hit.v * 1.6);
        let noise = Math.imul(tx, 374761393) ^ Math.imul(ty, 668265263);
        noise = (noise ^ (noise >>> 13)) & 127;
        const stripe = Math.abs(hit.v) < 16 || ((tx >> 4) & 3) === 0;
        const diffuse = Math.max(0.35, 0.6 + 0.4 * (hit.nx * lightX + hit.nz));
        const specular =
          scenario === 'paper'
            ? 0
            : 160 * Math.max(0, hit.nx * lightX + hit.nz * Math.sqrt(1 - lightX * lightX)) ** 48;
        const base =
          scenario === 'paper'
            ? [190 + noise / 2, 190 + noise / 2, 180 + noise / 2]
            : hit.printed
              ? [128 + noise, stripe ? 85 + noise / 2 : 20 + noise / 4, 15 + noise / 8]
              : [28, 65 + noise / 4, 34];
        for (let channel = 0; channel < 3; channel++)
          data[offset + channel] = base[channel] * diffuse + specular;
        mask[index] = 255;
      } else {
        data[offset] = 30 + x * 0.16;
        data[offset + 1] = 65 + y * 0.25;
        data[offset + 2] = 105 + (((x >> 3) ^ (y >> 3)) & 1) * 14;
      }
      data[offset + 3] = 255;
    }
  }
  return { imageData: { width, height, data }, mask, attachment: project(materialPoint) };
};
