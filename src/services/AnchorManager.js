import { SORTTracker } from '../cv/tracker.js';
import { AnchorStabilityTracker } from '../cv/anchorStability.js';
import { SimpleAnchorPersistence } from '../cv/SimpleAnchorPersistence.js';
import { WorkerAnchorPersistence } from '../cv/WorkerAnchorPersistence.js';

export class AnchorManager {
  constructor(config = {}) {
    this.tracker = new SORTTracker(30, 1, 0.3);
    this.stabilityTracker = new AnchorStabilityTracker();
    
    // Factory pattern: choose persistence implementation based on config
    const useWorkerPersistence = config.useWorkerPersistence ?? false; // Default to simple for Phase 1-6
    
    if (useWorkerPersistence) {
      console.log('[AnchorManager] Using WorkerAnchorPersistence for heavy OpenCV operations');
      this.persistenceTracker = new WorkerAnchorPersistence();
    } else {
      console.log('[AnchorManager] Using SimpleAnchorPersistence for Phase 1-6 compatibility');
      this.persistenceTracker = new SimpleAnchorPersistence();
    }
    
    this.activeTrackId = null;
    this.anchorStates = new Map();
    this.listeners = new Set();
    this.initialized = false;
    this.config = config;
  }

  async initialize() {
    if (!this.initialized) {
      console.log('[AnchorManager] Starting initialization...');
      try {
        console.log(`[AnchorManager] Initializing ${this.config.useWorkerPersistence ? 'worker-based' : 'simple'} persistence tracker...`);
        await this.persistenceTracker.initialize();
        this.initialized = true;
        const mode = this.config.useWorkerPersistence ? 'worker-based persistence' : 'Phase 1-6 compatibility';
        console.log(`[AnchorManager] Successfully initialized (${mode})`);
      } catch (error) {
        console.error('[AnchorManager] Initialization failed:', error);
        throw error;
      }
    }
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notifyUpdate() {
    const trackedObjects = this.tracker.getActiveTracks();
    console.log('[AnchorManager] Notifying UI with', trackedObjects.length, 'active tracks');
    
    this.listeners.forEach(listener => {
      if (listener.onAnchorUpdate) {
        listener.onAnchorUpdate({
          trackedObjects: trackedObjects,
          activeTrackId: this.activeTrackId,
          anchorStates: new Map(this.anchorStates)
        });
      }
    });
  }

  processDetections(detections, imageData) {
    console.log('[AnchorManager] processDetections called with', detections.length, 'detections');
    if (!this.initialized) {
      console.log('[AnchorManager] Not initialized, returning empty');
      return [];
    }

    // Process detections through persistence tracker
    const enhancedDetections = this.persistenceTracker.processWithDetections(detections, imageData);
    
    const tracks = this.tracker.update(enhancedDetections);
    console.log('[AnchorManager] SORT tracker returned', tracks.length, 'tracks');
    
    // Update anchor states for active track
    this._updateActiveAnchor(tracks, imageData);
    
    this._notifyUpdate();
    return tracks;
  }

  processWithoutDetections(imageData) {
    if (!this.initialized || !this.activeTrackId) {
      return [];
    }

    // Try persistence recovery
    const recoveredDetections = this.persistenceTracker.processWithoutDetections(imageData);
    
    // Update tracker with recovered detections or empty array
    const tracks = this.tracker.update(recoveredDetections);
    this._updateActiveAnchor(tracks, imageData);
    this._notifyUpdate();
    return tracks;
  }

  selectTrack(trackId) {
    if (this.activeTrackId && this.activeTrackId !== trackId) {
      this._clearTrack(this.activeTrackId);
    }
    
    this.activeTrackId = trackId;
    this._notifyUpdate();
  }

  clearActiveTrack() {
    if (this.activeTrackId) {
      this._clearTrack(this.activeTrackId);
      this.activeTrackId = null;
      this._notifyUpdate();
    }
  }

  findTrackAtPosition(tracks, position) {
    let bestTrack = null;
    let bestScore = 0;

    for (const track of tracks) {
      const { bbox } = track;
      const isInside = position.x >= bbox.x1 && position.x <= bbox.x2 && 
                      position.y >= bbox.y1 && position.y <= bbox.y2;
      
      if (isInside && track.confidence > bestScore) {
        bestTrack = track;
        bestScore = track.confidence;
      }
    }
    
    return bestTrack;
  }

  getActiveTrackState() {
    if (!this.activeTrackId) return null;
    return this.anchorStates.get(this.activeTrackId);
  }

  getAnchorStates() {
    return new Map(this.anchorStates);
  }

  _updateActiveAnchor(tracks, imageData) {
    if (!this.activeTrackId) return;

    const activeTrack = tracks.find(t => t.id === this.activeTrackId);
    const timestamp = performance.now();

    if (activeTrack) {
      // Update stability tracking
      const anchorState = this.stabilityTracker.updateTrack(
        this.activeTrackId,
        activeTrack.bbox,
        activeTrack.confidence,
        timestamp
      );

      // Update persistence tracking
      this.persistenceTracker.updateAnchor(
        this.activeTrackId,
        activeTrack.bbox,
        imageData,
        anchorState
      );

      const metrics = this.stabilityTracker.getStabilityMetrics(this.activeTrackId, timestamp);

      const screenPosition = {
        x: (activeTrack.bbox.x1 + activeTrack.bbox.x2) / 2,
        y: (activeTrack.bbox.y1 + activeTrack.bbox.y2) / 2,
        z: 0
      };

      this.anchorStates.set(this.activeTrackId, {
        state: anchorState,
        metrics,
        screenPosition,
        persistent: activeTrack.persistent || false,
        synthetic: activeTrack.synthetic || false,
        reacquired: activeTrack.reacquired || false
      });
    } else {
      // Track lost - for Phase 1-4, just clear after a few frames
      console.log('[AnchorManager] Active track lost, clearing...');
      this._clearTrack(this.activeTrackId);
      
      // Check persistence
      const persistenceStats = this.persistenceTracker.getAnchorStats();
      const persistentAnchor = persistenceStats.find(a => a.trackId === this.activeTrackId);
      if (!persistentAnchor || persistentAnchor.missCount > 10) {
        this._clearTrack(this.activeTrackId);
      }
    }
  }

  _clearTrack(trackId) {
    this.stabilityTracker.removeTrack(trackId);
    this.persistenceTracker.removeAnchor(trackId);
    this.anchorStates.delete(trackId);
  }

  updateNormal(normal) {
    if (this.activeTrackId && normal) {
      const currentAnchor = this.anchorStates.get(this.activeTrackId);
      if (currentAnchor) {
        this.anchorStates.set(this.activeTrackId, { ...currentAnchor, normal });
        this._notifyUpdate();
      }
    }
  }

  dispose() {
    this.tracker = null;
    this.stabilityTracker = null;
    this.persistenceTracker = null;
    this.anchorStates.clear();
    this.listeners.clear();
    this.initialized = false;
  }
}