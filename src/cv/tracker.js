// SORT (Simple Online and Realtime Tracking) implementation
// Based on the original paper: https://arxiv.org/abs/1602.00763

class KalmanFilter {
  constructor(bbox) {
    // State vector: [x, y, s, r, vx, vy, vs] where s=area, r=aspect_ratio
    this.state = new Array(7).fill(0);
    this.state[0] = bbox.x1 + (bbox.x2 - bbox.x1) / 2; // center_x
    this.state[1] = bbox.y1 + (bbox.y2 - bbox.y1) / 2; // center_y
    this.state[2] = (bbox.x2 - bbox.x1) * (bbox.y2 - bbox.y1); // area
    this.state[3] = (bbox.x2 - bbox.x1) / (bbox.y2 - bbox.y1); // aspect_ratio
    
    // State covariance matrix (7x7)
    this.covariance = this.createIdentityMatrix(7);
    for (let i = 0; i < 4; i++) {
      this.covariance[i][i] = 10; // High uncertainty for position and size
    }
    for (let i = 4; i < 7; i++) {
      this.covariance[i][i] = 1000; // Very high uncertainty for velocity
    }
    
    // Motion model (7x7) - constant velocity
    this.F = this.createIdentityMatrix(7);
    this.F[0][4] = 1; // x += vx
    this.F[1][5] = 1; // y += vy
    this.F[2][6] = 1; // s += vs
    
    // Observation model (4x7) - we observe [x, y, s, r]
    this.H = this.createZeroMatrix(4, 7);
    for (let i = 0; i < 4; i++) {
      this.H[i][i] = 1;
    }
    
    // Process noise
    this.Q = this.createIdentityMatrix(7);
    this.Q[4][4] = 0.01; // velocity noise
    this.Q[5][5] = 0.01;
    this.Q[6][6] = 0.0001;
    
    // Measurement noise
    this.R = this.createIdentityMatrix(4);
    for (let i = 0; i < 4; i++) {
      this.R[i][i] = 1;
    }
  }
  
  createIdentityMatrix(size) {
    const matrix = Array(size).fill().map(() => Array(size).fill(0));
    for (let i = 0; i < size; i++) {
      matrix[i][i] = 1;
    }
    return matrix;
  }
  
  createZeroMatrix(rows, cols) {
    return Array(rows).fill().map(() => Array(cols).fill(0));
  }
  
  predict() {
    // x = F * x
    this.state = this.matrixVectorMultiply(this.F, this.state);
    
    // P = F * P * F' + Q
    this.covariance = this.matrixAdd(
      this.matrixMultiply(this.matrixMultiply(this.F, this.covariance), this.transpose(this.F)),
      this.Q
    );
  }
  
  update(measurement) {
    // y = z - H * x (innovation)
    const predicted_measurement = this.matrixVectorMultiply(this.H, this.state);
    const innovation = this.vectorSubtract(measurement, predicted_measurement);
    
    // S = H * P * H' + R (innovation covariance)
    const S = this.matrixAdd(
      this.matrixMultiply(this.matrixMultiply(this.H, this.covariance), this.transpose(this.H)),
      this.R
    );
    
    // K = P * H' * S^(-1) (Kalman gain)
    const K = this.matrixMultiply(
      this.matrixMultiply(this.covariance, this.transpose(this.H)),
      this.matrixInverse(S)
    );
    
    // x = x + K * y
    this.state = this.vectorAdd(this.state, this.matrixVectorMultiply(K, innovation));
    
    // P = (I - K * H) * P
    const I_KH = this.matrixSubtract(
      this.createIdentityMatrix(7),
      this.matrixMultiply(K, this.H)
    );
    this.covariance = this.matrixMultiply(I_KH, this.covariance);
  }
  
  getBbox() {
    const [x, y, s, r] = this.state;
    const w = Math.sqrt(s * r);
    const h = s / w;
    
    return {
      x1: x - w / 2,
      y1: y - h / 2,
      x2: x + w / 2,
      y2: y + h / 2
    };
  }
  
  // Matrix operations (simplified implementations)
  matrixMultiply(A, B) {
    const rows = A.length;
    const cols = B[0].length;
    const inner = B.length;
    const result = Array(rows).fill().map(() => Array(cols).fill(0));
    
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        for (let k = 0; k < inner; k++) {
          result[i][j] += A[i][k] * B[k][j];
        }
      }
    }
    return result;
  }
  
  matrixAdd(A, B) {
    return A.map((row, i) => row.map((val, j) => val + B[i][j]));
  }
  
  matrixSubtract(A, B) {
    return A.map((row, i) => row.map((val, j) => val - B[i][j]));
  }
  
  matrixVectorMultiply(A, v) {
    return A.map(row => row.reduce((sum, val, i) => sum + val * v[i], 0));
  }
  
  vectorAdd(a, b) {
    return a.map((val, i) => val + b[i]);
  }
  
  vectorSubtract(a, b) {
    return a.map((val, i) => val - b[i]);
  }
  
  transpose(matrix) {
    return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex]));
  }
  
  // Simplified matrix inverse for small matrices (4x4 max)
  matrixInverse(matrix) {
    const n = matrix.length;
    if (n === 1) return [[1 / matrix[0][0]]];
    
    // For larger matrices, use a simplified approach
    // In production, consider using a proper linear algebra library
    const det = this.matrixDeterminant(matrix);
    if (Math.abs(det) < 1e-10) {
      // Singular matrix, return identity
      return this.createIdentityMatrix(n);
    }
    
    const adj = this.matrixAdjugate(matrix);
    return adj.map(row => row.map(val => val / det));
  }
  
  matrixDeterminant(matrix) {
    const n = matrix.length;
    if (n === 1) return matrix[0][0];
    if (n === 2) return matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
    
    // For larger matrices, use a simplified approach
    let det = 0;
    for (let i = 0; i < n; i++) {
      det += matrix[0][i] * this.matrixCofactor(matrix, 0, i);
    }
    return det;
  }
  
  matrixCofactor(matrix, row, col) {
    const minor = this.matrixMinor(matrix, row, col);
    const sign = (row + col) % 2 === 0 ? 1 : -1;
    return sign * this.matrixDeterminant(minor);
  }
  
  matrixMinor(matrix, excludeRow, excludeCol) {
    return matrix
      .filter((_, i) => i !== excludeRow)
      .map(row => row.filter((_, j) => j !== excludeCol));
  }
  
  matrixAdjugate(matrix) {
    const n = matrix.length;
    const adj = Array(n).fill().map(() => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        adj[j][i] = this.matrixCofactor(matrix, i, j); // Note: transposed
      }
    }
    return adj;
  }
}

class Track {
  constructor(detection, trackId) {
    this.id = trackId;
    this.kalman = new KalmanFilter(detection);
    this.timeSinceUpdate = 0;
    this.hitStreak = 1;
    this.age = 1;
    this.confidence = detection.confidence;
    this.className = detection.className;
    this.class = detection.class;
  }
  
  predict() {
    this.kalman.predict();
    this.age += 1;
    this.timeSinceUpdate += 1;
    return this.kalman.getBbox();
  }
  
  update(detection) {
    this.timeSinceUpdate = 0;
    this.hitStreak += 1;
    this.confidence = detection.confidence;
    this.className = detection.className;
    this.class = detection.class;
    
    // Convert bbox to measurement [x, y, s, r]
    const x = detection.x1 + (detection.x2 - detection.x1) / 2;
    const y = detection.y1 + (detection.y2 - detection.y1) / 2;
    const s = (detection.x2 - detection.x1) * (detection.y2 - detection.y1);
    const r = (detection.x2 - detection.x1) / (detection.y2 - detection.y1);
    
    this.kalman.update([x, y, s, r]);
  }
  
  getBbox() {
    return this.kalman.getBbox();
  }
}

// Hungarian algorithm for assignment (simplified implementation)
function hungarianAssignment(costMatrix) {
  if (costMatrix.length === 0) return [];
  
  const numRows = costMatrix.length;
  const numCols = costMatrix[0].length;
  
  // For simplicity, use greedy assignment for small matrices
  // In production, consider using a proper Hungarian algorithm implementation
  const assignments = [];
  const usedRows = new Set();
  const usedCols = new Set();
  
  // Find minimum cost assignments greedily
  const flatCosts = [];
  for (let i = 0; i < numRows; i++) {
    for (let j = 0; j < numCols; j++) {
      flatCosts.push({ cost: costMatrix[i][j], row: i, col: j });
    }
  }
  
  flatCosts.sort((a, b) => a.cost - b.cost);
  
  for (const { cost, row, col } of flatCosts) {
    if (!usedRows.has(row) && !usedCols.has(col)) {
      assignments.push([row, col]);
      usedRows.add(row);
      usedCols.add(col);
    }
  }
  
  return assignments;
}

// IoU calculation
function calculateIoU(box1, box2) {
  const x1 = Math.max(box1.x1, box2.x1);
  const y1 = Math.max(box1.y1, box2.y1);
  const x2 = Math.min(box1.x2, box2.x2);
  const y2 = Math.min(box1.y2, box2.y2);
  
  if (x2 <= x1 || y2 <= y1) return 0;
  
  const intersection = (x2 - x1) * (y2 - y1);
  const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
  const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
  const union = area1 + area2 - intersection;
  
  return intersection / union;
}

export class SORTTracker {
  constructor(maxAge = 30, minHits = 3, iouThreshold = 0.3) {
    this.maxAge = maxAge;
    this.minHits = minHits;
    this.iouThreshold = iouThreshold;
    this.tracks = [];
    this.nextId = 1;
  }
  
  update(detections) {
    console.log(`[SORTTracker] Update called with ${detections.length} detections, ${this.tracks.length} existing tracks`);
    console.log(`[SORTTracker] Detections:`, detections);
    
    // Predict existing tracks
    const predictions = this.tracks.map(track => ({
      track,
      bbox: track.predict()
    }));
    
    // Compute IoU cost matrix
    const costMatrix = [];
    for (let i = 0; i < predictions.length; i++) {
      const row = [];
      for (let j = 0; j < detections.length; j++) {
        const iou = calculateIoU(predictions[i].bbox, detections[j]);
        row.push(1 - iou); // Convert IoU to cost (lower is better)
      }
      costMatrix.push(row);
    }
    
    // Solve assignment problem
    const assignments = hungarianAssignment(costMatrix);
    console.log(`[SORTTracker] Assignments:`, assignments);
    
    // Update matched tracks
    const matchedTracks = new Set();
    const matchedDetections = new Set();
    
    for (const [trackIdx, detectionIdx] of assignments) {
      const iou = 1 - costMatrix[trackIdx][detectionIdx];
      if (iou >= this.iouThreshold) {
        predictions[trackIdx].track.update(detections[detectionIdx]);
        matchedTracks.add(trackIdx);
        matchedDetections.add(detectionIdx);
        console.log(`[SORTTracker] Matched track ${trackIdx} to detection ${detectionIdx} (IoU: ${iou.toFixed(3)})`);
      }
    }
    
    // Create new tracks for unmatched detections
    for (let i = 0; i < detections.length; i++) {
      if (!matchedDetections.has(i)) {
        const newTrack = new Track(detections[i], this.nextId++);
        this.tracks.push(newTrack);
        console.log(`[SORTTracker] Created new track ${newTrack.id} from detection ${i}`);
      }
    }
    
    // Remove old tracks
    this.tracks = this.tracks.filter((track, idx) => {
      if (matchedTracks.has(idx)) {
        return true; // Keep matched tracks
      }
      
      // Remove tracks that are too old or haven't been hit enough
      return track.timeSinceUpdate < this.maxAge && track.hitStreak >= this.minHits;
    });
    
    // Return active tracks with their bounding boxes
    const activeTracks = this.tracks.filter(track => {
      const isRecent = track.timeSinceUpdate < 1;
      const hasMinHits = track.hitStreak >= this.minHits;
      console.log(`[SORTTracker] Track ${track.id}: timeSinceUpdate=${track.timeSinceUpdate}, hitStreak=${track.hitStreak}, minHits=${this.minHits}, recent=${isRecent}, hasHits=${hasMinHits}`);
      return isRecent && hasMinHits;
    });
    
    console.log(`[SORTTracker] Returning ${activeTracks.length} active tracks:`, activeTracks.map(t => t.id));
    
    return activeTracks.map(track => ({
      id: track.id,
      bbox: track.getBbox(),
      confidence: track.confidence,
      className: track.className,
      class: track.class,
      age: track.age,
      hitStreak: track.hitStreak
    }));
  }
  
  getTrackById(id) {
    const track = this.tracks.find(t => t.id === id);
    return track ? {
      id: track.id,
      bbox: track.getBbox(),
      confidence: track.confidence,
      className: track.className,
      class: track.class,
      age: track.age,
      hitStreak: track.hitStreak
    } : null;
  }
}
