const DEFAULT_CONFIG = {
  patchRadius: 7,
  patchStep: 2,
  maxKeyframes: 6,
  maxEntriesPerKeyframe: 80,
  maxReferenceEntries: 260,
  maxQueryEntries: 150,
  minMatches: 5,
  minInliers: 4,
  minInlierRatio: 0.35,
  ratioThreshold: 0.9,
  maxDescriptorDistance: 1.2,
  inlierThreshold: 10,
  minPairDistance: 12,
};

const normalizeDescriptor = values => {
  let mean = 0;
  for (let index = 0; index < values.length; index++) {
    mean += values[index];
  }
  mean /= values.length;

  const centered = new Array(values.length);
  let variance = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index] - mean;
    centered[index] = value;
    variance += value * value;
  }
  variance /= values.length;
  const scale = Math.sqrt(variance) || 1;
  const normalized = new Array(values.length);
  let normSquared = 0;
  for (let index = 0; index < values.length; index++) {
    const value = centered[index] / scale;
    normalized[index] = value;
    normSquared += value * value;
  }

  const norm = Math.sqrt(normSquared) || 1;
  for (let index = 0; index < normalized.length; index++) {
    normalized[index] /= norm;
  }
  return normalized;
};

const descriptorDistanceSquared = (left, right) => {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return sum;
};

const transformPoint = (point, transform) => {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.tx + transform.scale * (cos * point.x - sin * point.y),
    y: transform.ty + transform.scale * (sin * point.x + cos * point.y),
  };
};

const fitTransformFromPair = (left, right, minPairDistance) => {
  const sourceDelta = {
    x: right.reference.x - left.reference.x,
    y: right.reference.y - left.reference.y,
  };
  const targetDelta = {
    x: right.point.x - left.point.x,
    y: right.point.y - left.point.y,
  };
  const sourceDistance = Math.hypot(sourceDelta.x, sourceDelta.y);
  const targetDistance = Math.hypot(targetDelta.x, targetDelta.y);

  if (sourceDistance < minPairDistance || targetDistance < minPairDistance * 0.25) {
    return null;
  }

  const scale = targetDistance / sourceDistance;
  const rotation = Math.atan2(targetDelta.y, targetDelta.x) - Math.atan2(sourceDelta.y, sourceDelta.x);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return {
    tx: left.point.x - scale * (cos * left.reference.x - sin * left.reference.y),
    ty: left.point.y - scale * (sin * left.reference.x + cos * left.reference.y),
    scale,
    rotation,
  };
};

const fitSimilarityTransform = matches => {
  const sourceCentroid = matches.reduce((sum, match) => ({
    x: sum.x + match.reference.x / matches.length,
    y: sum.y + match.reference.y / matches.length,
  }), { x: 0, y: 0 });
  const targetCentroid = matches.reduce((sum, match) => ({
    x: sum.x + match.point.x / matches.length,
    y: sum.y + match.point.y / matches.length,
  }), { x: 0, y: 0 });

  let a = 0;
  let b = 0;
  let denominator = 0;
  matches.forEach(match => {
    const sourceX = match.reference.x - sourceCentroid.x;
    const sourceY = match.reference.y - sourceCentroid.y;
    const targetX = match.point.x - targetCentroid.x;
    const targetY = match.point.y - targetCentroid.y;

    a += sourceX * targetX + sourceY * targetY;
    b += sourceX * targetY - sourceY * targetX;
    denominator += sourceX * sourceX + sourceY * sourceY;
  });

  const scale = Math.hypot(a, b) / Math.max(denominator, 1e-6);
  const rotation = Math.atan2(b, a);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return {
    tx: targetCentroid.x - scale * (cos * sourceCentroid.x - sin * sourceCentroid.y),
    ty: targetCentroid.y - scale * (sin * sourceCentroid.x + cos * sourceCentroid.y),
    scale,
    rotation,
  };
};

const scoreTransform = (matches, transform, threshold) => {
  const thresholdSquared = threshold * threshold;
  const inliers = [];
  let residualSum = 0;

  for (const match of matches) {
    const projected = transformPoint(match.reference, transform);
    const dx = projected.x - match.point.x;
    const dy = projected.y - match.point.y;
    const residualSquared = dx * dx + dy * dy;
    if (residualSquared <= thresholdSquared) {
      inliers.push(match);
      residualSum += Math.sqrt(residualSquared);
    }
  }

  const averageResidual = inliers.length > 0 ? residualSum / inliers.length : Infinity;

  return { inliers, averageResidual };
};

export class PatchKeyframeRelocalizer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.keyframes = [];
    this.nextKeyframeId = 0;
    this.lastResult = null;
    this.referenceEntriesCache = null;
  }

  hasKeyframes() {
    return this.keyframes.some(keyframe => keyframe.entries.length >= this.config.minMatches);
  }

  clear() {
    this.keyframes = [];
    this.nextKeyframeId = 0;
    this.lastResult = null;
    this.referenceEntriesCache = null;
  }

  setKeyframeEntries(entries) {
    this.keyframes = [{
      id: this.nextKeyframeId++,
      timestamp: 0,
      entries: entries.map(entry => ({
        id: entry.id,
        reference: { x: entry.reference.x, y: entry.reference.y },
        point: entry.point ? { x: entry.point.x, y: entry.point.y } : { x: entry.reference.x, y: entry.reference.y },
        descriptor: normalizeDescriptor(entry.descriptor),
        response: entry.response || 1,
      })),
    }];
    this.referenceEntriesCache = null;
  }

  storeKeyframeFromTrackedPoints(grayImage, trackedPoints, timestamp = performance.now()) {
    const entries = (trackedPoints || [])
      .filter(point => point.status === 'active')
      .filter(point => Number.isFinite(point.current.x) && Number.isFinite(point.current.y))
      .sort((left, right) => this._pointQuality(right) - this._pointQuality(left))
      .slice(0, this.config.maxEntriesPerKeyframe)
      .map(point => {
        const descriptor = this.extractPatchDescriptor(grayImage, point.current);
        if (!descriptor) return null;
        return {
          id: point.id,
          reference: { x: point.original.x, y: point.original.y },
          point: { x: point.current.x, y: point.current.y },
          descriptor,
          response: point.response || 1,
        };
      })
      .filter(Boolean);

    if (entries.length < this.config.minMatches) {
      this.lastResult = {
        success: false,
        reason: `Only ${entries.length} descriptors available for keyframe storage`,
        keyframeCount: this.keyframes.length,
      };
      return this.lastResult;
    }

    this.keyframes.push({
      id: this.nextKeyframeId++,
      timestamp,
      entries,
    });

    if (this.keyframes.length > this.config.maxKeyframes) {
      this.keyframes = this.keyframes.slice(-this.config.maxKeyframes);
    }
    this.referenceEntriesCache = null;

    this.lastResult = {
      success: true,
      keyframeCount: this.keyframes.length,
      descriptorCount: entries.length,
    };
    return this.lastResult;
  }

  relocalize(grayImage, keypoints) {
    const queryEntries = keypoints
      .sort((left, right) => (right.response || 0) - (left.response || 0))
      .slice(0, this.config.maxQueryEntries)
      .map(keypoint => {
        const point = keypoint.pt || keypoint;
        const descriptor = this.extractPatchDescriptor(grayImage, point);
        if (!descriptor) return null;
        return {
          point: { x: point.x, y: point.y },
          descriptor,
          response: keypoint.response || 1,
        };
      })
      .filter(Boolean);

    return this.relocalizeEntries(queryEntries);
  }

  relocalizeEntries(queryEntries) {
    const matches = this._matchEntries(queryEntries);
    if (matches.length < this.config.minMatches) {
      this.lastResult = {
        success: false,
        reason: `Insufficient descriptor matches: ${matches.length}`,
        matchCount: matches.length,
        queryCount: queryEntries.length,
        keyframeCount: this.keyframes.length,
      };
      return this.lastResult;
    }

    const transformResult = this._estimateTransform(matches);
    this.lastResult = {
      ...transformResult,
      matchCount: matches.length,
      queryCount: queryEntries.length,
      keyframeCount: this.keyframes.length,
    };
    return this.lastResult;
  }

  extractPatchDescriptor(grayImage, point) {
    const radius = this.config.patchRadius;
    const step = this.config.patchStep;
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    const width = grayImage.cols;
    const height = grayImage.rows;
    const data = grayImage.data;

    if (!data || x - radius < 0 || y - radius < 0 || x + radius >= width || y + radius >= height) {
      return null;
    }

    const values = [];
    for (let row = y - radius; row <= y + radius; row += step) {
      const offset = row * width;
      for (let column = x - radius; column <= x + radius; column += step) {
        values.push(data[offset + column] / 255);
      }
    }

    return normalizeDescriptor(values);
  }

  _matchEntries(queryEntries) {
    const references = this._referenceEntries();
    const candidateMatches = [];
    const maxDistanceSquared = this.config.maxDescriptorDistance * this.config.maxDescriptorDistance;
    const ratioThresholdSquared = this.config.ratioThreshold * this.config.ratioThreshold;

    for (const query of queryEntries) {
      let best = null;
      let secondBest = null;

      for (const reference of references) {
        const distanceSquared = descriptorDistanceSquared(reference.descriptor, query.descriptor);
        if (!best || distanceSquared < best.distanceSquared) {
          secondBest = best;
          best = { reference, query, distanceSquared };
        } else if (!secondBest || distanceSquared < secondBest.distanceSquared) {
          secondBest = { reference, query, distanceSquared };
        }
      }

      const ratioPass = secondBest &&
        best.distanceSquared / Math.max(secondBest.distanceSquared, 1e-18) <= ratioThresholdSquared;
      if (best && best.distanceSquared <= maxDistanceSquared && ratioPass) {
        candidateMatches.push({
          id: best.reference.id,
          reference: best.reference.reference,
          point: query.point,
          distance: Math.sqrt(best.distanceSquared),
          response: query.response,
          keyframeId: best.reference.keyframeId,
        });
      }
    }

    const uniqueByLandmark = new Map();
    candidateMatches
      .sort((left, right) => left.distance - right.distance)
      .forEach(match => {
        if (!uniqueByLandmark.has(match.id)) {
          uniqueByLandmark.set(match.id, match);
        }
      });

    return [...uniqueByLandmark.values()]
      .sort((left, right) => left.distance - right.distance)
      .slice(0, this.config.maxReferenceEntries);
  }

  _estimateTransform(matches) {
    let best = null;
    for (let leftIndex = 0; leftIndex < matches.length - 1; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < matches.length; rightIndex++) {
        const transform = fitTransformFromPair(matches[leftIndex], matches[rightIndex], this.config.minPairDistance);
        if (!transform || transform.scale < 0.15 || transform.scale > 6) {
          continue;
        }

        const scored = scoreTransform(matches, transform, this.config.inlierThreshold);
        if (!best ||
            scored.inliers.length > best.inliers.length ||
            (scored.inliers.length === best.inliers.length && scored.averageResidual < best.averageResidual)) {
          best = { transform, ...scored };
        }
      }
    }

    if (!best || best.inliers.length < this.config.minInliers) {
      return {
        success: false,
        reason: best
          ? `Insufficient relocalization inliers: ${best.inliers.length}`
          : 'No coherent relocalization transform',
      };
    }

    const refinedTransform = fitSimilarityTransform(best.inliers);
    const refined = scoreTransform(matches, refinedTransform, this.config.inlierThreshold);
    const inlierRatio = refined.inliers.length / matches.length;

    if (refined.inliers.length < this.config.minInliers || inlierRatio < this.config.minInlierRatio) {
      return {
        success: false,
        reason: `Weak relocalization consensus: ${refined.inliers.length}/${matches.length}`,
        inlierCount: refined.inliers.length,
        inlierRatio,
      };
    }

    const residualScore = Math.max(0, 1 - refined.averageResidual / this.config.inlierThreshold);
    const confidence = inlierRatio * 0.65 + residualScore * 0.35;
    return {
      success: true,
      transform: {
        ...refinedTransform,
        confidence,
        averageResidual: refined.averageResidual,
        inlierCount: refined.inliers.length,
        method: 'patch-keyframe-relocalization',
      },
      confidence,
      inlierCount: refined.inliers.length,
      inlierRatio,
      averageResidual: refined.averageResidual,
      inlierIds: refined.inliers.map(match => match.id),
      method: 'patch-keyframe-relocalization',
    };
  }

  _referenceEntries() {
    if (this.referenceEntriesCache) {
      return this.referenceEntriesCache;
    }

    const entries = [];
    for (const keyframe of this.keyframes) {
      for (const entry of keyframe.entries) {
        entries.push({
          id: entry.id,
          reference: entry.reference,
          point: entry.point,
          descriptor: entry.descriptor,
          response: entry.response,
          keyframeId: keyframe.id,
        });
      }
    }

    this.referenceEntriesCache = entries.slice(-this.config.maxReferenceEntries);
    return this.referenceEntriesCache;
  }

  _pointQuality(point) {
    return (point.response || 0) +
      (point.stabilityScore || 0) +
      Math.min(point.age || 0, 30) / 30 +
      Math.min(point.totalSuccessfulFrames || 0, 90) / 90;
  }
}
