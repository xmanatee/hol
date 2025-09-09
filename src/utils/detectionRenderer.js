import { logger } from './logger.js';

export const renderDetectionOverlay = (ctx, params) => {
  ctx.save();
  
  if (params.mode === 'detection') {
    renderDetectionMode(ctx, params);
  } else if (params.mode === 'anchor') {
    renderAnchorMode(ctx, params);
  } else {
    // Legacy mode for backward compatibility
    renderLegacyMode(ctx, params);
  }
  
  ctx.restore();
};

const renderDetectionMode = (ctx, { detections }) => {
  if (!detections || detections.length === 0) return;
  
  // Draw detection boxes
  for (const detection of detections) {
    const { x1, y1, x2, y2, confidence, className } = detection;
    
    // Draw bounding box
    ctx.strokeStyle = '#00ff00'; // Green for detections
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    
    // Draw label
    drawDetectionLabel(ctx, detection);
  }
  
  // Draw instruction text
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(10, 10, 250, 30);
  ctx.fillStyle = '#ffffff';
  ctx.font = '14px monospace';
  ctx.fillText('Tap on an object to create anchor', 15, 30);
};

const renderAnchorMode = (ctx, { anchor, anchorState }) => {
  if (!anchor || !anchorState) return;
  
  const { position } = anchor;
  const { state, metrics } = anchorState;
  
  // Debug: Log 2D anchor position updates (10% chance per frame)
  if (Math.random() < 0.1) {
    logger.info('DetectionRenderer', '2D Anchor position:', { x: position.x, y: position.y, state });
  }
  
  // Draw anchor point
  const radius = 8;
  const centerX = position.x;
  const centerY = position.y;
  
  // Color based on anchor state
  let fillColor = '#ff0000'; // Red for tracking
  if (state === 'stable') {
    fillColor = '#ffd700'; // Gold for stable
  } else if (state === 'initializing') {
    fillColor = '#ff8800'; // Orange for initializing
  } else if (state === 'lost') {
    fillColor = '#666666'; // Gray for lost
  }
  
  // Draw anchor circle
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
  
  // Draw cross-hair
  ctx.beginPath();
  ctx.moveTo(centerX - radius - 5, centerY);
  ctx.lineTo(centerX + radius + 5, centerY);
  ctx.moveTo(centerX, centerY - radius - 5);
  ctx.lineTo(centerX, centerY + radius + 5);
  ctx.strokeStyle = fillColor;
  ctx.lineWidth = 2;
  ctx.stroke();
  
  // Draw anchor info
  drawAnchorInfo(ctx, anchor, anchorState, centerX, centerY);
  
  // Draw instruction text
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(10, 10, 200, 30);
  ctx.fillStyle = '#ffffff';
  ctx.font = '14px monospace';
  ctx.fillText('Tap anywhere to clear anchor', 15, 30);
};

const renderLegacyMode = (ctx, {
  trackedObjects,
  activeTrackId,
  anchorStates,
  stabilityTrackerRef,
  persistenceTrackerRef
}) => {
  if (!trackedObjects) return;
  
  // Draw tracked objects (legacy)
  for (const track of trackedObjects) {
    const { bbox, id } = track;
    const isActive = id === activeTrackId;
    const anchorState = anchorStates?.get(id);
    const isStable = anchorState?.state === 'stable';
    
    // Draw bounding box with different colors for stability
    let strokeColor = '#00ff00'; // Default green
    if (isActive) {
      strokeColor = isStable ? '#ffd700' : '#ff0000'; // Gold for stable, red for tracking
    }
    
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = isActive ? 3 : 2;
    ctx.strokeRect(bbox.x1, bbox.y1, bbox.x2 - bbox.x1, bbox.y2 - bbox.y1);
    
    // Stability indicators removed - using color only
    
    // Draw label
    drawTrackLabel(ctx, track, anchorState);
  }
  
  // Draw lock indicator with stability status
  if (activeTrackId) {
    drawLockIndicator(ctx, {
      activeTrackId,
      anchorStates,
      stabilityTrackerRef,
      persistenceTrackerRef
    });
  }
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
  const info = [
    `State: ${state}`,
    `Keypoints: ${metrics?.keypointCount || 0}`,
    `Quality: ${((metrics?.templateQuality || 0) * 100).toFixed(0)}%`
  ];
  
  const boxWidth = 150;
  const boxHeight = info.length * 16 + 10;
  const boxX = centerX + 20;
  const boxY = centerY - boxHeight / 2;
  
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


const drawTrackLabel = (ctx, track, anchorState) => {
  const { bbox, id, confidence, className } = track;
  
  // Build status text
  let statusText = '';
  if (anchorState) {
    statusText = ` [${anchorState.state.toUpperCase()}`;
    if (anchorState.synthetic) statusText += ' FLOW';
    if (anchorState.reacquired) statusText += ' REACQ';
    if (anchorState.persistent) statusText += ' PERSIST';
    statusText += ']';
  }
  
  const labelText = `${className} #${id} (${(confidence * 100).toFixed(0)}%)${statusText}`;
  ctx.font = '14px Arial';
  const textMetrics = ctx.measureText(labelText);
  const textWidth = textMetrics.width + 8;
  const textHeight = 20;
  
  // Background color based on state
  const isActive = anchorState?.state !== undefined;
  const isStable = anchorState?.state === 'stable';
  let bgColor = 'rgba(0, 255, 0, 0.8)';
  if (isActive) {
    bgColor = isStable ? 'rgba(255, 215, 0, 0.8)' : 'rgba(255, 0, 0, 0.8)';
  }
  
  ctx.fillStyle = bgColor;
  ctx.fillRect(bbox.x1, bbox.y1 - textHeight, textWidth, textHeight);
  
  // Draw label text
  ctx.fillStyle = 'white';
  ctx.fillText(labelText, bbox.x1 + 4, bbox.y1 - 4);
};

const drawLockIndicator = (ctx, {
  activeTrackId,
  anchorStates,
  stabilityTrackerRef,
  persistenceTrackerRef
}) => {
  const anchorState = anchorStates.get(activeTrackId);
  const isStable = anchorState?.state === 'stable';
  
  ctx.fillStyle = isStable ? 'rgba(255, 215, 0, 0.9)' : 'rgba(255, 0, 0, 0.9)';
  ctx.fillRect(10, 60, 280, 200);
  ctx.fillStyle = 'white';
  ctx.font = '16px Arial';
  ctx.fillText(`LOCKED #${activeTrackId}`, 15, 80);
  ctx.font = '12px Arial';
  ctx.fillText(`State: ${anchorState?.state?.toUpperCase() || 'TRACKING'}`, 15, 95);
  
  // Show persistence status
  let yOffset = 110;
  if (anchorState?.synthetic) {
    ctx.fillText('Status: OPTICAL FLOW', 15, yOffset);
    yOffset += 15;
  }
  if (anchorState?.reacquired) {
    ctx.fillText('Status: RE-ACQUIRED', 15, yOffset);
    yOffset += 15;
  }
  if (anchorState?.persistent) {
    ctx.fillText('Status: PERSISTENT', 15, yOffset);
    yOffset += 15;
  }
  
  // Show detailed stability metrics
  if (anchorState?.metrics) {
    const { centerVelocity, areaChangePercent, confidenceRate, sampleCount } = anchorState.metrics;
    ctx.fillText(`Samples: ${sampleCount}`, 15, yOffset);
    ctx.fillText(`Velocity: ${centerVelocity.toFixed(1)} px/s (<30)`, 15, yOffset + 15);
    ctx.fillText(`Area Δ: ${areaChangePercent.toFixed(1)}% (<10)`, 15, yOffset + 30);
    ctx.fillText(`Confidence: ${(confidenceRate * 100).toFixed(0)}% (≥75)`, 15, yOffset + 45);
    
    // Show timer progress
    const tracker = stabilityTrackerRef.current;
    const stats = tracker?.trackStats?.get(activeTrackId);
    if (stats && stats.stableStartTime) {
      const elapsed = performance.now() - stats.stableStartTime;
      const progress = (elapsed / 1000).toFixed(1);
      ctx.fillText(`Timer: ${progress}s / 1.0s`, 15, yOffset + 60);
    }
    
    // Show persistence stats
    const persistenceStats = persistenceTrackerRef.current?.getAnchorStats() || [];
    const persistentAnchor = persistenceStats.find(a => a.trackId === activeTrackId);
    if (persistentAnchor) {
      ctx.fillText(`Flow Points: ${persistentAnchor.flowPoints}`, 15, yOffset + 75);
      ctx.fillText(`Miss Count: ${persistentAnchor.missCount}`, 15, yOffset + 90);
      ctx.fillText(`Template: ${persistentAnchor.hasTemplate ? 'Yes' : 'No'}`, 15, yOffset + 105);
    }
  }
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
  
  keypoints.forEach((point, index) => {
    const { current, status, errorHistory, age } = point;
    
    if (!current || current.x === undefined || current.y === undefined) return;
    
    // Color based on status
    let color;
    let size;
    switch (status) {
      case 'active':
        color = '#00ff00'; // Green for active points
        size = 3;
        break;
      case 'outlier':
        color = '#ffaa00'; // Orange for outliers
        size = 2;
        break;
      case 'lost':
        color = '#ff0000'; // Red for lost points
        size = 2;
        break;
      default:
        color = '#888888'; // Gray for unknown
        size = 2;
    }
    
    // Draw keypoint
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(current.x, current.y, size, 0, Math.PI * 2);
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
  
  // Show keypoint summary
  const activeCount = keypoints.filter(p => p.status === 'active').length;
  const outlierCount = keypoints.filter(p => p.status === 'outlier').length;
  const lostCount = keypoints.filter(p => p.status === 'lost').length;
  
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(10, 300, 180, 50);
  ctx.fillStyle = '#ffffff';
  ctx.font = '12px monospace';
  ctx.fillText(`Keypoints: ${keypoints.length}`, 15, 315);
  ctx.fillText(`Active: ${activeCount}`, 15, 330);
  ctx.fillText(`Outlier: ${outlierCount} Lost: ${lostCount}`, 15, 345);
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
  
  // Calculate template region (same logic as ImageAnchorService)
  let baseSize = Math.min(canvasWidth, canvasHeight) * 0.3;
  
  if (boundingBox) {
    const detectionWidth = boundingBox.x2 - boundingBox.x1;
    const detectionHeight = boundingBox.y2 - boundingBox.y1;
    const avgDetectionSize = (detectionWidth + detectionHeight) / 2;
    baseSize = Math.min(avgDetectionSize * 1.4, Math.min(canvasWidth, canvasHeight) * 0.5);
  }
  
  const region = {
    x: Math.max(0, tapPosition.x - baseSize / 2),
    y: Math.max(0, tapPosition.y - baseSize / 2),
    width: baseSize,
    height: baseSize
  };
  
  // Ensure region is within bounds
  region.x = Math.max(0, Math.min(region.x, canvasWidth - region.width));
  region.y = Math.max(0, Math.min(region.y, canvasHeight - region.height));
  
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