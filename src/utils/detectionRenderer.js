import { calculateTemplateRegion } from './templateRegion.js';

const STATE_STYLES = {
  candidate: { fill: '#ff8800', stroke: '#fff7ed', label: 'candidate' },
  mapping: { fill: '#00d4ff', stroke: '#e0f2fe', label: 'mapping' },
  tracking: { fill: '#22c55e', stroke: '#dcfce7', label: 'tracking' },
  stable: { fill: '#ffd700', stroke: '#fef9c3', label: 'stable' },
  degraded: { fill: '#f59e0b', stroke: '#fef3c7', label: 'weak' },
  lost: { fill: '#ef4444', stroke: '#fde68a', label: 'lost' },
  initializing: { fill: '#ff8800', stroke: '#fff7ed', label: 'initializing' },
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const pointColor = (point) => {
  if (point.status === 'outlier') return '#ef4444';
  if (point.status === 'lost') return '#64748b';
  if (point.objectOwned === false) return '#ef4444';
  const reliability = point.reliability ?? point.stabilityScore ?? point.quality ?? 0;
  if (reliability >= 0.72 || point.objectOwned === true) return '#22c55e';
  if (reliability >= 0.45) return '#38bdf8';
  return '#f59e0b';
};

export const renderDetectionOverlay = (ctx, params) => {
  ctx.save();
  
  if (params.mode === 'detection') {
    renderDetectionMode(ctx, params);
  } else if (params.mode === 'anchor') {
    renderAnchorMode(ctx, params);
  } else {
    throw new Error(`Unknown detection renderer mode: ${params.mode}`);
  }
  
  ctx.restore();
};

const renderDetectionMode = (ctx, { detections }) => {
  if (!detections || detections.length === 0) return;
  
  // Draw detection boxes
  for (const detection of detections) {
    const { x1, y1, x2, y2 } = detection;
    
    // Draw bounding box
    ctx.strokeStyle = '#00ff00'; // Green for detections
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    
    // Draw label
    drawDetectionLabel(ctx, detection);
  }
};

const renderAnchorMode = (ctx, { anchor, anchorState, trackedPoints = [] }) => {
  if (!anchor || !anchorState) return;
  
  const { position } = anchor;
  const { state } = anchorState;
  const metrics = anchorState.metrics || anchor.diagnostics || {};
  const style = getAnchorStyle(state);
  const reconstructionPreview = metrics.reconstructionPreview || null;
  
  const centerX = position.x;
  const centerY = position.y;

  drawSelectedObjectRegion(ctx, anchor, metrics);
  drawLiveReconstruction(ctx, reconstructionPreview);
  drawTrackedLandmarks(ctx, trackedPoints, reconstructionPreview);
  drawSurfaceNormal(ctx, anchorState, centerX, centerY);
  
  const radius = 8;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = style.strokeWidth;
  ctx.stroke();

  drawReadinessRing(ctx, centerX, centerY, metrics, radius + 5);
  
  ctx.beginPath();
  ctx.moveTo(centerX - radius - 5, centerY);
  ctx.lineTo(centerX + radius + 5, centerY);
  ctx.moveTo(centerX, centerY - radius - 5);
  ctx.lineTo(centerX, centerY + radius + 5);
  ctx.strokeStyle = state === 'lost' ? style.stroke : style.fill;
  ctx.lineWidth = state === 'lost' ? style.strokeWidth : 2;
  ctx.stroke();
  
  drawAnchorInfo(ctx, anchor, anchorState, centerX, centerY);
  };

const getAnchorStyle = (state) => {
  if (state === 'lost') {
    const pulseTime = performance.now() * 0.003;
    const pulseIntensity = 0.5 + 0.5 * Math.sin(pulseTime);
    return {
      fill: `rgb(${Math.floor(255 * pulseIntensity)}, 0, 0)`,
      stroke: STATE_STYLES.lost.stroke,
      strokeWidth: 3,
    };
  }

  const style = STATE_STYLES[state] || { fill: '#ef4444', stroke: '#ffffff' };
  return {
    fill: style.fill,
    stroke: style.stroke,
    strokeWidth: 2,
  };
};

const regionFromBounds = (bounds) => {
  if (!bounds) return null;
  if (typeof bounds.width === 'number' && typeof bounds.height === 'number') {
    return bounds;
  }
  if (
    typeof bounds.x1 === 'number' &&
    typeof bounds.y1 === 'number' &&
    typeof bounds.x2 === 'number' &&
    typeof bounds.y2 === 'number'
  ) {
    return {
      x: bounds.x1,
      y: bounds.y1,
      width: bounds.x2 - bounds.x1,
      height: bounds.y2 - bounds.y1,
    };
  }
  return null;
};

const objectRegionForAnchor = (anchor, metrics) => {
  return regionFromBounds(metrics.currentObjectSupportMaskBounds) ||
    regionFromBounds(metrics.objectSupportMaskBounds) ||
    regionFromBounds(anchor.sourceDetection?.objectSupportMask?.bbox) ||
    regionFromBounds(anchor.sourceDetection);
};

const objectMaskPreviewForAnchor = (anchor, metrics) => (
  metrics.currentObjectSupportMaskPreview ||
  metrics.objectSupportMaskPreview ||
  anchor.diagnostics?.objectSupportMaskPreview ||
  anchor.evidence?.objectSupportMaskPreview ||
  null
);

const drawObjectMaskPreview = (ctx, maskPreview) => {
  const region = regionFromBounds(maskPreview.bbox);
  const points = maskPreview.points || [];
  if (!region || points.length === 0) return false;

  const sampleSize = clamp(maskPreview.sampleStride || 3, 3, 9);

  ctx.save();
  ctx.strokeStyle = maskPreview.source === 'tap-local-detection'
    ? 'rgba(250, 204, 21, 0.76)'
    : 'rgba(45, 212, 191, 0.92)';
  ctx.fillStyle = maskPreview.source === 'tap-local-detection'
    ? 'rgba(250, 204, 21, 0.2)'
    : 'rgba(20, 184, 166, 0.22)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(region.x, region.y, region.width, region.height);
  ctx.setLineDash([]);

  for (const point of points) {
    ctx.fillRect(point.x - sampleSize / 2, point.y - sampleSize / 2, sampleSize, sampleSize);
  }

  ctx.restore();
  return true;
};

const drawSelectedObjectRegion = (ctx, anchor, metrics) => {
  const maskPreview = objectMaskPreviewForAnchor(anchor, metrics);
  if (maskPreview && drawObjectMaskPreview(ctx, maskPreview)) {
    return;
  }

  const region = objectRegionForAnchor(anchor, metrics);
  if (!region || region.width <= 0 || region.height <= 0) return;

  ctx.save();
  ctx.strokeStyle = metrics.currentObjectSupportMaskBounds || anchor.sourceDetection?.objectSupportMask
    ? 'rgba(45, 212, 191, 0.92)'
    : 'rgba(250, 204, 21, 0.82)';
  ctx.fillStyle = 'rgba(20, 184, 166, 0.06)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 5]);
  ctx.fillRect(region.x, region.y, region.width, region.height);
  ctx.strokeRect(region.x, region.y, region.width, region.height);
  ctx.setLineDash([]);
  ctx.restore();
};

const currentPreviewPoints = (reconstructionPreview) => reconstructionPreview?.current?.points || [];

const pointById = (points) => new Map(points.map(point => [point.id, point]));

const drawPolygonPath = (ctx, points) => {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index++) {
    ctx.lineTo(points[index].x, points[index].y);
  }
  ctx.closePath();
};

const drawLiveReconstruction = (ctx, reconstructionPreview) => {
  const points = currentPreviewPoints(reconstructionPreview);
  if (points.length < 3) return;

  const surface = reconstructionPreview?.current?.surface || reconstructionPreview?.surface || {};
  const byId = pointById(points);
  const faces = surface.faces || [];
  const edges = surface.edges || [];
  const hull = surface.hull || [];

  ctx.save();
  for (const face of faces.slice(0, 48)) {
    const polygon = face.points.map(id => byId.get(id)).filter(Boolean);
    if (polygon.length < 3) continue;
    drawPolygonPath(ctx, polygon);
    ctx.fillStyle = face.reliability >= 0.68
      ? 'rgba(20, 184, 166, 0.15)'
      : 'rgba(15, 23, 42, 0.18)';
    ctx.strokeStyle = 'rgba(20, 184, 166, 0.42)';
    ctx.lineWidth = 0.8;
    ctx.fill();
    ctx.stroke();
  }

  const hullPoints = hull.map(id => byId.get(id)).filter(Boolean);
  if (hullPoints.length >= 3) {
    drawPolygonPath(ctx, hullPoints);
    ctx.fillStyle = 'rgba(14, 165, 233, 0.08)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.82)';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }

  for (const edge of edges.slice(0, 96)) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = edge.reliability >= 0.7
      ? 'rgba(34, 197, 94, 0.72)'
      : 'rgba(148, 163, 184, 0.48)';
    ctx.lineWidth = edge.reliability >= 0.7 ? 1.2 : 0.8;
    ctx.stroke();
  }
  ctx.restore();
};

const drawTrackedLandmarks = (ctx, trackedPoints, reconstructionPreview) => {
  const previewPoints = currentPreviewPoints(reconstructionPreview);
  const rawPoints = trackedPoints.length
    ? trackedPoints
      .filter(point => point.current && ['active', 'outlier', 'lost'].includes(point.status))
      .filter(point => point.status !== 'active' || point.objectOwned !== false)
      .map(point => ({
        id: point.id,
        x: point.current.x,
        y: point.current.y,
        status: point.status,
        reliability: point.stabilityScore ?? point.quality ?? 0,
        objectOwned: point.objectOwned,
      }))
    : previewPoints;

  const points = rawPoints.slice(0, 120);
  if (points.length === 0) return;

  ctx.save();
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const radius = point.status === 'lost' ? 1.8 : 2.8;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = pointColor(point);
    ctx.globalAlpha = point.status === 'lost' ? 0.36 : 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
};

const drawSurfaceNormal = (ctx, anchorState, centerX, centerY) => {
  const normal = anchorState.normal;
  if (!normal) return;

  const length = 32;
  const endX = centerX + normal.x * length;
  const endY = centerY - normal.y * length;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(endX, endY);
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.9)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(endX, endY, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#f8fafc';
  ctx.fill();
  ctx.restore();
};

const readinessProgress = (metrics) => {
  const mapConfidence = metrics.reconstructionMapConfidence;
  if (typeof mapConfidence === 'number') return clamp(mapConfidence, 0, 1);

  const objectOwned = metrics.objectOwnedLandmarks ?? 0;
  const activeLandmarks = metrics.activeLandmarkCount ?? metrics.activeLandmarks ?? metrics.keypointCount ?? 0;
  return clamp(Math.max(objectOwned, activeLandmarks) / 32, 0, 1);
};

const drawReadinessRing = (ctx, centerX, centerY, metrics, radius) => {
  const progress = readinessProgress(metrics);
  const ready = metrics.readiness?.faceReady || metrics.reconstructionReady;

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
  ctx.strokeStyle = ready ? '#22c55e' : '#38bdf8';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
};

const drawDetectionLabel = (ctx, detection) => {
  const { x1, y1, confidence, className } = detection;
  const label = `${className} (${(confidence * 100).toFixed(0)}%)`;
  
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(x1, y1 - 25, label.length * 7 + 10, 20);
  
  ctx.fillStyle = '#ffffff';
  ctx.font = '12px monospace';
  ctx.fillText(label, x1 + 5, y1 - 8);
};

const drawAnchorInfo = (ctx, anchor, anchorState, centerX, centerY) => {
  const { state, metrics } = anchorState;
  const readiness = metrics?.readiness;
  const mapConfidence = metrics?.reconstructionMapConfidence;
  const faceStatus = readiness?.faceReady || metrics?.reconstructionReady ? 'ready' : 'building';
  const info = [
    `State: ${state}`,
    `Landmarks: ${metrics?.activeLandmarkCount || metrics?.keypointCount || 0}/${metrics?.landmarkCount || metrics?.keypointCount || 0}`,
    `Object: ${metrics?.objectOwnedLandmarks || metrics?.keypointCount || 0}`,
    `Map: ${metrics?.reconstructionFrames || 0}f ${metrics?.reconstructionLandmarks || 0}p ${typeof mapConfidence === 'number' ? `${(mapConfidence * 100).toFixed(0)}%` : '0%'}`,
    `Face: ${faceStatus}`
  ];
  
  const boxWidth = 190;
  const boxHeight = info.length * 16 + 10;
  const canvasWidth = ctx.canvas?.width || 0;
  const canvasHeight = ctx.canvas?.height || 0;
  const boxX = clamp(centerX + 20, 8, Math.max(8, canvasWidth - boxWidth - 8));
  const boxY = clamp(centerY - boxHeight / 2, 8, Math.max(8, canvasHeight - boxHeight - 8));
  
  // Background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
  
  // Text
  ctx.fillStyle = '#ffffff';
  ctx.font = '12px monospace';
  info.forEach((line, index) => {
    ctx.fillText(line, boxX + 5, boxY + 15 + index * 16);
  });
};

export const renderDebugStats = (ctx, { fps, frameTime, processingTime, objectCount }) => {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(10, 10, 200, 60);
  ctx.fillStyle = '#00ff00';
  ctx.font = '12px monospace';
  ctx.fillText(`FPS: ${fps.toFixed(1)}`, 15, 25);
  ctx.fillText(`Frame: ${frameTime.toFixed(1)}ms`, 15, 40);
  ctx.fillText(`Detection: ${processingTime.toFixed(1)}ms`, 15, 55);
  ctx.fillText(`Objects: ${objectCount}`, 15, 70);
};

/**
 * Render tracked keypoints on canvas
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} anchorSystem - Anchor system state with keypoint data
 */
export const renderKeypoints = (ctx, anchorSystem) => {
  if (!anchorSystem?.keypointTracker?.trackedPoints) return;

  const keypoints = anchorSystem.keypointTracker.trackedPoints;
  
  // Only render active keypoints to avoid visual clutter from fixed lost/outlier points
  const activeKeypoints = keypoints.filter(point => point.status === 'active');
  
  activeKeypoints.forEach((point, index) => {
    const { current } = point;
    
    if (!current || current.x === undefined || current.y === undefined) return;
    
    // Draw active keypoint in green
    ctx.fillStyle = '#00ff00'; // Green for active points
    ctx.beginPath();
    ctx.arc(current.x, current.y, 3, 0, Math.PI * 2);
    ctx.fill();
    
    // Add subtle border for visibility
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Show point ID for debugging (every 10th point to avoid clutter)
    if (index % 10 === 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.font = '10px monospace';
      ctx.fillText(`${point.id}`, current.x + 5, current.y - 5);
    }
  });
};

/**
 * Render template region preview on click/hover
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} tapPosition - {x, y} position of tap/hover
 * @param {Object} boundingBox - Optional detection bounding box
 * @param {number} canvasWidth - Canvas width
 * @param {number} canvasHeight - Canvas height
 */
export const renderTemplatePreview = (ctx, tapPosition, boundingBox, canvasWidth, canvasHeight) => {
  if (!tapPosition) return;
  
  const region = calculateTemplateRegion(tapPosition, boundingBox, canvasWidth, canvasHeight);
  
  // Draw template region outline
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)'; // Cyan
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]); // Dashed line
  ctx.strokeRect(region.x, region.y, region.width, region.height);
  ctx.setLineDash([]); // Reset line dash
  
  // Draw center crosshair
  const centerX = region.x + region.width / 2;
  const centerY = region.y + region.height / 2;
  const crossSize = 10;
  
  ctx.strokeStyle = 'rgba(255, 255, 0, 0.9)'; // Yellow
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(centerX - crossSize, centerY);
  ctx.lineTo(centerX + crossSize, centerY);
  ctx.moveTo(centerX, centerY - crossSize);
  ctx.lineTo(centerX, centerY + crossSize);
  ctx.stroke();
  
  // Add label
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(region.x, region.y - 20, 120, 18);
  ctx.fillStyle = '#00ffff';
  ctx.font = '12px monospace';
  ctx.fillText('Template Region', region.x + 2, region.y - 6);
};
