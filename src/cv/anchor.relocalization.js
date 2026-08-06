import { fitRobustAffine2D, fitRobustSimilarity } from './anchor.reconstructionRobust.js';
import { isReconstructionEligibleLandmark } from './landmarkOwnership.js';

const ORB_DESCRIPTOR_WORDS = 8;
const ORB_EDGE_THRESHOLD = 23;
const ORB_FAST_THRESHOLD = 6;
const RICH_VIEW_REDUNDANT_KEYFRAME_MOTION = 5;
const MIN_RICH_VIEW_LANDMARKS = 13;
const TRANSLATION_INVARIANT_REDUNDANT_KEYFRAME_MOTION = 4;

const DEFAULT_CONFIG = Object.freeze({
  maxKeyframes: 6,
  maxEntriesPerKeyframe: 96,
  maxStorageFeatures: 1000,
  maxQueryFeatures: 1000,
  minMatches: 5,
  minInliers: 5,
  minKeyframeEntries: 8,
  minAffineInliers: 6,
  minInlierRatio: 0.5,
  ratioThreshold: 0.92,
  maxDescriptorDistance: 72,
  inlierThreshold: 10,
  associationRadius: 16,
  minSpatialSpread: 18,
  minLinearScale: 0.3,
  maxLinearScale: 3,
  maxAffineAnisotropy: 2.4,
  maxAverageResidual: 5.5,
  minObservations: 5,
  minTrackingStreak: 3,
  minLandmarkQuality: 0.48,
  redundantKeyframeMotion: 4,
  minNewLandmarks: 4,
});

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const requiredKeyframeEntries = (config) => Math.max(config.minMatches, config.minKeyframeEntries);

const popcount32 = (value) => {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const descriptorWords = (feature) =>
  feature.descriptorWords ||
  new Uint32Array(
    feature.descriptor.buffer,
    feature.descriptor.byteOffset,
    feature.descriptor.byteLength / Uint32Array.BYTES_PER_ELEMENT,
  );

const hammingDistanceAt = (left, right, offset) =>
  popcount32(left[0] ^ right[offset]) +
  popcount32(left[1] ^ right[offset + 1]) +
  popcount32(left[2] ^ right[offset + 2]) +
  popcount32(left[3] ^ right[offset + 3]) +
  popcount32(left[4] ^ right[offset + 4]) +
  popcount32(left[5] ^ right[offset + 5]) +
  popcount32(left[6] ^ right[offset + 6]) +
  popcount32(left[7] ^ right[offset + 7]);

const createNearest = () => ({
  bestIndex: -1,
  bestDistance: Infinity,
  secondDistance: Infinity,
});

const passesRatio = ({ bestDistance, secondDistance }, ratioThreshold) =>
  bestDistance < secondDistance * ratioThreshold;

const flattenDescriptorWords = (features) => {
  const words = new Uint32Array(features.length * ORB_DESCRIPTOR_WORDS);
  for (let index = 0; index < features.length; index++) {
    words.set(descriptorWords(features[index]), index * ORB_DESCRIPTOR_WORDS);
  }
  return words;
};

const matchOrbDescriptorBuffer = (
  references,
  queryDescriptorWords,
  queryCount,
  queryAt,
  {
    ratioThreshold = DEFAULT_CONFIG.ratioThreshold,
    maxDescriptorDistance = DEFAULT_CONFIG.maxDescriptorDistance,
  } = {},
) => {
  if (references.length === 0 || queryCount === 0) {
    return [];
  }

  const referenceDescriptors = references.map(descriptorWords);
  const referenceToQuery = references.map(createNearest);
  const queryToReference = Array.from({ length: queryCount }, createNearest);
  for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex++) {
    const forward = referenceToQuery[referenceIndex];
    for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
      const distance = hammingDistanceAt(
        referenceDescriptors[referenceIndex],
        queryDescriptorWords,
        queryIndex * ORB_DESCRIPTOR_WORDS,
      );
      if (distance < forward.bestDistance) {
        forward.secondDistance = forward.bestDistance;
        forward.bestDistance = distance;
        forward.bestIndex = queryIndex;
      } else if (distance < forward.secondDistance) {
        forward.secondDistance = distance;
      }

      const reverse = queryToReference[queryIndex];
      if (distance < reverse.bestDistance) {
        reverse.secondDistance = reverse.bestDistance;
        reverse.bestDistance = distance;
        reverse.bestIndex = referenceIndex;
      } else if (distance < reverse.secondDistance) {
        reverse.secondDistance = distance;
      }
    }
  }
  const matches = [];

  referenceToQuery.forEach((forward, referenceIndex) => {
    if (
      forward.bestIndex < 0 ||
      forward.bestDistance > maxDescriptorDistance ||
      !passesRatio(forward, ratioThreshold)
    ) {
      return;
    }

    const reverse = queryToReference[forward.bestIndex];
    if (reverse.bestIndex !== referenceIndex || reverse.bestDistance >= reverse.secondDistance) {
      return;
    }

    const reference = references[referenceIndex];
    const query = queryAt(forward.bestIndex);
    matches.push({
      id: reference.id,
      reference: { ...reference.reference },
      landmarkReference: { ...(reference.landmarkReference || reference.reference) },
      referenceOffset: { ...(reference.referenceOffset || { x: 0, y: 0 }) },
      point: { ...query.point },
      descriptorDistance: forward.bestDistance,
      response: Math.min(reference.response || 0, query.response || 0),
    });
  });

  return matches.sort((left, right) => left.descriptorDistance - right.descriptorDistance);
};

export const matchOrbDescriptors = (references, queries, config = {}) =>
  matchOrbDescriptorBuffer(
    references,
    flattenDescriptorWords(queries),
    queries.length,
    (index) => queries[index],
    config,
  );

export const selectRelocalizationLandmarks = (
  trackedPoints,
  {
    minObservations = DEFAULT_CONFIG.minObservations,
    minTrackingStreak = DEFAULT_CONFIG.minTrackingStreak,
    minLandmarkQuality = DEFAULT_CONFIG.minLandmarkQuality,
    maxEntries = DEFAULT_CONFIG.maxEntriesPerKeyframe,
    includeFreshLandmarks = false,
  } = {},
) =>
  trackedPoints
    .filter((point) => point.status === 'active')
    .filter(isReconstructionEligibleLandmark)
    .filter((point) => point.recentDropout !== true)
    .filter(
      (point) =>
        includeFreshLandmarks ||
        ((point.totalSuccessfulFrames || 0) >= minObservations &&
          (point.successfulTrackingStreak || 0) >= minTrackingStreak &&
          (point.landmarkQuality || 0) >= minLandmarkQuality),
    )
    .filter((point) => Number.isFinite(point.original?.x) && Number.isFinite(point.original?.y))
    .filter((point) => Number.isFinite(point.current?.x) && Number.isFinite(point.current?.y))
    .sort((left, right) => {
      const qualityDelta = (right.landmarkQuality || 0) - (left.landmarkQuality || 0);
      if (Math.abs(qualityDelta) > 1e-6) return qualityDelta;
      const observationDelta = (right.totalSuccessfulFrames || 0) - (left.totalSuccessfulFrames || 0);
      if (observationDelta !== 0) return observationDelta;
      return (right.response || 0) - (left.response || 0);
    })
    .slice(0, maxEntries);

const createOrbDetector = (cv, maxFeatures) => {
  const detector = new cv.ORB();
  detector.setMaxFeatures(maxFeatures);
  detector.setScaleFactor(1.2);
  detector.setNLevels(8);
  detector.setEdgeThreshold(ORB_EDGE_THRESHOLD);
  detector.setPatchSize(ORB_EDGE_THRESHOLD);
  detector.setFastThreshold(ORB_FAST_THRESHOLD);
  return detector;
};

const createOrbExtractionWorkspace = (cv, maxFeatures) => ({
  detector: createOrbDetector(cv, maxFeatures),
  mask: new cv.Mat(),
  keypoints: new cv.KeyPointVector(),
  descriptors: new cv.Mat(),
  maxFeatures,
});

const prepareOrbExtractionWorkspace = (workspace, maxFeatures) => {
  if (workspace.maxFeatures !== maxFeatures) {
    workspace.detector.setMaxFeatures(maxFeatures);
    workspace.maxFeatures = maxFeatures;
  }
  return workspace;
};

const disposeOrbExtractionWorkspace = (workspace) => {
  workspace.detector.delete();
  workspace.mask.delete();
  workspace.keypoints.delete();
  workspace.descriptors.delete();
};

const normalizeSearchRegion = (grayImage, searchRegion) => {
  if (searchRegion == null) {
    return null;
  }

  const { x, y, width, height } = searchRegion;
  const integerValues = [x, y, width, height].every(Number.isInteger);
  const insideImage =
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= grayImage.cols &&
    y + height <= grayImage.rows;
  if (!integerValues || !insideImage) {
    throw new RangeError('ORB search region must be an integer rectangle inside the image');
  }

  return { x, y, width, height };
};

const extractOrbFeatureSet = (cv, grayImage, { workspace, maxFeatures, searchRegion = null }) => {
  const startedAt = performance.now();
  const normalizedSearchRegion = normalizeSearchRegion(grayImage, searchRegion);
  const searchImage = normalizedSearchRegion
    ? grayImage.roi(
        new cv.Rect(
          normalizedSearchRegion.x,
          normalizedSearchRegion.y,
          normalizedSearchRegion.width,
          normalizedSearchRegion.height,
        ),
      )
    : grayImage;
  const { detector, mask, keypoints, descriptors } = prepareOrbExtractionWorkspace(workspace, maxFeatures);
  detector.detectAndCompute(searchImage, mask, keypoints, descriptors);

  const descriptorBytes = descriptors.data.subarray(0, keypoints.size() * descriptors.cols);
  const descriptorSize = descriptors.cols;
  const queryFeatures = new Array(keypoints.size());
  const featureAt = (index) => {
    if (queryFeatures[index]) {
      return queryFeatures[index];
    }
    const keypoint = keypoints.get(index);
    const feature = {
      point: {
        x: keypoint.pt.x + (normalizedSearchRegion?.x || 0),
        y: keypoint.pt.y + (normalizedSearchRegion?.y || 0),
      },
      response: keypoint.response,
    };
    queryFeatures[index] = feature;
    return feature;
  };

  if (normalizedSearchRegion) {
    searchImage.delete();
  }
  return {
    count: keypoints.size(),
    descriptorBytes,
    descriptorWords: new Uint32Array(
      descriptorBytes.buffer,
      descriptorBytes.byteOffset,
      descriptorBytes.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    ),
    descriptorSize,
    featureAt,
    keypoints,
    pointOffset: {
      x: normalizedSearchRegion?.x || 0,
      y: normalizedSearchRegion?.y || 0,
    },
    startedAt,
    durationMs: performance.now() - startedAt,
  };
};

const materializeOrbPoints = (featureSet) =>
  Array.from({ length: featureSet.count }, (_, index) => featureSet.featureAt(index));

const createFrameFeatures = (featureSet) => ({
  count: featureSet.count,
  descriptorBytes: Uint8Array.from(featureSet.descriptorBytes),
  descriptorSize: featureSet.descriptorSize,
  features: materializeOrbPoints(featureSet),
});

const attachFrameFeatures = (result, frameFeatures) =>
  frameFeatures ? { ...result, frameFeatures } : result;

const matchOrbFeatureSet = (references, featureSet, config) =>
  matchOrbDescriptorBuffer(
    references,
    featureSet.descriptorWords,
    featureSet.count,
    featureSet.featureAt,
    config,
  );

export const associateLandmarkCoordinateIndexes = (featureX, featureY, landmarks, associationRadius) => {
  const maxDistanceSquared = associationRadius * associationRadius;
  const cellSize = associationRadius;
  const rows = new Map();
  for (let featureIndex = 0; featureIndex < featureX.length; featureIndex++) {
    const cellX = Math.floor(featureX[featureIndex] / cellSize);
    const cellY = Math.floor(featureY[featureIndex] / cellSize);
    let row = rows.get(cellY);
    if (!row) {
      row = new Map();
      rows.set(cellY, row);
    }
    const cell = row.get(cellX);
    if (cell) {
      cell.push(featureIndex);
    } else {
      row.set(cellX, [featureIndex]);
    }
  }
  const usedFeatureIndexes = new Uint8Array(featureX.length);
  const associations = [];

  landmarks.forEach((landmark, landmarkIndex) => {
    let bestFeatureIndex = -1;
    let bestDistanceSquared = maxDistanceSquared;
    const minCellX = Math.floor((landmark.current.x - associationRadius) / cellSize);
    const maxCellX = Math.floor((landmark.current.x + associationRadius) / cellSize);
    const minCellY = Math.floor((landmark.current.y - associationRadius) / cellSize);
    const maxCellY = Math.floor((landmark.current.y + associationRadius) / cellSize);
    const candidateIndexes = [];
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      const row = rows.get(cellY);
      if (!row) continue;
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const cell = row.get(cellX);
        if (cell) candidateIndexes.push(...cell);
      }
    }
    candidateIndexes.sort((left, right) => left - right);

    for (const featureIndex of candidateIndexes) {
      if (usedFeatureIndexes[featureIndex]) continue;
      const dx = featureX[featureIndex] - landmark.current.x;
      const dy = featureY[featureIndex] - landmark.current.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared <= bestDistanceSquared) {
        bestFeatureIndex = featureIndex;
        bestDistanceSquared = distanceSquared;
      }
    }

    if (bestFeatureIndex < 0) return;
    usedFeatureIndexes[bestFeatureIndex] = 1;
    associations.push({ landmarkIndex, featureIndex: bestFeatureIndex });
  });

  return associations;
};

const readOrbFeatureColumns = (featureSet) => {
  const x = new Float64Array(featureSet.count);
  const y = new Float64Array(featureSet.count);
  const response = new Float64Array(featureSet.count);
  for (let index = 0; index < featureSet.count; index++) {
    const keypoint = featureSet.keypoints.get(index);
    x[index] = keypoint.pt.x + featureSet.pointOffset.x;
    y[index] = keypoint.pt.y + featureSet.pointOffset.y;
    response[index] = keypoint.response;
  }
  return { x, y, response };
};

const readFeatureColumns = (features) => ({
  x: Float64Array.from(features, (feature) => feature.point.x),
  y: Float64Array.from(features, (feature) => feature.point.y),
  response: Float64Array.from(features, (feature) => feature.response),
});

const createKeyframeEntries = (featureSet, associations, landmarks, featureColumns) => {
  const descriptorBytes = new Uint8Array(associations.length * featureSet.descriptorSize);

  return associations.map(({ landmarkIndex, featureIndex }, entryIndex) => {
    const landmark = landmarks[landmarkIndex];
    const featureX = featureColumns.x[featureIndex];
    const featureY = featureColumns.y[featureIndex];
    const sourceOffset = featureIndex * featureSet.descriptorSize;
    const descriptorOffset = entryIndex * featureSet.descriptorSize;
    descriptorBytes.set(
      featureSet.descriptorBytes.subarray(sourceOffset, sourceOffset + featureSet.descriptorSize),
      descriptorOffset,
    );
    const descriptor = descriptorBytes.subarray(
      descriptorOffset,
      descriptorOffset + featureSet.descriptorSize,
    );
    return {
      id: landmark.id,
      reference: { x: featureX, y: featureY },
      landmarkReference: { x: landmark.original.x, y: landmark.original.y },
      referenceOffset: {
        x: landmark.current.x - featureX,
        y: landmark.current.y - featureY,
      },
      keyframePoint: { x: featureX, y: featureY },
      landmarkPoint: { x: landmark.current.x, y: landmark.current.y },
      descriptor,
      descriptorWords: new Uint32Array(
        descriptor.buffer,
        descriptor.byteOffset,
        descriptor.byteLength / Uint32Array.BYTES_PER_ELEMENT,
      ),
      response: featureColumns.response[featureIndex],
      landmarkQuality: landmark.landmarkQuality,
    };
  });
};

const associateFeatureColumnsWithLandmarks = (featureSet, featureColumns, landmarks, associationRadius) =>
  createKeyframeEntries(
    featureSet,
    associateLandmarkCoordinateIndexes(featureColumns.x, featureColumns.y, landmarks, associationRadius),
    landmarks,
    featureColumns,
  );

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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

const pointSetSpread = (entries, selectPoint) => {
  const points = entries.map(selectPoint);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

export const assessOrbGeometry = (
  fit,
  {
    minSpatialSpread = DEFAULT_CONFIG.minSpatialSpread,
    minLinearScale = DEFAULT_CONFIG.minLinearScale,
    maxLinearScale = DEFAULT_CONFIG.maxLinearScale,
    maxAffineAnisotropy = DEFAULT_CONFIG.maxAffineAnisotropy,
    maxAverageResidual = DEFAULT_CONFIG.maxAverageResidual,
    methodLabel = 'ORB',
  } = {},
) => {
  const [a, b] = fit.transform.rowX;
  const [c, d] = fit.transform.rowY;
  const determinant = a * d - b * c;
  const firstAxisScale = Math.hypot(a, c);
  const secondAxisScale = Math.hypot(b, d);
  const minScale = Math.min(firstAxisScale, secondAxisScale);
  const maxScale = Math.max(firstAxisScale, secondAxisScale);
  const anisotropy = maxScale / Math.max(minScale, 1e-6);
  const referenceSpread = pointSetSpread(fit.inliers, (inlier) => inlier.reference);
  const querySpread = pointSetSpread(fit.inliers, (inlier) => inlier.current || inlier.point);

  let reason = null;
  if (![determinant, firstAxisScale, secondAxisScale].every(Number.isFinite)) {
    reason = `${methodLabel} geometry contains non-finite affine coefficients`;
  } else if (determinant <= 0) {
    reason = `${methodLabel} geometry implies a reflected or collapsed view`;
  } else if (minScale < minLinearScale || maxScale > maxLinearScale) {
    reason = `${methodLabel} geometry scale ${minScale.toFixed(2)}-${maxScale.toFixed(2)} is implausible`;
  } else if (anisotropy > maxAffineAnisotropy) {
    reason = `${methodLabel} affine anisotropy ${anisotropy.toFixed(2)} is implausible`;
  } else if (referenceSpread < minSpatialSpread || querySpread < minSpatialSpread) {
    reason = `${methodLabel} inliers are spatially concentrated (${referenceSpread.toFixed(1)}px/${querySpread.toFixed(1)}px)`;
  } else if (fit.averageResidual > maxAverageResidual) {
    reason = `${methodLabel} geometric residual ${fit.averageResidual.toFixed(2)}px is too high`;
  }

  return {
    valid: reason == null,
    reason,
    determinant,
    firstAxisScale,
    secondAxisScale,
    anisotropy,
    referenceSpread,
    querySpread,
  };
};

const relocalizeAgainstKeyframe = (keyframe, queryFeatureSet, config) => {
  const matches = matchOrbFeatureSet(keyframe.entries, queryFeatureSet, config);
  if (matches.length < config.minMatches) {
    return {
      success: false,
      reason: `Keyframe ${keyframe.id} produced only ${matches.length} reciprocal ORB matches`,
      matchCount: matches.length,
      keyframeId: keyframe.id,
    };
  }

  const observations = matches.map((match) => ({
    ...match,
    current: match.point,
    quality: clamp01(1 - match.descriptorDistance / 128) * 0.8 + clamp01(match.response) * 0.2,
  }));
  const affineFit = fitRobustAffine2D(observations, {
    minInliers: config.minInliers,
    threshold: config.inlierThreshold,
    maxSample: 20,
    sampleCoverage: 'spatial',
  });
  const similarityFit = fitRobustSimilarity(observations, {
    minInliers: config.minInliers,
    threshold: config.inlierThreshold,
    maxSample: 24,
  });
  const unvalidatedAffineCandidate =
    affineFit.success &&
    affineFit.inlierCount >= config.minAffineInliers &&
    affineFit.inlierRatio >= config.minInlierRatio
      ? { ...affineFit, model: 'affine' }
      : null;
  const unvalidatedSimilarityCandidate =
    similarityFit.success && similarityFit.inlierRatio >= config.minInlierRatio
      ? {
          ...similarityFit,
          transform: similarityToAffine(similarityFit.transform),
          model: 'similarity',
        }
      : null;
  const affineAssessment = unvalidatedAffineCandidate
    ? assessOrbGeometry(unvalidatedAffineCandidate, config)
    : null;
  const similarityAssessment = unvalidatedSimilarityCandidate
    ? assessOrbGeometry(unvalidatedSimilarityCandidate, config)
    : null;
  const affineCandidate = affineAssessment?.valid
    ? { ...unvalidatedAffineCandidate, geometry: affineAssessment }
    : null;
  const similarityCandidate = similarityAssessment?.valid
    ? { ...unvalidatedSimilarityCandidate, geometry: similarityAssessment }
    : null;
  const fit =
    affineCandidate && similarityCandidate
      ? affineCandidate.inlierCount >= similarityCandidate.inlierCount + 2 &&
        affineCandidate.averageResidual <= similarityCandidate.averageResidual
        ? affineCandidate
        : similarityCandidate
      : affineCandidate || similarityCandidate;

  if (!fit) {
    return {
      success: false,
      reason:
        affineAssessment?.reason ||
        similarityAssessment?.reason ||
        affineFit.reason ||
        similarityFit.reason ||
        'No robust ORB geometric consensus',
      matchCount: matches.length,
      inlierCount: Math.max(affineFit.inlierCount || 0, similarityFit.inlierCount || 0),
      keyframeId: keyframe.id,
    };
  }

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
    descriptorDistance: inlier.descriptorDistance,
    response: inlier.response,
  }));

  return {
    success: true,
    method: 'orb-keyframe-relocalization',
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
    anchorPoint: applyAffine(keyframe.anchorPoint, fit.transform),
    inlierMatches,
    inlierIds: inlierMatches.map((match) => match.id),
    matchCount: matches.length,
    inlierCount: fit.inlierCount,
    inlierRatio: fit.inlierRatio,
    averageResidual: fit.averageResidual,
    confidence: fit.confidence,
    keyframeId: keyframe.id,
  };
};

export class OrbKeyframeRelocalizer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.keyframes = [];
    this.nextKeyframeId = 0;
    this.lastResult = null;
    this.extractionWorkspace = null;
  }

  hasKeyframes() {
    return this.keyframes.some((keyframe) => keyframe.entries.length >= this.config.minMatches);
  }

  getKeyframeCount() {
    return this.keyframes.length;
  }

  clear() {
    this.keyframes = [];
    this.nextKeyframeId = 0;
    this.lastResult = null;
  }

  dispose() {
    this.clear();
    if (this.extractionWorkspace) {
      disposeOrbExtractionWorkspace(this.extractionWorkspace);
      this.extractionWorkspace = null;
    }
  }

  _getExtractionWorkspace(cv, maxFeatures) {
    if (!this.extractionWorkspace) {
      this.extractionWorkspace = createOrbExtractionWorkspace(cv, maxFeatures);
    }
    return this.extractionWorkspace;
  }

  storeKeyframe({
    cv,
    grayImage,
    trackedPoints,
    anchorPoint,
    timestamp = performance.now(),
    includeFreshLandmarks = false,
    frameFeatures = null,
    translationInvariantRedundancy = false,
  }) {
    const landmarks = selectRelocalizationLandmarks(trackedPoints || [], {
      minObservations: this.config.minObservations,
      minTrackingStreak: this.config.minTrackingStreak,
      minLandmarkQuality: this.config.minLandmarkQuality,
      maxEntries: this.config.maxEntriesPerKeyframe,
      includeFreshLandmarks,
    });

    const selectionLabel = includeFreshLandmarks ? 'active object-owned' : 'mature object-owned';
    const requiredEntries = requiredKeyframeEntries(this.config);

    if (landmarks.length < requiredEntries) {
      this.lastResult = {
        success: false,
        reason: `Only ${landmarks.length} ${selectionLabel} landmarks available for ORB keyframe storage`,
        keyframeCount: this.keyframes.length,
        descriptorCount: 0,
        storageEvaluated: landmarks.length >= this.config.minMatches,
      };
      return this.lastResult;
    }

    if (this._isRedundantLandmarkView(landmarks, translationInvariantRedundancy)) {
      this.lastResult = {
        success: false,
        reason: translationInvariantRedundancy
          ? 'ORB keyframe view is redundant after common translation alignment'
          : 'ORB keyframe view is redundant with the latest stored view',
        keyframeCount: this.keyframes.length,
        descriptorCount: 0,
        storageEvaluated: false,
      };
      return this.lastResult;
    }

    const extractedFeatureSet = frameFeatures
      ? null
      : extractOrbFeatureSet(cv, grayImage, {
          workspace: this._getExtractionWorkspace(cv, this.config.maxStorageFeatures),
          maxFeatures: this.config.maxStorageFeatures,
        });
    const featureSet = frameFeatures || extractedFeatureSet;
    const featureColumns = extractedFeatureSet
      ? readOrbFeatureColumns(extractedFeatureSet)
      : readFeatureColumns(frameFeatures.features);
    const featureExtractionMs = extractedFeatureSet
      ? performance.now() - extractedFeatureSet.startedAt
      : null;
    const entries = associateFeatureColumnsWithLandmarks(
      featureSet,
      featureColumns,
      landmarks,
      this.config.associationRadius,
    );
    const extractionTiming = featureExtractionMs == null ? {} : { featureExtractionMs };

    if (entries.length < requiredEntries) {
      this.lastResult = {
        success: false,
        reason: `Only ${entries.length} ${selectionLabel} landmarks had nearby ORB descriptors`,
        keyframeCount: this.keyframes.length,
        descriptorCount: entries.length,
        storageEvaluated: true,
        ...extractionTiming,
      };
      return this.lastResult;
    }

    if (this._isRedundantKeyframe(entries)) {
      this.lastResult = {
        success: false,
        reason: 'ORB keyframe view is redundant with the latest stored view',
        keyframeCount: this.keyframes.length,
        descriptorCount: entries.length,
        storageEvaluated: true,
        ...extractionTiming,
      };
      return this.lastResult;
    }

    this.keyframes.push({
      id: this.nextKeyframeId++,
      timestamp,
      entries,
      anchorPoint: { x: anchorPoint.x, y: anchorPoint.y },
    });
    if (this.keyframes.length > this.config.maxKeyframes) {
      this.keyframes = this.keyframes.slice(-this.config.maxKeyframes);
    }

    this.lastResult = {
      success: true,
      keyframeCount: this.keyframes.length,
      descriptorCount: entries.length,
      storageEvaluated: true,
      ...extractionTiming,
    };
    return this.lastResult;
  }

  relocalize(cv, grayImage, { searchRegion = null } = {}) {
    const normalizedSearchRegion = normalizeSearchRegion(grayImage, searchRegion);
    const featureSet = extractOrbFeatureSet(cv, grayImage, {
      workspace: this._getExtractionWorkspace(cv, this.config.maxQueryFeatures),
      maxFeatures: this.config.maxQueryFeatures,
      searchRegion: normalizedSearchRegion,
    });
    const timings = {
      featureExtractionMs: featureSet.durationMs,
      keyframeSearchMs: 0,
    };
    const canReuseFrameFeatures =
      normalizedSearchRegion == null &&
      featureSet.count >= requiredKeyframeEntries(this.config) &&
      this.config.maxQueryFeatures === this.config.maxStorageFeatures;
    if (featureSet.count < this.config.minMatches) {
      const insufficientFrameFeatures = canReuseFrameFeatures ? createFrameFeatures(featureSet) : null;
      this.lastResult = {
        success: false,
        reason: `Only ${featureSet.count} ORB features detected in the recovery frame`,
        keyframeCount: this.keyframes.length,
        queryFeatureCount: featureSet.count,
        searchRegion: normalizedSearchRegion,
        timings,
      };
      return attachFrameFeatures(this.lastResult, insufficientFrameFeatures);
    }

    const keyframeSearchStartedAt = performance.now();
    const results = this.keyframes.map((keyframe) =>
      relocalizeAgainstKeyframe(keyframe, featureSet, this.config),
    );
    timings.keyframeSearchMs = performance.now() - keyframeSearchStartedAt;
    const queryFeatureCount = featureSet.count;
    const successful = results
      .filter((result) => result.success)
      .sort(
        (left, right) =>
          right.inlierCount - left.inlierCount ||
          right.inlierRatio - left.inlierRatio ||
          left.averageResidual - right.averageResidual,
      );
    const frameFeatures = canReuseFrameFeatures ? createFrameFeatures(featureSet) : null;

    if (successful.length === 0) {
      const bestFailure = results.sort(
        (left, right) =>
          (right.inlierCount || 0) - (left.inlierCount || 0) ||
          (right.matchCount || 0) - (left.matchCount || 0),
      )[0];
      this.lastResult = {
        success: false,
        reason: bestFailure?.reason || 'No ORB keyframe produced a geometric consensus',
        keyframeCount: this.keyframes.length,
        queryFeatureCount,
        matchCount: bestFailure?.matchCount || 0,
        inlierCount: bestFailure?.inlierCount || 0,
        searchRegion: normalizedSearchRegion,
        timings,
      };
      return attachFrameFeatures(this.lastResult, frameFeatures);
    }

    this.lastResult = {
      ...successful[0],
      keyframeCount: this.keyframes.length,
      queryFeatureCount,
      searchRegion: normalizedSearchRegion,
      timings,
    };
    return attachFrameFeatures(this.lastResult, frameFeatures);
  }

  _isRedundantKeyframe(entries) {
    const latest = this.keyframes.at(-1);
    if (!latest) return false;

    const latestById = new Map(latest.entries.map((entry) => [entry.id, entry]));
    const shared = entries.filter((entry) => latestById.has(entry.id));
    const newLandmarks = entries.length - shared.length;
    if (shared.length < this.config.minMatches || newLandmarks >= this.config.minNewLandmarks) {
      return false;
    }

    const displacements = shared.map((entry) => {
      const previous = latestById.get(entry.id);
      return Math.hypot(
        entry.landmarkPoint.x - previous.landmarkPoint.x,
        entry.landmarkPoint.y - previous.landmarkPoint.y,
      );
    });
    return median(displacements) < this.config.redundantKeyframeMotion;
  }

  _isRedundantLandmarkView(landmarks, translationInvariantRedundancy = false) {
    const latest = this.keyframes.at(-1);
    if (!latest) return false;

    const latestById = new Map(latest.entries.map((entry) => [entry.id, entry]));
    const shared = landmarks.filter((landmark) => latestById.has(landmark.id));
    const newLandmarks = landmarks.length - shared.length;
    if (shared.length < this.config.minMatches || newLandmarks >= this.config.minNewLandmarks) {
      return false;
    }

    if (!translationInvariantRedundancy) {
      const displacements = shared.map((landmark) => {
        const previous = latestById.get(landmark.id);
        return Math.hypot(
          landmark.current.x - previous.landmarkPoint.x,
          landmark.current.y - previous.landmarkPoint.y,
        );
      });
      const motionThreshold =
        shared.length >= MIN_RICH_VIEW_LANDMARKS
          ? RICH_VIEW_REDUNDANT_KEYFRAME_MOTION
          : this.config.redundantKeyframeMotion;
      return median(displacements) < motionThreshold;
    }

    const translations = shared.map((landmark) => {
      const previous = latestById.get(landmark.id);
      return {
        x: landmark.current.x - previous.landmarkPoint.x,
        y: landmark.current.y - previous.landmarkPoint.y,
      };
    });
    const translationX = median(translations.map((translation) => translation.x));
    const translationY = median(translations.map((translation) => translation.y));
    const deformation = translations.map((translation) =>
      Math.hypot(translation.x - translationX, translation.y - translationY),
    );
    return median(deformation) < TRANSLATION_INVARIANT_REDUNDANT_KEYFRAME_MOTION;
  }
}
