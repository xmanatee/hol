import { MAX_OBJECT_OBSERVATION_AGE_MS } from '../utils/cvScheduling.js';

const DISCOVERY_INTERVAL_MS = 750;
const MIN_TRACKING_OBSERVATIONS = 3;
const MIN_TRACKING_DURATION_MS = 180;
const MAX_OBSERVATION_GAP_MS = 600;
const FOCUS_RELEASE_MS = 700;

// The manager owns CV buffers and geometry. This session owns subject identity and user commitment.
export class ObjectObservationSession {
  constructor({ manager, width, height, now = () => performance.timeOrigin + performance.now() }) {
    this.manager = manager;
    this.width = width;
    this.height = height;
    this.now = now;
    this.selected = false;
    this.subject = null;
    this.nextObjectId = 1;
    this.lastCapturedAt = -Infinity;
    this.nextDiscoveryAt = 0;
    this.disposed = false;
  }

  async processFrame({ imageData, update, refreshSegmentation, depthContext, capturedAt }) {
    this._assertActive();
    if (!Number.isFinite(capturedAt) || capturedAt < 0) {
      throw new TypeError('Observation requires a finite capture timestamp');
    }
    if (imageData.width !== this.width || imageData.height !== this.height) {
      throw new RangeError('Observation raster changed; reset the camera session');
    }
    if (capturedAt <= this.lastCapturedAt) {
      return { success: false, reason: 'Stale camera frame' };
    }
    if (this.subject && capturedAt - this.subject.capturedAt > MAX_OBSERVATION_GAP_MS) {
      this._resetTrackingEvidence();
    }
    this.lastCapturedAt = capturedAt;

    if (!this.subject) {
      if (capturedAt < this.nextDiscoveryAt) {
        return { success: false, reason: 'Looking for an object' };
      }
      this.nextDiscoveryAt = capturedAt + DISCOVERY_INTERVAL_MS;
      const result = await this.manager.prepareObjectAtPoint(
        { x: this.width / 2, y: this.height / 2 },
        imageData,
      );
      this._assertActive();
      if (!result.success || result.objectSupportMaskSource !== 'interactive-segmenter') {
        this.manager.clearAnchor();
        return { success: false, reason: 'Keep a distinct object near the center' };
      }
      this.subject = {
        id: this.nextObjectId++,
        capturedAt,
        trackingSince: null,
        trackingObservations: 0,
        unfocusedSince: null,
      };
      return { success: true, method: 'object-discovered' };
    }

    // Complete mask inference before the next RGB mutation: the returned mask belongs to this frame.
    const { updateResult } = await this.manager.processFrame(imageData, {
      update,
      refreshSegmentation,
      depthContext,
    });
    this._assertActive();
    const state = this.manager.getState();
    if (!state.activeAnchor) {
      this._clearSubject();
      return { updateResult };
    }
    if (update) {
      const present = updateResult?.targetPresent === true && updateResult.success;
      if (present) {
        this.subject.trackingSince ??= capturedAt;
        this.subject.trackingObservations++;
      } else {
        this._resetTrackingEvidence();
      }
      this.subject.capturedAt = capturedAt;
    }
    if (!this.selected) {
      const focused =
        state.anchorState?.metrics?.targetPresent === true &&
        this.manager.containsSourcePoint({ x: this.width / 2, y: this.height / 2 });
      this.subject.unfocusedSince = focused ? null : (this.subject.unfocusedSince ?? capturedAt);
      if (
        this.subject.unfocusedSince !== null &&
        capturedAt - this.subject.unfocusedSince >= FOCUS_RELEASE_MS
      ) {
        this._clearSubject();
        this.nextDiscoveryAt = capturedAt;
      }
    }
    return { updateResult };
  }

  selectCandidate({ candidateId, tapPosition, capturedAt, timeOrigin }) {
    this._assertActive();
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) {
      throw new TypeError('Selection requires a positive safe-integer candidate ID');
    }
    if (!Number.isFinite(timeOrigin) || timeOrigin < 0) {
      throw new TypeError('Selection requires a finite non-negative time origin');
    }
    if (!Number.isFinite(capturedAt) || capturedAt < 0) {
      throw new TypeError('Selection requires a finite capture timestamp');
    }
    if (!Number.isFinite(tapPosition.x) || !Number.isFinite(tapPosition.y)) {
      throw new TypeError('Selection requires a finite source point');
    }
    const candidate = this.getState().candidate;
    const observationAge = candidate ? this.now() - (timeOrigin + candidate.capturedAt) : null;
    if (
      this.selected ||
      !candidate ||
      candidate.id !== candidateId ||
      candidate.status !== 'ready' ||
      observationAge < 0 ||
      observationAge > MAX_OBJECT_OBSERVATION_AGE_MS ||
      capturedAt < candidate.capturedAt ||
      capturedAt - candidate.capturedAt > MAX_OBJECT_OBSERVATION_AGE_MS
    ) {
      return { success: false, reason: 'Hold the object in view until its outline turns green' };
    }
    if (
      tapPosition.x < 0 ||
      tapPosition.y < 0 ||
      tapPosition.x >= this.width ||
      tapPosition.y >= this.height ||
      !this.manager.containsSourcePoint(tapPosition)
    ) {
      return { success: false, reason: 'Tap inside the highlighted object' };
    }
    this.selected = true;
    const { activeAnchor } = this.getState();
    return {
      success: true,
      method: 'prepared-object-selected',
      id: activeAnchor.id,
      createdAt: activeAnchor.createdAt,
      position: activeAnchor.position,
      keypoints: activeAnchor.keypoints,
      quality: activeAnchor.quality,
      state: activeAnchor.state,
      trackingMode: activeAnchor.trackingMode,
      readiness: activeAnchor.readiness,
      objectSupportMaskSource: activeAnchor.objectSupportMaskSource,
    };
  }

  getState() {
    const state = { ...this.manager.getState(), nextObservationAt: 0 };
    if (!this.subject || !state.activeAnchor) {
      return {
        ...state,
        mode: 'selection',
        activeAnchor: null,
        anchorState: null,
        candidate: null,
        nextObservationAt: this.nextDiscoveryAt,
      };
    }
    if (this.selected) {
      return { ...state, activeAnchor: { ...state.activeAnchor, id: this.subject.id }, candidate: null };
    }
    const metrics = state.anchorState?.metrics || {};
    const tracked =
      this.subject.trackingObservations >= MIN_TRACKING_OBSERVATIONS &&
      this.subject.capturedAt - this.subject.trackingSince >= MIN_TRACKING_DURATION_MS;
    const present = metrics.targetPresent === true;
    const ready = present && tracked && metrics.readiness?.faceReady === true;
    const candidate = {
      id: this.subject.id,
      status: !present ? 'lost' : ready ? 'ready' : tracked ? 'tracking' : 'segmented',
      capturedAt: this.subject.capturedAt,
      position: state.activeAnchor.position,
      maskPreview: metrics.currentObjectSupportMaskPreview || metrics.objectSupportMaskPreview || null,
      reason: ready
        ? 'Tap the highlighted object to bring it to life'
        : !present
          ? 'Keep the object visible'
          : tracked
            ? 'Move slightly to prepare the surface'
            : 'Hold the object near the center',
    };
    return { ...state, mode: 'selection', activeAnchor: null, anchorState: null, candidate };
  }

  clearAnchor() {
    this._assertActive();
    this._clearSubject();
    this.nextDiscoveryAt = 0;
  }

  async setTrackingMode(mode) {
    this._assertActive();
    const previousMode = this.manager.getState().trackingMode;
    await this.manager.setTrackingMode(mode);
    this._assertActive();
    if (previousMode !== mode && this.subject) {
      this._resetTrackingEvidence();
    }
  }

  dispose() {
    this.disposed = true;
    this.subject = null;
    this.manager.dispose();
  }

  _clearSubject() {
    this.manager.clearAnchor();
    this.subject = null;
    this.selected = false;
  }

  _resetTrackingEvidence() {
    this.subject.trackingSince = null;
    this.subject.trackingObservations = 0;
  }

  _assertActive() {
    if (this.disposed) {
      throw new Error('Object observation session is disposed');
    }
  }
}
