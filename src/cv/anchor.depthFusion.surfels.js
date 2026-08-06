import { clamp } from './anchor.reconstruction.math.js';
import { createSurfacePreview } from './anchor.reconstruction.preview.js';
import {
  calculateDepthGeometry,
  colorAt,
  depthAt,
  invertSimilarityPoint,
  isMaskInterior,
  maskHasPixel,
  median,
} from './anchor.depthFusion.geometry.js';

const EMPTY_STATS = {
  averageSupport: 0,
  averageReliability: 0,
  matureLandmarks: 0,
  geometricConsistency: 0,
  mapConfidence: 0,
  mappedFrames: 0,
};

const createEmptyPreview = ({ poseModel, statistics }) => ({
  poseModel,
  points: [],
  anchor: null,
  surface: {
    model: 'depth-fusion-surfels',
    hull: [],
    edges: [],
    faces: [],
  },
  landmarkCount: 0,
  statistics,
});

const DEFAULT_PREVIEW_POINT_LIMIT = 48;

export class DepthFusionSurfelMap {
  constructor({
    maxSurfels,
    sampleStride,
    voxelSize,
    maxTemporalDepthJump,
    previewPointLimit = DEFAULT_PREVIEW_POINT_LIMIT,
  }) {
    this.maxSurfels = maxSurfels;
    this.sampleStride = sampleStride;
    this.voxelSize = voxelSize;
    this.maxTemporalDepthJump = maxTemporalDepthJump;
    this.previewPointLimit = previewPointLimit;
    this.reset();
  }

  reset() {
    this.surfels = new Map();
  }

  get size() {
    return this.surfels.size;
  }

  fuse({ depthFrame, fit, objectSupportMask, imageData, timestamp, templateRegion, cameraParams }) {
    const samples = this._samples({ depthFrame, objectSupportMask, imageData });
    if (!samples.length) {
      return { accepted: 0, rejected: 0, consistency: 0 };
    }

    const centerDepth = median(samples.map((sample) => sample.value));
    const depthScale = Math.max(templateRegion.width, templateRegion.height, 1) * 0.54;
    let accepted = 0;
    let rejected = 0;
    let residualSum = 0;

    samples.forEach((sample) => {
      const point = this._backProjectSample({
        sample,
        fit,
        centerDepth,
        depthScale,
        cameraParams,
      });
      const key = this._surfelKey(point);
      const previous = this.surfels.get(key);
      if (previous && Math.abs(previous.z - point.z) > this.maxTemporalDepthJump) {
        rejected++;
        residualSum += Math.abs(previous.z - point.z) / this.maxTemporalDepthJump;
        return;
      }

      this._mergeSurfel({ key, point, sample, timestamp });
      accepted++;
    });

    this._prune();
    const rejectionRatio = rejected / Math.max(accepted + rejected, 1);
    return {
      accepted,
      rejected,
      consistency: clamp(1 - rejectionRatio - (residualSum / Math.max(rejected, 1)) * 0.25, 0, 1),
    };
  }

  previewPoints({ limit = 180, frameCount }) {
    return [...this.surfels.values()]
      .sort((left, right) => right.observations * right.confidence - left.observations * left.confidence)
      .slice(0, limit)
      .map((surfel, index) => ({
        id: index,
        x: surfel.x,
        y: surfel.y,
        z: surfel.z,
        cameraX: surfel.cameraX,
        cameraY: surfel.cameraY,
        cameraZ: surfel.cameraZ,
        color: {
          r: Math.round(surfel.color.r),
          g: Math.round(surfel.color.g),
          b: Math.round(surfel.color.b),
        },
        reliability: clamp(
          (surfel.observations / Math.max(frameCount, 1)) * 0.65 + surfel.confidence * 0.35,
          0,
          1,
        ),
        observations: surfel.observations,
      }));
  }

  statistics({ frameCount, minFrames, minSurfels, consistency }) {
    const surfels = [...this.surfels.values()];
    if (!surfels.length) {
      return EMPTY_STATS;
    }

    const averageSupport =
      surfels.reduce((sum, surfel) => sum + clamp(surfel.observations / Math.max(frameCount, 1), 0, 1), 0) /
      surfels.length;
    const averageReliability = surfels.reduce((sum, surfel) => sum + surfel.confidence, 0) / surfels.length;
    const matureLandmarks = surfels.filter(
      (surfel) => surfel.observations >= Math.max(2, minFrames - 1),
    ).length;
    const geometricConsistency = consistency.length
      ? consistency.reduce((sum, value) => sum + value, 0) / consistency.length
      : 0;
    const frameScore = clamp(frameCount / Math.max(minFrames, 1), 0, 1);
    const surfelScore = clamp(matureLandmarks / Math.max(minSurfels, 1), 0, 1);

    return {
      averageSupport,
      averageReliability,
      matureLandmarks,
      geometricConsistency,
      mapConfidence: clamp(
        frameScore * 0.25 + surfelScore * 0.38 + averageReliability * 0.22 + geometricConsistency * 0.15,
        0,
        1,
      ),
      mappedFrames: frameCount,
    };
  }

  measureGeometry() {
    return calculateDepthGeometry(this.surfels.values());
  }

  createPreview({ poseModel, anchor, current = null, frameCount, statistics, points = null }) {
    const previewPoints = points || this.previewPoints({ limit: this.previewPointLimit, frameCount });
    if (!previewPoints.length) {
      return createEmptyPreview({ poseModel, statistics });
    }

    const surface = {
      model: 'depth-fusion-surfels',
      ...createSurfacePreview(previewPoints),
    };

    return {
      poseModel,
      points: previewPoints,
      anchor,
      surface,
      landmarkCount: this.size,
      statistics,
      current: current
        ? {
            ...current,
            points: previewPoints,
            surface,
          }
        : null,
    };
  }

  _samples({ depthFrame, objectSupportMask, imageData }) {
    const samples = [];
    const bbox = objectSupportMask.bbox;
    const sourceWidth = depthFrame.sourceWidth || depthFrame.width;
    const sourceHeight = depthFrame.sourceHeight || depthFrame.height;
    const startX = clamp(
      Math.floor((bbox.x / Math.max(sourceWidth, 1)) * depthFrame.width),
      0,
      depthFrame.width - 1,
    );
    const startY = clamp(
      Math.floor((bbox.y / Math.max(sourceHeight, 1)) * depthFrame.height),
      0,
      depthFrame.height - 1,
    );
    const endX = clamp(
      Math.ceil(((bbox.x + bbox.width) / Math.max(sourceWidth, 1)) * depthFrame.width),
      0,
      depthFrame.width,
    );
    const endY = clamp(
      Math.ceil(((bbox.y + bbox.height) / Math.max(sourceHeight, 1)) * depthFrame.height),
      0,
      depthFrame.height,
    );

    for (let depthY = startY; depthY < endY; depthY += this.sampleStride) {
      for (let depthX = startX; depthX < endX; depthX += this.sampleStride) {
        const x =
          depthFrame.width === 1
            ? (sourceWidth - 1) / 2
            : (depthX / Math.max(depthFrame.width - 1, 1)) * (sourceWidth - 1);
        const y =
          depthFrame.height === 1
            ? (sourceHeight - 1) / 2
            : (depthY / Math.max(depthFrame.height - 1, 1)) * (sourceHeight - 1);

        if (
          !maskHasPixel(objectSupportMask, x, y, sourceWidth, sourceHeight) ||
          !isMaskInterior(objectSupportMask, x, y, sourceWidth, sourceHeight)
        ) {
          continue;
        }

        const value = depthAt(depthFrame, depthX, depthY);
        if (Number.isFinite(value) && value > 0.02 && value < 0.98) {
          samples.push({ x, y, value, color: colorAt(imageData, x, y) });
        }
      }
    }

    return samples;
  }

  _backProjectSample({ sample, fit, centerDepth, depthScale, cameraParams }) {
    const reference = invertSimilarityPoint(sample, fit);
    const cameraZ = clamp(1 + (sample.value - centerDepth) * 0.88, 0.2, 2.4);
    const centerZ = 1;
    const cameraX = ((sample.x - cameraParams.cx) / cameraParams.fx) * cameraZ;
    const cameraY = ((sample.y - cameraParams.cy) / cameraParams.fy) * cameraZ;
    const centerCameraX = ((sample.x - cameraParams.cx) / cameraParams.fx) * centerZ;
    const centerCameraY = ((sample.y - cameraParams.cy) / cameraParams.fy) * centerZ;

    return {
      x: reference.x + (cameraX - centerCameraX) * depthScale,
      y: reference.y + (cameraY - centerCameraY) * depthScale,
      z: (cameraZ - centerZ) * depthScale,
      cameraX,
      cameraY,
      cameraZ,
    };
  }

  _surfelKey(point) {
    return [
      Math.round(point.x / this.voxelSize),
      Math.round(point.y / this.voxelSize),
      Math.round(point.z / this.voxelSize),
    ].join(':');
  }

  _mergeSurfel({ key, point, sample, timestamp }) {
    const previous = this.surfels.get(key);
    const confidence = clamp(1 - Math.abs(sample.value - 0.5) * 1.25, 0.18, 1);
    if (!previous) {
      this.surfels.set(key, {
        id: key,
        x: point.x,
        y: point.y,
        z: point.z,
        cameraX: point.cameraX,
        cameraY: point.cameraY,
        cameraZ: point.cameraZ,
        color: sample.color,
        confidence,
        observations: 1,
        lastSeen: timestamp,
      });
      return;
    }

    const count = previous.observations + 1;
    previous.x += (point.x - previous.x) / count;
    previous.y += (point.y - previous.y) / count;
    previous.z += (point.z - previous.z) / count;
    previous.cameraX += (point.cameraX - previous.cameraX) / count;
    previous.cameraY += (point.cameraY - previous.cameraY) / count;
    previous.cameraZ += (point.cameraZ - previous.cameraZ) / count;
    previous.confidence += (confidence - previous.confidence) / count;
    previous.color.r += (sample.color.r - previous.color.r) / count;
    previous.color.g += (sample.color.g - previous.color.g) / count;
    previous.color.b += (sample.color.b - previous.color.b) / count;
    previous.observations = count;
    previous.lastSeen = timestamp;
  }

  _prune() {
    if (this.surfels.size <= this.maxSurfels) {
      return;
    }

    const sorted = [...this.surfels.values()]
      .sort((left, right) => right.observations * right.confidence - left.observations * left.confidence)
      .slice(0, this.maxSurfels);
    this.surfels = new Map(sorted.map((surfel) => [surfel.id, surfel]));
  }
}
