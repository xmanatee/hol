import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAnimationFrame, useFrameRate } from '../hooks/useAnimationFrame.js';
import { useDetection } from '../hooks/useDetection.js';
import { useNormalEstimation } from '../hooks/useNormalEstimation.js';
import { SORTTracker } from '../cv/tracker.js';
import { AnchorStabilityTracker } from '../cv/anchorStability.js';
import { AnchorPersistenceTracker } from '../cv/anchorPersistence.js';
import OverlayScene from '../scenes/OverlayScene.jsx';
import { useHudMetrics } from '../hooks/useHudMetrics.js';

const CameraView = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const trackerRef = useRef(new SORTTracker(30, 1, 0.3)); // maxAge=30, minHits=1, iouThreshold=0.3
  const stabilityTrackerRef = useRef(new AnchorStabilityTracker());
  const persistenceTrackerRef = useRef(new AnchorPersistenceTracker());
  const frameCountRef = useRef(0);
  const [cameraState, setCameraState] = useState('idle'); // idle, requesting, active, error
  const [stats, setStats] = useState({ fps: 0, frameTime: 0 });
  const [showStats, setShowStats] = useState(true);
  const [videoDimensions, setVideoDimensions] = useState({ width: 1280, height: 720 });
  const [trackedObjects, setTrackedObjects] = useState([]);
  const [activeTrackId, setActiveTrackId] = useState(null);
  const [anchorStates, setAnchorStates] = useState(new Map()); // trackId -> {state, metrics}
  
  const { updateMetric } = useHudMetrics();

  // Detection hook
  const {
    detectObjects,
    detections,
    isInitialized: detectionInitialized,
    isModelLoaded,
    error: detectionError,
    processingTime
  } = useDetection();
  const { estimate: estimateNormal, normal: estimatedNormal, isReady: normalEstimationReady } = useNormalEstimation();

  // Placeholder for camera intrinsics matrix K
  const getCameraMatrix = (width, height) => {
    // This should be derived from the Three.js camera's projection matrix
    // For now, a default assuming ~60deg FOV
    const fov = 60 * Math.PI / 180;
    const focalLength = width / (2 * Math.tan(fov / 2));
    return {
      fx: focalLength,
      fy: focalLength,
      cx: width / 2,
      cy: height / 2,
    };
  };

  
  const throttledFrame = useFrameRate(30);

  // Initialize persistence tracker
  useEffect(() => {
    persistenceTrackerRef.current.initialize().then(() => {
      console.log('[CameraView] Persistence tracker initialized');
    }).catch(err => {
      console.error('[CameraView] Failed to initialize persistence tracker:', err);
    });
  }, []);

  // Update tracked objects when new detections arrive
  useEffect(() => {
    console.log('[CameraView] Detection update - detections:', detections.length, 'activeTrackId:', activeTrackId);
    
    if (detections.length > 0) {
      // Process detections through persistence tracker first
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const enhancedDetections = persistenceTrackerRef.current.processWithDetections(detections, imageData);
        
        console.log('[CameraView] Enhanced detections with persistence:', enhancedDetections.length);
        
        // Update SORT tracker with enhanced detections
        const tracks = trackerRef.current.update(enhancedDetections);
        console.log('[CameraView] Updated tracks:', tracks);
        setTrackedObjects(tracks);
        
        // Update anchor stability and persistence for locked track
        if (activeTrackId) {
          console.log('[CameraView] Looking for active track:', activeTrackId);
          const activeTrack = tracks.find(t => t.id === activeTrackId);
          console.log('[CameraView] Found active track:', activeTrack);
          
          if (activeTrack) {
            const timestamp = performance.now();
            console.log('[CameraView] Updating stability for track:', activeTrackId);
            
            const anchorState = stabilityTrackerRef.current.updateTrack(
              activeTrackId,
              activeTrack.bbox,
              activeTrack.confidence,
              timestamp
            );
            
            // Update persistence tracker
            persistenceTrackerRef.current.updateAnchor(
              activeTrackId,
              activeTrack.bbox,
              imageData,
              anchorState
            );
            
            const metrics = stabilityTrackerRef.current.getStabilityMetrics(activeTrackId, timestamp);
            
            // Update HUD metrics for stability
            updateMetric('Stability score', metrics.stabilityScore);
            if (metrics.stabilityScore >= 0.75) {
              updateMetric('lock time', (timestamp - metrics.stableStartTime) / 1000);
            }

            const screenPosition = {
              x: (activeTrack.bbox.x1 + activeTrack.bbox.x2) / 2,
              y: (activeTrack.bbox.y1 + activeTrack.bbox.y2) / 2,
              z: 0
            };
            
            console.log(`[CameraView] Track ${activeTrackId} screen position:`, screenPosition);
            console.log(`[CameraView] Track ${activeTrackId} state:`, anchorState);
            console.log(`[CameraView] Track ${activeTrackId} metrics:`, metrics);
            
            setAnchorStates(prev => {
              const newMap = new Map(prev).set(activeTrackId, {
                state: anchorState,
                metrics,
                screenPosition,
                persistent: activeTrack.persistent || false,
                synthetic: activeTrack.synthetic || false,
                reacquired: activeTrack.reacquired || false
              });
              console.log('[CameraView] Updated anchor states:', Array.from(newMap.entries()));
              return newMap;
            });
          } else {
            console.log('[CameraView] Active track lost, checking for persistence');
            // Track lost - but persistence tracker might still have it
            const persistenceStats = persistenceTrackerRef.current.getAnchorStats();
            const persistentAnchor = persistenceStats.find(a => a.trackId === activeTrackId);
            
            if (!persistentAnchor || persistentAnchor.missCount > 10) {
              console.log('[CameraView] Removing completely lost track');
              stabilityTrackerRef.current.removeTrack(activeTrackId);
              persistenceTrackerRef.current.removeAnchor(activeTrackId);
              setAnchorStates(prev => {
                const newMap = new Map(prev);
                newMap.delete(activeTrackId);
                console.log('[CameraView] Cleared anchor states:', Array.from(newMap.entries()));
                return newMap;
              });
            }
          }
        } else {
          console.log('[CameraView] No active track ID set');
        }
      }
    } else {
      console.log('[CameraView] No detections available - trying persistence recovery');
      
      // No detections from main detector - try persistence tracker for recovery
      const canvas = canvasRef.current;
      if (canvas && activeTrackId) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const recoveredDetections = persistenceTrackerRef.current.processWithoutDetections(imageData);
        
        if (recoveredDetections.length > 0) {
          console.log('[CameraView] Recovered detections via persistence:', recoveredDetections.length);
          
          // Update SORT tracker with recovered detections
          const tracks = trackerRef.current.update(recoveredDetections);
          setTrackedObjects(tracks);
          
          // Update anchor states to show persistence status
          const activeTrack = tracks.find(t => t.id === activeTrackId);
          if (activeTrack) {
            setAnchorStates(prev => {
              const current = prev.get(activeTrackId) || {};
              const newMap = new Map(prev).set(activeTrackId, {
                ...current,
                persistent: true,
                synthetic: activeTrack.synthetic || false,
                reacquired: activeTrack.reacquired || false
              });
              return newMap;
            });
          }
        }
      }
    }
  }, [detections, activeTrackId, updateMetric]);

  // Update anchor state with the latest estimated normal
  useEffect(() => {
    if (activeTrackId && estimatedNormal) {
      setAnchorStates(prev => {
        const newMap = new Map(prev);
        const currentAnchor = newMap.get(activeTrackId);
        if (currentAnchor) {
          newMap.set(activeTrackId, { ...currentAnchor, normal: estimatedNormal });
        }
        return newMap;
      });
      // Update HUD metric for normal jitter (dummy value for now)
      updateMetric('Normal jitter', Math.random() * 10); // Simulate some jitter
    }
  }, [estimatedNormal, activeTrackId, updateMetric]);

  // Handle tap-to-lock functionality
  const handleCanvasTap = useCallback((event) => {
    console.log('[CameraView] Canvas tap detected!', { 
      x: event.clientX, 
      y: event.clientY, 
      target: event.target.tagName,
      trackedObjects: trackedObjects.length 
    });
    
    if (trackedObjects.length === 0) {
      console.log('[CameraView] No tracked objects to tap on');
      return;
    }
    
    const rect = event.target.getBoundingClientRect();
    const tapX = event.clientX - rect.left;
    const tapY = event.clientY - rect.top;
    
    // Convert tap coordinates from display space to canvas space
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const x = (tapX / rect.width) * canvas.width;
    const y = (tapY / rect.height) * canvas.height;
    
    console.log('[CameraView] Tap event:', {
      display: { tapX, tapY },
      displaySize: { width: rect.width, height: rect.height },
      canvasSize: { width: canvas.width, height: canvas.height },
      videoDimensions,
      converted: { x, y }
    });
    
    // Find the highest confidence object under the tap
    let bestTrack = null;
    let bestScore = 0;
    
    for (const track of trackedObjects) {
      const { bbox } = track;
      const isInside = x >= bbox.x1 && x <= bbox.x2 && y >= bbox.y1 && y <= bbox.y2;
      
      console.log(`[CameraView] Track ${track.id} bbox:`, bbox, 'tap inside:', isInside);
      
      if (isInside && track.confidence > bestScore) {
        bestTrack = track;
        bestScore = track.confidence;
      }
    }
    
    console.log('[CameraView] Best track found:', bestTrack?.id || 'none');
    
    if (bestTrack) {
      console.log('[CameraView] Setting active track to:', bestTrack.id);
      // Clear previous track's stability and persistence data
      if (activeTrackId && activeTrackId !== bestTrack.id) {
        stabilityTrackerRef.current.removeTrack(activeTrackId);
        persistenceTrackerRef.current.removeAnchor(activeTrackId);
        setAnchorStates(prev => {
          const newMap = new Map(prev);
          newMap.delete(activeTrackId);
          return newMap;
        });
      }
      setActiveTrackId(bestTrack.id);
    } else {
      console.log('[CameraView] No track found at tap location');
    }
  }, [trackedObjects, videoDimensions, activeTrackId]);
  
  // Draw bounding boxes and track IDs
  const drawDetectionOverlay = useCallback((ctx) => {
    // Clear previous overlays (just detection boxes)
    ctx.save();
    
    // Draw tracked objects
    for (const track of trackedObjects) {
      const { bbox, id, confidence, className } = track;
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
        // Draw sparkle effect manually (simple version)
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
      }
      
      // Draw label background with persistence status
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
      
      let bgColor = 'rgba(0, 255, 0, 0.8)';
      if (isActive) {
        bgColor = isStable ? 'rgba(255, 215, 0, 0.8)' : 'rgba(255, 0, 0, 0.8)';
      }
      
      ctx.fillStyle = bgColor;
      ctx.fillRect(bbox.x1, bbox.y1 - textHeight, textWidth, textHeight);
      
      // Draw label text
      ctx.fillStyle = 'white';
      ctx.fillText(labelText, bbox.x1 + 4, bbox.y1 - 4);
    }
    
    // Draw lock indicator with stability status
    if (activeTrackId) {
      const anchorState = anchorStates.get(activeTrackId);
      const isStable = anchorState?.state === 'stable';
      
      ctx.fillStyle = isStable ? 'rgba(255, 215, 0, 0.9)' : 'rgba(255, 0, 0, 0.9)';
      ctx.fillRect(10, 60, 280, 200); // Increased height for persistence info
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
        const stats = tracker.trackStats.get(activeTrackId);
        if (stats && stats.stableStartTime) {
          const elapsed = performance.now() - stats.stableStartTime;
          const progress = (elapsed / 1000).toFixed(1);
          ctx.fillText(`Timer: ${progress}s / 1.0s`, 15, yOffset + 60);
        }
        
        // Show persistence stats
        const persistenceStats = persistenceTrackerRef.current.getAnchorStats();
        const persistentAnchor = persistenceStats.find(a => a.trackId === activeTrackId);
        if (persistentAnchor) {
          ctx.fillText(`Flow Points: ${persistentAnchor.flowPoints}`, 15, yOffset + 75);
          ctx.fillText(`Miss Count: ${persistentAnchor.missCount}`, 15, yOffset + 90);
          ctx.fillText(`Template: ${persistentAnchor.hasTemplate ? 'Yes' : 'No'}`, 15, yOffset + 105);
        }
      }
    }
    
    ctx.restore();
  }, [trackedObjects, activeTrackId, anchorStates]);

  // Camera constraints optimized for mobile
  const constraints = useMemo(() => ({
    video: {
      facingMode: 'environment', // rear camera
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    },
    audio: false
  }), []);

  const startCamera = useCallback(async () => {
    try {
      setCameraState('requesting');
      // setError(null);

      // Request camera permission and stream
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        
        // Handle video load events
        const onLoadedMetadata = () => {
          // For iOS, we need to call play() after metadata loads
          video.play().then(() => {
            setCameraState('active');
          }).catch((playError) => {
            console.error('Video play error:', playError);
            // Autoplay blocked - user interaction needed
            setCameraState('blocked');
          });
        };

        video.addEventListener('loadedmetadata', onLoadedMetadata);
        
        // Cleanup function for event listener
        return () => {
          video.removeEventListener('loadedmetadata', onLoadedMetadata);
        };
      }
    } catch (err) {
      console.error('Camera error:', err);
      // setError(err.message);
      setCameraState('error');
    }
  }, [constraints]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraState('idle');
  }, []);

  // Handle user tap to start (required for iOS autoplay)
  const handleStartClick = useCallback(() => {
    if (cameraState === 'blocked' && videoRef.current) {
      videoRef.current.play().then(() => {
        setCameraState('active');
      }).catch(console.error);
    } else {
      startCamera();
    }
  }, [cameraState, startCamera]);

  // Animation loop for canvas updates and FPS tracking
  useAnimationFrame(() => {
    if (cameraState === 'active' && videoRef.current && canvasRef.current) {
      throttledFrame(({ fps, frameTime }) => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');

        // Match canvas size to video dimensions
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          // Update dimensions state for WebGL overlay
          setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
        }

        // Draw current video frame to canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Run detection every 4th frame
        frameCountRef.current++;
        if (frameCountRef.current % 4 === 0 && isModelLoaded) {
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          detectObjects(imageData);
        }

        // Run normal estimation for stable track
        if (activeTrackId && anchorStates.get(activeTrackId)?.state === 'stable' && normalEstimationReady) {
          const activeTrack = trackedObjects.find(t => t.id === activeTrackId);
          if (activeTrack) {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const cameraMatrix = getCameraMatrix(canvas.width, canvas.height);
            estimateNormal(imageData, activeTrack.bbox, cameraMatrix);
          }
        }

        // Draw detection overlay
        drawDetectionOverlay(ctx, canvas);

        // Update HUD metrics
        updateMetric('Capture FPS', fps);
        updateMetric('Render frame time', frameTime);
        updateMetric('Detection amortized cost', processingTime);
        // Dummy updates for other metrics to show them in the HUD
        updateMetric('Track ID persistence', 95 - Math.random() * 10);
        updateMetric('Short-loss survival', 80 + Math.random() * 15);
        updateMetric('Reattach latency', 800 + Math.random() * 400);
        updateMetric('Mask IoU stability', 0.9 + Math.random() * 0.1);
        updateMetric('Mask cost', 5 + Math.random() * 2);
        updateMetric('Attachment drift', 0.03 + Math.random() * 0.04);
        updateMetric('Pose solve time', 1.0 + Math.random() * 0.5);
        updateMetric('Seam contrast ratio', 0.1 + Math.random() * 0.1);
        updateMetric('Effect FPS', 58 + Math.random() * 5);
        updateMetric('Persona RTT', 1200 + Math.random() * 500);
        updateMetric('Confidence tag', 0.7 + Math.random() * 0.2);
        updateMetric('Agent start latency', 600 + Math.random() * 200);
        updateMetric('Audio underruns', Math.floor(Math.random() * 2));
        updateMetric('A/V sync error', (Math.random() - 0.5) * 100);
        updateMetric('Viseme stability', 85 + Math.random() * 10);
        updateMetric('Gaze error', 5 + Math.random() * 5);
        updateMetric('Micro-motion energy', 1.5 + Math.random() * 2);
        updateMetric('Lost time ratio', 5 + Math.random() * 10);
        updateMetric('Exit recovery path', 90 + Math.random() * 5);
        updateMetric('95p frame time', 20 + Math.random() * 5);
        updateMetric('Thermal headroom', 70 + Math.random() * 20);
        updateMetric('GC pressure', 20 + Math.random() * 15);

        // Draw FPS counter and detection stats (old debug overlay)
        if (showStats) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
          ctx.fillRect(10, 10, 200, 60);
          ctx.fillStyle = '#00ff00';
          ctx.font = '12px monospace';
          ctx.fillText(`FPS: ${fps.toFixed(1)}`, 15, 25);
          ctx.fillText(`Frame: ${frameTime.toFixed(1)}ms`, 15, 40);
          ctx.fillText(`Detection: ${processingTime.toFixed(1)}ms`, 15, 55);
          ctx.fillText(`Objects: ${trackedObjects.length}`, 15, 70);
        }

        // Update stats for console output
        setStats({ fps, frameTime });
      });
    }
  });

  // Log performance stats periodically
  useEffect(() => {
    if (cameraState === 'active') {
      const interval = setInterval(() => {
        console.table({
          'FPS': stats.fps.toFixed(1),
          'Frame Time (ms)': stats.frameTime.toFixed(1),
          'Video Resolution': videoRef.current 
            ? `${videoRef.current.videoWidth}x${videoRef.current.videoHeight}`
            : 'N/A'
        });
      }, 2000);

      return () => clearInterval(interval);
    }
  }, [cameraState, stats]);

  // Cleanup on unmount
  useEffect(() => {
    return stopCamera;
  }, [stopCamera]);

  return (
    <div 
      className="camera-view"
      onClick={(e) => {
        console.log('[CameraView] Click on container:', e.target.tagName, e.target.className);
        // If click is on canvas, call the canvas tap handler directly
        if (e.target.tagName === 'CANVAS') {
          console.log('[CameraView] Calling handleCanvasTap from container click');
          handleCanvasTap(e);
        }
      }}>
      {/* Video element - full screen */}
      <video
        ref={videoRef}
        className="camera-video"
        playsInline
        muted
        autoPlay
        style={{
          width: '100vw',
          height: '100vh',
          objectFit: 'cover',
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 1
        }}
      />
      
      {/* Canvas for CV processing and detection overlay */}
      <canvas
        ref={canvasRef}
        onClick={handleCanvasTap}
        onTouchEnd={handleCanvasTap}
        onMouseDown={(e) => console.log('[CameraView] MouseDown on canvas:', e.target.tagName)}
        onPointerDown={(e) => console.log('[CameraView] PointerDown on canvas:', e.target.tagName)}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          objectFit: 'cover',
          zIndex: 5, // Higher than R3F overlay
          pointerEvents: cameraState === 'active' ? 'auto' : 'none',
          background: 'transparent',
          cursor: cameraState === 'active' ? 'pointer' : 'default',
          touchAction: 'manipulation', // Better touch handling on mobile
          border: '2px solid rgba(255,0,0,0.3)' // Debug: red border to see canvas bounds
        }}
      />

      {/* WebGL Overlay Scene */}
      {cameraState === 'active' && (() => {
        const anchorsArray = Array.from(anchorStates.entries()).map(([id, anchorState]) => ({
          id,
          state: anchorState.state,
          screenPosition: anchorState.screenPosition,
          color: '#FFD700'
        }));
        console.log('[CameraView] Creating anchors array for OverlayScene:', anchorsArray);
        console.log('[CameraView] Raw anchorStates:', Array.from(anchorStates.entries()));
        
        return (
          <OverlayScene 
            width={videoDimensions.width} 
            height={videoDimensions.height} 
            anchors={anchorsArray}
          />
        );
      })()}

      {/* UI Overlay */}
      <div className="camera-ui" style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 10,
        pointerEvents: 'none'
      }}>

        {/* Start button - only show when needed */}
        {(cameraState === 'idle' || cameraState === 'blocked' || cameraState === 'error') && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'auto'
          }}>
            <button
              onClick={handleStartClick}
              style={{
                padding: '16px 32px',
                fontSize: '18px',
                backgroundColor: '#007AFF',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(0,0,0,0.3)'
              }}
            >
              {cameraState === 'blocked' ? 'Start Camera' : 'Enable Camera'}
            </button>
          </div>
        )}

        {/* Detection status */}
        {cameraState === 'active' && (
          <div style={{
            position: 'absolute',
            top: '20px',
            left: '20px',
            backgroundColor: 'rgba(0,0,0,0.7)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '12px',
            pointerEvents: 'none'
          }}>
            <div>Detection: {detectionInitialized ? '✓' : '⏳'}</div>
            <div>Model: {isModelLoaded ? '✓' : '⏳'}</div>
            {detectionError && <div style={{color: '#ff6b6b'}}>Error: {detectionError}</div>}
          </div>
        )}
        
        {/* Instructions */}
        {cameraState === 'active' && trackedObjects.length > 0 && !activeTrackId && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            backgroundColor: 'rgba(0,0,0,0.8)',
            color: 'white',
            padding: '16px 24px',
            borderRadius: '8px',
            textAlign: 'center',
            pointerEvents: 'none',
            fontSize: '16px'
          }}>
            Tap on a bottle or cup to select it
          </div>
        )}

        {/* Debug controls */}
        {cameraState === 'active' && (
          <div style={{
            position: 'absolute',
            bottom: '20px',
            right: '20px',
            pointerEvents: 'auto'
          }}>
            <button
              onClick={() => setShowStats(!showStats)}
              style={{
                padding: '8px 12px',
                fontSize: '12px',
                backgroundColor: 'rgba(0,0,0,0.7)',
                color: 'white',
                border: '1px solid #333',
                borderRadius: '4px',
                cursor: 'pointer',
                marginRight: '8px'
              }}
            >
              {showStats ? 'Hide Stats' : 'Show Stats'}
            </button>
            {activeTrackId && (
              <button
                onClick={() => {
                  stabilityTrackerRef.current.removeTrack(activeTrackId);
                  persistenceTrackerRef.current.removeAnchor(activeTrackId);
                  setAnchorStates(prev => {
                    const newMap = new Map(prev);
                    newMap.delete(activeTrackId);
                    return newMap;
                  });
                  setActiveTrackId(null);
                }}
                style={{
                  padding: '8px 12px',
                  fontSize: '12px',
                  backgroundColor: 'rgba(255,165,0,0.7)',
                  color: 'white',
                  border: '1px solid #ff8c00',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  marginRight: '8px'
                }}
              >
                Unlock
              </button>
            )}
            <button
              onClick={stopCamera}
              style={{
                padding: '8px 12px',
                fontSize: '12px',
                backgroundColor: 'rgba(255,0,0,0.7)',
                color: 'white',
                border: '1px solid #600',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default CameraView;
