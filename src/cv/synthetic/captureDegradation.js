const SRGB_GAMMA = 2.2;

const CAPTURE_EFFECTS = Object.freeze({
  'low-light': Object.freeze({
    condition: 'low-light',
    exposureScale: 0.26,
    fullWellElectrons: 180,
    readNoiseElectrons: 2.8,
    rowNoiseElectrons: 1.2,
  }),
  'motion-blur': Object.freeze({
    condition: 'motion-blur',
    exposureFraction: 0.72,
    maxBlurPixels: 10,
    sampleCount: 7,
  }),
  'rolling-shutter': Object.freeze({
    condition: 'rolling-shutter',
    readoutFraction: 0.82,
    maxSkewPixels: 12,
  }),
});

const captureProfile = (effects) => Object.freeze({ effects: Object.freeze(effects) });

export const CAPTURE_CONDITIONS = Object.freeze({
  'low-light': captureProfile(['low-light']),
  'motion-blur': captureProfile(['motion-blur']),
  'rolling-shutter': captureProfile(['rolling-shutter']),
  'low-light-motion': captureProfile(['motion-blur', 'low-light']),
  'rolling-motion': captureProfile(['rolling-shutter', 'motion-blur']),
  'handheld-night': captureProfile(['rolling-shutter', 'motion-blur', 'low-light']),
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const cloneImageData = (imageData) => ({
  width: imageData.width,
  height: imageData.height,
  data: new Uint8ClampedArray(imageData.data),
});

const uniformNoise = (index, seed) => {
  let value = (index + Math.imul(seed, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return ((value >>> 0) + 1) / 4294967297;
};

const gaussianNoise = (index, seed) => {
  const first = uniformNoise(index * 2, seed);
  const second = uniformNoise(index * 2 + 1, seed ^ 0x68bc21eb);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};

export const applyLowLightSensorNoise = (imageData, seed) => {
  const profile = CAPTURE_EFFECTS['low-light'];
  const output = cloneImageData(imageData);
  const rowNoise = Array.from(
    { length: imageData.height * 3 },
    (_, index) => gaussianNoise(index, seed ^ 0x45d9f3b) * profile.rowNoiseElectrons,
  );

  for (let y = 0; y < imageData.height; y++) {
    for (let x = 0; x < imageData.width; x++) {
      const pixelOffset = (y * imageData.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const sampleIndex = pixelOffset + channel;
        const linearSignal = Math.pow(imageData.data[sampleIndex] / 255, SRGB_GAMMA);
        const expectedElectrons = linearSignal * profile.exposureScale * profile.fullWellElectrons;
        const shotNoise = Math.sqrt(expectedElectrons) * gaussianNoise(sampleIndex, seed);
        const readNoise = profile.readNoiseElectrons * gaussianNoise(sampleIndex, seed ^ 0x27d4eb2d);
        const noisyElectrons = Math.max(
          0,
          expectedElectrons + shotNoise + readNoise + rowNoise[y * 3 + channel],
        );
        const noisyLinear = clamp(noisyElectrons / profile.fullWellElectrons, 0, 1);
        output.data[sampleIndex] = Math.pow(noisyLinear, 1 / SRGB_GAMMA) * 255;
      }
    }
  }

  return output;
};

const sampleChannel = (imageData, x, y, channel) => {
  const sampleX = clamp(x, 0, imageData.width - 1);
  const sampleY = clamp(y, 0, imageData.height - 1);
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const x1 = Math.min(imageData.width - 1, x0 + 1);
  const y1 = Math.min(imageData.height - 1, y0 + 1);
  const tx = sampleX - x0;
  const ty = sampleY - y0;
  const at = (sampleColumn, sampleRow) =>
    imageData.data[(sampleRow * imageData.width + sampleColumn) * 4 + channel];
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
};

export const applyLinearMotionBlur = (imageData, motion) => {
  const profile = CAPTURE_EFFECTS['motion-blur'];
  const output = cloneImageData(imageData);
  const lastSample = profile.sampleCount - 1;

  for (let y = 0; y < imageData.height; y++) {
    for (let x = 0; x < imageData.width; x++) {
      const pixelOffset = (y * imageData.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let sample = 0; sample < profile.sampleCount; sample++) {
          const time = sample / lastSample - 0.5;
          sum += sampleChannel(imageData, x - motion.x * time, y - motion.y * time, channel);
        }
        output.data[pixelOffset + channel] = sum / profile.sampleCount;
      }
    }
  }

  return output;
};

const rollingShutterOffsetAt = (y, height, skewX) => skewX * (y / Math.max(1, height - 1) - 0.5);

export const warpRollingShutterPoint = (point, height, skewX) => ({
  x: point.x + rollingShutterOffsetAt(point.y, height, skewX),
  y: point.y,
});

export const applyRollingShutterWarp = (imageData, skewX) => {
  const output = cloneImageData(imageData);

  for (let y = 0; y < imageData.height; y++) {
    const offsetX = rollingShutterOffsetAt(y, imageData.height, skewX);
    for (let x = 0; x < imageData.width; x++) {
      const pixelOffset = (y * imageData.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        output.data[pixelOffset + channel] = sampleChannel(imageData, x - offsetX, y, channel);
      }
    }
  }

  return output;
};

const applyRollingShutterMask = (objectMask, width, height, skewX) => {
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const offsetX = rollingShutterOffsetAt(y, height, skewX);
    for (let x = 0; x < width; x++) {
      const sourceX = Math.round(x - offsetX);
      if (sourceX >= 0 && sourceX < width) {
        output[y * width + x] = objectMask.data[y * width + sourceX];
      }
    }
  }
  return { ...objectMask, data: output };
};

const boundingBoxCorners = (boundingBox) => [
  { x: boundingBox.x1, y: boundingBox.y1 },
  { x: boundingBox.x2, y: boundingBox.y1 },
  { x: boundingBox.x2, y: boundingBox.y2 },
  { x: boundingBox.x1, y: boundingBox.y2 },
];

const boundingBoxFor = (points) => {
  const x1 = Math.min(...points.map((point) => point.x));
  const y1 = Math.min(...points.map((point) => point.y));
  const x2 = Math.max(...points.map((point) => point.x));
  const y2 = Math.max(...points.map((point) => point.y));
  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    x1,
    y1,
    x2,
    y2,
  };
};

const motionAt = (frames, index) => {
  const comparisonIndex = index === 0 ? 1 : index - 1;
  const direction = index === 0 ? 1 : -1;
  const current = frames[index].groundTruth.anchor;
  const comparison = frames[comparisonIndex].groundTruth.anchor;
  return {
    x: (comparison.x - current.x) * direction,
    y: (comparison.y - current.y) * direction,
  };
};

const cappedVector = (motion, scale, maxLength) => {
  const scaled = { x: motion.x * scale, y: motion.y * scale };
  const length = Math.hypot(scaled.x, scaled.y);
  const cap = length > maxLength ? maxLength / length : 1;
  return { x: scaled.x * cap, y: scaled.y * cap };
};

const warpProbePoints = (points, height, skewX) =>
  Object.fromEntries(
    Object.entries(points).map(([name, point]) => [name, warpRollingShutterPoint(point, height, skewX)]),
  );

const appendCaptureEffect = (frame, evidence) => ({
  ...frame,
  captureDegradation: {
    effects: [...(frame.captureDegradation?.effects || []), evidence],
  },
});

const degradeFrame = ({ frame, frames, index, width, height, effect }) => {
  if (effect.condition === 'low-light') {
    const seed = 1009 + index * 131;
    return appendCaptureEffect(
      {
        ...frame,
        imageData: applyLowLightSensorNoise(frame.imageData, seed),
      },
      { condition: effect.condition, seed },
    );
  }

  const frameMotion = motionAt(frames, index);
  if (effect.condition === 'motion-blur') {
    const blurVector = cappedVector(frameMotion, effect.exposureFraction, effect.maxBlurPixels);
    return appendCaptureEffect(
      {
        ...frame,
        imageData: applyLinearMotionBlur(frame.imageData, blurVector),
      },
      { condition: effect.condition, blurVector },
    );
  }

  const skewX = clamp(frameMotion.x * effect.readoutFraction, -effect.maxSkewPixels, effect.maxSkewPixels);
  const warpPoint = (point) => warpRollingShutterPoint(point, height, skewX);
  const corners = frame.corners?.map(warpPoint);
  const boundingBox = frame.boundingBox
    ? boundingBoxFor(boundingBoxCorners(frame.boundingBox).map(warpPoint))
    : null;
  const decoyBoundingBox = frame.decoyBoundingBox
    ? boundingBoxFor(boundingBoxCorners(frame.decoyBoundingBox).map(warpPoint))
    : null;
  return appendCaptureEffect(
    {
      ...frame,
      imageData: applyRollingShutterWarp(frame.imageData, skewX),
      ...(frame.objectMask
        ? { objectMask: applyRollingShutterMask(frame.objectMask, width, height, skewX) }
        : {}),
      ...(corners ? { corners } : {}),
      ...(boundingBox ? { boundingBox } : {}),
      ...(decoyBoundingBox ? { decoyBoundingBox } : {}),
      ...(frame.maskProbePoints
        ? { maskProbePoints: warpProbePoints(frame.maskProbePoints, height, skewX) }
        : {}),
      groundTruth: {
        ...frame.groundTruth,
        anchor: warpPoint(frame.groundTruth.anchor),
      },
    },
    { condition: effect.condition, skewX },
  );
};

export const applyCaptureCondition = (sequence, conditionName) => {
  const condition = CAPTURE_CONDITIONS[conditionName];
  if (!condition) {
    throw new Error(`Unknown capture condition: ${conditionName}`);
  }
  const frames = condition.effects.reduce((currentFrames, effectName) => {
    const effect = CAPTURE_EFFECTS[effectName];
    return currentFrames.map((frame, index) =>
      degradeFrame({
        frame,
        frames: currentFrames,
        index,
        width: sequence.width,
        height: sequence.height,
        effect,
      }),
    );
  }, sequence.frames);

  return {
    ...sequence,
    tap: frames[0].groundTruth.anchor,
    boundingBox: frames[0].boundingBox,
    camera: { ...sequence.camera },
    frames,
    metadata: {
      ...sequence.metadata,
      captureCondition: conditionName,
      captureModel: {
        effects: [...condition.effects],
        models: condition.effects.map((effectName) => ({ ...CAPTURE_EFFECTS[effectName] })),
      },
    },
  };
};
