export const ANCHOR_SELECTION_IN_PROGRESS_REASON = 'Anchor selection in progress';

export class AnchorSelectionGate {
  constructor() {
    this.owner = null;
  }

  run(action) {
    if (this.owner) {
      return Promise.resolve({
        success: false,
        reason: ANCHOR_SELECTION_IN_PROGRESS_REASON,
      });
    }

    const owner = {};
    this.owner = owner;
    return this._runOwned(owner, action);
  }

  reset() {
    this.owner = null;
  }

  async _runOwned(owner, action) {
    try {
      return await action();
    } finally {
      if (this.owner === owner) {
        this.owner = null;
      }
    }
  }
}
