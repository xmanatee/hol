import { logger } from './logger.js';

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

const renderAnchorMode = (ctx, { anchor, anchorState }) => {
  if (!anchor || !anchorState) return;
  
  const { position } = anchor;
  const { state } = anchorState;
  
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
  let strokeColor = '#ffffff'; // Default white stroke
  let strokeWidth = 2;
  
  if (state === 'stable') {
    fillColor = '#ffd700'; // Gold for stable
  } else if (state === 'initializing') {
    fillColor = '#ff8800'; // Orange for initializing
  } else if (state === 'lost') {
    // Make lost anchor more visible with bright red and pulsing effect
    const pulseTime = performance.now() * 0.003; // 3 cycles per second
    const pulseIntensity = 0.5 + 0.5 * Math.sin(pulseTime);
    
    fillColor = `rgb(${Math.floor(255 * pulseIntensity)}, 0, 0)`; // Pulsing red
    strokeColor = '#ffff00'; // Bright yellow stroke for high contrast
    strokeWidth = 3; // Thicker stroke for visibility
  }
  
  // Draw anchor circle
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
  
  // Draw cross-hair with enhanced visibility for lost state
  ctx.beginPath();
  ctx.moveTo(centerX - radius - 5, centerY);
  ctx.lineTo(centerX + radius + 5, centerY);
  ctx.moveTo(centerX, centerY - radius - 5);
  ctx.lineTo(centerX, centerY + radius + 5);
  
  if (state === 'lost') {
    // Make cross-hair more prominent for lost anchors
    ctx.strokeStyle = strokeColor; // Bright yellow
    ctx.lineWidth = strokeWidth; // Thicker line
  } else {
    ctx.strokeStyle = fillColor;
    ctx.lineWidth = 2;
  }
  ctx.stroke();
  
  // Draw anchor info
  drawAnchorInfo(ctx, anchor, anchorState, centerX, centerY);
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
