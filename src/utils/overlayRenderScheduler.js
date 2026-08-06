export class DemandRenderScheduler {
  constructor({ invalidate, requestFrame, cancelFrame, now, settleDurationMs = 250 }) {
    this.invalidate = invalidate;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.now = now;
    this.settleDurationMs = settleDurationMs;
    this.active = false;
    this.settleUntil = 0;
    this.frameId = null;
    this.disposed = false;
    this.tick = (timestamp) => this._tick(timestamp);
  }

  setActive(active) {
    this.active = active;
    this.settleUntil = active ? Infinity : this.now() + this.settleDurationMs;
    this.invalidate();
    this._scheduleFrame();
  }

  _scheduleFrame() {
    if (this.frameId === null && (this.active || this.now() < this.settleUntil)) {
      this.frameId = this.requestFrame(this.tick);
    }
  }

  _tick(timestamp) {
    this.frameId = null;
    if (this.disposed) {
      return;
    }
    this.invalidate();
    if (this.active || timestamp < this.settleUntil) {
      this.frameId = this.requestFrame(this.tick);
    }
  }

  dispose() {
    this.disposed = true;
    if (this.frameId !== null) {
      this.cancelFrame(this.frameId);
      this.frameId = null;
    }
  }
}
