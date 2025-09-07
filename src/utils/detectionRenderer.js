export const renderDetectionOverlay = (ctx, {
  trackedObjects,
  activeTrackId,
  anchorStates,
  stabilityTrackerRef,
  persistenceTrackerRef
}) => {
  ctx.save();
  
  // Draw tracked objects
  for (const track of trackedObjects) {
    const { bbox, id } = track;
    const isActive = id === activeTrackId;
    const anchorState = anchorStates.get(id);
    const isStable = anchorState?.state === 'stable';
    
    // Draw bounding box with different colors for stability
    let strokeColor = '#00ff00'; // Default green
    if (isActive) {
      strokeColor = isStable ? '#ffd700' : '#ff0000'; // Gold for stable, red for tracking
    }
    
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = isActive ? 3 : 2;
    ctx.strokeRect(bbox.x1, bbox.y1, bbox.x2 - bbox.x1, bbox.y2 - bbox.y1);
    
    // Draw stability indicators for active track
    if (isActive && isStable) {
      drawSparkleEffect(ctx, bbox);
    }
    
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
  
  ctx.restore();
};

const drawSparkleEffect = (ctx, bbox) => {
  const centerX = (bbox.x1 + bbox.x2) / 2;
  const centerY = (bbox.y1 + bbox.y2) / 2;
  const time = performance.now() * 0.003;
  
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + time;
    const radius = 20 + Math.sin(time * 2 + i) * 5;
    const sparkleX = centerX + Math.cos(angle) * radius;
    const sparkleY = centerY + Math.sin(angle) * radius;
    
    ctx.fillStyle = `rgba(255, 215, 0, ${0.7 + Math.sin(time * 4 + i) * 0.3})`;
    ctx.beginPath();
    ctx.arc(sparkleX, sparkleY, 2, 0, Math.PI * 2);
    ctx.fill();
  }
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