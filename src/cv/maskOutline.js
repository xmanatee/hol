const NEIGHBORS = [
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
];

// Moore boundary walk. Storage stays bounded even for a long, highly concave silhouette.
export const traceMaskOutline = (mask, maxPoints) => {
  const inside = (pixelX, pixelY) =>
    pixelX >= 0 &&
    pixelY >= 0 &&
    pixelX < mask.width &&
    pixelY < mask.height &&
    mask.data[pixelY * mask.width + pixelX] > 0;
  const startY = mask.bbox.y;
  let startX = mask.bbox.x;
  while (startX < mask.bbox.x + mask.bbox.width && !inside(startX, startY)) startX++;
  if (startX === mask.bbox.x + mask.bbox.width) return [];
  let x = startX;
  let y = startY;
  let backX = x - 1;
  let backY = y;
  let firstNext = null;
  let stride = 1;
  let points = [];
  for (let step = 0; step < mask.width * mask.height * 8; step++) {
    let begin = 0;
    while (x + NEIGHBORS[begin][0] !== backX || y + NEIGHBORS[begin][1] !== backY) begin++;
    let direction = -1;
    for (let offset = 0; offset < 8; offset++) {
      const index = (begin + offset) % 8;
      if (inside(x + NEIGHBORS[index][0], y + NEIGHBORS[index][1])) {
        direction = index;
        break;
      }
    }
    const next = direction === -1 ? null : { x: x + NEIGHBORS[direction][0], y: y + NEIGHBORS[direction][1] };
    if (firstNext && x === startX && y === startY && next?.x === firstNext.x && next?.y === firstNext.y)
      break;
    if (step % stride === 0) points.push({ x, y });
    if (points.length >= maxPoints * 2) {
      points = points.filter((_, index) => index % 2 === 0);
      stride *= 2;
    }
    if (!next) break;
    firstNext ??= next;
    const previous = NEIGHBORS[(direction + 7) % 8];
    backX = x + previous[0];
    backY = y + previous[1];
    x = next.x;
    y = next.y;
  }
  return points.length <= maxPoints ? points : points.filter((_, index) => index % 2 === 0);
};
