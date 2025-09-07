import { SORTTracker } from '../cv/tracker.js';
import { AnchorStabilityTracker } from '../cv/anchorStability.js';
import { AnchorPersistenceTracker } from '../cv/anchorPersistence.js';

export class AnchorManager {
  constructor() {
    this.tracker = new SORTTracker(30, 1, 0.3);
    this.stabilityTracker = new AnchorStabilityTracker();
    this.persistenceTracker = new AnchorPersistenceTracker();
    this.activeTrackId = null;
    this.anchorStates = new Map();
    this.listeners = new Set();
    this.initialized = false;
  }

  async initialize() {
    if (!this.initialized) {
      console.log('[AnchorManager] Starting initialization...');
      try {
        // For Phase 1-4, we can skip persistence tracker initialization
        // and just do basic SORT tracking with stability
        console.log('[AnchorManager] Skipping persistence tracker for Phase 1-4...');
        // await this.persistenceTracker.initialize();
        this.initialized = true;
        console.log('[AnchorManager] Successfully initialized (basic mode)');
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
    // For Phase 1-4, just pass through detections without persistence processing
    const enhancedDetections = detections;
    // TODO Phase 6: const enhancedDetections = this.persistenceTracker.processWithDetections(detections, imageData);
    
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

    // For Phase 1-4, just update tracker with empty detections
    // This allows SORT to predict object positions
    const tracks = this.tracker.update([]);
    this._updateActiveAnchor(tracks, imageData);
    this._notifyUpdate();
    return tracks;
    
    // TODO Phase 6: Try persistence recovery
    // const recoveredDetections = this.persistenceTracker.processWithoutDetections(imageData);
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

      // TODO Phase 6: Update persistence tracking
      // this.persistenceTracker.updateAnchor(
      //   this.activeTrackId,
      //   activeTrack.bbox,
      //   imageData,
      //   anchorState
      // );

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
      
      // TODO Phase 6: Check persistence
      // const persistenceStats = this.persistenceTracker.getAnchorStats();
      // const persistentAnchor = persistenceStats.find(a => a.trackId === this.activeTrackId);
      // if (!persistentAnchor || persistentAnchor.missCount > 10) {
      //   this._clearTrack(this.activeTrackId);
      // }
    }
  }

  _clearTrack(trackId) {
    this.stabilityTracker.removeTrack(trackId);
    // TODO Phase 6: this.persistenceTracker.removeAnchor(trackId);
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