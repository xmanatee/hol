import { shouldRenderAnchorOverlay } from './overlayVisibility.js';

const ANCHOR_UI_UPDATE_INTERVAL_MS = 100;

const scheduleAnchorUiUpdate = (callback) => {
  const timeoutId = globalThis.setTimeout(callback, ANCHOR_UI_UPDATE_INTERVAL_MS);
  return () => globalThis.clearTimeout(timeoutId);
};

const getAnchorIdentity = (state) => {
  const anchor = state.activeAnchor;
  return anchor ? (anchor.createdAt ?? anchor.id) : null;
};

const hasSameStatePayload = (previous, next) =>
  previous.mode === next.mode &&
  previous.activeAnchor === next.activeAnchor &&
  previous.anchorState === next.anchorState &&
  previous.trackingMode === next.trackingMode &&
  previous.initialized === next.initialized;

const hasStructuralChange = (previous, next) => {
  if (
    previous.mode !== next.mode ||
    previous.initialized !== next.initialized ||
    previous.trackingMode !== next.trackingMode ||
    getAnchorIdentity(previous) !== getAnchorIdentity(next)
  ) {
    return true;
  }

  return shouldRenderAnchorOverlay(previous) !== shouldRenderAnchorOverlay(next);
};

export const createAnchorStateStore = (initialState, schedule = scheduleAnchorUiUpdate) => {
  let latestState = initialState;
  let uiSnapshot = initialState;
  let cancelScheduledPublish = null;
  const listeners = new Set();
  const latestListeners = new Set();

  const publish = () => {
    if (uiSnapshot === latestState) {
      return;
    }
    uiSnapshot = latestState;
    listeners.forEach((listener) => {
      listener(uiSnapshot);
    });
  };

  const cancelPendingPublish = () => {
    cancelScheduledPublish?.();
    cancelScheduledPublish = null;
  };

  return {
    getLatest: () => latestState,
    getSnapshot: () => uiSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeLatest: (listener) => {
      latestListeners.add(listener);
      return () => latestListeners.delete(listener);
    },
    update: (state) => {
      const duplicate = hasSameStatePayload(latestState, state);
      latestState = state;
      if (duplicate) {
        return;
      }
      latestListeners.forEach((listener) => {
        listener(latestState);
      });
      if (uiSnapshot === state) {
        return;
      }

      if (hasStructuralChange(uiSnapshot, state)) {
        cancelPendingPublish();
        publish();
        return;
      }

      if (!cancelScheduledPublish) {
        cancelScheduledPublish = schedule(() => {
          cancelScheduledPublish = null;
          publish();
        });
      }
    },
    reset: (state) => {
      cancelPendingPublish();
      latestState = state;
      latestListeners.forEach((listener) => {
        listener(latestState);
      });
      publish();
    },
    dispose: () => {
      cancelPendingPublish();
      listeners.clear();
      latestListeners.clear();
    },
  };
};
