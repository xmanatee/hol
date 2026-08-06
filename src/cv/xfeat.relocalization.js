import { fitRobustAffine2D, fitRobustSimilarity } from './anchor.reconstructionRobust.js';
import {
  associateLandmarkCoordinateIndexes,
  assessOrbGeometry,
  selectRelocalizationLandmarks,
} from './anchor.relocalization.js';
import {
  ORT_WASM_ASSET_URL,
  ORT_WASM_LOADER_ASSET_URL,
  XFEAT_ASSET_URL,
  XFEAT_DATA_ASSET_URL,
} from '../runtime/capabilityPacks.js';

export const XFEAT_INPUT_WIDTH = 256;
export const XFEAT_INPUT_HEIGHT = 192;

const DESCRIPTOR_SIZE = 64;
const DETECTION_THRESHOLD = 0.05;
const MAX_REFERENCE_FEATURES = 500;
const MAX_QUERY_FEATURES = 500;
const MAX_REFERENCE_ENTRIES = 96;
const MAX_REFERENCE_KEYFRAMES = 2;
const ASSOCIATION_RADIUS = 16;
const MIN_MATCHES = 5;
const MIN_AFFINE_INLIERS = 6;
const MIN_INLIER_RATIO = 0.5;
const INLIER_THRESHOLD = 10;
const MIN_COSINE_SIMILARITY = 0.82;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export const preprocessXFeatImageData = (
  imageData,
  { width = XFEAT_INPUT_WIDTH, height = XFEAT_INPUT_HEIGHT } = {},
) => {
  const data = new Float32Array(3 * width * height);
  const xScale = imageData.width / width;
  const yScale = imageData.height / height;
  const planeSize = width * height;
  for (let y = 0; y < height; y++) {
    const sourceY = (y + 0.5) * yScale - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(imageData.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < width; x++) {
      const sourceX = (x + 0.5) * xScale - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(imageData.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const target = y * width + x;
      for (let channel = 0; channel < 3; channel++) {
        const topLeft = imageData.data[(y0 * imageData.width + x0) * 4 + channel];
        const topRight = imageData.data[(y0 * imageData.width + x1) * 4 + channel];
        const bottomLeft = imageData.data[(y1 * imageData.width + x0) * 4 + channel];
        const bottomRight = imageData.data[(y1 * imageData.width + x1) * 4 + channel];
        const top = topLeft + (topRight - topLeft) * xWeight;
        const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight;
        data[channel * planeSize + target] = (top + (bottom - top) * yWeight) / 255;
      }
    }
  }
  return { data, dims: [1, 3, height, width] };
};

const cubicWeight = (distance) => {
  const x = Math.abs(distance);
  if (x <= 1) return 1.25 * x * x * x - 2.25 * x * x + 1;
  if (x < 2) return -0.75 * x * x * x + 3.75 * x * x - 6 * x + 3;
  return 0;
};

const sampleDescriptor = (descriptors, x, y, imageWidth, imageHeight) => {
  const [, channels, height, width] = descriptors.dims;
  const sampleX = (x * width) / (imageWidth - 1) - 0.5;
  const sampleY = (y * height) / (imageHeight - 1) - 0.5;
  const baseX = Math.floor(sampleX);
  const baseY = Math.floor(sampleY);
  const output = new Float32Array(channels);
  let norm = 0;
  for (let channel = 0; channel < channels; channel++) {
    let value = 0;
    const channelOffset = channel * height * width;
    for (let offsetY = -1; offsetY <= 2; offsetY++) {
      const descriptorY = baseY + offsetY;
      if (descriptorY < 0 || descriptorY >= height) continue;
      const yWeight = cubicWeight(sampleY - descriptorY);
      for (let offsetX = -1; offsetX <= 2; offsetX++) {
        const descriptorX = baseX + offsetX;
        if (descriptorX < 0 || descriptorX >= width) continue;
        value +=
          descriptors.data[channelOffset + descriptorY * width + descriptorX] *
          yWeight *
          cubicWeight(sampleX - descriptorX);
      }
    }
    output[channel] = value;
    norm += value * value;
  }
  const inverseNorm = 1 / Math.max(1e-12, Math.sqrt(norm));
  for (let channel = 0; channel < channels; channel++) {
    output[channel] *= inverseNorm;
  }
  return output;
};

const isLocalMaximum = (data, width, height, x, y) => {
  const value = data[y * width + x];
  for (let offsetY = -2; offsetY <= 2; offsetY++) {
    const sampleY = y + offsetY;
    if (sampleY < 0 || sampleY >= height) continue;
    for (let offsetX = -2; offsetX <= 2; offsetX++) {
      const sampleX = x + offsetX;
      if (sampleX < 0 || sampleX >= width) continue;
      if (data[sampleY * width + sampleX] > value) return false;
    }
  }
  return true;
};

export const postprocessXFeatOutputs = (
  outputs,
  {
    sourceWidth,
    sourceHeight,
    maxFeatures = MAX_QUERY_FEATURES,
    detectionThreshold = DETECTION_THRESHOLD,
  } = {},
) => {
  const [, , height, width] = outputs.heatmap.dims;
  const candidates = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (
        outputs.heatmap.data[index] <= detectionThreshold ||
        !isLocalMaximum(outputs.heatmap.data, width, height, x, y)
      )
        continue;
      candidates.push({
        modelPoint: { x, y },
        point: {
          x: (x * sourceWidth) / width,
          y: (y * sourceHeight) / height,
        },
        response: outputs.heatmap.data[index] * outputs.reliability.data[index],
      });
    }
  }
  candidates.sort((left, right) => right.response - left.response);
  return candidates.slice(0, maxFeatures).map((candidate) => ({
    point: candidate.point,
    response: candidate.response,
    descriptor: sampleDescriptor(
      outputs.descriptors,
      candidate.modelPoint.x,
      candidate.modelPoint.y,
      width,
      height,
    ),
  }));
};

export const matchXFeatDescriptors = (
  references,
  queries,
  { minCosineSimilarity = MIN_COSINE_SIMILARITY } = {},
) => {
  if (references.length === 0 || queries.length === 0) return [];
  const referenceBest = Array.from({ length: references.length }, () => ({
    index: -1,
    similarity: -Infinity,
  }));
  const queryBest = Array.from({ length: queries.length }, () => ({ index: -1, similarity: -Infinity }));
  for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex++) {
    const reference = references[referenceIndex];
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
      const query = queries[queryIndex];
      let similarity = 0;
      for (let channel = 0; channel < DESCRIPTOR_SIZE; channel++) {
        similarity += reference.descriptor[channel] * query.descriptor[channel];
      }
      if (similarity > referenceBest[referenceIndex].similarity) {
        referenceBest[referenceIndex] = { index: queryIndex, similarity };
      }
      if (similarity > queryBest[queryIndex].similarity) {
        queryBest[queryIndex] = { index: referenceIndex, similarity };
      }
    }
  }

  return referenceBest
    .flatMap((best, referenceIndex) => {
      if (best.similarity < minCosineSimilarity || queryBest[best.index].index !== referenceIndex) return [];
      const reference = references[referenceIndex];
      const query = queries[best.index];
      return [
        {
          id: reference.id,
          reference: { ...reference.reference },
          landmarkReference: { ...(reference.landmarkReference || reference.reference) },
          referenceOffset: { ...(reference.referenceOffset || { x: 0, y: 0 }) },
          point: { ...query.point },
          descriptorSimilarity: best.similarity,
          response: Math.min(reference.response || 0, query.response || 0),
        },
      ];
    })
    .sort((left, right) => right.descriptorSimilarity - left.descriptorSimilarity);
};

const similarityToAffine = (transform) => {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    rowX: [transform.scale * cos, -transform.scale * sin, transform.tx],
    rowY: [transform.scale * sin, transform.scale * cos, transform.ty],
  };
};

const applyAffine = (point, transform) => ({
  x: transform.rowX[0] * point.x + transform.rowX[1] * point.y + transform.rowX[2],
  y: transform.rowY[0] * point.x + transform.rowY[1] * point.y + transform.rowY[2],
});

const fitXFeatMatches = (matches) => {
  const observations = matches.map((match) => ({
    ...match,
    current: match.point,
    quality: clamp01(match.descriptorSimilarity),
  }));
  const affineFit = fitRobustAffine2D(observations, {
    minInliers: MIN_MATCHES,
    threshold: INLIER_THRESHOLD,
    maxSample: 20,
    sampleCoverage: 'spatial',
  });
  const similarityFit = fitRobustSimilarity(observations, {
    minInliers: MIN_MATCHES,
    threshold: INLIER_THRESHOLD,
    maxSample: 24,
  });
  const affine =
    affineFit.success &&
    affineFit.inlierCount >= MIN_AFFINE_INLIERS &&
    affineFit.inlierRatio >= MIN_INLIER_RATIO
      ? { ...affineFit, model: 'affine' }
      : null;
  const similarity =
    similarityFit.success && similarityFit.inlierRatio >= MIN_INLIER_RATIO
      ? {
          ...similarityFit,
          transform: similarityToAffine(similarityFit.transform),
          model: 'similarity',
        }
      : null;
  const validAffine = affine
    ? { ...affine, geometry: assessOrbGeometry(affine, { methodLabel: 'XFeat' }) }
    : null;
  const validSimilarity = similarity
    ? { ...similarity, geometry: assessOrbGeometry(similarity, { methodLabel: 'XFeat' }) }
    : null;
  const candidates = [validAffine, validSimilarity].filter((candidate) => candidate?.geometry.valid);
  return (
    candidates.sort(
      (left, right) =>
        right.inlierCount - left.inlierCount ||
        right.inlierRatio - left.inlierRatio ||
        left.averageResidual - right.averageResidual,
    )[0] || null
  );
};

export const createXFeatFeatureExtractor = async ({
  ort,
  model,
  modelData,
  runtimeLoaderUrl = null,
  runtimeWasmUrl = null,
}) => {
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = 1;
  if (runtimeLoaderUrl && runtimeWasmUrl) {
    ort.env.wasm.wasmPaths = {
      mjs: runtimeLoaderUrl,
      wasm: runtimeWasmUrl,
    };
  }
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    externalData: [{ path: 'xfeat_backbone.onnx.data', data: modelData }],
    graphOptimizationLevel: 'all',
  });
  return {
    extract: async (imageData, maxFeatures) => {
      const input = preprocessXFeatImageData(imageData);
      const outputs = await session.run({
        image: new ort.Tensor('float32', input.data, input.dims),
      });
      return postprocessXFeatOutputs(outputs, {
        sourceWidth: imageData.width,
        sourceHeight: imageData.height,
        maxFeatures,
      });
    },
    dispose: () => session.release(),
  };
};

const createDefaultFeatureExtractor = async () => {
  const ort = await import('onnxruntime-web/wasm');
  return createXFeatFeatureExtractor({
    ort,
    model: XFEAT_ASSET_URL,
    modelData: XFEAT_DATA_ASSET_URL,
    runtimeLoaderUrl: ORT_WASM_LOADER_ASSET_URL,
    runtimeWasmUrl: ORT_WASM_ASSET_URL,
  });
};

export class XFeatKeyframeRelocalizer {
  constructor({ extractFeatures = null, featureExtractorFactory = createDefaultFeatureExtractor } = {}) {
    this.extractFeatures = extractFeatures;
    this.featureExtractorFactory = featureExtractorFactory;
    this.featureExtractorPromise = null;
    this.featureExtractor = null;
    this.references = [];
    this.nextReferenceId = 0;
    this.referenceEpoch = 0;
    this.disposed = false;
    this.activeExtractionCount = 0;
    this.pendingFeatureExtractorDisposal = null;
  }

  hasReference() {
    return this.references.some((reference) => reference.entries.length >= MIN_MATCHES);
  }

  clear() {
    this.referenceEpoch++;
    this.references = [];
    this.nextReferenceId = 0;
  }

  dispose() {
    this.clear();
    this.disposed = true;
    if (this.featureExtractor) {
      if (this.activeExtractionCount > 0) {
        this.pendingFeatureExtractorDisposal = this.featureExtractor;
      } else {
        this.featureExtractor.dispose();
      }
    }
    this.featureExtractor = null;
    this.featureExtractorPromise = null;
  }

  async _extract(imageData, maxFeatures) {
    if (this.extractFeatures) return this.extractFeatures(imageData, maxFeatures);
    if (this.disposed) throw new Error('XFeat relocalizer is disposed');
    if (!this.featureExtractorPromise) {
      const featureExtractorPromise = this.featureExtractorFactory().then((createdFeatureExtractor) => {
        if (this.disposed) {
          createdFeatureExtractor.dispose();
          throw new Error('XFeat relocalizer was disposed during runtime initialization');
        }
        this.featureExtractor = createdFeatureExtractor;
        return createdFeatureExtractor;
      });
      this.featureExtractorPromise = featureExtractorPromise;
      featureExtractorPromise.catch(() => {
        if (this.featureExtractorPromise === featureExtractorPromise) {
          this.featureExtractorPromise = null;
        }
      });
    }
    const featureExtractor = await this.featureExtractorPromise;
    this.activeExtractionCount++;
    const extraction = Promise.resolve().then(() => featureExtractor.extract(imageData, maxFeatures));
    return extraction.finally(() => {
      this.activeExtractionCount--;
      if (this.activeExtractionCount === 0 && this.pendingFeatureExtractorDisposal) {
        const pendingDisposal = this.pendingFeatureExtractorDisposal;
        this.pendingFeatureExtractorDisposal = null;
        pendingDisposal.dispose();
      }
    });
  }

  async storeReference({ imageData, trackedPoints, anchorPoint }) {
    const epoch = ++this.referenceEpoch;
    if (this.references.length >= MAX_REFERENCE_KEYFRAMES) {
      return {
        success: false,
        descriptorCount: 0,
        keyframeCount: this.references.length,
        reason: `XFeat reference memory already contains ${MAX_REFERENCE_KEYFRAMES} keyframes`,
      };
    }
    const landmarks = selectRelocalizationLandmarks(trackedPoints || [], {
      maxEntries: MAX_REFERENCE_ENTRIES,
      includeFreshLandmarks: true,
    });
    if (landmarks.length < MIN_MATCHES) {
      return {
        success: false,
        descriptorCount: 0,
        keyframeCount: this.references.length,
        reason: `Only ${landmarks.length} object-owned landmarks available for XFeat reference storage`,
      };
    }
    const startedAt = performance.now();
    const features = await this._extract(imageData, MAX_REFERENCE_FEATURES);
    const associations = associateLandmarkCoordinateIndexes(
      Float64Array.from(features, (feature) => feature.point.x),
      Float64Array.from(features, (feature) => feature.point.y),
      landmarks,
      ASSOCIATION_RADIUS,
    );
    const entries = associations.map(({ landmarkIndex, featureIndex }) => {
      const landmark = landmarks[landmarkIndex];
      const feature = features[featureIndex];
      return {
        id: landmark.id,
        reference: { ...feature.point },
        landmarkReference: { ...landmark.original },
        referenceOffset: {
          x: landmark.current.x - feature.point.x,
          y: landmark.current.y - feature.point.y,
        },
        descriptor: Float32Array.from(feature.descriptor),
        response: feature.response,
      };
    });
    if (epoch !== this.referenceEpoch) {
      return {
        success: false,
        descriptorCount: 0,
        keyframeCount: this.references.length,
        reason: 'XFeat reference storage superseded',
      };
    }
    if (entries.length < MIN_MATCHES) {
      return {
        success: false,
        descriptorCount: entries.length,
        keyframeCount: this.references.length,
        reason: `Only ${entries.length} object-owned landmarks had nearby XFeat descriptors`,
      };
    }
    this.references.push({
      id: this.nextReferenceId++,
      anchorPoint: { ...anchorPoint },
      entries,
    });
    return {
      success: true,
      descriptorCount: entries.length,
      keyframeCount: this.references.length,
      featureExtractionMs: performance.now() - startedAt,
    };
  }

  async relocalize(imageData) {
    if (!this.hasReference()) {
      return { success: false, reason: 'No XFeat reference available' };
    }
    const startedAt = performance.now();
    const features = await this._extract(imageData, MAX_QUERY_FEATURES);
    const featureExtractionMs = performance.now() - startedAt;
    const matchingStartedAt = performance.now();
    const candidates = this.references.map((storedReference) => {
      const referenceMatches = matchXFeatDescriptors(storedReference.entries, features);
      return {
        reference: storedReference,
        matches: referenceMatches,
        fit: referenceMatches.length >= MIN_MATCHES ? fitXFeatMatches(referenceMatches) : null,
      };
    });
    const bestMatchCount = Math.max(...candidates.map((candidate) => candidate.matches.length));
    if (bestMatchCount < MIN_MATCHES) {
      return {
        success: false,
        reason: `XFeat produced only ${bestMatchCount} mutual descriptor matches`,
        matchCount: bestMatchCount,
        queryFeatureCount: features.length,
        timings: {
          featureExtractionMs,
          keyframeSearchMs: performance.now() - matchingStartedAt,
        },
      };
    }
    const winner = candidates
      .filter((candidate) => candidate.fit)
      .sort(
        (left, right) =>
          right.fit.inlierCount - left.fit.inlierCount ||
          right.fit.inlierRatio - left.fit.inlierRatio ||
          left.fit.averageResidual - right.fit.averageResidual,
      )[0];
    if (!winner) {
      return {
        success: false,
        reason: 'No robust XFeat geometric consensus',
        matchCount: bestMatchCount,
        queryFeatureCount: features.length,
        timings: {
          featureExtractionMs,
          keyframeSearchMs: performance.now() - matchingStartedAt,
        },
      };
    }
    const { reference, matches, fit } = winner;
    const inlierMatches = fit.inliers.map((inlier) => ({
      id: inlier.id,
      reference: { ...inlier.landmarkReference },
      point: {
        x:
          inlier.point.x +
          fit.transform.rowX[0] * inlier.referenceOffset.x +
          fit.transform.rowX[1] * inlier.referenceOffset.y,
        y:
          inlier.point.y +
          fit.transform.rowY[0] * inlier.referenceOffset.x +
          fit.transform.rowY[1] * inlier.referenceOffset.y,
      },
      descriptorSimilarity: inlier.descriptorSimilarity,
      response: inlier.response,
    }));
    return {
      success: true,
      method: 'xfeat-keyframe-relocalization',
      transform: {
        type: 'affine',
        rowX: [...fit.transform.rowX],
        rowY: [...fit.transform.rowY],
        confidence: fit.confidence,
        averageResidual: fit.averageResidual,
        model: fit.model,
        determinant: fit.geometry.determinant,
        anisotropy: fit.geometry.anisotropy,
        referenceSpread: fit.geometry.referenceSpread,
        querySpread: fit.geometry.querySpread,
      },
      anchorPoint: applyAffine(reference.anchorPoint, fit.transform),
      inlierMatches,
      inlierIds: inlierMatches.map((match) => match.id),
      matchCount: matches.length,
      inlierCount: fit.inlierCount,
      inlierRatio: fit.inlierRatio,
      averageResidual: fit.averageResidual,
      confidence: fit.confidence,
      queryFeatureCount: features.length,
      keyframeCount: this.references.length,
      keyframeId: reference.id,
      timings: {
        featureExtractionMs,
        keyframeSearchMs: performance.now() - matchingStartedAt,
      },
    };
  }
}
