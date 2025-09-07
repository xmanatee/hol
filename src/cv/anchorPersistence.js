/**
 * Anchor Persistence System - Phase 6
 * Keeps anchors alive through brief losses; re-attaches when objects return.
 */

export class AnchorPersistenceTracker {
  constructor() {
    this.anchors = new Map(); // trackId -> AnchorState
    this.cv = null;
    this.lastFrame = null;
    this.templateMatches = new Map(); // trackId -> template data for ORB matching
    
    // Constants
    this.FLOW_POINTS_COUNT = 80;
    this.MIN_FLOW_POINTS = 35;
    this.MAX_DETECTOR_MISSES = 10;
    this.MIN_ORB_INLIERS = 30;
    this.MIN_IOU_THRESHOLD = 0.3;
    this.FLOW_ERROR_THRESHOLD = 10.0;
  }

  async initialize() {
    if (typeof window !== 'undefined' && window.cv) {
      this.cv = window.cv;
      console.log('[AnchorPersistence] OpenCV.js initialized');
      return true;
    }
    
    // Wait for OpenCV to load
    return new Promise((resolve) => {
      const checkCV = () => {
        if (typeof window !== 'undefined' && window.cv && window.cv.Mat) {
          this.cv = window.cv;
          console.log('[AnchorPersistence] OpenCV.js loaded');
          resolve(true);
        } else {
          setTimeout(checkCV, 100);
        }
      };
      checkCV();
    });
  }

  /**
   * Create or update an anchor for a track
   * @param {number} trackId - Track identifier
   * @param {Object} bbox - Bounding box {x1, y1, x2, y2}
   * @param {ImageData} frame - Current frame
   * @param {string} state - Current state ('tracking' or 'stable')
   */
  updateAnchor(trackId, bbox, frame, state) {
    if (!this.cv) return;

    let anchor = this.anchors.get(trackId);
    
    if (!anchor) {
      // Create new anchor
      anchor = new AnchorState(trackId, bbox);
      this.anchors.set(trackId, anchor);
      console.log(`[AnchorPersistence] Created anchor for track ${trackId}`);
    }

    // Update anchor state
    anchor.lastDetection = { bbox, timestamp: Date.now() };
    anchor.state = state;
    anchor.missCount = 0;
    
    // Initialize or update ROI tracking
    if (state === 'stable') {
      this.initializeROITracking(anchor, frame, bbox);
      this.extractTemplate(anchor, frame, bbox);
    }

    this.lastFrame = this.imageDataToMat(frame);
  }

  /**
   * Process frame when detector has results
   * @param {Array} detections - Array of detection objects
   * @param {ImageData} frame - Current frame
   * @returns {Array} Updated detections with persistence info
   */
  processWithDetections(detections, frame) {
    if (!this.cv) return detections;

    const currentFrame = this.imageDataToMat(frame);
    
    // Update flow tracking for all anchors
    if (this.lastFrame) {
      for (const [, anchor] of this.anchors) {
        if (anchor.flowPoints && anchor.flowPoints.length > 0) {
          this.updateOpticalFlow(anchor, this.lastFrame, currentFrame);
        }
      }
    }

    // Match detections to existing anchors
    const matchedTracks = new Set();
    const enhancedDetections = [];

    for (const detection of detections) {
      let bestMatch = null;
      let bestIoU = 0;

      // Find best matching anchor
      for (const [trackId, anchor] of this.anchors) {
        if (matchedTracks.has(trackId)) continue;
        
        const iou = this.calculateIoU(detection, anchor.lastDetection.bbox);
        if (iou > bestIoU && iou > 0.3) {
          bestIoU = iou;
          bestMatch = { trackId, anchor };
        }
      }

      if (bestMatch) {
        matchedTracks.add(bestMatch.trackId);
        enhancedDetections.push({
          ...detection,
          trackId: bestMatch.trackId,
          anchorState: bestMatch.anchor.state,
          persistent: true
        });
      } else {
        enhancedDetections.push({
          ...detection,
          persistent: false
        });
      }
    }

    // Handle unmatched anchors (potential losses)
    for (const [trackId, anchor] of this.anchors) {
      if (!matchedTracks.has(trackId)) {
        anchor.missCount++;
        console.log(`[AnchorPersistence] Track ${trackId} missed detection (${anchor.missCount}/${this.MAX_DETECTOR_MISSES})`);
        
        // Check if flow tracking can keep it alive
        if (anchor.flowPoints && anchor.flowPoints.length >= this.MIN_FLOW_POINTS) {
          console.log(`[AnchorPersistence] Track ${trackId} kept alive by optical flow (${anchor.flowPoints.length} points)`);
          
          // Create synthetic detection from flow
          const flowBbox = this.estimateBboxFromFlow(anchor);
          if (flowBbox) {
            enhancedDetections.push({
              ...anchor.lastDetection,
              ...flowBbox,
              trackId: trackId,
              anchorState: anchor.state,
              persistent: true,
              synthetic: true,
              confidence: Math.max(0.3, anchor.lastDetection.confidence * 0.9)
            });
          }
        }
      }
    }

    this.lastFrame = currentFrame;
    return enhancedDetections;
  }

  /**
   * Process frame when detector has no results (global search for re-acquisition)
   * @param {ImageData} frame - Current frame
   * @returns {Array} Potential re-acquired detections
   */
  processWithoutDetections(frame) {
    if (!this.cv) return [];

    const currentFrame = this.imageDataToMat(frame);
    const timestamp = Date.now();
    const reacquiredDetections = [];

    // Update optical flow for all anchors
    if (this.lastFrame) {
      for (const [, anchor] of this.anchors) {
        if (anchor.flowPoints && anchor.flowPoints.length > 0) {
          this.updateOpticalFlow(anchor, this.lastFrame, currentFrame);
        }
      }
    }

    // Check for re-acquisition candidates using ORB matching
    for (const [trackId, anchor] of this.anchors) {
      anchor.missCount++;
      
      // Check if flow can keep it alive
      if (anchor.flowPoints && anchor.flowPoints.length >= this.MIN_FLOW_POINTS) {
        const flowBbox = this.estimateBboxFromFlow(anchor);
        if (flowBbox) {
          console.log(`[AnchorPersistence] Track ${trackId} maintained by flow (${anchor.flowPoints.length} points)`);
          reacquiredDetections.push({
            ...anchor.lastDetection,
            ...flowBbox,
            trackId: trackId,
            anchorState: anchor.state,
            persistent: true,
            synthetic: true,
            confidence: Math.max(0.2, anchor.lastDetection.confidence * 0.8)
          });
          continue;
        }
      }

      // If flow fails and we have a template, try ORB matching
      if (anchor.missCount > 5 && anchor.template) {
        const reacquisition = this.attemptReacquisition(anchor, currentFrame);
        if (reacquisition) {
          console.log(`[AnchorPersistence] Track ${trackId} re-acquired via ORB matching!`);
          reacquiredDetections.push({
            ...reacquisition,
            trackId: trackId,
            anchorState: 'tracking', // Reset to tracking state
            persistent: true,
            reacquired: true
          });
          
          // Reset anchor state
          anchor.missCount = 0;
          anchor.lastDetection = { bbox: reacquisition, timestamp };
          this.initializeROITracking(anchor, this.matToImageData(currentFrame), reacquisition);
        }
      }

      // Clean up anchors that are lost for too long
      if (anchor.missCount > this.MAX_DETECTOR_MISSES * 2) {
        console.log(`[AnchorPersistence] Removing lost anchor ${trackId}`);
        this.removeAnchor(trackId);
      }
    }

    this.lastFrame = currentFrame;
    return reacquiredDetections;
  }

  /**
   * Initialize ROI tracking with Shi-Tomasi points
   */
  initializeROITracking(anchor, frame, bbox) {
    if (!this.cv) return;

    try {
      const mat = this.imageDataToMat(frame);
      const gray = new this.cv.Mat();
      this.cv.cvtColor(mat, gray, this.cv.COLOR_RGBA2GRAY);

      // Define ROI
      const roi = new this.cv.Rect(
        Math.max(0, Math.floor(bbox.x1)),
        Math.max(0, Math.floor(bbox.y1)),
        Math.min(mat.cols, Math.floor(bbox.x2 - bbox.x1)),
        Math.min(mat.rows, Math.floor(bbox.y2 - bbox.y1))
      );

      const roiGray = gray.roi(roi);
      
      // Detect Shi-Tomasi corners
      const corners = new this.cv.Mat();
      this.cv.goodFeaturesToTrack(
        roiGray,
        corners,
        this.FLOW_POINTS_COUNT,
        0.01,    // quality level
        10,      // min distance
        new this.cv.Mat(),
        3,       // block size
        false,   // use Harris detector
        0.04     // Harris parameter
      );

      // Convert to global coordinates
      const points = [];
      for (let i = 0; i < corners.rows; i++) {
        const point = corners.data32F.slice(i * 2, (i + 1) * 2);
        points.push([
          point[0] + roi.x,
          point[1] + roi.y
        ]);
      }

      anchor.flowPoints = points;
      anchor.roiBounds = bbox;
      
      console.log(`[AnchorPersistence] Initialized ${points.length} flow points for track ${anchor.trackId}`);

      // Cleanup
      corners.delete();
      roiGray.delete();
      gray.delete();
      mat.delete();
    } catch (error) {
      console.error('[AnchorPersistence] Error initializing ROI tracking:', error);
    }
  }

  /**
   * Update optical flow tracking
   */
  updateOpticalFlow(anchor, prevFrame, currentFrame) {
    if (!this.cv || !anchor.flowPoints || anchor.flowPoints.length === 0) return;

    try {
      const prevGray = new this.cv.Mat();
      const currGray = new this.cv.Mat();
      
      this.cv.cvtColor(prevFrame, prevGray, this.cv.COLOR_RGBA2GRAY);
      this.cv.cvtColor(currentFrame, currGray, this.cv.COLOR_RGBA2GRAY);

      // Convert points to OpenCV format
      const prevPts = new this.cv.Mat(anchor.flowPoints.length, 1, this.cv.CV_32FC2);
      for (let i = 0; i < anchor.flowPoints.length; i++) {
        prevPts.data32F[i * 2] = anchor.flowPoints[i][0];
        prevPts.data32F[i * 2 + 1] = anchor.flowPoints[i][1];
      }

      const nextPts = new this.cv.Mat();
      const status = new this.cv.Mat();
      const error = new this.cv.Mat();

      // Calculate optical flow
      this.cv.calcOpticalFlowPyrLK(
        prevGray,
        currGray,
        prevPts,
        nextPts,
        status,
        error,
        new this.cv.Size(15, 15), // window size
        3,  // max pyramid level
        new this.cv.TermCriteria(this.cv.TERM_CRITERIA_EPS | this.cv.TERM_CRITERIA_COUNT, 30, 0.01)
      );

      // Filter good points
      const goodPoints = [];
      for (let i = 0; i < status.rows; i++) {
        if (status.data[i] === 1 && error.data32F[i] < this.FLOW_ERROR_THRESHOLD) {
          goodPoints.push([
            nextPts.data32F[i * 2],
            nextPts.data32F[i * 2 + 1]
          ]);
        }
      }

      anchor.flowPoints = goodPoints;
      
      console.log(`[AnchorPersistence] Flow updated: ${goodPoints.length}/${anchor.flowPoints.length} points tracked`);

      // Cleanup
      prevPts.delete();
      nextPts.delete();
      status.delete();
      error.delete();
      prevGray.delete();
      currGray.delete();
    } catch (error) {
      console.error('[AnchorPersistence] Error updating optical flow:', error);
      anchor.flowPoints = [];
    }
  }

  /**
   * Extract template for ORB matching
   */
  extractTemplate(anchor, frame, bbox) {
    if (!this.cv) return;

    try {
      const mat = this.imageDataToMat(frame);
      const gray = new this.cv.Mat();
      this.cv.cvtColor(mat, gray, this.cv.COLOR_RGBA2GRAY);

      // Extract template region
      const roi = new this.cv.Rect(
        Math.max(0, Math.floor(bbox.x1)),
        Math.max(0, Math.floor(bbox.y1)),
        Math.min(mat.cols, Math.floor(bbox.x2 - bbox.x1)),
        Math.min(mat.rows, Math.floor(bbox.y2 - bbox.y1))
      );

      const template = gray.roi(roi).clone();
      
      // Extract ORB features
      const orb = new this.cv.ORB();
      const keypoints = new this.cv.KeyPointVector();
      const descriptors = new this.cv.Mat();
      
      orb.detectAndCompute(template, new this.cv.Mat(), keypoints, descriptors);
      
      if (descriptors.rows > 0) {
        anchor.template = {
          image: template.clone(),
          descriptors: descriptors.clone(),
          keypoints: Array.from({length: keypoints.size()}, (_, i) => {
            const kp = keypoints.get(i);
            return { x: kp.pt.x, y: kp.pt.y };
          }),
          bbox: bbox
        };
        
        console.log(`[AnchorPersistence] Extracted template with ${descriptors.rows} ORB features for track ${anchor.trackId}`);
      }

      // Cleanup
      orb.delete();
      keypoints.delete();
      descriptors.delete();
      template.delete();
      gray.delete();
      mat.delete();
    } catch (error) {
      console.error('[AnchorPersistence] Error extracting template:', error);
    }
  }

  /**
   * Attempt re-acquisition using ORB matching
   */
  attemptReacquisition(anchor, currentFrame) {
    if (!this.cv || !anchor.template) return null;

    try {
      const gray = new this.cv.Mat();
      this.cv.cvtColor(currentFrame, gray, this.cv.COLOR_RGBA2GRAY);

      // Extract ORB features from current frame
      const orb = new this.cv.ORB();
      const keypoints = new this.cv.KeyPointVector();
      const descriptors = new this.cv.Mat();
      
      orb.detectAndCompute(gray, new this.cv.Mat(), keypoints, descriptors);

      if (descriptors.rows < 10) {
        console.log('[AnchorPersistence] Not enough features in current frame for matching');
        orb.delete();
        keypoints.delete();
        descriptors.delete();
        gray.delete();
        return null;
      }

      // Match descriptors
      const matcher = new this.cv.BFMatcher(this.cv.NORM_HAMMING, true);
      const matches = new this.cv.DMatchVector();
      matcher.match(anchor.template.descriptors, descriptors, matches);

      if (matches.size() < this.MIN_ORB_INLIERS) {
        console.log(`[AnchorPersistence] Not enough matches: ${matches.size()}/${this.MIN_ORB_INLIERS}`);
        matcher.delete();
        matches.delete();
        orb.delete();
        keypoints.delete();
        descriptors.delete();
        gray.delete();
        return null;
      }

      // Extract good matches and compute homography
      const srcPoints = [];
      const dstPoints = [];
      
      for (let i = 0; i < matches.size(); i++) {
        const match = matches.get(i);
        if (match.distance < 50) { // Distance threshold for good matches
          srcPoints.push([
            anchor.template.keypoints[match.queryIdx].x,
            anchor.template.keypoints[match.queryIdx].y
          ]);
          
          const kp = keypoints.get(match.trainIdx);
          dstPoints.push([kp.pt.x, kp.pt.y]);
        }
      }

      if (srcPoints.length < this.MIN_ORB_INLIERS) {
        console.log(`[AnchorPersistence] Not enough good matches: ${srcPoints.length}/${this.MIN_ORB_INLIERS}`);
        matcher.delete();
        matches.delete();
        orb.delete();
        keypoints.delete();
        descriptors.delete();
        gray.delete();
        return null;
      }

      // Compute homography
      const srcMat = this.cv.matFromArray(srcPoints.length, 1, this.cv.CV_32FC2, srcPoints.flat());
      const dstMat = this.cv.matFromArray(dstPoints.length, 1, this.cv.CV_32FC2, dstPoints.flat());
      
      const homography = this.cv.findHomography(srcMat, dstMat, this.cv.RANSAC, 3.0);
      
      if (homography.empty()) {
        console.log('[AnchorPersistence] Could not compute homography');
        srcMat.delete();
        dstMat.delete();
        homography.delete();
        matcher.delete();
        matches.delete();
        orb.delete();
        keypoints.delete();
        descriptors.delete();
        gray.delete();
        return null;
      }

      // Transform template bbox to current frame
      const templateBbox = anchor.template.bbox;
      const corners = [
        [templateBbox.x1 - templateBbox.x1, templateBbox.y1 - templateBbox.y1], // Relative to template
        [templateBbox.x2 - templateBbox.x1, templateBbox.y1 - templateBbox.y1],
        [templateBbox.x2 - templateBbox.x1, templateBbox.y2 - templateBbox.y1],
        [templateBbox.x1 - templateBbox.x1, templateBbox.y2 - templateBbox.y1]
      ];

      const cornersMat = this.cv.matFromArray(4, 1, this.cv.CV_32FC2, corners.flat());
      const transformedCorners = new this.cv.Mat();
      
      this.cv.perspectiveTransform(cornersMat, transformedCorners, homography);

      // Extract transformed bbox
      const transformedPoints = [];
      for (let i = 0; i < 4; i++) {
        transformedPoints.push([
          transformedCorners.data32F[i * 2],
          transformedCorners.data32F[i * 2 + 1]
        ]);
      }

      const newBbox = {
        x1: Math.min(...transformedPoints.map(p => p[0])),
        y1: Math.min(...transformedPoints.map(p => p[1])),
        x2: Math.max(...transformedPoints.map(p => p[0])),
        y2: Math.max(...transformedPoints.map(p => p[1]))
      };

      // Validate bbox and IOU with predicted position
      const predictedBbox = anchor.lastDetection.bbox;
      const iou = this.calculateIoU(newBbox, predictedBbox);
      
      console.log(`[AnchorPersistence] ORB match IOU: ${iou.toFixed(3)}, inliers: ${srcPoints.length}`);

      // Cleanup
      srcMat.delete();
      dstMat.delete();
      homography.delete();
      cornersMat.delete();
      transformedCorners.delete();
      matcher.delete();
      matches.delete();
      orb.delete();
      keypoints.delete();
      descriptors.delete();
      gray.delete();

      // Accept if IOU is reasonable and we have enough inliers
      if (iou >= this.MIN_IOU_THRESHOLD && srcPoints.length >= this.MIN_ORB_INLIERS) {
        return {
          ...newBbox,
          confidence: Math.min(0.8, srcPoints.length / 50), // Scale confidence based on matches
          className: anchor.lastDetection.className,
          class: anchor.lastDetection.class
        };
      }

      return null;
    } catch (error) {
      console.error('[AnchorPersistence] Error in re-acquisition:', error);
      return null;
    }
  }

  /**
   * Estimate bbox from optical flow points
   */
  estimateBboxFromFlow(anchor) {
    if (!anchor.flowPoints || anchor.flowPoints.length < 4) {
      return null;
    }

    const xs = anchor.flowPoints.map(p => p[0]);
    const ys = anchor.flowPoints.map(p => p[1]);
    
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    
    // Add some padding based on original bbox size
    const originalBbox = anchor.roiBounds;
    const padding = Math.min(
      (originalBbox.x2 - originalBbox.x1) * 0.2,
      (originalBbox.y2 - originalBbox.y1) * 0.2
    );
    
    return {
      x1: minX - padding,
      y1: minY - padding,
      x2: maxX + padding,
      y2: maxY + padding
    };
  }

  /**
   * Remove anchor
   */
  removeAnchor(trackId) {
    const anchor = this.anchors.get(trackId);
    if (anchor && anchor.template) {
      anchor.template.image?.delete();
      anchor.template.descriptors?.delete();
    }
    this.anchors.delete(trackId);
  }

  /**
   * Calculate IoU between two bboxes
   */
  calculateIoU(box1, box2) {
    const x1 = Math.max(box1.x1, box2.x1);
    const y1 = Math.max(box1.y1, box2.y1);
    const x2 = Math.min(box1.x2, box2.x2);
    const y2 = Math.min(box1.y2, box2.y2);

    if (x2 <= x1 || y2 <= y1) return 0;

    const intersection = (x2 - x1) * (y2 - y1);
    const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
    const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
    const union = area1 + area2 - intersection;

    return union > 0 ? intersection / union : 0;
  }

  /**
   * Convert ImageData to OpenCV Mat
   */
  imageDataToMat(imageData) {
    if (!this.cv) return null;
    
    return this.cv.matFromImageData(imageData);
  }

  /**
   * Convert OpenCV Mat to ImageData
   */
  matToImageData(mat) {
    if (!this.cv || !mat) return null;
    
    const canvas = document.createElement('canvas');
    canvas.width = mat.cols;
    canvas.height = mat.rows;
    const ctx = canvas.getContext('2d');
    
    this.cv.imshow(canvas, mat);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /**
   * Get anchor statistics for debugging
   */
  getAnchorStats() {
    const stats = [];
    for (const [trackId, anchor] of this.anchors) {
      stats.push({
        trackId,
        state: anchor.state,
        missCount: anchor.missCount,
        flowPoints: anchor.flowPoints?.length || 0,
        hasTemplate: !!anchor.template,
        age: Date.now() - (anchor.lastDetection?.timestamp || Date.now())
      });
    }
    return stats;
  }
}

/**
 * Internal class to maintain state for each anchor
 */
class AnchorState {
  constructor(trackId, bbox) {
    this.trackId = trackId;
    this.lastDetection = { bbox, timestamp: Date.now() };
    this.state = 'tracking'; // 'tracking' or 'stable'
    this.missCount = 0;
    this.flowPoints = null; // Array of [x, y] points for optical flow
    this.roiBounds = null; // Original ROI bounds
    this.template = null; // {image, descriptors, keypoints, bbox} for ORB matching
  }
}