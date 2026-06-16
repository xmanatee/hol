import { modelFromRegion } from './anchor.parametricGeometry.js';
import { isPointInsideObjectSupport } from './objectSupportMask.js';
import { extractObjectSilhouette, scoreSilhouetteLandmarks } from './objectSilhouette.js';

const clamp01 = value => Math.max(0, Math.min(1, value));

const emptyState = {
  surfacePrior: 'unknown',
  bounds: null,
  cellCount: 0,
  occupiedCells: 0,
  coverage: 0,
  lockedLandmarks: 0,
  contourSegments: [],
  silhouette: null,
  silhouetteCoverage: null,
  contourFitResidual: null,
  landmarksInsideMask: 0,
  landmarksOutsideMask: 0,
  occlusionState: 'inactive',
  allowGrowth: false,
  lastOcclusionReason: 'No object support',
};

const pointResidual = point => {
  const errors = point.errorHistory || [];
  const usable = errors.filter(error => Number.isFinite(error));
  return usable.length
    ? usable.reduce((sum, error) => sum + error, 0) / usable.length
    : 0;
};

const pointQuality = point => point.landmarkQuality ??
  point.quality ??
  point.response ??
  0;

const pointReference = point => point.current || point.reference || point.original;

const cellKeyForPoint = ({ point, bbox, cellSize }) => {
  const reference = pointReference(point);
  const column = Math.floor((reference.x - bbox.x) / cellSize);
  const row = Math.floor((reference.y - bbox.y) / cellSize);
  return `${column}:${row}`;
};

const occlusionStateFromLandmarks = ({ activeLandmarks, objectLandmarks, poseResidual, previousState }) => {
  const active = activeLandmarks;
  const owned = objectLandmarks;
  const ownedRatio = owned.length / Math.max(1, active.length);
  const residual = Number.isFinite(poseResidual)
    ? poseResidual
    : active.reduce((sum, point) => sum + pointResidual(point), 0) / Math.max(1, active.length);

  if (active.length < 3) {
    return {
      occlusionState: 'lost',
      allowGrowth: false,
      lastOcclusionReason: 'Too few active object landmarks',
    };
  }

  if (ownedRatio < 0.55 || residual > 6) {
    return {
      occlusionState: 'partial-occlusion',
      allowGrowth: false,
      lastOcclusionReason: `Low object ownership or high residual (${ownedRatio.toFixed(2)}, ${residual.toFixed(2)})`,
    };
  }

  if (previousState === 'partial-occlusion' || previousState === 'lost') {
    return {
      occlusionState: 'recovering',
      allowGrowth: false,
      lastOcclusionReason: 'Stable object evidence is returning',
    };
  }

  return {
    occlusionState: 'visible',
    allowGrowth: true,
    lastOcclusionReason: null,
  };
};

export class ObjectSurfaceModel {
  constructor({ cellSize = 42, lockQuality = 0.72 } = {}) {
    this.cellSize = cellSize;
    this.lockQuality = lockQuality;
    this.state = { ...emptyState };
  }

  reset() {
    this.state = { ...emptyState };
    return this.state;
  }

  update({ objectSupportMask, landmarks = [], targetClass = null, poseResidual = null } = {}) {
    if (!objectSupportMask?.bbox) {
      return this.reset();
    }

    const bbox = { ...objectSupportMask.bbox };
    const silhouette = extractObjectSilhouette(objectSupportMask);
    const columns = Math.max(1, Math.ceil(bbox.width / this.cellSize));
    const rows = Math.max(1, Math.ceil(bbox.height / this.cellSize));
    const activeLandmarks = landmarks.filter(point => point.status === 'active');
    const activeObjectLandmarks = activeLandmarks.filter(point => (
      point.objectOwned !== false &&
      pointReference(point) &&
      isPointInsideObjectSupport(objectSupportMask, pointReference(point))
    ));
    const silhouetteFit = scoreSilhouetteLandmarks({
      objectSupportMask,
      landmarks: landmarks.filter(point => point.status === 'active' && point.objectOwned !== false),
      silhouette,
    });
    const occupied = new Set(activeObjectLandmarks.map(point => cellKeyForPoint({
      point,
      bbox,
      cellSize: this.cellSize,
    })));
    const locked = activeObjectLandmarks.filter(point => (
      point.objectOwned === true &&
      pointQuality(point) >= this.lockQuality &&
      pointResidual(point) <= 8
    ));
    const occlusion = occlusionStateFromLandmarks({
      activeLandmarks,
      objectLandmarks: activeObjectLandmarks,
      poseResidual,
      previousState: this.state.occlusionState,
    });
    const cellCount = columns * rows;
    const coverage = clamp01(occupied.size / Math.max(1, cellCount));

    this.state = {
      surfacePrior: modelFromRegion(bbox, targetClass),
      bounds: {
        min: { x: bbox.x, y: bbox.y },
        max: { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
        bbox,
      },
      cellCount,
      occupiedCells: occupied.size,
      coverage,
      lockedLandmarks: locked.length,
      contourSegments: silhouette.contourSegments,
      silhouette,
      ...silhouetteFit,
      ...occlusion,
    };

    return this.state;
  }

  getState() {
    return this.state;
  }
}
