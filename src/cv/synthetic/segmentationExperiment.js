// Runtime-independent probe protocol. This module is not imported by the application.
// The browser runner and native implementations must use the same RGBA/mask SHA-256s.
export const SEGMENTATION_EXPERIMENT_PROTOCOL = 'hol.point-segmentation.v1';
export const SEGMENTATION_EXPERIMENT_POLICY = Object.freeze({
  warmupRuns: 2,
  measuredRuns: 20,
  minimumIou: 0.85,
  maximumEmptyForegroundFraction: 0.01,
});
export const SEGMENTATION_EXPERIMENT_CASES = Object.freeze(
  [
    {
      id: 'textured-ellipse',
      width: 320,
      height: 240,
      shape: 'ellipse',
      light: 1,
      shift: 0,
      distractor: false,
    },
    {
      id: 'portrait-bottle',
      width: 240,
      height: 320,
      shape: 'bottle',
      light: 1,
      shift: 0,
      distractor: false,
    },
    { id: 'thin-object', width: 320, height: 240, shape: 'thin', light: 1, shift: 0, distractor: false },
    { id: 'low-light', width: 320, height: 240, shape: 'ellipse', light: 0.12, shift: 0, distractor: false },
    { id: 'specular-label', width: 320, height: 240, shape: 'glossy', light: 1, shift: 0, distractor: false },
    {
      id: 'similar-distractor',
      width: 320,
      height: 240,
      shape: 'ellipse',
      light: 1,
      shift: 0,
      distractor: true,
    },
    { id: 'edge-crop', width: 320, height: 240, shape: 'ellipse', light: 1, shift: -130, distractor: false },
    { id: 'empty-background', width: 320, height: 240, shape: 'none', light: 1, shift: 0, distractor: false },
    {
      id: 'demo-landscape',
      width: 960,
      height: 540,
      shape: 'ellipse',
      light: 1,
      shift: 0,
      distractor: false,
    },
    { id: 'demo-portrait', width: 540, height: 960, shape: 'bottle', light: 1, shift: 0, distractor: false },
  ].map((value) => Object.freeze(value)),
);

export const createSegmentationProbe = (id) => {
  const config = SEGMENTATION_EXPERIMENT_CASES.find((entry) => entry.id === id);
  if (!config) throw new RangeError(`Unknown segmentation probe: ${id}`);
  const { width, height, shape, light, shift, distractor } = config;
  const data = new Uint8ClampedArray(width * height * 4);
  const truth = new Uint8Array(width * height);
  const point = { x: width / 2 + shift, y: height / 2 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - point.x;
      const dy = y - point.y;
      const inEllipse = (dx / (width * 0.27)) ** 2 + (dy / (height * 0.3)) ** 2 <= 1;
      const target =
        shape === 'none'
          ? false
          : shape === 'thin'
            ? Math.abs(dx) <= 7 && Math.abs(dy) <= height * 0.34
            : shape === 'bottle'
              ? (Math.abs(dx) < width * 0.22 && dy > -height * 0.13 && dy < height * 0.34) ||
                (Math.abs(dx) < width * 0.09 && dy >= -height * 0.34 && dy <= -height * 0.13)
              : inEllipse;
      const other =
        distractor &&
        ((x - width * 0.12) / (width * 0.08)) ** 2 + ((y - height * 0.3) / (height * 0.16)) ** 2 <= 1;
      let noise = Math.imul(x - shift + (other ? 197 : 0), 374761393) ^ Math.imul(y, 668265263);
      noise = (noise ^ (noise >>> 13)) & 127;
      const foreground = target || other;
      const highlight =
        target && shape === 'glossy' ? Math.round(180 * Math.exp(-(((dx - 18) / 12) ** 2))) : 0;
      const offset = (y * width + x) * 4;
      data[offset] = (foreground ? 128 + noise + highlight : 30 + x * 0.28) * light;
      data[offset + 1] = (foreground ? 20 + (noise >> 2) + highlight : 70 + y * 0.35) * light;
      data[offset + 2] =
        (foreground ? 15 + (noise >> 3) + highlight : 108 + (((x >> 3) ^ (y >> 3)) & 1) * 14) * light;
      data[offset + 3] = 255;
      truth[y * width + x] = target ? 255 : 0;
    }
  }
  return { imageData: { width, height, data }, truth, point };
};

export const scoreSegmentationMask = (prediction, truth) => {
  if (
    !(prediction instanceof Uint8Array) ||
    !(truth instanceof Uint8Array) ||
    prediction.length !== truth.length ||
    truth.length === 0
  )
    throw new TypeError('Segmentation scoring requires matching nonempty binary masks');
  let intersection = 0;
  let predictedPixels = 0;
  let targetPixels = 0;
  for (let index = 0; index < truth.length; index++) {
    if (
      (prediction[index] !== 0 && prediction[index] !== 255) ||
      (truth[index] !== 0 && truth[index] !== 255)
    )
      throw new TypeError('Masks must contain only 0 and 255');
    predictedPixels += Number(prediction[index] > 0);
    targetPixels += Number(truth[index] > 0);
    intersection += Number(prediction[index] > 0 && truth[index] > 0);
  }
  const union = targetPixels + predictedPixels - intersection;
  return {
    iou: union === 0 ? 1 : intersection / union,
    precision: predictedPixels === 0 ? null : intersection / predictedPixels,
    recall: targetPixels === 0 ? null : intersection / targetPixels,
    falseForegroundFraction: (predictedPixels - intersection) / truth.length,
    targetPixels,
    predictedPixels,
  };
};

export const summarizeDurations = (values) => {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0))
    throw new TypeError('Timing samples must be nonempty, finite and non-negative');
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maximumMs: sorted.at(-1),
  };
};

const hashBytes = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');

export const assertSegmentationMeasurement = (
  { backendId, objectSupportMask, timings, roundTripMs },
  expected,
) => {
  if (
    backendId !== expected.backendId ||
    objectSupportMask.width !== expected.width ||
    objectSupportMask.height !== expected.height ||
    objectSupportMask.createdAtFrame !== expected.frameId ||
    objectSupportMask.updatedAtFrame !== expected.frameId ||
    objectSupportMask.source !== 'interactive-segmenter' ||
    !Number.isFinite(objectSupportMask.confidence) ||
    objectSupportMask.confidence < 0 ||
    objectSupportMask.confidence > 1 ||
    !(objectSupportMask.data instanceof Uint8Array) ||
    objectSupportMask.data.length !== expected.width * expected.height
  )
    throw new Error('Segmentation measurement ownership or raster mismatch');
  if (typeof timings.cold !== 'boolean')
    throw new TypeError('Segmentation measurement requires an explicit cold/warm state');
  if (!timings.cold && timings.initializationMs !== 0)
    throw new Error('Warm segmentation cannot include model initialization');
  for (const field of [
    'initializationMs',
    'segmentCallMs',
    'maskReadbackAndSyncMs',
    'maskPostprocessMs',
    'totalMs',
  ])
    summarizeDurations([timings[field]]);
  summarizeDurations([roundTripMs]);
  if (
    timings.initializationMs +
      timings.segmentCallMs +
      timings.maskReadbackAndSyncMs +
      timings.maskPostprocessMs >
      timings.totalMs + 0.1 ||
    timings.totalMs > roundTripMs + 1
  )
    throw new Error('Segmentation timing envelopes are inconsistent');
};

export const runSegmentationExperiment = async ({ workerUrl, backendId, model, runtime }) => {
  const worker = new Worker(workerUrl, { type: 'module' });
  let requestId = 0;
  const samples = [];
  let coldStart = null;
  let backendInfo = null;
  const request = (imageData, tapPosition, frameId) =>
    new Promise((resolve, reject) => {
      const copiedAt = performance.now();
      const data = imageData.data.slice();
      const sentAt = performance.now();
      const id = ++requestId;
      const timeout = setTimeout(() => {
        reject(new Error('Segmentation experiment request timed out'));
      }, 60_000);
      worker.onmessage = ({ data: message }) => {
        if (message.requestId !== id) {
          clearTimeout(timeout);
          reject(new Error('Segmentation response ID mismatch'));
          return;
        }
        clearTimeout(timeout);
        if (message.type === 'segment-error') {
          backendInfo = message.backendInfo;
          reject(Object.assign(new Error(message.reason), { code: message.code }));
          return;
        }
        if (message.type !== 'segment-result' || message.backendId !== backendId) {
          reject(new Error('Segmentation backend response mismatch'));
          return;
        }
        const observation = {
          ...message,
          callerCopyMs: sentAt - copiedAt,
          roundTripMs: performance.now() - sentAt,
        };
        try {
          assertSegmentationMeasurement(observation, {
            backendId,
            width: imageData.width,
            height: imageData.height,
            frameId,
          });
          resolve(observation);
        } catch (error) {
          reject(error);
        }
      };
      worker.onerror = (error) => {
        clearTimeout(timeout);
        reject(new Error(`Segmentation worker runtime failed: ${error.message || error.type}`));
      };
      worker.onmessageerror = () => {
        clearTimeout(timeout);
        reject(new Error('Segmentation response deserialization failed'));
      };
      worker.postMessage(
        {
          type: 'segment',
          backendId,
          requestId: id,
          imageData: { ...imageData, data },
          tapPosition,
          createdAtFrame: frameId,
        },
        [data.buffer],
      );
    });
  const environment = {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    webgpuAdvertised: Boolean(navigator.gpu),
    deviceEvidence: 'browser-on-desktop-host; mobile emulation is not physical-device evidence',
  };
  try {
    for (const entry of SEGMENTATION_EXPERIMENT_CASES) {
      const { imageData, truth, point } = createSegmentationProbe(entry.id);
      const inputSha256 = await hashBytes(imageData.data);
      const truthSha256 = await hashBytes(truth);
      for (let warmup = 0; warmup < SEGMENTATION_EXPERIMENT_POLICY.warmupRuns; warmup++) {
        const observation = await request(imageData, point, 0);
        if (coldStart === null) {
          if (!observation.timings.cold || !observation.backendInfo)
            throw new Error('First segmentation sample must identify its cold backend');
          backendInfo = observation.backendInfo;
          coldStart = { ...observation.timings, roundTripMs: observation.roundTripMs };
        }
      }
      const observations = [];
      for (let index = 0; index < SEGMENTATION_EXPERIMENT_POLICY.measuredRuns; index++) {
        const observation = await request(imageData, point, index + 1);
        if (observation.timings.cold !== false)
          throw new Error('Warm experiment sample reinitialized its model');
        const quality = scoreSegmentationMask(observation.objectSupportMask.data, truth);
        observations.push({
          ...observation.timings,
          callerCopyMs: observation.callerCopyMs,
          roundTripMs: observation.roundTripMs,
          quality,
        });
      }
      const timing = {};
      for (const field of [
        'segmentCallMs',
        'maskReadbackAndSyncMs',
        'maskPostprocessMs',
        'totalMs',
        'callerCopyMs',
        'roundTripMs',
      ])
        timing[field] = summarizeDurations(observations.map((sample) => sample[field]));
      const minimumIou = Math.min(...observations.map(({ quality }) => quality.iou));
      const maximumFalseForegroundFraction = Math.max(
        ...observations.map(({ quality }) => quality.falseForegroundFraction),
      );
      const empty = observations[0].quality.targetPixels === 0;
      samples.push({
        id: entry.id,
        width: entry.width,
        height: entry.height,
        inputSha256,
        truthSha256,
        minimumIou,
        maximumFalseForegroundFraction,
        targetMet: empty
          ? maximumFalseForegroundFraction <= SEGMENTATION_EXPERIMENT_POLICY.maximumEmptyForegroundFraction
          : minimumIou >= SEGMENTATION_EXPERIMENT_POLICY.minimumIou,
        timing,
        observations,
      });
    }
    return {
      protocol: SEGMENTATION_EXPERIMENT_PROTOCOL,
      status: 'completed',
      backendId,
      backendInfo,
      model,
      runtime,
      environment,
      policy: SEGMENTATION_EXPERIMENT_POLICY,
      coldStart,
      samples,
      error: null,
    };
  } catch (error) {
    return {
      protocol: SEGMENTATION_EXPERIMENT_PROTOCOL,
      status: error.code === 'BACKEND_UNAVAILABLE' ? 'unavailable' : 'failed',
      backendId,
      backendInfo,
      model,
      runtime,
      environment,
      policy: SEGMENTATION_EXPERIMENT_POLICY,
      coldStart,
      samples,
      error: error.message,
    };
  } finally {
    worker.terminate();
  }
};
